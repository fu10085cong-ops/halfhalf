/**
 * 联网补洞流水线：搜索 → 质量闸 → 分节总结 → ImportedDocument。
 *
 * v1 不抓原页。实测智谱 web_search 的 content 字段平均 574 字，已是抽好的正文
 * 片段，对「解释一个术语」够用。于是整个 SSRF 面、超时、大小限制、并发抓取都
 * 不存在——v1 不发起任何对第三方网页的请求，只跟搜索 API 说话。
 *
 * 红线：搜不到就报错。绝不退化成让模型凭记忆写一段——那种产出看起来完全正常，
 * 而用户会把它打印出来带进考场。
 */
import type {
  AiProviderConfig,
  ImportedDocument,
  ResearchSource,
  SearchHit,
} from '../types/index.js';
import { chatComplete } from './ai-provider.js';
import { loadBlocklist } from './blocklist.js';
import { filterSearchHits } from './source-quality.js';
import { SearchError, type SearchProvider } from './search-provider.js';

export class ResearchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ResearchError';
  }
}

export interface ResearchProgress {
  progress: number;
  stage: 'extracting' | 'rendering' | 'finalizing';
  message: string;
}

export interface ResearchOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ResearchProgress) => void;
  provider?: AiProviderConfig;
  /**
   * 总结环节的注入点（TESTING.md L2 硬要求：调模型的环节必须能在零 token、不联网的
   * 条件下跑通全流程）。此前本管道缺这个口子，接地检测的行为锁只能靠捕异常绕过。
   */
  summarize?: (prompt: string) => Promise<string>;
}

/** 采纳几个源。瓶颈在用户要读，不在服务器。 */
const KEEP_SOURCES = 4;
/** 每个源喂给总结模型的片段上限，防止个别超长片段挤掉其他源。 */
const SNIPPET_CHAR_CAP = 1200;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Research cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

/** 总结提示词。沿用 structurize 的「只重组不新增」，并额外要求分节标注来源。 */
export function buildSummaryPrompt(query: string, hits: SearchHit[]): string {
  const blocks = hits
    .map(
      (hit, index) =>
        `【来源 ${index + 1}】${hit.domain}\n标题：${hit.title}\n片段：${hit.snippet.slice(0, SNIPPET_CHAR_CAP)}`
    )
    .join('\n\n');

  return `你在帮学生整理考试用的复习资料。下面是就「${query}」检索到的 ${hits.length} 个网页片段。

请为每个来源单独写一节总结，输出 Markdown，严格遵守：

1. 只重组这些片段里已经说过的内容。**不要补充片段之外的任何知识**，即使你知道更多。
2. 片段可能在句子中间截断、可能夹杂网页噪声（广告语、残留标签）。忽略噪声，截断处不要脑补续写。
3. 每个来源一节，标题格式：### 来自 <域名>
4. 每节只写该来源说了什么，不要跨来源合并或比较。
5. 若某个片段没有与「${query}」相关的实质内容，该节就写「此来源未提供相关内容」。
6. 用要点式，简洁。这是要印在纸上带进考场的。

${blocks}`;
}

/**
 * 接地检测（② 联网补洞的确定性判据，2026-07-30 立）。
 *
 * **要防的是什么**：规格红线写着「搜索不可用 → 明确报错，绝不退化成模型凭记忆生成」。
 * 这条红线不是洁癖，是判例——`search-provider.ts` 头注释记着 DeepSeek 传
 * `enable_search` 会 HTTP 200 静默忽略、内容全由模型编造。但那条红线只锁了"搜索失败时
 * 不调总结模型"，**没有任何判据检查"总结到底有没有用检索到的东西"**。
 *
 * **为什么用「可验证 token 回溯率」而不是别的**（三次测法踩坑后定的口径）：
 * - 不能用中文 4-gram：总结**本来就该改写**（不同于 structurize 的重组），实测回溯率
 *   只有 4~13%，正常与异常无法区分。
 * - 不能用裸数字：`pool.includes('2')` 在任何中文网页文本里都命中，短数字被无条件"找到"，
 *   矩阵三行完全相同、零区分度。
 * - 故只取**≥3 位数字**与**≥4 字母的英文词**：它们要么来自片段，要么是模型编的，
 *   没有第三种可能。年份、序号、协议名、数据结构名都在这个集合里。
 *
 * **证据池必须 = 模型当时看到的全部内容**（domain + title + snippet，与 buildSummaryPrompt
 * 逐字段对齐）。首版漏了 domain，于是总结里 `### 来自 <域名>` 那行的 CSDN / ZHIHU /
 * ZHUANLAN 全被判成"未接地"，对角线被压到 17~77%——那是测法错，不是产出错。
 * LaTeX 命令（`\frac` 这类）也剔掉：它是排版记号，不是知识。
 *
 * 返回 null 表示可验证 token 不足 5 个（很短的总结），此时不作判断——
 * 小样本上的比率没有意义，宁可不报也不靠猜。
 */
/**
 * 接地率下限。实测 7 个查询（含冷门、符号密集、短查询）**全部 100%**，
 * 交叉负对照（A 的总结 × B 的证据池）只有 0~15%。60% 落在中间，两侧余量都极大。
 * 破线意味着"总结基本没用检索结果"——即规格红线要防的"退化成模型凭记忆生成"。
 */
export const GROUNDING_FLOOR = 0.6;

export function groundingRate(summary: string, hits: SearchHit[]): {
  rate: number;
  total: number;
  unsupported: string[];
} | null {
  const scrubbed = summary.replace(/\\[A-Za-z]+/g, ' '); // LaTeX 命令不是知识
  const tokens = [
    ...new Set([
      ...(scrubbed.match(/\d{3,}(?:\.\d+)?/g) ?? []),
      ...(scrubbed.match(/[A-Za-z]{4,}/g) ?? []).map((w) => w.toUpperCase()),
    ]),
  ];
  if (tokens.length < 5) return null;
  const pool = hits
    .map((h) => `${h.domain}\n${h.title}\n${h.snippet}`)
    .join('\n')
    .toUpperCase();
  const unsupported = tokens.filter((t) => !pool.includes(t));
  return { rate: (tokens.length - unsupported.length) / tokens.length, total: tokens.length, unsupported };
}

/**
 * 拼成最终 Markdown。
 *
 * 刻意**不把 URL 清单印进正文**：这份内容最终要排进半开卷小抄，版面寸土寸金，
 * 而考场上 URL 既点不开也没法查，纯属占地方。溯源不靠正文里的链接——
 * 完整来源保存在 summary.sources 里，由界面展示供用户回查。
 */
export function assembleResearchMarkdown(
  query: string,
  summary: string,
  _hits: SearchHit[]
): string {
  return [
    `## ${query}`,
    '',
    '> 以下内容来自网络检索，**非教材口径**，请与课件核对后再采用。',
    '',
    summary.trim(),
  ].join('\n');
}

export async function runResearch(
  query: string,
  searchProvider: SearchProvider,
  options: ResearchOptions = {}
): Promise<ImportedDocument> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new ResearchError('RESEARCH_EMPTY_QUERY', '请先填写要检索的关键词。', 400);
  }

  throwIfAborted(options.signal);
  options.onProgress?.({ progress: 10, stage: 'extracting', message: '正在检索网页…' });

  let hits: SearchHit[];
  try {
    hits = await searchProvider.search(trimmed, { signal: options.signal });
  } catch (error) {
    if (error instanceof SearchError) {
      throw new ResearchError(error.code, error.message, error.status);
    }
    throw error;
  }

  if (hits.length === 0) {
    throw new ResearchError(
      'RESEARCH_NO_RESULTS',
      '这个关键词没有搜到任何网页，换个说法再试。',
      422,
      { query: trimmed }
    );
  }

  throwIfAborted(options.signal);
  options.onProgress?.({ progress: 40, stage: 'rendering', message: '正在筛选来源…' });

  const report = filterSearchHits(hits, loadBlocklist(), KEEP_SOURCES);
  if (report.kept.length === 0) {
    // 区分「没搜到」和「被拦了」——这两种情况用户该做的事完全不同
    throw new ResearchError(
      'RESEARCH_ALL_FILTERED',
      '搜到的来源全部被质量过滤挡下了（多为内容农场或付费墙文库）。换个关键词，或让管理员调整 blocklist.txt。',
      422,
      { blockedDomains: report.blockedDomains, searched: hits.length }
    );
  }

  throwIfAborted(options.signal);
  options.onProgress?.({
    progress: 65,
    stage: 'rendering',
    message: `正在总结 ${report.kept.length} 个来源…`,
  });

  let summary: string;
  try {
    // chatComplete 只接受超时数字，不吃 AbortSignal。用户中途取消时，任务会立刻
    // 被标记 cancelled、产物丢弃，但这一次上游调用仍会跑完——代价是浪费一次调用。
    // 为此改动 chatComplete 会波及 compress 链路，不值得，故接受。
    const prompt = buildSummaryPrompt(trimmed, report.kept);
    summary = options.summarize
      ? await options.summarize(prompt)
      : await chatComplete(options.provider ?? serverProvider(), [{ role: 'user', content: prompt }]);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    // 总结挂了也要把搜到的东西交出去，用户至少能自己点开看
    throw new ResearchError(
      'RESEARCH_SUMMARY_FAILED',
      `已搜到 ${report.kept.length} 个来源，但总结失败：${error instanceof Error ? error.message : String(error)}`,
      502,
      { sources: report.kept.map(toSource) }
    );
  }

  throwIfAborted(options.signal);

  // 接地检测：总结到底有没有用检索到的东西。原有的四段 throw 只保证"搜索失败时不调
  // 总结模型"，没有任何判据检查产出本身是否接地——这是 ② 环节此前唯一没有 pass/fail
  // 判据的地方（TESTING.md §5 的自陈缺口）。
  const grounding = groundingRate(summary, report.kept);
  if (grounding && grounding.rate < GROUNDING_FLOOR) {
    throw new ResearchError(
      'RESEARCH_NOT_GROUNDED',
      `总结与检索到的内容对不上（可验证内容只有 ${Math.round(grounding.rate * 100)}% 能在片段里找到），` +
        `判定为模型凭记忆生成而非基于检索结果，已丢弃。请换关键词重试。`,
      502,
      { sources: report.kept.map(toSource) }
    );
  }

  options.onProgress?.({ progress: 92, stage: 'finalizing', message: '正在组装可追溯内容…' });

  const markdown = assembleResearchMarkdown(trimmed, summary, report.kept);
  const sources = report.kept.map(toSource);
  const warnings = [
    '内容来自网络检索，非教材口径——请与课件核对后再采用。',
    ...(report.blockedDomains.length > 0
      ? [`${report.blockedDomains.length} 个来源被质量黑名单挡下。`]
      : []),
    ...(report.kept.length < KEEP_SOURCES
      ? [`符合质量要求的来源只有 ${report.kept.length} 个。`]
      : []),
    // 没破线但有未接地内容:逐个点名让用户能核。实测正常应当是 0 个。
    ...(grounding && grounding.unsupported.length > 0
      ? [
          `${grounding.unsupported.length} 处内容在检索片段里找不到依据，` +
            `请重点核对：${grounding.unsupported.slice(0, 8).join('、')}`,
        ]
      : []),
  ];

  return {
    markdown,
    summary: {
      kind: 'research',
      originalName: trimmed.slice(0, 60),
      sizeBytes: Buffer.byteLength(markdown, 'utf8'),
      characterCount: markdown.replace(/\s/g, '').length,
      paragraphCount: report.kept.length,
      headingCount: report.kept.length + 1,
      tableCount: 0,
      imageCount: 0,
      sources,
      warnings,
    },
  };
}

function toSource(hit: SearchHit): ResearchSource {
  return { url: hit.url, domain: hit.domain, title: hit.title };
}

/** 服务器统一 key（与 structurize 同源配置）。缺了就明确报 501。 */
function serverProvider(): AiProviderConfig {
  const endpoint = process.env.HALFHALF_AI_ENDPOINT?.trim();
  const model = process.env.HALFHALF_AI_MODEL?.trim();
  const apiKey = process.env.HALFHALF_AI_KEY?.trim();
  if (!endpoint || !model || !apiKey) {
    throw new ResearchError(
      'RESEARCH_UNAVAILABLE',
      '未配置总结用的 AI（HALFHALF_AI_ENDPOINT / MODEL / KEY），也没有提供 BYOK。',
      501
    );
  }
  return { endpoint, model, headers: { Authorization: `Bearer ${apiKey}` } };
}

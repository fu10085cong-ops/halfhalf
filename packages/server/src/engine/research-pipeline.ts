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

/** 把模型产出与来源清单拼成最终 Markdown，保证每节都带可回查的 URL。 */
export function assembleResearchMarkdown(
  query: string,
  summary: string,
  hits: SearchHit[]
): string {
  const references = hits
    .map((hit, index) => `${index + 1}. [${hit.title}](${hit.url}) — ${hit.domain}`)
    .join('\n');

  return [
    `## ${query}`,
    '',
    '> 以下内容来自网络检索，**非教材口径**，请与课件核对后再采用。',
    '',
    summary.trim(),
    '',
    '### 来源',
    '',
    references,
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
    summary = await chatComplete(options.provider ?? serverProvider(), [
      { role: 'user', content: buildSummaryPrompt(trimmed, report.kept) },
    ]);
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

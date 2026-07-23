/**
 * AI 语义级精简的核心：把 Markdown 分块，对每个"含正文"的块，遮罩掉刚性原子后
 * 只把散文交给用户自带 key 的 AI 改写成要点式，回填原子，再过三道安全网，
 * 产出"原文 vs 建议"的逐块清单。**输出只是建议，不自动落到文档**——由前端展示
 * diff、用户逐块接受/拒绝后才回写（回写用本模块给出的字符区间 range）。
 *
 * 三道安全网（任一不过就作废该块、保留原文，并给人话原因）：
 *   ① 哨兵完整性——刚性原子占位符逐一回来、不丢/不重/不杜撰（原子没被 AI 动过的判据）
 *   ② 公式预检——回填后不引入原文没有的 KaTeX 错误（回填相邻处漏个 $ 之类的兜底）
 *   ③ 确实精简——剥后正文字数确有缩减（口径同 analyzeContent），否则不误报为可用建议
 *
 * chatComplete 以参数注入，测试可传假实现走通全流程而不花 token（见 test/unit/ai-compress）。
 */
import { chunkMarkdown } from './chunk-markdown.js';
import type { ContentBlock } from './chunk-markdown.js';
import { analyzeContent } from './scene-presets.js';
import { precheckFormulas } from './precheck-formulas.js';
import { maskAtoms, unmaskAtoms, isPureAtom, checkSentinels, SENTINEL_RE } from './atom-mask.js';
import { chatComplete } from './ai-provider.js';
import type { ChatMessage } from './ai-provider.js';
import type {
  AiCompressRequest,
  AiCompressResponse,
  AiProviderConfig,
  BlockSuggestion,
} from '../types/index.js';

/** 同时在飞的 AI 请求数上限：太多会撞服务商速率限制，太少长文慢 */
const CONCURRENCY = 4;
/** 默认认为"确实精简了"的最小剥后正文缩减字数 */
const DEFAULT_MIN_REDUCTION = 4;
/** 遮罩后剩余散文（去哨兵去空白）不足这么多字就不值得调 AI */
const MIN_PROSE_CHARS = 12;
const PER_CALL_TIMEOUT = 60_000;

const SYSTEM_PROMPT = `你是一个中文学习笔记压缩助手。你唯一的任务是把叙述性文字改写成极简的要点式表达，在不丢失任何知识点、定义、数字、专有名词、因果或条件关系的前提下尽量缩短篇幅，以便排进更小的纸面、用更大的字号。

严格规则：
1. 只压缩叙述性散文：把完整句子改写成短要点（用「- 」列表或分号短句），删掉口语、过渡词、冗余修饰，但保留全部技术含义。
2. 绝对不要修改、翻译、解释或删除任何形如 〔HH数字〕 的占位符——它代表公式/代码/表格/图片/标题等不可改动的内容。逐字保留每一个占位符，且保持它在文中的相对位置。
3. 不要新增占位符，不要合并或拆分占位符，不要改动占位符里的数字。
4. 保持原文语言（中文保持中文），不要翻译。
5. 只输出改写后的 Markdown 正文，不要用代码块包裹整段输出，不要加任何解释、前言、后记或元评论。
6. 不要杜撰原文没有的信息；拿不准就保留原文表述。`;

function buildUserPrompt(blockTitle: string, maskedBody: string): string {
  const titleLine = blockTitle
    ? `章节标题（仅供你理解上下文，不要输出，也不要改写）：${blockTitle}\n\n`
    : '';
  return `${titleLine}请压缩下面这段内容：\n\n${maskedBody}`;
}

/** 剥掉 Markdown 标记后的正文字数（口径同 analyzeContent，忽略公式/代码/符号） */
function countBodyChars(markdown: string): number {
  const block: ContentBlock = { id: 'x', kind: 'text', level: 0, title: '', markdown };
  return analyzeContent([block]).charCount;
}

/**
 * AI 可能无视"不要用代码块包裹"的指令，把整段输出裹进 ```。由于真实代码已被遮罩成哨兵，
 * 遮罩态文本里出现的 ``` 只可能是这层包裹，安全剥掉；剥错的风险为零（哨兵里没有 ```）。
 */
function stripOuterFence(s: string): string {
  const t = s.trim();
  const m = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return m ? m[1].trim() : t;
}

/** 原文块过一遍公式预检，返回错误信息的多重集（按 message 计数），用于前后对比 */
async function formulaErrorBag(block: ContentBlock): Promise<Map<string, number>> {
  const issues = await precheckFormulas([block]);
  const bag = new Map<string, number>();
  for (const it of issues) bag.set(it.message, (bag.get(it.message) ?? 0) + 1);
  return bag;
}

/** 改写块相对原文块是否引入了"新的"公式错误（原文本就有的同类错误不算） */
function introducesNewFormulaError(afterBag: Map<string, number>, beforeBag: Map<string, number>): boolean {
  for (const [msg, n] of afterBag) {
    if ((beforeBag.get(msg) ?? 0) < n) return true;
  }
  return false;
}

type ChatFn = (
  provider: AiProviderConfig,
  messages: ChatMessage[],
  timeoutMs?: number,
) => Promise<string>;

export interface CompressDeps {
  /** 注入点：默认走真实 OpenAI 兼容调用，测试传假实现 */
  chat?: ChatFn;
}

/**
 * 首行锚定算每个块在原始字符串里的区间 [start, end)。锚在块的**首行**（标题/图片/首行散文）
 * 而不是整块 markdown——因为 chunkMarkdown 会 trim、会把"空章头块"用合成 \n\n 并进下一块，
 * 整块未必是原文子串，但首行一定是（trim 只删首尾空行，首行内容原样保留）。
 * 用移动游标消歧重复行，块按文档顺序，区间首尾相接铺满全文。
 */
function computeRanges(src: string, blocks: ContentBlock[]): { start: number; end: number }[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const b of blocks) {
    const firstLine = b.markdown.split('\n', 1)[0];
    const at = src.indexOf(firstLine, cursor);
    const start = at < 0 ? cursor : at;
    starts.push(start);
    cursor = start + firstLine.length;
  }
  return starts.map((s, i) => ({
    start: s,
    end: i + 1 < starts.length ? starts[i + 1] : src.length,
  }));
}

function skipped(reason: string): BlockSuggestion['safety'] {
  return { ok: false, atomsPreserved: true, formulaClean: true, reason };
}

/**
 * 精简单个块：遮罩 → 调 AI → 剥外层围栏 → 哨兵校验 → 回填 → 公式前后对比 → 缩减判定。
 * 只返回与该块相关的可变字段；blockId/title/kind/original/range 由上层补齐。
 */
async function compressBlock(
  block: ContentBlock,
  provider: AiProviderConfig,
  chat: ChatFn,
  minReduction: number,
): Promise<Pick<BlockSuggestion, 'suggested' | 'charsBefore' | 'charsAfter' | 'skipped' | 'safety'>> {
  const original = block.markdown;
  const charsBefore = countBodyChars(original);

  // 图片块本身就是一张图，没有正文可精简
  if (block.kind === 'image') {
    return { suggested: original, charsBefore, charsAfter: charsBefore, skipped: true, safety: skipped('图片块，无正文可精简') };
  }

  const { masked, atoms } = maskAtoms(original);
  if (isPureAtom(masked)) {
    return { suggested: original, charsBefore, charsAfter: charsBefore, skipped: true, safety: skipped('纯原子块（公式/代码/表格/标题），无可精简正文') };
  }
  const proseChars = masked.replace(SENTINEL_RE, '').replace(/\s/g, '').length;
  if (proseChars < MIN_PROSE_CHARS) {
    return { suggested: original, charsBefore, charsAfter: charsBefore, skipped: true, safety: skipped('正文过短，无需精简') };
  }

  // —— 调 AI ——
  let raw: string;
  try {
    raw = await chat(
      provider,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(block.title, masked) },
      ],
      PER_CALL_TIMEOUT,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : '未知错误';
    return { suggested: original, charsBefore, charsAfter: charsBefore, skipped: false, safety: { ok: false, atomsPreserved: true, formulaClean: true, reason: `AI 调用失败：${msg}` } };
  }

  const suggestedMasked = stripOuterFence(raw);

  // 安全网①：哨兵完整性——原子有没有被 AI 动过
  if (!checkSentinels(suggestedMasked, atoms.length)) {
    return { suggested: original, charsBefore, charsAfter: charsBefore, skipped: false, safety: { ok: false, atomsPreserved: false, formulaClean: true, reason: '占位符丢失或错乱，已保留原文（疑似模型改动了公式/代码/表格）' } };
  }

  const suggested = unmaskAtoms(suggestedMasked, atoms);

  // 安全网②：回填后公式预检不引入新错误
  const beforeBag = await formulaErrorBag(block);
  const afterBag = await formulaErrorBag({ ...block, markdown: suggested });
  if (introducesNewFormulaError(afterBag, beforeBag)) {
    return { suggested: original, charsBefore, charsAfter: charsBefore, skipped: false, safety: { ok: false, atomsPreserved: true, formulaClean: false, reason: '改写引入了公式错误，已保留原文' } };
  }

  // 安全网③：确实精简了（否则不误报为可用建议，但改写本身可信，仍展示让用户自己判断）
  const charsAfter = countBodyChars(suggested);
  if (charsBefore - charsAfter < minReduction) {
    return { suggested, charsBefore, charsAfter, skipped: false, safety: { ok: false, atomsPreserved: true, formulaClean: true, reason: '改写后正文未见明显缩短' } };
  }

  return { suggested, charsBefore, charsAfter, skipped: false, safety: { ok: true, atomsPreserved: true, formulaClean: true } };
}

/** 有界并发 map：最多 limit 个在飞，其余排队；保持结果与输入同序 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 批量精简一份 Markdown，一次性返回所有块的建议 + 汇总。
 * src 用原始 req.markdown（不归一化换行）——区间锚定的偏移要与前端提交时那份字符串一致，
 * 前端就按这份 snapshot 拼接回写。首行锚定对 \r\n / \n 都成立（首行不含行尾符）。
 */
export async function compressMarkdown(req: AiCompressRequest, deps: CompressDeps = {}): Promise<AiCompressResponse> {
  const chat = deps.chat ?? chatComplete;
  const src = req.markdown;
  const blocks = chunkMarkdown(src);
  const ranges = computeRanges(src, blocks);
  const wanted = req.blockIds ? new Set(req.blockIds) : null;
  const minReduction = req.options?.minReductionChars ?? DEFAULT_MIN_REDUCTION;

  const suggestions = await mapLimit(blocks, CONCURRENCY, async (block, i): Promise<BlockSuggestion> => {
    const range = ranges[i];
    const base = { blockId: block.id, blockTitle: block.title, kind: block.kind, original: block.markdown, range };
    if (wanted && !wanted.has(block.id)) {
      const charsBefore = countBodyChars(block.markdown);
      return { ...base, suggested: block.markdown, charsBefore, charsAfter: charsBefore, skipped: true, safety: skipped('未选中') };
    }
    const outcome = await compressBlock(block, req.provider, chat, minReduction);
    return { ...base, ...outcome };
  });

  const compressed = suggestions.filter((s) => s.safety.ok).length;
  const charsBefore = suggestions.reduce((a, s) => a + s.charsBefore, 0);
  // 汇总的"精简后字数"按"接受所有 ok 建议"口径算，让用户对整体收益有个预期
  const charsAfter = suggestions.reduce((a, s) => a + (s.safety.ok ? s.charsAfter : s.charsBefore), 0);

  return {
    suggestions,
    summary: { total: suggestions.length, compressed, charsBefore, charsAfter },
  };
}

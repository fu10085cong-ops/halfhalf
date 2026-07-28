/**
 * ⓪ AI 结构化入口（DESIGN.md）：任意粘贴材料（Word 文本/课件/聊天记录）→ 标准 .md。
 *
 * 与 ① 精简（ai-compress）的分工：这里只管"从生料到合法输入"（格式劳动），
 * 不做语义压缩——两步不合并，否则安全网无法区分"结构调整"与"内容丢失"。
 *
 * key 策略：服务器统一 key（env HALFHALF_AI_ENDPOINT/MODEL/KEY，部署者自有，
 * 端点受信任、不走 BYOK 白名单）+ 前端 BYOK 覆盖（走白名单校验）。
 *
 * 质量闸：产物过 checkStructure（切块 + 巨块 + 公式预检，纯离线毫秒级），
 * 不合格自动带体检结论追问一轮（最多一轮，防循环烧钱）。
 */
import type { AiProviderConfig } from '../types/index.js';
import { chatCompleteStream, type ChatMessage, type ChatStreamOptions } from './ai-provider.js';
import { chunkMarkdown } from './chunk-markdown.js';
import { precheckFormulas } from './precheck-formulas.js';

/**
 * 格式契约的唯一权威在 docs/FORMAT.md——本提示词、下方 checkStructure、chunkMarkdown
 * 三处都对齐它;改格式先改文档再同步这里。
 * 结构约束与切块器对齐:每 ## 节 ≤800 字 = chunkMarkdown 默认 maxBlockChars,
 * 保证 AI 产出的节直接就是健康的排版原子粒度。
 */
export const STRUCTURIZE_SYSTEM_PROMPT = `你是 HalfHalf 的材料结构化助手。用户会粘贴任意形态的复习材料（Word 文本、课件、聊天记录、零散要点）。你的唯一任务：把它整理成标准 Markdown。只重组，不新增知识，不做语义压缩。

格式规范：
1. 用一个 # 总标题、若干 ## 分节；每个 ## 节的正文不超过 800 字，内容多就多分几节（可用 ### 细分）。标题一律用 # 井号写法，禁止在文字下面画 --- 或 === 当标题。
2. 数学公式一律用 $...$（行内）或 $$...$$（独立成行）的 LaTeX；禁止用 Unicode 上下标字符（x²、H₂O 这类）拼公式。
3. 表格一律用 GFM 管道表格（| 表头 | … |，第二行 |---|---|）。输入里"空格对齐 + 虚线行"的伪表格（Word/Pandoc 转换的常见产物）、用空格或制表符对齐的"名称 含义"键值行，都必须转成管道表格——它们不转的话在排版里会塌成一团文字。代码用 \`\`\` 围栏并标语言。
4. 允许的元素只有：标题、段落、有序/无序列表（嵌套最多两层）、粗体/斜体、行内代码、围栏代码、管道表格、LaTeX 公式、独立成行的图片、引用块（仅原文自带的提示语）。**禁止**：超链接（这是要印在纸上的，去掉链接语法只保留文字）、分隔线 ---、内联 HTML 标签、脚注、任务列表、删除线。
5. 保真红线：原文里的公式、数字、定义、结论一个不丢、一个不改；删掉的只能是与知识无关的噪音（页眉页脚、"如下图所示"、乱码、重复内容）。
6. 只输出 Markdown 正文本身：不要解释你做了什么，不要把整个文档包进代码围栏。

禁止：回答题目、生成题库或答案、补充用户材料里没有的知识。`;

export interface StructurizeCheck {
  ok: boolean;
  /** 人话问题清单（也是追问 AI 的修正依据） */
  problems: string[];
  blockCount: number;
}

/** 切块后单块超过它就算"巨型块"——2× maxBlockChars：细分仍超说明 AI 根本没分节 */
const GIANT_BLOCK_CHARS = 1600;

/** 结构体检：不开浏览器，毫秒级。既是质量闸也是追问 AI 时的修正说明。 */
export async function checkStructure(markdown: string): Promise<StructurizeCheck> {
  if (markdown.trim() === '') {
    return { ok: false, problems: ['输出为空'], blockCount: 0 };
  }
  const problems: string[] = [];
  if (!/^#{1,2} /m.test(markdown)) {
    problems.push('没有任何 #/## 标题——必须按主题分节');
  }
  const blocks = chunkMarkdown(markdown);
  const giants = blocks.filter((b) => b.kind === 'text' && b.markdown.length > GIANT_BLOCK_CHARS);
  if (giants.length > 0) {
    const example = giants[0].title || giants[0].id;
    problems.push(
      `有 ${giants.length} 个超过 ${GIANT_BLOCK_CHARS} 字仍无法细分的巨型段落（如「${example}」）——每个 ## 节控制在 800 字内，内容多就多分节`
    );
  }
  // Pandoc 伪表格残留（≥2 段虚线用空格隔开的分隔行，如 "------ ----------"）：
  // markdown-it 不认它，排版时整张表塌成一团文字（真材料 db-systems 判例——
  // 20+ 张表全灭）。围栏内的横线是代码内容，先摘掉再扫。
  const noFence = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
  const pandocDividers = noFence.split('\n').filter((l) => /^\s*-{3,}(\s+-{3,})+\s*$/.test(l));
  if (pandocDividers.length > 0) {
    problems.push(
      `有 ${pandocDividers.length} 处"空格对齐 + 虚线"的伪表格（Pandoc/Word 转换残留）——必须转成 GFM 管道表格（| 列 | 列 |，第二行 |---|---|），否则排版时会塌成一团文字`
    );
  }
  const formulaIssues = await precheckFormulas(blocks);
  if (formulaIssues.length > 0) {
    const samples = formulaIssues.slice(0, 3).map((i) => i.message).join('；');
    problems.push(`有 ${formulaIssues.length} 处公式无法渲染（KaTeX）：${samples}`);
  }
  problems.push(...checkElementWhitelist(markdown));
  return { ok: problems.length === 0, problems, blockCount: blocks.length };
}

/** 白名单扫描前把"非散文"内容抹掉:围栏/行内代码按代码对待,公式里的 <、^ 是数学 */
function maskNonProse(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

/** Unicode 上下标字符(公式必须走 LaTeX,这些字符字体覆盖不稳、KaTeX 管不着) */
const UNICODE_SUPSUB = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼ⁿⁱ₀₁₂₃₄₅₆₇₈₉₊₋ₐₑₓₙₘ]/gu;
/** 超链接:[文字](http…) 与 <http…> 自动链接;(?<!!) 放过图片 ![alt](http…) */
const MD_LINK = /(?<!!)\[[^\]\n]*\]\(\s*https?:\/\/[^)]*\)|<https?:\/\/[^>\s]+>/g;
/** 整行分隔线或 setext 下划线(三个以上的横线、星号或下划线):FORMAT.md 禁用,标题一律 ATX */
const DIVIDER_LINE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
/** 裸 HTML 标签(不带属性的常见泄漏形态)。刻意不匹配带属性写法——
 *  "若 a<b 且 c>d" 这类比较符散文会被宽泛正则误伤,窄匹配零误报优先 */
const BARE_HTML_TAG = /<\/?(?:br|hr|b|i|u|em|strong|p|div|span|sub|sup|table|tr|td|th|ul|ol|li|img|a|code|pre|center|font)\s*\/?>/i;

/**
 * 元素封闭子集体检(docs/FORMAT.md §2):白名单外的元素明确拒绝。
 * 全部是毫秒级正则;只查能零误报判定的——键值行伪表格等模糊形态仍靠提示词约束。
 */
function checkElementWhitelist(markdown: string): string[] {
  const problems: string[] = [];
  const prose = maskNonProse(markdown);

  // 追问必须逐处点名带上下文——实测只给一个示例时,模型只修被点名的那处
  const supsubSites: string[] = [];
  for (const m of prose.matchAll(UNICODE_SUPSUB)) {
    const at = m.index ?? 0;
    const context = prose.slice(Math.max(0, at - 6), at + 7).replace(/\s+/g, ' ').trim();
    if (!supsubSites.includes(context)) supsubSites.push(context);
    if (supsubSites.length >= 5) break;
  }
  if (supsubSites.length > 0) {
    problems.push(
      `有 Unicode 上下标字符,逐处改写成 $...$ 的 LaTeX(如 x² 写成 $x^2$、H₂O 写成 $H_2O$):${supsubSites.map((s) => `「${s}」`).join('、')}`
    );
  }
  const links = prose.match(MD_LINK);
  if (links) {
    problems.push(
      `有 ${links.length} 处超链接——这是要印在纸上的，去掉链接语法只保留文字`
    );
  }
  const dividers = prose.split('\n').filter((l) => DIVIDER_LINE.test(l));
  if (dividers.length > 0) {
    problems.push(
      `有 ${dividers.length} 处分隔线或下划线式标题（---/***/___）——标题一律用 # 井号，分隔线删掉`
    );
  }
  const htmlTag = prose.match(BARE_HTML_TAG);
  if (htmlTag) {
    problems.push(
      `出现内联 HTML 标签（如「${htmlTag[0]}」）——排版不支持 HTML，上下标用 LaTeX、换行用空行`
    );
  }
  return problems;
}

/** AI 常把整个文档包进 \`\`\`markdown 围栏——剥掉最外层（只在首尾恰好成对时） */
export function stripOuterFence(md: string): string {
  const t = md.trim();
  const m = t.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  return m ? m[1] : t;
}

/** 服务器统一 key（三个 env 齐全才算配置了）；端点是部署者自有的，受信任 */
export function resolveServerProvider(): AiProviderConfig | null {
  const endpoint = process.env.HALFHALF_AI_ENDPOINT;
  const model = process.env.HALFHALF_AI_MODEL;
  const key = process.env.HALFHALF_AI_KEY;
  if (!endpoint || !model || !key) return null;
  return { endpoint, model, headers: { Authorization: `Bearer ${key}` } };
}

export interface StructurizeEvents {
  /** 流式片段（attempt: 1=首轮, 2=体检不过后的修正轮——前端换轮时应清空缓冲重新累积） */
  onDelta: (text: string, attempt: number) => void;
  /** 首轮体检不过、即将追问修正时通知（带问题清单） */
  onRetry: (problems: string[]) => void;
}

export interface StructurizeResult {
  markdown: string;
  /** 最终一轮的体检结论；ok=false 也照常返回（前端提示"结构可能欠佳"，让用户决定） */
  check: StructurizeCheck;
  attempts: number;
}

/** 流式调用函数的形状（单元测试注入假实现，不花 token） */
export type StreamFn = (
  provider: AiProviderConfig,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  options?: ChatStreamOptions,
) => Promise<string>;

export async function structurize(
  content: string,
  provider: AiProviderConfig,
  events: StructurizeEvents,
  opts?: { trustEndpoint?: boolean; streamFn?: StreamFn },
): Promise<StructurizeResult> {
  const stream = opts?.streamFn ?? chatCompleteStream;
  const streamOpts: ChatStreamOptions = { trustEndpoint: opts?.trustEndpoint };

  const messages: ChatMessage[] = [
    { role: 'system', content: STRUCTURIZE_SYSTEM_PROMPT },
    { role: 'user', content },
  ];
  let markdown = stripOuterFence(
    await stream(provider, messages, (d) => events.onDelta(d, 1), streamOpts)
  );
  let check = await checkStructure(markdown);
  let attempts = 1;

  if (!check.ok) {
    events.onRetry(check.problems);
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: markdown },
      {
        role: 'user',
        content: `你的输出未通过结构体检：\n- ${check.problems.join('\n- ')}\n请修正以上问题后重新输出完整的 Markdown，仍然只输出 Markdown 正文本身。`,
      },
    ];
    markdown = stripOuterFence(
      await stream(provider, retryMessages, (d) => events.onDelta(d, 2), streamOpts)
    );
    check = await checkStructure(markdown);
    attempts = 2;
  }

  return { markdown, check, attempts };
}

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
4. 允许的元素只有：标题、段落、有序/无序列表（嵌套最多两层）、粗体/斜体、行内代码、围栏代码、管道表格、LaTeX 公式、独立成行的图片、引用块（仅原文自带的提示语）。**禁止**：超链接（这是要印在纸上的，去掉链接语法只保留文字）、分隔线 ---、内联 HTML 标签、脚注、任务列表、删除线。（第 7 条那一行 HTML 注释是唯一例外。）
5. 保真红线：原文里的公式、数字、定义、结论一个不丢、一个不改；删掉的只能是与知识无关的噪音（页眉页脚、"如下图所示"、乱码、重复内容）。
6. 只输出 Markdown 正文本身：不要解释你做了什么，不要把整个文档包进代码围栏。
7. 顺序判据：如果这份材料的**先后次序本身承载信息**，就在输出的第一行原样写上这一行，然后空一行再写正文：
<!-- halfhalf:source-order=strict -->
判定标准（命中任意一条就算）：章节带连续编号（一二三 / 1.2.3. / 第N章）；内容是步骤、流程、算法或推导，打乱了就读不通；后文明确依赖前文的定义或结论。
反过来，并列罗列的知识点、术语表、要点卡片、互不依赖的条目——次序换了照样读，**不要**写这一行。
拿不准就不写：漏判只是版面顺序可能被优化调整，误判会让整份材料的字号变小。
除这一行外，不要输出任何其他 HTML 注释。

禁止：回答题目、生成题库或答案、补充用户材料里没有的知识。`;

export interface StructurizeCheck {
  ok: boolean;
  /** 人话问题清单（也是追问 AI 的修正依据） */
  problems: string[];
  blockCount: number;
  /**
   * true = 检出**疑似新增知识**（保真红线），而非单纯的结构瑕疵。
   * 两者在界面上必须区别对待：结构差只是版面欠佳，知识被添加会被用户当成自己的笔记
   * 打印进考场。
   */
  fabricationSuspected?: boolean;
}

/**
 * 散文载荷字数：剥掉公式/代码/表格分隔行后只数中文字符。
 *
 * **为什么不数全部字符**（2026-07-30 实测判例）：结构化的本职之一是把 Unicode 公式
 * 转成 LaTeX，`∫` → `\int` 一个符号变四五个拉丁字符。按全字符算，`slides-calculus`
 * 这份**产出完美**的材料膨胀率报 1.45，是最接近阈值的假阳性；换成只数公式区外的中文，
 * 它降到 0.96，六份材料的区间从 0.93~1.45 收窄到 0.87~1.05。
 */
export function prosePayload(markdown: string): number {
  const prose = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s*\|[-:| ]+\|\s*$/gm, ' ');
  return (prose.match(/[一-鿿]/g) ?? []).length;
}

/**
 * 编造检测（保真红线的确定性判据，2026-07-30 立）。
 *
 * 判例：输入 18 字「死锁四条件 互斥 占有并等待 不可剥夺 循环等待」，产出 ~160 字中文，
 * 把四个条件各自的定义**整段编了出来**，两次复跑都编。内容本身是对的操作系统知识，
 * 所以更危险——用户会把 AI 替他写的话当成自己的笔记带进考场。
 * 提示词里早就写着「只重组，不新增知识」和「禁止：补充用户材料里没有的知识」，**没管住**。
 *
 * 判据 `出 > 入 * 1.5 + 40`，一个式子同时罩住三种情况（实测数据见 RULES.md §4.15）：
 * - 六份评测材料膨胀率 0.87~1.05，最紧的 `pandoc-db`（入 270 出 284）离上界还有 36%；
 * - 18 字编造案（入 20 出 160，上界 70）被抓到；
 * - **纯公式无散文**的材料（入 0 出 33，全是「标准形式」这类结构标签）被放行——
 *   常数项 40 就是为它留的，纯比率会误杀。
 *
 * **已知局限**：它测的是总量。长文档里加一两句（入 500 出 600，上界 790）抓不到。
 * 互补指标是「新颖 4-gram 率」，但实测正常区间 2~50%（chatlog 类材料被大幅重写属正常），
 * 离编造案的 93% 太近，当门禁会误报——故只进 L3 当观察值，不当闸。
 */
export function checkFabrication(input: string, output: string): string[] {
  const ci = prosePayload(input);
  const co = prosePayload(output);
  if (co <= ci * 1.5 + 40) return [];
  return [
    `疑似新增了原文没有的内容：原文散文 ${ci} 字，产出 ${co} 字。` +
      `结构化只重组、不补充知识，请删掉原文里找不到依据的解释与举例`,
  ];
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
/**
 * 行内混排的 `$$`:FORMAT.md 规定块级公式必须**独立成行**,而渲染器(markdown-it-katex
 * 的 math_block)也只认独立成行的形态——`能量关系：$$E = mc^2$$` 会被整段当普通文字,
 * `$$` 原样印进小抄。
 *
 * **这是闸与渲染器判断不一致的第二例**(2026-07-30,Docker 冒烟验证时目检发现):
 * precheckFormulas 扫 `$$...$$` 拿到 `E = mc^2`、KaTeX 渲染通过 → 判"公式干净",
 * 而渲染器根本没把它当公式。今早修的那例方向相反(渲染器显红字而预检不认)。
 * 两例的共同教训:**任何"判据与渲染器各自解析同一段文本"的地方都要对齐**。
 */
const INLINE_DISPLAY_MATH = /^(?!\s*\$\$[^$]*\$\$\s*$).*\S\s*\$\$[^$\n]*\$\$/;

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
  const inlineDisplay = markdown
    .split('\n')
    .filter((l) => INLINE_DISPLAY_MATH.test(l))
    .slice(0, 3);
  if (inlineDisplay.length > 0) {
    problems.push(
      `有 ${inlineDisplay.length} 处 $$...$$ 和文字写在同一行——块级公式必须独立成行` +
        `（前后各空一行），否则渲染时不认公式、$$ 会原样印出来。` +
        `想放在句子里就用单个 $ 的行内公式：${inlineDisplay.map((l) => `「${l.trim().slice(0, 30)}」`).join('、')}`
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

/**
 * 严格源序标记（FORMAT.md §6 内部方言）。structurize 判定材料"先后次序承载信息"时
 * 写在输出首行，`/api/scene` 据此关掉 repack/backfill 保住阅读顺序。
 *
 * 为什么走 Markdown 里的注释而不是独立字段：多份材料拼接时**任一份带标记即整体保序**
 * 是免费得到的，而且标记跟着材料走——「存为新材料」「写回」「用户复制到别处」都不会丢。
 */
export const STRICT_ORDER_MARK = '<!-- halfhalf:source-order=strict -->';
export const STRICT_ORDER_RE = /<!--\s*halfhalf:source-order=strict\s*-->/;

export function hasStrictSourceOrder(markdown: string): boolean {
  return STRICT_ORDER_RE.test(markdown);
}

/** AI 常把整个文档包进 \`\`\`markdown 围栏——剥掉最外层（只在首尾恰好成对时） */
export function stripOuterFence(md: string): string {
  const t = md.trim();
  const m = t.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  return m ? m[1] : t;
}

/** 服务器统一 key（三个 env 齐全才算配置了）；端点是部署者自有的，受信任 */
/**
 * 服务器统一 key（三个 env 齐全才算配置了）；端点是部署者自有的，受信任。
 *
 * `prefix='EVAL_'` 读 `HALFHALF_EVAL_ENDPOINT/MODEL/KEY`，缺任一项回落到主组。
 * **为什么要分两组**（2026-07-30 定案，RULES.md §4.16）：应用该用强模型（质量好），
 * 而评测该**钉在最弱的支持档上**——弱模型才暴露提示词缺陷。精简恒定失效、结构化编造
 * 这两个判例都是弱模型先露出来的，换强模型会把提示词的毛病盖住。
 */
export function resolveServerProvider(prefix: 'AI_' | 'EVAL_' = 'AI_'): AiProviderConfig | null {
  const pick = (name: string) =>
    process.env[`HALFHALF_${prefix}${name}`]?.trim() || undefined;
  const endpoint = pick('ENDPOINT');
  const model = pick('MODEL');
  const key = pick('KEY');
  if (endpoint && model && key) {
    return { endpoint, model, headers: { Authorization: `Bearer ${key}` } };
  }
  // 三项不齐就整组回落，不许 endpoint 用评测组而 key 用主组这种混搭
  return prefix === 'EVAL_' ? resolveServerProvider('AI_') : null;
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
  /** 结构体检 + 编造检测合并成一次判定。后者要拿输入比对，故不并进 checkStructure */
  const fullCheck = async (md: string): Promise<StructurizeCheck> => {
    const base = await checkStructure(md);
    const fab = checkFabrication(content, md);
    return {
      ...base,
      ok: base.ok && fab.length === 0,
      problems: [...base.problems, ...fab],
      fabricationSuspected: fab.length > 0,
    };
  };

  let markdown = stripOuterFence(
    await stream(provider, messages, (d) => events.onDelta(d, 1), streamOpts)
  );
  let check = await fullCheck(markdown);
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
    check = await fullCheck(markdown);
    attempts = 2;
  }

  return { markdown, check, attempts };
}

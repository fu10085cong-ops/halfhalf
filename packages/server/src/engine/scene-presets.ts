/**
 * 场景预设：把排版引擎的调节钮（密度/留白/宽高比/缩放下限/宽度档位/策略）按学科场景
 * 打包成命名预设——"分类讨论"：内容极多的背诵型课程才需要 samples 里那种极致压缩；
 * 理科公式型课程文本量小，公式可读性优先、允许留白。
 *
 * 定位（RULES.md §三 落地后）：预设是「常见组合的命名快捷方式」，只在用户强制指定时
 * 直接使用；自动模式的参数由 rule-engine.ts 的硬约束交集推导（推荐理由 = rule trace，
 * 纯规则、无黑盒）。本文件还承担内容统计（analyzeContent）与阈值（SCENE_THRESHOLDS）。
 * 预设字段就是 GridSearchParams 的子集，引擎内核零改动。
 */
import type { Density } from '../types/index.js';
import type { PackStrategy } from './pack-blocks.js';
import type { ContentBlock } from './chunk-markdown.js';

export type SceneId = 'text-cram' | 'formula' | 'code' | 'visual' | 'balanced';

export interface ScenePreset {
  id: SceneId;
  name: string;
  /** 一句话适用场景，前端下拉框直接用 */
  description: string;
  density: Density;
  /** undefined = 网格默认（1 格宽） */
  gutterMm?: number;
  maxAspect: number;
  minScale: number;
  /** undefined = 网格默认档位（含 6 格窄档） */
  widthTiers?: number[];
  strategy: PackStrategy;
}

export const SCENE_PRESETS: Record<SceneId, ScenePreset> = {
  'text-cram': {
    id: 'text-cram',
    name: '极限文本',
    description: '内容极多的背诵型课程：极限密度、发丝线分隔、窄栏等宽，每毫米都是字',
    density: 'cram',
    gutterMm: 2,
    maxAspect: 4,
    minScale: 0.5,
    strategy: 'column-flow',
  },
  formula: {
    id: 'formula',
    name: '理科公式',
    description: '公式/推导/例题为主：公式几乎不缩小（宁可升宽档），宽卡为主，允许留白',
    density: 'normal',
    maxAspect: 1.3,
    minScale: 0.85,
    // 去掉 6 格窄档：公式的刚性宽度在窄栏里放不下，留着只会逼出缩放
    widthTiers: [8, 12, 16, 24],
    strategy: 'column-flow',
  },
  code: {
    id: 'code',
    name: '代码密集',
    description: '编程课：代码块不折行（折行会破坏缩进语义），宽度优先给代码',
    density: 'normal',
    maxAspect: 1.5,
    // 代码块是刚性原子，缩太狠就没法读；比公式略松（等宽字体在小字号下仍清晰）
    minScale: 0.75,
    // 去掉 6 格窄档：代码行在 1/4 页宽里必然折行或缩过头
    widthTiers: [8, 12, 16, 24],
    strategy: 'column-flow',
  },
  visual: {
    id: 'visual',
    name: '图文混排',
    description: '截图多的课程（半导体/电路/信号）：图片优先保原尺寸，文字紧凑绕排',
    density: 'compact',
    maxAspect: 2,
    minScale: 0.7,
    strategy: 'column-flow',
  },
  balanced: {
    id: 'balanced',
    name: '均衡默认',
    description: '内容形态均衡或吃不准时的兜底：正常密度、疏朗留白',
    density: 'normal',
    maxAspect: 2,
    minScale: 0.5,
    strategy: 'column-flow',
  },
};

export interface ContentStats {
  /** 去掉公式/代码/Markdown 标记后的正文字数 */
  charCount: number;
  /** $$..$$ 独立公式数 */
  displayFormulaCount: number;
  /** $..$ 行内公式数 */
  inlineFormulaCount: number;
  /** 独立图片块数（chunkMarkdown 的 kind==='image'） */
  imageBlockCount: number;
  /** 表格数（按分隔行 |---| 计，水平线 --- 不算） */
  tableCount: number;
  /** 围栏代码块数——代码是刚性原子（折行会破坏缩进语义），编程课的判别依据 */
  codeBlockCount: number;
  blockCount: number;
}

/**
 * 推荐阈值（可调常量）。校准判例：os-large.md → text-cram、image-test.md → visual、
 * formula-heavy.md → formula、random-topic.md → balanced。调阈值以这四个判例为准。
 *
 * ⚠️ 证据等级：以下数值全部是 ◐（方向可信、但数字未经真实材料校准，是拍的）。
 * 每个数字该不该信、怎么升级到 ●，见 RULES.md §一 图例与 §4.2——
 * 改这里的数字前先去那边对账，别绕过文档里的等级记录。
 *
 * 口径说明：
 * - formula 判别只看独立公式（$$..$$）——它才是刚性原子、需要"不缩宁升宽档"的保护；
 *   行内公式随文字换行，任何预设都排得好（random-topic 有 61 个行内公式仍是 balanced）。
 * - charCount 是剥掉公式/表格/Markdown 标记后的口径，比原始文件字数小得多
 *   （os-large 原文 ~3300 字符 → 剥后 ~1700），阈值按剥后口径定。
 */
export const SCENE_THRESHOLDS = {
  /** visual：独立图片块 ≥ 此数，或图片块占比 ≥ visualImageRatio */
  visualImageCount: 2,
  visualImageRatio: 0.15,
  /** formula：独立公式密度（个/千字）≥ 此值，且独立公式总数 ≥ formulaMinDisplay。
   *  判例：calc-monthly（微积分，5.7/千字、13 个）应命中 formula——数学课哪怕文本量大，
   *  也不能推给会把公式缩小的 cram；random-topic（4.6/千字、3 个）仍是 balanced */
  displayPer1000: 5,
  formulaMinDisplay: 4,
  /** code（RULES.md 的 H4）：代码块数 ≥ 此值。判例：sample.md（5 个代码块）应命中 code；
   *  random-topic（3 个，但以文字为主）不该被代码绑架 —— 故取 4 */
  codeMinBlocks: 4,
  /** H3 表格可读：表格数 ≥ 此值 **且** 用户声明的学科 atomRoles.table === 'core' 才触发
   *（力学层测不出"表是不是知识本体"，缺学科声明时表格按普通内容排） */
  tableMinCount: 3,
  /** text-cram：剥后正文字数 ≥ 此值 */
  cramCharCount: 1500,
} as const;

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const DISPLAY_MATH_RE = /\$\$[\s\S]*?\$\$/g;
const INLINE_MATH_RE = /\$[^$\n]+\$/g;
/**
 * 表格分隔行（`|---|---|`）：整行只由 `| - : 空白` 组成，且至少各有一个 `|` 和 `-`。
 * **管道符是关键**——老版本不要求它，把 Markdown 的水平分隔线 `---` 也算成了表格：
 * 真实材料 test.md 只有 1 张表却被报成 6 张（5 条 `---` 全被误判）。
 */
function isTableDivider(line: string): boolean {
  return /^[\s|:-]+$/.test(line) && line.includes('|') && line.includes('-');
}

export function analyzeContent(blocks: ContentBlock[]): ContentStats {
  let charCount = 0;
  let displayFormulaCount = 0;
  let inlineFormulaCount = 0;
  let tableCount = 0;
  let codeBlockCount = 0;
  let imageBlockCount = 0;

  for (const b of blocks) {
    if (b.kind === 'image') {
      imageBlockCount++;
      continue;
    }
    // 代码围栏先数再摘：代码是刚性原子，得计数；但里面的 $ / # / | 不算公式表格
    codeBlockCount += (b.markdown.match(FENCE_RE) ?? []).length;
    let text = b.markdown.replace(FENCE_RE, '');

    displayFormulaCount += (text.match(DISPLAY_MATH_RE) ?? []).length;
    text = text.replace(DISPLAY_MATH_RE, '');
    inlineFormulaCount += (text.match(INLINE_MATH_RE) ?? []).length;
    text = text.replace(INLINE_MATH_RE, '');

    // 表格按分隔行计数（一张表恰好一行 |---|---|）
    tableCount += text.split('\n').filter(isTableDivider).length;

    // 正文字数：去掉 Markdown 结构符号和空白
    charCount += text.replace(/[#*_>`|\-\s!\[\]()]/g, '').length;
  }

  return {
    charCount,
    displayFormulaCount,
    inlineFormulaCount,
    imageBlockCount,
    tableCount,
    codeBlockCount,
    blockCount: blocks.length,
  };
}

// 场景推荐已迁往 rule-engine.ts（recommendScene 保留旧签名）：
// 老的"优先级链选一个预设"被"硬约束取交集"取代——多类刚性原子并存时各自的保护
// 同时生效，不再选赢家丢其余。本文件此后只承担：统计（analyzeContent）、阈值
// （SCENE_THRESHOLDS）、命名快捷方式（SCENE_PRESETS，用户强制指定时直接用）。

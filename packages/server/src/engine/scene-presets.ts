/**
 * 场景预设：把排版引擎的调节钮（密度/留白/宽高比/缩放下限/宽度档位/策略）按学科场景
 * 打包成命名预设，并按内容特征做确定性推荐——"分类讨论"：内容极多的背诵型课程才需要
 * samples 里那种极致压缩；理科公式型课程文本量小，公式可读性优先、允许留白。
 *
 * 推荐只是建议：机制是"程序推荐 + 用户可改"，推荐理由必须说得清（纯规则，无黑盒）。
 * 预设字段就是 GridSearchParams 的子集，引擎内核零改动。
 */
import type { Density } from '../types/index.js';
import type { PackStrategy } from './pack-blocks.js';
import type { ContentBlock } from './chunk-markdown.js';

export type SceneId = 'text-cram' | 'formula' | 'visual' | 'balanced';

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
  /** 表格数（按分隔行 |---| 计） */
  tableCount: number;
  blockCount: number;
}

/**
 * 推荐阈值（可调常量）。校准判例：os-large.md → text-cram、image-test.md → visual、
 * formula-heavy.md → formula、random-topic.md → balanced。调阈值以这四个判例为准。
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
  /** text-cram：剥后正文字数 ≥ 此值 */
  cramCharCount: 1500,
} as const;

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const DISPLAY_MATH_RE = /\$\$[\s\S]*?\$\$/g;
const INLINE_MATH_RE = /\$[^$\n]+\$/g;
const TABLE_DIVIDER_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

export function analyzeContent(blocks: ContentBlock[]): ContentStats {
  let charCount = 0;
  let displayFormulaCount = 0;
  let inlineFormulaCount = 0;
  let tableCount = 0;
  let imageBlockCount = 0;

  for (const b of blocks) {
    if (b.kind === 'image') {
      imageBlockCount++;
      continue;
    }
    // 代码围栏先摘掉：里面的 $ / # / | 都不算数
    let text = b.markdown.replace(FENCE_RE, '');

    displayFormulaCount += (text.match(DISPLAY_MATH_RE) ?? []).length;
    text = text.replace(DISPLAY_MATH_RE, '');
    inlineFormulaCount += (text.match(INLINE_MATH_RE) ?? []).length;
    text = text.replace(INLINE_MATH_RE, '');

    // 表格按分隔行计数（一张表恰好一行 |---|---|）
    tableCount += text.split('\n').filter((line) => TABLE_DIVIDER_RE.test(line)).length;

    // 正文字数：去掉 Markdown 结构符号和空白
    charCount += text.replace(/[#*_>`|\-\s!\[\]()]/g, '').length;
  }

  return {
    charCount,
    displayFormulaCount,
    inlineFormulaCount,
    imageBlockCount,
    tableCount,
    blockCount: blocks.length,
  };
}

export function recommendScene(stats: ContentStats): { scene: SceneId; reason: string } {
  const t = SCENE_THRESHOLDS;

  if (
    stats.imageBlockCount >= t.visualImageCount ||
    (stats.blockCount > 0 && stats.imageBlockCount / stats.blockCount >= t.visualImageRatio)
  ) {
    return {
      scene: 'visual',
      reason: `独立图片块 ${stats.imageBlockCount} 个（占比 ${Math.round((100 * stats.imageBlockCount) / Math.max(stats.blockCount, 1))}%），图片优先保原尺寸`,
    };
  }

  const displayPer1000 =
    stats.charCount > 0 ? (stats.displayFormulaCount / stats.charCount) * 1000 : 0;
  if (displayPer1000 >= t.displayPer1000 && stats.displayFormulaCount >= t.formulaMinDisplay) {
    return {
      scene: 'formula',
      reason: `独立公式 ${stats.displayFormulaCount} 个（${displayPer1000.toFixed(0)}/千字），公式可读性优先`,
    };
  }

  if (stats.charCount >= t.cramCharCount) {
    return {
      scene: 'text-cram',
      reason: `正文约 ${stats.charCount} 字（阈值 ${t.cramCharCount}），大文本走极限密度`,
    };
  }

  return {
    scene: 'balanced',
    reason: `正文约 ${stats.charCount} 字、独立公式 ${stats.displayFormulaCount} 个、图片 ${stats.imageBlockCount} 块，形态均衡`,
  };
}

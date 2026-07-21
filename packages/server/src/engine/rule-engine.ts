/**
 * 规则引擎（RULES.md §三 决策流程的落地）：
 * 力学特征 → 硬约束逐条钳制取交集（可行域）→ 软偏好在可行域内择优 → 参数 + rule trace。
 *
 * 与 scene-presets 的关系：预设降级为「常见组合的命名快捷方式」——用户强制指定预设时
 * 直接用预设参数；自动模式走本引擎。区别在多类刚性原子并存的材料：老的优先级链
 * 选一个预设当赢家、其余诉求整体丢弃（"图+公式"命中公式档后图片只拿到一句警告）；
 * 交集则同时成立——minScale 下界取 max、密度上界取 min、窄档削除取并，互不排挤。
 *
 * 交集为空：以当前约束词汇表不可能发生——minScale 只有下界、密度只有上界（往紧不限）、
 * 档位只削窄档，各参数的界全部同向。等将来出现反向界（如某约束要求"密度不得紧过
 * normal"）时，按 RULES.md §1.4 的 H1 > H4 > H3 > H2 放宽最低优先级并警告。
 *
 * rule trace：每条触发的规则记一笔账，前端"推荐理由"由 trace 派生，
 * 替代过去与实际参数脱节的手拼 reason 字符串。
 */
import type { Density } from '../types/index.js';
import type { PackStrategy } from './pack-blocks.js';
import {
  SCENE_THRESHOLDS,
  type ContentStats,
  type SceneId,
} from './scene-presets.js';
import { GRID_DEFAULTS } from './grid-layout.js';
import type { SubjectRule } from './subject-rules.js';

export interface RuleTraceEntry {
  /** RULES.md 的规则编号（H=硬约束，S=软偏好） */
  rule: 'H1' | 'H2' | 'H3' | 'H4' | 'S1' | 'S2' | 'S3';
  kind: 'hard' | 'soft';
  /** 人话：触发条件 + 实际钳制/选择 */
  detail: string;
}

/** 引擎参数的完整集合（GridSearchParams 的场景相关子集） */
export interface DerivedLayoutParams {
  density: Density;
  minScale: number;
  maxAspect: number;
  gutterMm?: number;
  widthTiers?: number[];
  strategy: PackStrategy;
  backfill: boolean;
}

export interface RuleOutcome {
  params: DerivedLayoutParams;
  trace: RuleTraceEntry[];
  reason: string;
  /** 多类刚性原子并存时的提示：交集已同时保护，但空间必然更挤 */
  warning?: string;
  /** 最接近的预设：前端展示、"用户可改"下拉框的默认项 */
  sceneEquivalent: SceneId;
}

/** 密度由紧到松的全序——硬约束的"密度上界"（≤ 某档）按此索引取 min */
const DENSITY_ORDER: readonly Density[] = ['cram', 'compact', 'normal', 'loose'];

export function deriveLayoutParams(
  stats: ContentStats,
  opts: {
    allowReorder?: boolean;
    /** 用户声明的学科（学科层补充特征来源；识别建议不算声明，见 subject-rules.ts） */
    subject?: SubjectRule;
  } = {}
): RuleOutcome {
  const t = SCENE_THRESHOLDS;
  const trace: RuleTraceEntry[] = [];

  const displayPer1000 =
    stats.charCount > 0 ? (stats.displayFormulaCount / stats.charCount) * 1000 : 0;
  const formulaHeavy =
    displayPer1000 >= t.displayPer1000 && stats.displayFormulaCount >= t.formulaMinDisplay;
  const codeHeavy = stats.codeBlockCount >= t.codeMinBlocks;
  const imageHeavy =
    stats.imageBlockCount >= t.visualImageCount ||
    (stats.blockCount > 0 && stats.imageBlockCount / stats.blockCount >= t.visualImageRatio);
  const bigText = stats.charCount >= t.cramCharCount;

  // ── 可行域（初始 = 引擎默认的全开区间），硬约束只收紧不放松 ──
  let minScaleLB = 0.5;
  let minTier = 0; // 宽度档位下限（格）；0 = 保留全部默认档
  let densityMaxIdx = DENSITY_ORDER.length - 1; // 密度上界（最松允许到哪）

  if (formulaHeavy) {
    minScaleLB = Math.max(minScaleLB, 0.85);
    minTier = Math.max(minTier, 8);
    trace.push({
      rule: 'H1',
      kind: 'hard',
      detail: `独立公式 ${stats.displayFormulaCount} 个（${displayPer1000.toFixed(0)}/千字）→ 缩放下限 ≥0.85、去掉 <8 格窄档`,
    });
  }
  if (codeHeavy) {
    minScaleLB = Math.max(minScaleLB, 0.75);
    minTier = Math.max(minTier, 8);
    trace.push({
      rule: 'H4',
      kind: 'hard',
      detail: `代码块 ${stats.codeBlockCount} 个 → 缩放下限 ≥0.75、去掉 <8 格窄档（折行毁缩进语义）`,
    });
  }
  if (imageHeavy) {
    // minScale 0.7 沿用 visual 预设的先例（RULES.md §1.4 H2 行已同步）
    minScaleLB = Math.max(minScaleLB, 0.7);
    densityMaxIdx = Math.min(densityMaxIdx, DENSITY_ORDER.indexOf('compact'));
    trace.push({
      rule: 'H2',
      kind: 'hard',
      detail: `图片 ${stats.imageBlockCount} 块（占比 ${Math.round((100 * stats.imageBlockCount) / Math.max(stats.blockCount, 1))}%）→ 密度 ≤compact 给图让位、缩放下限 ≥0.7`,
    });
  }
  // H3 表格可读：力学层测不出"表是不是知识本体"，由学科层 atomRoles 判定
  //（用户声明学科且该学科表=core 才触发——政治课的表是 support，缩了还能看，不触发）
  if (opts.subject?.atomRoles?.table === 'core' && stats.tableCount >= t.tableMinCount) {
    minScaleLB = Math.max(minScaleLB, 0.7);
    trace.push({
      rule: 'H3',
      kind: 'hard',
      detail: `表格 ${stats.tableCount} 张且学科「${opts.subject.name}」的表是考点本体 → 缩放下限 ≥0.7`,
    });
  }

  const hardCount = trace.length;

  // ── 软偏好：在可行域内择优 ──
  // S1 密度优先：柔性量大且无任何刚性原子保护介入时才走极限密度
  //（有硬约束在场说明刚性原子多，cram 的行高/窄栏会挤压它们）
  let densityTarget: Density = 'normal';
  let gutterMm: number | undefined;
  let maxAspect: number = GRID_DEFAULTS.maxAspect;
  let sceneEquivalent: SceneId = 'balanced';

  if (hardCount === 0 && bigText) {
    densityTarget = 'cram';
    gutterMm = 2;
    maxAspect = 4;
    sceneEquivalent = 'text-cram';
    // 理由必须诚实：材料里可能有不少刚性原子、只是没过保护线（真实判例 poli-econ：
    // 32 个公式但 4.9/千字差 0.1 没触发 H1）——不写出来会显得推荐器瞎
    const nearMiss: string[] = [];
    if (stats.displayFormulaCount > 0) {
      const per1000 = stats.charCount > 0 ? (stats.displayFormulaCount / stats.charCount) * 1000 : 0;
      nearMiss.push(`独立公式 ${stats.displayFormulaCount} 个（${per1000.toFixed(1)}/千字，保护线 ${t.displayPer1000}）`);
    }
    if (stats.tableCount > 0) nearMiss.push(`表格 ${stats.tableCount} 张`);
    trace.push({
      rule: 'S1',
      kind: 'soft',
      detail:
        `正文约 ${stats.charCount} 字（阈值 ${t.cramCharCount}）→ 极限密度、留白 2mm` +
        (nearMiss.length ? `；含${nearMiss.join('、')}，均未达保护线，密度按大文本优先` : ''),
    });
  } else if (formulaHeavy) {
    maxAspect = 1.3;
    sceneEquivalent = 'formula';
  } else if (codeHeavy) {
    maxAspect = 1.5;
    sceneEquivalent = 'code';
  } else if (imageHeavy) {
    sceneEquivalent = 'visual';
  } else {
    trace.push({
      rule: 'S3',
      kind: 'soft',
      detail: `正文约 ${stats.charCount} 字、无刚性原子密集 → 正常密度、疏朗留白`,
    });
  }

  // 密度 = min(目标, 硬约束上界)——上界只会把 normal 压到 compact，不会把 cram 放松
  const densityIdx = Math.min(DENSITY_ORDER.indexOf(densityTarget), densityMaxIdx);
  const density = DENSITY_ORDER[densityIdx];

  // S2 乱序换密度：顺序刚性弱才允许——来源是用户直接声明，或用户声明的学科顺序弱
  const subjectWeakOrder = opts.subject?.orderRigidity === 'weak';
  const backfill = opts.allowReorder === true || subjectWeakOrder;
  if (backfill) {
    trace.push({
      rule: 'S2',
      kind: 'soft',
      detail: `${
        opts.allowReorder ? '用户声明内容可乱序' : `学科「${opts.subject!.name}」顺序刚性弱`
      } → 开启跨页回填（后面的块可填进前面页的缺口换密度）`,
    });
  }

  const widthTiers =
    minTier > 0 ? GRID_DEFAULTS.widthTiers.filter((w) => w >= minTier) : undefined;

  const reason =
    trace
      .filter((e) => e.kind === 'hard')
      .map((e) => e.detail)
      .join('；') ||
    trace.map((e) => e.detail).join('；') ||
    '形态均衡，走默认参数';

  // 多类刚性原子并存：交集已同时保护（不再静默丢弃），但空间必然更挤，仍要让用户知道
  const hardNames: Record<string, string> = { H1: '公式', H4: '代码', H3: '表格', H2: '图片' };
  const warning =
    hardCount >= 2
      ? `材料同时含${trace
          .filter((e) => e.kind === 'hard')
          .map((e) => hardNames[e.rule])
          .join('、')}多类刚性原子，保护已同时生效（参数取交集），空间更紧、字号可能偏小；可手动改选场景放弃某类保护`
      : undefined;

  return {
    params: {
      density,
      minScale: minScaleLB,
      maxAspect,
      gutterMm,
      widthTiers,
      strategy: 'column-flow',
      backfill,
    },
    trace,
    reason,
    warning,
    sceneEquivalent,
  };
}

/**
 * 场景推荐（规则引擎的薄包装，保持旧签名）：scene 是"最接近的预设"，
 * 供前端下拉框展示；自动模式的实际参数请直接用 deriveLayoutParams 的 params。
 */
export function recommendScene(stats: ContentStats): {
  scene: SceneId;
  reason: string;
  warning?: string;
} {
  const r = deriveLayoutParams(stats);
  return { scene: r.sceneEquivalent, reason: r.reason, warning: r.warning };
}

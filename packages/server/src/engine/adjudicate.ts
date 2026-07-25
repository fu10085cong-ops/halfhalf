/**
 * B1 模糊带双跑裁决（RULES.md §4.5）：规则引擎在公式密度模糊带内给出两套候选参数
 * （保护公式 vs 要密度），这里把两套都真跑一遍字号搜索，按**实测**裁决——
 * 静态阈值猜不出"这份材料的公式会不会被挤坏"，但测量结果里躺着答案。
 *
 * 裁决判据是**公式有效字号** = 正文字号 × 该结果里公式的最小缩放系数（formulaScale，
 * 只算 .katex-display，表格被缩不连坐）。第一版用过"绝对缩放 ≥0.85"的否决线，
 * 立刻被真判例证伪：poli-econ 在 cram 下有个宽公式缩到 ×0.78，绝对线把 cram 判出局，
 * 换来的"保护"却是 6.5pt/3 页——公式有效字号 6.5pt 还不如 cram 的 8×0.78=6.2pt 大多少，
 * 正文和页数却全赔进去。**保护必须真的买到公式可读性才算数**，所以改相对线：
 *
 *   ① 某侧公式有效字号 < 另一侧的 85%（复用 H1 的 0.85，不引入新数字）→ 该侧出局
 *   ② 幸存者比正文字号（本产品的效用函数），平比页数，再平取 primary（静态倾向）
 *
 * 真实判例（2026-07-23 催生本机制的事故）：poli-econ 经 AI 精简后密度 4.9→5.9 跨线，
 * 静态规则把它推给 formula 档、字号 8pt→6pt；双跑下 cram 公式有效字号与 formula 侧
 * 相差 <15%、正文大 2pt 且少一页 → cram 胜出，用户拿回大字号。
 */
import { searchGridFontSize, type GridSearchOutcome, type GridSearchParams } from './grid-layout.js';
import type { RuleOutcome, RuleTraceEntry } from './rule-engine.js';

/** 相对否决线：不保护侧的公式有效字号至少要达到保护侧的 85%（复用 H1 的钳制值） */
export const RELATIVE_FORMULA_FLOOR = 0.85;

/** 该结果里独立公式的最小缩放系数（没被缩/没有公式 = 1；表格不计入） */
export function minFormulaScale(outcome: Pick<GridSearchOutcome, 'best'>): number {
  let min = 1;
  for (const m of outcome.best.measurements) {
    if (m.formulaScale < min) min = m.formulaScale;
  }
  return min;
}

export interface AdjudicationCandidate {
  label: string; // 场景名，进 trace 文案
  outcome: Pick<GridSearchOutcome, 'best' | 'withinTargetPages'>;
}

export interface AdjudicationVerdict {
  winner: 'primary' | 'alternative';
  /** B1 trace 文案：两侧实测结果 + 出局/胜出原因 */
  detail: string;
}

/** 纯裁决逻辑（不碰浏览器，单测在 test/unit/adjudicate.test.ts） */
export function judgeCandidates(
  primary: AdjudicationCandidate,
  alternative: AdjudicationCandidate
): AdjudicationVerdict {
  const effOf = (c: AdjudicationCandidate) => c.outcome.best.fontSize * minFormulaScale(c.outcome);
  const effP = effOf(primary);
  const effA = effOf(alternative);
  const describe = (c: AdjudicationCandidate, eff: number) =>
    `${c.label} ${c.outcome.best.fontSize}pt/${c.outcome.best.pages}页（公式有效字号 ≈${eff.toFixed(1)}pt）`;
  const both = `${describe(primary, effP)} vs ${describe(alternative, effA)}`;

  const vetoP = effP < RELATIVE_FORMULA_FLOOR * effA;
  const vetoA = effA < RELATIVE_FORMULA_FLOOR * effP;
  if (vetoP !== vetoA) {
    const winner = vetoP ? 'alternative' : 'primary';
    const loser = vetoP ? primary : alternative;
    return {
      winner,
      detail: `${both} → ${(vetoP ? alternative : primary).label} 胜出（${loser.label} 的公式有效字号不足另一侧的 ${Math.round(RELATIVE_FORMULA_FLOOR * 100)}%，出局）`,
    };
  }
  // 公式可读性打平（差距 <15%）→ 比正文字号，平比页数
  const p = primary.outcome.best;
  const a = alternative.outcome.best;
  let winner: 'primary' | 'alternative';
  let why: string;
  if (a.fontSize !== p.fontSize) {
    winner = a.fontSize > p.fontSize ? 'alternative' : 'primary';
    why = '公式可读性打平，正文字号大者胜';
  } else if (a.pages !== p.pages) {
    winner = a.pages < p.pages ? 'alternative' : 'primary';
    why = '字号相同，页数少者胜';
  } else {
    winner = 'primary';
    why = '实测打平，保持静态倾向';
  }
  return {
    winner,
    detail: `${both} → ${winner === 'primary' ? primary.label : alternative.label} 胜出（${why}）`,
  };
}

/** 场景相关参数合入搜索参数 */
function mergeParams(
  base: Omit<GridSearchParams, 'density' | 'strategy' | 'minScale' | 'maxAspect' | 'gutterMm' | 'widthTiers' | 'backfill'>,
  r: RuleOutcome
): GridSearchParams {
  return {
    ...base,
    density: r.params.density,
    strategy: r.params.strategy,
    minScale: r.params.minScale,
    maxAspect: r.params.maxAspect,
    gutterMm: r.params.gutterMm,
    widthTiers: r.params.widthTiers ? [...r.params.widthTiers] : undefined,
    backfill: r.params.backfill,
  };
}

/**
 * 自动模式的搜索入口：无裁决请求时与 searchGridFontSize 完全等价（单跑零开销）；
 * 带内双跑并把 B1 记进胜者的 trace。返回胜者的 outcome 与（可能换边的）RuleOutcome。
 */
export async function searchAdjudicated(
  base: Parameters<typeof mergeParams>[0],
  derived: RuleOutcome
): Promise<{ outcome: GridSearchOutcome; derived: RuleOutcome }> {
  const primaryOutcome = await searchGridFontSize(mergeParams(base, derived));
  if (!derived.adjudication) return { outcome: primaryOutcome, derived };

  const alt = derived.adjudication.alternative;
  const altOutcome = await searchGridFontSize(mergeParams(base, alt));

  const verdict = judgeCandidates(
    { label: derived.sceneEquivalent, outcome: primaryOutcome },
    { label: alt.sceneEquivalent, outcome: altOutcome }
  );

  const winnerDerived = verdict.winner === 'primary' ? derived : alt;
  const winnerOutcome = verdict.winner === 'primary' ? primaryOutcome : altOutcome;
  const b1: RuleTraceEntry = {
    rule: 'B1',
    kind: 'adjudication',
    detail: `${derived.adjudication.detail}。实测：${verdict.detail}`,
  };
  return {
    outcome: winnerOutcome,
    derived: {
      ...winnerDerived,
      trace: [...winnerDerived.trace, b1],
      adjudication: undefined,
    },
  };
}

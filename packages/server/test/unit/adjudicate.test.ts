/**
 * B1 双跑裁决的纯逻辑回归（不开浏览器）：公式有效字号相对否决线、字号/页数裁决、
 * 平局保持静态倾向、表格缩放不连坐公式。
 * 双跑编排本身要开浏览器，端到端验证走 /api/scene（判例：poli-econ / poli-econ-slim）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  judgeCandidates,
  minFormulaScale,
  RELATIVE_FORMULA_FLOOR,
  type AdjudicationCandidate,
} from '../../src/engine/adjudicate.js';

/** 造一个最小候选：只需要 fontSize/pages 和每块的 (scale, formulaScale) */
function cand(
  label: string,
  fontSize: number,
  pages: number,
  ms: { scale: number; formulaScale: number }[]
): AdjudicationCandidate {
  return {
    label,
    outcome: {
      best: {
        fontSize,
        pages,
        measurements: ms.map((m, i) => ({
          id: `b${i}`,
          span: 8,
          heightPx: 100,
          scale: m.scale,
          formulaScale: m.formulaScale,
          belowMinScale: false,
        })),
        placements: [],
        oversized: [],
        cramped: [],
      },
      withinTargetPages: true,
    },
  } as AdjudicationCandidate;
}

test('相对否决：宽公式材料在 cram 下有效字号塌掉（8×0.55=4.4 < 7×0.85）→ 保护侧胜', () => {
  const formulaSide = cand('formula', 7, 2, [{ scale: 1, formulaScale: 1 }]);
  const cramSide = cand('text-cram', 8, 2, [{ scale: 0.55, formulaScale: 0.55 }]);
  const v = judgeCandidates(formulaSide, cramSide);
  assert.equal(v.winner, 'primary');
  assert.ok(v.detail.includes('出局'));
});

test('poli-econ 事故正解：cram 8×0.78=6.24 ≥ 6.5×0.85 → 不出局，正文字号大者胜', () => {
  const formulaSide = cand('formula', 6.5, 3, [{ scale: 1, formulaScale: 1 }]);
  const cramSide = cand('text-cram', 8, 2, [{ scale: 0.78, formulaScale: 0.78 }]);
  const v = judgeCandidates(formulaSide, cramSide);
  assert.equal(v.winner, 'alternative');
  assert.ok(v.detail.includes('正文字号大者胜'));
});

test('字号平 → 页数少者胜；全平 → 保持静态倾向（primary）', () => {
  const a = cand('formula', 8, 3, [{ scale: 1, formulaScale: 1 }]);
  const b = cand('text-cram', 8, 2, [{ scale: 1, formulaScale: 1 }]);
  assert.equal(judgeCandidates(a, b).winner, 'alternative');
  const c = cand('text-cram', 8, 3, [{ scale: 1, formulaScale: 1 }]);
  assert.equal(judgeCandidates(a, c).winner, 'primary');
});

test('表格被缩不连坐公式：scale 0.5 但 formulaScale 1 → 公式有效字号不受影响', () => {
  const withTable = cand('text-cram', 9, 1, [
    { scale: 0.5, formulaScale: 1 }, // 表格块：整体缩了，公式没缩
    { scale: 0.9, formulaScale: 0.9 },
  ]);
  assert.equal(minFormulaScale(withTable.outcome), 0.9);
  const protectedSide = cand('formula', 8, 2, [{ scale: 1, formulaScale: 1 }]);
  // 9×0.9=8.1 vs 8×1=8：打平（差距 <15%）→ 字号大者（cram）胜
  assert.equal(judgeCandidates(protectedSide, withTable).winner, 'alternative');
});

test('否决线常量与 H1 钳制值一致（不引入新的拍脑袋数字）', () => {
  assert.equal(RELATIVE_FORMULA_FLOOR, 0.85);
});

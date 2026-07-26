/**
 * 搜索达标判据的行为锁（isAcceptableTrial）：
 * 真实判例（2026-07-26，数据分析材料横版）——12.5pt 时工具对比表超页高、
 * Tableau 一整行被页底裁掉，老判据只看页数就把它选为最优。修复后:
 * 内容完整是达标的必要条件；唯一例外是最小字号就超高的块（字号救不了）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAcceptableTrial } from '../../src/engine/grid-layout.js';

test('页数达标 + 无超高 → 达标', () => {
  assert.equal(isAcceptableTrial({ pages: 2, oversized: [] }, 2, true), true);
});

test('页数达标但有超高截断 → 不达标（横版截表判例）', () => {
  assert.equal(isAcceptableTrial({ pages: 2, oversized: ['block-8'] }, 2, true), false);
});

test('页数超目标 → 不达标（与超高无关）', () => {
  assert.equal(isAcceptableTrial({ pages: 3, oversized: [] }, 2, true), false);
  assert.equal(isAcceptableTrial({ pages: 3, oversized: ['b'] }, 2, false), false);
});

test('最小字号就存在超高块（gate 关）→ 退回只看页数的尽力交付', () => {
  assert.equal(isAcceptableTrial({ pages: 2, oversized: ['giant-image'] }, 2, false), true);
});

// —— 满版伸展的空隙计算（computeStretchGaps）——
// 场景基线：内容区高 100mm；块按 (id, page, column, span, yMm) 摆放，高度另给。

import { computeStretchGaps } from '../../src/engine/grid-layout.js';

const H = new Map([
  ['a', 40],
  ['b', 40],
  ['c', 30],
]);

test('stretch: 触底块的空隙 = 页底减盒底；正下方有块则为 0（不入表）', () => {
  // a(0~5 格, y0 h40) 下方紧贴 b(0~5 格, y40 h40)：a 无隙;b 底下到页底剩 20
  const gaps = computeStretchGaps(
    [
      { id: 'a', page: 0, column: 0, span: 6, yMm: 0 },
      { id: 'b', page: 0, column: 0, span: 6, yMm: 40 },
    ],
    H,
    100
  );
  assert.equal(gaps.has('a'), false);
  assert.equal(gaps.get('b'), 20);
});

test('stretch: 跨多列的块取各列限制的最小值', () => {
  // c 跨 0~11 格(y0 h30)；右半 6~11 格下方 y60 处有 b → c 的极限是 60,空隙 30
  const gaps = computeStretchGaps(
    [
      { id: 'c', page: 0, column: 0, span: 12, yMm: 0 },
      { id: 'b', page: 0, column: 6, span: 6, yMm: 60 },
    ],
    H,
    100
  );
  assert.equal(gaps.get('c'), 30);
  assert.equal(gaps.get('b'), undefined); // b 底 = 60+40 = 100 = 页底,无隙不入表
});

test('stretch: 不同页/不重叠列的块互不限制', () => {
  const gaps = computeStretchGaps(
    [
      { id: 'a', page: 0, column: 0, span: 6, yMm: 0 },
      { id: 'b', page: 1, column: 0, span: 6, yMm: 0 }, // 异页
      { id: 'c', page: 0, column: 12, span: 6, yMm: 50 }, // 同页不重叠列
    ],
    H,
    100
  );
  assert.equal(gaps.get('a'), 60); // 只受页底限制
});

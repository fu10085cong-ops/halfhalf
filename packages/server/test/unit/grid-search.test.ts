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

// —— 硬疙瘩联合选档（packWithNuggetVariants）——
// 复刻真实判例的几何：高大块按默认档拼要多开一页，换宽档（变矮）后省回来。

import { packWithNuggetVariants } from '../../src/engine/grid-layout.js';
import { PX_PER_MM } from '../../src/engine/measure-blocks.js';
import type { BlockMeasurement } from '../../src/engine/measure-blocks.js';

const GEO = { columnHeightMm: 100, columnsPerPage: 24, gapMm: 0 };
const JOPTS = { geo: GEO, gutterMm: 0, strategy: 'column-flow' as const, pack: { repack: true }, minScale: 0.5 };

function meas(id: string, span: number, hMm: number, bySpanMm?: Record<number, [number, number]>): BlockMeasurement {
  const bySpan = bySpanMm
    ? Object.fromEntries(
        Object.entries(bySpanMm).map(([s, [h, scale]]) => [s, { heightPx: h * PX_PER_MM, scale, formulaScale: 1 }])
      )
    : undefined;
  return { id, span, heightPx: hMm * PX_PER_MM, scale: 1, formulaScale: 1, belowMinScale: false, bySpan };
}

test('jointSpan: 高大块换宽档后页数变少 → 采用并回报 override', () => {
  // a 通栏 50mm → t(8格,90mm) 塞不进剩余 50 → 独占第 2 页 → b 通栏又开第 3 页;
  // t 换 16 格只有 45mm,跟在 a 下面,b 第 2 页——3 页变 2 页
  const items = [
    { id: 'a', span: 24, heightMm: 50 },
    { id: 't', span: 8, heightMm: 90 },
    { id: 'b', span: 24, heightMm: 40 },
  ];
  const ms = [meas('a', 24, 50), meas('t', 8, 90, { 8: [90, 1], 16: [45, 1] }), meas('b', 24, 40)];
  const { result, overrides } = packWithNuggetVariants(items, ms, JOPTS);
  const override = overrides[0] ?? null;
  assert.equal(result.pages, 2);
  assert.equal(override?.id, 't');
  assert.equal(override?.span, 16);
});

test('jointSpan: 变体 scale 低于 minScale（缩到不可读换宽档）不采用', () => {
  const items = [
    { id: 'a', span: 24, heightMm: 50 },
    { id: 't', span: 8, heightMm: 90 },
    { id: 'b', span: 24, heightMm: 40 },
  ];
  const ms = [meas('a', 24, 50), meas('t', 8, 90, { 8: [90, 1], 16: [45, 0.4] }), meas('b', 24, 40)];
  const { result, overrides } = packWithNuggetVariants(items, ms, JOPTS);
  const override = overrides[0] ?? null;
  assert.equal(override, null);
  assert.ok(result.pages >= 3);
});

test('jointSpan: 换档不省页数（平手）→ 保持默认档不折腾', () => {
  const items = [{ id: 't', span: 8, heightMm: 60 }];
  const ms = [meas('t', 8, 60, { 8: [60, 1], 16: [30, 1] })];
  const { overrides } = packWithNuggetVariants(items, ms, JOPTS);
  const override = overrides[0] ?? null;
  assert.equal(override, null);
});

test('jointSpan: 真凶不是最高的疙瘩——高散文块占前排也轮得到表格（回归锁:候选曾只取前2漏掉真凶）', () => {
  // d1/d2 是最高的疙瘩但没有可换的宽档;t 第三高,换 16 格才是省页的真凶
  const items = [
    { id: 'd1', span: 6, heightMm: 92 },
    { id: 'd2', span: 6, heightMm: 91 },
    { id: 'a', span: 24, heightMm: 50 },
    { id: 't', span: 8, heightMm: 90 },
    { id: 'b', span: 24, heightMm: 40 },
  ];
  const ms = [
    meas('d1', 6, 92, { 6: [92, 1] }),
    meas('d2', 6, 91, { 6: [91, 1] }),
    meas('a', 24, 50),
    meas('t', 8, 90, { 8: [90, 1], 16: [45, 1] }),
    meas('b', 24, 40),
  ];
  const { result, overrides } = packWithNuggetVariants(items, ms, JOPTS);
  const override = overrides[0] ?? null;
  assert.equal(override?.id, 't');
  assert.equal(override?.span, 16);
  assert.equal(result.pages, 3); // 默认 4 页,表格换 16 格后 3 页
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

// —— 深压缩救援（站⑤⑥）——

test('深压缩救援: 缩放<0.75 的块升到"高度不增/更清晰"的宽档,页数不变差即采用;≥0.75 不动', () => {
  // tbl 在 span6 缩到 0.55(网表判例),span12 更矮更清晰;ok 块 0.80 ≥0.75 不该被碰
  const items = [
    { id: 'a', span: 12, heightMm: 50 },
    { id: 'tbl', span: 6, heightMm: 60 },
    { id: 'ok', span: 6, heightMm: 40 },
  ];
  const ms = [
    meas('a', 12, 50),
    meas('tbl', 6, 60, { 6: [60, 0.55], 12: [55, 0.98] }),
    meas('ok', 6, 40, { 6: [40, 0.8], 12: [35, 1.0] }),
  ];
  const { result, overrides } = packWithNuggetVariants(items, ms, JOPTS);
  assert.equal(result.pages, 1);
  assert.deepEqual(overrides.map((o) => ({ id: o.id, span: o.span })), [{ id: 'tbl', span: 12 }]);
});

test('深压缩救援: 升档会顶出新页时拒绝(密排材料的密度取舍不受伤)', () => {
  // 三块并排恰好占满 24 格;tbl 升 12 格后横向塞不下、纵向也无处放 → 会开新页 → 拒绝
  const items = [
    { id: 'x', span: 12, heightMm: 95 },
    { id: 'y', span: 6, heightMm: 95 },
    { id: 'tbl', span: 6, heightMm: 95 },
  ];
  const ms = [
    meas('x', 12, 95),
    meas('y', 6, 95),
    meas('tbl', 6, 95, { 6: [95, 0.5], 12: [90, 1.0] }),
  ];
  const { result, overrides } = packWithNuggetVariants(items, ms, JOPTS);
  assert.equal(result.pages, 1, '保持单页');
  assert.equal(overrides.length, 0, '救援被页数裁判否决');
  const tbl = result.placements.find((p) => p.id === 'tbl')!;
  assert.equal(tbl.span, 6, 'tbl 保持原档');
});

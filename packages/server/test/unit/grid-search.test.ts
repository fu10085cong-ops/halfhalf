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

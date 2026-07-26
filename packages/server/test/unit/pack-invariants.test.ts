/**
 * 拼装不变量回归（纯算法，不开浏览器）：
 * 随机块集 × {老行为, repack, repack+backfill, size-desc}，断言
 * ① 每块恰好落位一次 ② 同页无矩形重叠 ③ 非超高块不超页高
 * ④ 不回填的 column-flow 保持"每页成员是阅读顺序前缀"（repack 亦然）
 * ⑤ repack/backfill 的页数永不劣于老行为（补丁只能更密）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packBlocks, type PackInput, type PackGeometry } from '../../src/engine/pack-blocks.js';

const geo: PackGeometry = { columnHeightMm: 180, columnsPerPage: 24, gapMm: 0 };
const TIERS = [6, 8, 12, 16, 24];

function rnd(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function randomBlocks(r: () => number, n: number): PackInput[] {
  return Array.from({ length: n }, (_, i) => {
    const span = TIERS[Math.floor(r() * TIERS.length)];
    const heightMm = 8 + r() * (r() < 0.06 ? 220 : 150); // 少量超高块
    // 约半数块带备选窄档（洞驱动降档的输入）：窄一档 → 高一截，模拟真实 bySpan
    const alts = TIERS.filter((t) => t < span);
    const altSpans =
      alts.length > 0 && r() < 0.5
        ? alts
            .map((t) => ({ span: t, heightMm: heightMm * (span / t) * (0.8 + 0.4 * r()) }))
            .sort((a, z) => z.span - a.span)
        : undefined;
    return { id: `b${i}`, heightMm, span, altSpans };
  });
}

type Rect = { column: number; span: number; yMm: number; h: number; id: string };
function overlaps(a: Rect, b: Rect) {
  const xHit = a.column < b.column + b.span && b.column < a.column + a.span;
  const yHit = a.yMm < b.yMm + b.h - 1e-6 && b.yMm < a.yMm + a.h - 1e-6;
  return xHit && yHit;
}

test('随机压测 60 组：无丢块/无重叠/不超页高/前缀性质/补丁不劣于老行为', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = rnd(seed * 7919);
    const blocks = randomBlocks(r, 5 + Math.floor(r() * 35));
    const heights = new Map(blocks.map((b) => [b.id, b.heightMm]));

    const runs = {
      old: packBlocks(blocks, geo, 'column-flow', { repack: false, backfill: false }),
      repack: packBlocks(blocks, geo, 'column-flow', { repack: true, backfill: false }),
      backfill: packBlocks(blocks, geo, 'column-flow', { repack: true, backfill: true }),
      sizeDesc: packBlocks(blocks, geo, 'size-desc'),
    };

    for (const [name, res] of Object.entries(runs)) {
      const ids = res.placements.map((p) => p.id);
      assert.equal(ids.length, blocks.length, `seed${seed} ${name}: 落位数`);
      assert.equal(new Set(ids).size, blocks.length, `seed${seed} ${name}: 无重复落位`);

      // 降档块的有效高度 = 声明过的备选档高度；降档必须落在声明档上且与落位一致
      const effHeights = new Map(heights);
      for (const rt of res.retiered) {
        const b = blocks.find((x) => x.id === rt.id)!;
        const alt = b.altSpans?.find((a) => a.span === rt.span);
        assert.ok(alt, `seed${seed} ${name}: ${rt.id} 降到未声明的档 ${rt.span}`);
        const pl = res.placements.find((p) => p.id === rt.id)!;
        assert.equal(pl.span, rt.span, `seed${seed} ${name}: ${rt.id} 落位档与降档记录不一致`);
        effHeights.set(rt.id, alt!.heightMm);
      }

      const byPage = new Map<number, Rect[]>();
      for (const p of res.placements) {
        const h = effHeights.get(p.id)!;
        if (h <= geo.columnHeightMm) {
          assert.ok(
            p.yMm + h <= geo.columnHeightMm + 1e-6,
            `seed${seed} ${name}: ${p.id} 超页高 y=${p.yMm.toFixed(1)} h=${h.toFixed(1)}`
          );
        }
        if (!byPage.has(p.page)) byPage.set(p.page, []);
        byPage.get(p.page)!.push({ column: p.column, span: p.span, yMm: p.yMm, h, id: p.id });
      }
      for (const [pg, rects] of byPage) {
        for (let i = 0; i < rects.length; i++)
          for (let j = i + 1; j < rects.length; j++)
            assert.ok(
              !overlaps(rects[i], rects[j]),
              `seed${seed} ${name}: 页${pg} 重叠 ${rects[i].id}×${rects[j].id}`
            );
      }
    }

    // ④ 前缀性质：不回填时按输入顺序页号单调不减（repack 只挪页内位置，不破坏它）
    for (const name of ['old', 'repack'] as const) {
      const pageOf = new Map(runs[name].placements.map((p) => [p.id, p.page]));
      let last = 0;
      for (const b of blocks) {
        const pg = pageOf.get(b.id)!;
        assert.ok(pg >= last, `seed${seed} ${name}: ${b.id} 页${pg} < 前块页${last}`);
        if (pg > last) last = pg;
      }
    }

    // ⑤ 补丁只能更密
    assert.ok(runs.repack.pages <= runs.old.pages, `seed${seed}: repack 页数劣化`);
    assert.ok(runs.backfill.pages <= runs.old.pages, `seed${seed}: backfill 页数劣化`);
  }
});

test('超高块：单独占新页并显式上报，不静默丢弃', () => {
  const blocks: PackInput[] = [
    { id: 'a', heightMm: 100, span: 12 },
    { id: 'tall', heightMm: 250, span: 24 }, // 超过 180mm 页高
    { id: 'b', heightMm: 50, span: 12 },
  ];
  const res = packBlocks(blocks, geo, 'column-flow');
  assert.deepEqual(res.oversized, ['tall']);
  const tall = res.placements.find((p) => p.id === 'tall')!;
  assert.equal(tall.yMm, 0);
  assert.equal(tall.column, 0);
  assert.equal(res.placements.length, 3);
});

test('backfill：开新页后，后续窄块回填旧页缺口（老行为则跟去新页）', () => {
  // 页 1：24格×100 + 12格×80（左），剩右下 12格×80 的缺口；
  // stuck 需要 12格×81 放不下 → 开新页；filler 12格×70 应回填页 1 缺口
  const blocks: PackInput[] = [
    { id: 'wide', heightMm: 100, span: 24 },
    { id: 'left', heightMm: 80, span: 12 },
    { id: 'stuck', heightMm: 81, span: 12 },
    { id: 'filler', heightMm: 70, span: 12 },
  ];
  const noBf = packBlocks(blocks, geo, 'column-flow', { repack: false, backfill: false });
  const bf = packBlocks(blocks, geo, 'column-flow', { repack: false, backfill: true });
  const pageOf = (r: typeof bf, id: string) => r.placements.find((p) => p.id === id)!.page;
  assert.equal(pageOf(noBf, 'filler'), 1, '老行为: filler 跟去第 2 页');
  assert.equal(pageOf(bf, 'filler'), 0, 'backfill: filler 回填第 1 页');
});

test('repack 阅读序优先：标题保持页首、顺序不被高度序打散（cs 材料页 0 判例）', () => {
  // 真实判例（cs-programming 13.5pt 页 0 缩影，页高 277）：leftmost-first-fit 把
  // title、二 竖着堆进左列 → 16 格的 三 卡住 → 老 repack 只试高度序，把 三 排到
  // 标题前面（标题沉到页中）。阅读序 + best-fit 本可全装下且标题留在 (0,0)。
  const tallGeo: PackGeometry = { columnHeightMm: 277, columnsPerPage: 24, gapMm: 0 };
  const blocks: PackInput[] = [
    { id: 'title', heightMm: 133, span: 12 },
    { id: 'sec2', heightMm: 87, span: 12 },
    { id: 'sec3', heightMm: 139, span: 16 },
  ];
  const res = packBlocks(blocks, tallGeo, 'column-flow', { repack: true });
  assert.equal(res.pages, 1);
  const at = (id: string) => res.placements.find((p) => p.id === id)!;
  assert.deepEqual({ column: at('title').column, yMm: at('title').yMm }, { column: 0, yMm: 0 }, '标题钉在页首');
  assert.deepEqual({ column: at('sec2').column, yMm: at('sec2').yMm }, { column: 12, yMm: 0 }, '二 平行铺右列');
  assert.deepEqual({ column: at('sec3').column, yMm: at('sec3').yMm }, { column: 0, yMm: 133 }, '三 落标题下方');
});

test('洞驱动降档：原档装不下且换位无解时，降到备选窄档塞进本页缺口而不是开新页', () => {
  // A(16格,120) 后 C(8格,60) 被 leftmost 堆进左列（120+60=180 恰好占满）；
  // B 按 12 格任何窗口都与 A/C 重叠超页高，repack 也无解——
  // 但降到 8 格能塞进右侧 8 列的空缺（cols16-24 全空）。
  const blocks: PackInput[] = [
    { id: 'A', heightMm: 120, span: 16 },
    { id: 'C', heightMm: 60, span: 8 },
    { id: 'B', heightMm: 70, span: 12, altSpans: [{ span: 8, heightMm: 100 }] },
  ];
  const res = packBlocks(blocks, geo, 'column-flow', { repack: true });
  assert.equal(res.pages, 1, '降档后全部塞进一页');
  assert.deepEqual(res.retiered, [{ id: 'B', span: 8 }]);
  const b = res.placements.find((p) => p.id === 'B')!;
  assert.equal(b.span, 8);
  assert.equal(b.column, 16, 'B 落进右侧 8 列空缺');
  assert.equal(b.yMm, 0);
  // 不带备选档 = 老行为：B 去第 2 页
  const noAlt = packBlocks(
    blocks.map((x) => ({ ...x, altSpans: undefined })),
    geo,
    'column-flow',
    { repack: true }
  );
  assert.equal(noAlt.pages, 2, '无备选档则开新页（老行为可复现）');
});

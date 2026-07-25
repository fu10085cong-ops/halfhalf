/**
 * 拼装/参数 A/B 对比（实验第三步的一键版）：同一 fixture 同一目标页数，
 * 一次跑完 {老行为 norepack / 默认 repack / repack+乱序回填} 三种拼装变体，
 * 打印字号、页数、逐页填充率对照表——替代手写 shell 循环逐个跑再肉眼比对。
 *
 * 参数由场景解析：'auto'（默认）= 规则引擎按内容特征推导；也可指定预设 id 强制。
 *
 * 用法：
 *   npx tsx test/run-ab.ts <fixture> [targetPages=1] [scene=auto]
 *   npx tsx test/run-ab.ts poli-econ.md 2
 *   npx tsx test/run-ab.ts os-large.md 1 text-cram
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { searchGridFontSize, resolveGrid, type GridSearchParams } from '../src/engine/grid-layout.js';
import { chunkMarkdown } from '../src/engine/chunk-markdown.js';
import { analyzeContent, SCENE_PRESETS, type SceneId } from '../src/engine/scene-presets.js';
import { deriveLayoutParams } from '../src/engine/rule-engine.js';
import { closeSharedBrowser } from '../src/engine/browser-pool.js';
import { PX_PER_MM } from '../src/engine/measure-blocks.js';
import { DEFAULT_MARGINS } from '../src/types/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function main() {
  const fileName = process.argv[2];
  if (!fileName) {
    console.error('用法: npx tsx test/run-ab.ts <fixture> [targetPages=1] [scene=auto]');
    process.exitCode = 1;
    return;
  }
  const targetPages = Number(process.argv[3] || 1);
  const sceneArg = process.argv[4] || 'auto';
  const markdown = readFileSync(path.join(fixturesDir, fileName), 'utf-8');

  // 参数解析：auto 走规则引擎（与 /api/scene 同一条路），指定 id 用预设
  const derived =
    sceneArg === 'auto'
      ? deriveLayoutParams(analyzeContent(chunkMarkdown(markdown)))
      : null;
  const preset = derived ? null : SCENE_PRESETS[sceneArg as SceneId];
  if (!derived && !preset) {
    console.error(`未知场景: ${sceneArg}（可选 auto / ${Object.keys(SCENE_PRESETS).join(' / ')}）`);
    process.exitCode = 1;
    return;
  }
  const p = derived ? derived.params : preset!;
  console.log(
    `[run-ab] ${fileName} | 目标${targetPages}页 | 场景 ${derived ? `auto→${derived.sceneEquivalent}` : sceneArg}` +
      `${derived ? ` [${derived.trace.map((e) => e.rule).join(',') || '默认'}]` : ''}`
  );

  const base: GridSearchParams = {
    markdown,
    targetPages,
    paperSize: 'A4',
    orientation: 'portrait',
    margins: DEFAULT_MARGINS,
    density: p.density,
    strategy: 'column-flow',
    minScale: p.minScale,
    maxAspect: p.maxAspect,
    gutterMm: p.gutterMm,
    widthTiers: p.widthTiers ? [...p.widthTiers] : undefined,
    imageBaseDir: fixturesDir,
  };

  const variants: { name: string; repack?: boolean; backfill?: boolean }[] = [
    { name: '老行为(norepack)', repack: false },
    { name: '默认(repack)   ' },
    { name: '+乱序回填      ', backfill: true },
  ];

  const { grid, contentHMm } = resolveGrid(base);
  const pageArea = grid.unitsX * grid.unitMm * contentHMm;

  for (const v of variants) {
    const outcome = await searchGridFontSize({ ...base, repack: v.repack, backfill: v.backfill });
    const { best } = outcome;
    // 逐页填充率 = 该页所有盒子面积（span×格宽 × 盒高）/ 页面内容区面积
    const heightById = new Map(
      best.measurements.map((m) => [m.id, m.heightPx / PX_PER_MM + grid.gutterMm])
    );
    const fill = new Array<number>(best.pages).fill(0);
    for (const pl of best.placements) {
      fill[pl.page] += pl.span * grid.unitMm * (heightById.get(pl.id) ?? 0);
    }
    const fillStr = fill.map((a, i) => `p${i + 1} ${Math.round((100 * a) / pageArea)}%`).join(' ');
    console.log(
      `[run-ab] ${v.name} ${String(best.fontSize).padStart(4)}pt · ${best.pages}页` +
        `${outcome.withinTargetPages ? '' : '（未达标，兜底最少页数）'} · 填充 ${fillStr}`
    );
  }
}

main()
  .catch((err) => {
    console.error('[run-ab] 失败:', err);
    process.exitCode = 1;
  })
  .finally(() => closeSharedBrowser());

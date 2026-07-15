/**
 * 网格引擎端到端（带优化循环）：分块 → 公式预检 → [二分搜索字号：档位测量→网格拼装] → 渲染。
 * 与 run-layout 的区别：几何是 24 单位格 + 标准宽度档位 + 强制留白（gutter），
 * 块高取整到格、所有块落在格线上——编辑器拖拽吸附用同一坐标系。
 *
 * 用法：
 *   cd packages/server
 *   npx tsx test/run-grid.ts [文件名] [目标页数] [orientation] [strategy] [minScale] [maxAspect] [density] [gutterMm]
 *   maxAspect：文字块最大高宽比（默认 2）。调大 → 更多块挤窄档（趋向等宽栏）；调小 → 更多宽卡
 *   density：compact/normal/loose/cram（cram = 极限密度，分隔靠发丝线不靠留白）
 *   gutterMm：块间留白 mm（默认 1 格宽 ≈7.9；cram 建议 2~3）
 *
 * 示例：
 *   npx tsx test/run-grid.ts os-large.md 2                     # A4 竖版 24 格制，自动求最大字号
 *   npx tsx test/run-grid.ts image-test.md 1 portrait size-desc
 *   npx tsx test/run-grid.ts os-large.md 2 portrait column-flow 0.5 1.5   # 更多宽卡
 *   npx tsx test/run-grid.ts os-large.md 1 portrait column-flow 0.5 4 cram 2   # 极限密度塞 1 页
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  renderGridPdf,
  searchGridFontSize,
  type GridSearchParams,
} from '../src/engine/grid-layout.js';
import { precheckFormulas } from '../src/engine/precheck-formulas.js';
import { closeSharedBrowser } from '../src/engine/browser-pool.js';
import { PX_PER_MM } from '../src/engine/measure-blocks.js';
import { DEFAULT_MARGINS, type ResolvedOrientation } from '../src/types/index.js';
import type { PackStrategy } from '../src/engine/pack-blocks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const fileName = process.argv[2] || 'random-topic.md';
  const targetPages = Number(process.argv[3] || 1);
  const orientation = (process.argv[4] || 'portrait') as ResolvedOrientation;
  const strategy = (process.argv[5] || 'column-flow') as PackStrategy;
  const minScale = Number(process.argv[6] || 0.5);
  const maxAspect = process.argv[7] ? Number(process.argv[7]) : undefined;
  const density = (process.argv[8] || 'normal') as GridSearchParams['density'];
  const gutterMm = process.argv[9] ? Number(process.argv[9]) : undefined;
  const fixturesDir = path.join(__dirname, 'fixtures');
  const markdown = readFileSync(path.join(fixturesDir, fileName), 'utf-8');

  const params: GridSearchParams = {
    markdown,
    targetPages,
    paperSize: 'A4',
    orientation,
    margins: DEFAULT_MARGINS,
    density,
    strategy,
    minScale,
    maxAspect,
    gutterMm,
    imageBaseDir: fixturesDir,
  };

  console.log(
    `[run-grid] ${fileName} | 目标${targetPages}页 A4 ${orientation} ${strategy} minScale=${minScale}${maxAspect !== undefined ? ` maxAspect=${maxAspect}` : ''}`
  );

  const outcome = await searchGridFontSize(params, (t) =>
    console.log(`   试 ${t.fontSize}pt → ${t.pages} 页`)
  );
  const { grid, best } = outcome;
  console.log(
    `[run-grid] 网格: ${grid.unitsX}×${grid.unitsY} 格（格边长 ${grid.unitMm.toFixed(2)}mm，留白 ${grid.gutterMm.toFixed(1)}mm，宽度档位 ${grid.widthTiers.join('/')}格）`
  );

  // 公式预检（不占浏览器，纯管线干跑）
  const issues = await precheckFormulas(outcome.blocks);
  for (const issue of issues) {
    console.log(`[run-grid] ⚠️ 公式错误 @${issue.blockId}「${issue.blockTitle}」: ${issue.message}`);
  }

  console.log(`\n[run-grid] 最优字号: ${best.fontSize}pt  实际 ${best.pages} 页  达标: ${outcome.withinTargetPages}`);
  const tierNote = best.measurements
    .map((m) => {
      const hUnits = Math.ceil((m.heightPx / PX_PER_MM + grid.gutterMm) / grid.unitMm);
      return `${m.id}:${m.span}×${hUnits}格${m.scale < 1 ? `(×${m.scale.toFixed(2)})` : ''}`;
    })
    .join(' ');
  console.log(`[run-grid] 块尺寸: ${tierNote}`);
  if (best.oversized.length) console.log(`[run-grid] ⚠️ 超高块: ${best.oversized.join(', ')}`);
  if (best.cramped.length) console.log(`[run-grid] ⚠️ 缩到下限以下: ${best.cramped.join(', ')}`);

  const { pdfBuffer, pageCount } = await renderGridPdf(outcome.blocks, best.placements, grid, {
    paperSize: 'A4',
    orientation,
    margins: DEFAULT_MARGINS,
    fontSize: best.fontSize,
    density,
    imageBaseDir: fixturesDir,
  });
  const outputPath = path.join(fixturesDir, fileName.replace(/\.md$/, '.grid.pdf'));
  writeFileSync(outputPath, pdfBuffer);

  console.log(`[run-grid] 渲染完成: PDF ${pageCount} 页  输出: ${outputPath}`);
}

main()
  .catch((err) => {
    console.error('[run-grid] 失败:', err);
    process.exitCode = 1;
  })
  .finally(() => closeSharedBrowser());

/**
 * layout 引擎端到端（带优化循环）：分块 → [二分搜索字号：测量→拼装] → 渲染最优版 PDF。
 * 与 run-pack 的区别：run-pack 用固定字号拍一版；run-layout 给目标页数、自动找最大字号。
 *
 * 用法：
 *   cd packages/server
 *   npx tsx test/run-layout.ts [文件名] [目标页数] [栏数] [orientation] [strategy] [minScale]
 *
 * 示例：
 *   npx tsx test/run-layout.ts random-topic.md 1 3            # 塞进 1 页 A4 竖版 3 栏，自动求最大字号
 *   npx tsx test/run-layout.ts random-topic.md 2 3 portrait size-desc
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { searchLayoutFontSize } from '../src/engine/search-layout.js';
import { renderLayoutPdf, type LayoutRenderOptions } from '../src/engine/render-layout.js';
import { precheckFormulas } from '../src/engine/precheck-formulas.js';
import { closeSharedBrowser } from '../src/engine/browser-pool.js';
import { DEFAULT_MARGINS, type ResolvedOrientation } from '../src/types/index.js';
import type { PackStrategy } from '../src/engine/pack-blocks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const fileName = process.argv[2] || 'random-topic.md';
  const targetPages = Number(process.argv[3] || 1);
  const columnsPerPage = Number(process.argv[4] || 3);
  const orientation = (process.argv[5] || 'portrait') as ResolvedOrientation;
  const strategy = (process.argv[6] || 'column-flow') as PackStrategy;
  const minScale = Number(process.argv[7] || 0.5);
  const fixturesDir = path.join(__dirname, 'fixtures');
  const markdown = readFileSync(path.join(fixturesDir, fileName), 'utf-8');

  const columnGapMm = 5;
  const blockGapMm = 4;

  console.log(
    `[run-layout] ${fileName} | 目标${targetPages}页 A4 ${orientation} ${columnsPerPage}栏 ${strategy} minScale=${minScale}`
  );
  console.log('[run-layout] 二分搜索最大字号...');

  const outcome = await searchLayoutFontSize(
    {
      markdown,
      targetPages,
      paperSize: 'A4',
      orientation,
      margins: DEFAULT_MARGINS,
      columnsPerPage,
      columnGapMm,
      blockGapMm,
      density: 'normal',
      strategy,
      minScale,
      imageBaseDir: fixturesDir,
    },
    (t) => console.log(`   试 ${t.fontSize}pt → ${t.pages} 页`)
  );

  // 公式预检（不占浏览器，纯管线干跑）
  const issues = await precheckFormulas(outcome.blocks);
  for (const issue of issues) {
    console.log(`[run-layout] ⚠️ 公式错误 @${issue.blockId}「${issue.blockTitle}」: ${issue.message}`);
  }

  const { best } = outcome;
  console.log(`\n[run-layout] 最优字号: ${best.fontSize}pt  实际 ${best.pages} 页  达标: ${outcome.withinTargetPages}`);
  const adjusted = best.measurements
    .filter((m) => m.span > 1 || m.scale < 1)
    .map((m) => `${m.id}→${m.span}栏${m.scale < 1 ? `×${m.scale.toFixed(2)}` : ''}`)
    .join(' ');
  if (adjusted) console.log(`[run-layout] 宽内容处理: ${adjusted}`);
  if (best.oversized.length) console.log(`[run-layout] ⚠️ 超高块: ${best.oversized.join(', ')}`);
  if (best.cramped.length) console.log(`[run-layout] ⚠️ 缩到下限以下: ${best.cramped.join(', ')}`);

  const opts: LayoutRenderOptions = {
    paperSize: 'A4',
    orientation,
    margins: DEFAULT_MARGINS,
    columnsPerPage,
    columnGapMm,
    fontSize: best.fontSize,
    density: 'normal',
    imageBaseDir: fixturesDir,
  };
  const { pdfBuffer, pageCount } = await renderLayoutPdf(outcome.blocks, best.placements, opts);
  const outputPath = path.join(__dirname, 'fixtures', fileName.replace(/\.md$/, '.layout.pdf'));
  writeFileSync(outputPath, pdfBuffer);

  console.log(`[run-layout] 渲染完成: PDF ${pageCount} 页  输出: ${outputPath}`);
}

main()
  .catch((err) => {
    console.error('[run-layout] 失败:', err);
    process.exitCode = 1;
  })
  .finally(() => closeSharedBrowser());

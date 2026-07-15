/**
 * 手动验证脚本：layout 引擎端到端——分块 → 测量 → 贪心拼装 → 渲染 PDF。
 *
 * 用法：
 *   cd packages/server
 *   npx tsx test/run-pack.ts [文件名] [栏数] [字号pt] [orientation] [strategy] [minScale]
 *   minScale：宽内容（表格/公式）允许的最小等比缩放（默认 0.6），低于它才升级跨栏盒子
 *
 * 示例：
 *   npx tsx test/run-pack.ts random-topic.md 3 9                        # A4 竖版 3 栏 9pt，按序填栏
 *   npx tsx test/run-pack.ts random-topic.md 3 9 portrait size-desc    # 大块优先（更密，顺序让位）
 *   npx tsx test/run-pack.ts random-topic.md 4 8 landscape             # 横版 4 栏 8pt
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chunkMarkdown } from '../src/engine/chunk-markdown.js';
import { measureBlocks, PX_PER_MM } from '../src/engine/measure-blocks.js';
import { packBlocks, type PackStrategy } from '../src/engine/pack-blocks.js';
import { columnWidthMm, renderLayoutPdf, type LayoutRenderOptions } from '../src/engine/render-layout.js';
import { closeSharedBrowser } from '../src/engine/browser-pool.js';
import { DEFAULT_MARGINS, PAPER_SIZES, type ResolvedOrientation } from '../src/types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const fileName = process.argv[2] || 'random-topic.md';
  const columnsPerPage = Number(process.argv[3] || 3);
  const fontSize = Number(process.argv[4] || 9);
  const orientation = (process.argv[5] || 'portrait') as ResolvedOrientation;
  const strategy = (process.argv[6] || 'column-flow') as PackStrategy;

  const markdown = readFileSync(path.join(__dirname, 'fixtures', fileName), 'utf-8');

  const opts: LayoutRenderOptions = {
    paperSize: 'A4',
    orientation,
    margins: DEFAULT_MARGINS,
    columnsPerPage,
    columnGapMm: 5,
    fontSize,
    density: 'normal',
  };

  const paper = PAPER_SIZES.A4;
  const contentH =
    (orientation === 'landscape' ? paper.width : paper.height) -
    opts.margins.top -
    opts.margins.bottom;
  const colW = columnWidthMm(opts);

  console.log(
    `[run-pack] ${fileName} | A4 ${orientation} ${columnsPerPage}栏(每栏${colW.toFixed(1)}mm宽×${contentH}mm高) ${fontSize}pt ${strategy}`
  );

  // ① 分块
  const blocks = chunkMarkdown(markdown);
  console.log(`[run-pack] ① 分块: ${blocks.length} 块`);

  // ② 测量（宽内容优先等比缩小塞进窄栏，缩过可读下限才升级跨栏盒子）
  const minScale = Number(process.argv[7] || 0.5);
  const measurements = await measureBlocks(blocks, {
    columnWidthPx: colW * PX_PER_MM,
    columnGapPx: opts.columnGapMm * PX_PER_MM,
    maxSpan: columnsPerPage,
    fontSize,
    density: opts.density,
    minScale,
  });
  const adjusted = measurements
    .filter((m) => m.span > 1 || m.scale < 1)
    .map((m) => `${m.id}→${m.span}栏${m.scale < 1 ? `×${m.scale.toFixed(2)}` : ''}`)
    .join(' ');
  console.log(`[run-pack] ② 测量完成（minScale=${minScale}）${adjusted ? `\n   宽内容处理: ${adjusted}` : ''}`);
  const cramped = measurements.filter((m) => m.belowMinScale);
  if (cramped.length > 0) {
    console.log(`   ⚠️ 跨满整页仍需缩到下限以下的块: ${cramped.map((m) => `${m.id}(×${m.scale.toFixed(2)})`).join(', ')}`);
  }

  // ③ 拼装
  const packInputs = measurements.map((m) => ({
    id: m.id,
    heightMm: m.heightPx / PX_PER_MM,
    span: m.span,
  }));
  const result = packBlocks(packInputs, {
    columnHeightMm: contentH,
    columnsPerPage,
    gapMm: 4,
  }, strategy);

  console.log(`[run-pack] ③ 拼装: ${result.pages} 页`);
  result.usage.forEach((cols, page) => {
    const bars = cols
      .map((used, i) => `栏${i + 1} ${(100 * used / contentH).toFixed(0)}%`)
      .join('  ');
    console.log(`   第${page + 1}页: ${bars}`);
  });
  if (result.oversized.length > 0) {
    console.log(`   ⚠️ 超高块（超过单栏高度，会被截断）: ${result.oversized.join(', ')}`);
  }

  // ④ 渲染
  const { pdfBuffer, pageCount } = await renderLayoutPdf(blocks, result.placements, opts);
  const outputPath = path.join(__dirname, 'fixtures', fileName.replace(/\.md$/, '.pack.pdf'));
  writeFileSync(outputPath, pdfBuffer);

  console.log(`[run-pack] ④ 渲染: PDF 实际 ${pageCount} 页`);
  console.log(`[run-pack] 输出: ${outputPath}`);
}

main()
  .catch((err) => {
    console.error('[run-pack] 失败:', err);
    process.exitCode = 1;
  })
  .finally(() => closeSharedBrowser());

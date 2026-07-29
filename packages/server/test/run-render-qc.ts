/**
 * 排版栅格质检跑分器 —— **门禁型**（见 TESTING.md §3）：栅格发现空白页/贴边即 exit 1。
 *
 * 判据是绝对的、与模型无关（不调 AI，同一份 fixture 每次结果一致），所以能当硬门禁；
 * 这与 `pnpm bench` 的对账型不同——那个测版面质量趋势，这个只测"这份 PDF 有没有坏掉"。
 *
 * 用法：pnpm qc:render [fixture.md]                        默认 formula-heavy.md
 *      HALFHALF_QC_OUTPUT=/tmp/x.pdf pnpm qc:render        顺便留下 PDF 供目检
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkMarkdown } from '../src/engine/chunk-markdown.js';
import { renderGridPdf, searchGridFontSize } from '../src/engine/grid-layout.js';
import { inspectRenderedPdf } from '../src/engine/pdf-visual-qc.js';
import { closeSharedBrowser } from '../src/engine/browser-pool.js';
import { DEFAULT_MARGINS } from '../src/types/index.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureName = process.argv.slice(2).find((argument) => argument !== '--') ?? 'formula-heavy.md';
const outputPath = process.env.HALFHALF_QC_OUTPUT;
const imageBaseDir = path.join(dirname, 'fixtures');

try {
  const markdown = await readFile(path.join(imageBaseDir, fixtureName), 'utf8');
  const outcome = await searchGridFontSize({
    markdown,
    targetPages: 2,
    paperSize: 'A4',
    orientation: 'portrait',
    margins: DEFAULT_MARGINS,
    density: 'normal',
    strategy: 'column-flow',
    minScale: 0.7,
    imageBaseDir,
  });
  const rendered = await renderGridPdf(outcome.blocks, outcome.best.placements, outcome.grid, {
    paperSize: 'A4',
    orientation: 'portrait',
    margins: DEFAULT_MARGINS,
    fontSize: outcome.best.fontSize,
    density: 'normal',
    imageBaseDir,
    stretched: outcome.best.stretched,
  });
  if (outputPath) await writeFile(outputPath, rendered.pdfBuffer);
  const raster = await inspectRenderedPdf(rendered.pdfBuffer);
  console.log(
    JSON.stringify(
      {
        fixture: fixtureName,
        inputBlocks: chunkMarkdown(markdown).length,
        pages: rendered.pageCount,
        raster,
        outputPath: outputPath ?? null,
      },
      null,
      2
    )
  );
  if (!raster.available || raster.issues.length > 0) process.exitCode = 1;
} finally {
  await closeSharedBrowser();
}

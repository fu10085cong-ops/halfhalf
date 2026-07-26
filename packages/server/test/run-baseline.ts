/**
 * 对照组生成器：模拟"AI 直出文本 → 学生粘进 Word → 直接打印"。
 *
 * 不做任何 HalfHalf 的事——不分块、不搜字号、不选场景、不拼装，
 * 就是单栏 + 固定字号 + 常规行距，页数是多少算多少。存在的意义是给
 * 「同一份内容，最后一公里换个工具」提供一个诚实的基线。
 *
 * 用法：
 *   cd packages/server
 *   npx tsx test/run-baseline.ts <文件名> [字号pt] [word|narrow]
 *     word   = Word 默认页边距（上下 25.4mm / 左右 31.8mm），学生实际拿到的样子
 *     narrow = 10mm 四边（= 引擎的 DEFAULT_MARGINS），已经手动调过边距的"优待对照组"
 *
 * 示例：
 *   npx tsx test/run-baseline.ts poli-econ.md 12 word
 *   npx tsx test/run-baseline.ts poli-econ.md 12 narrow
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { markdownToHtml } from '../src/engine/md-to-html.js';
import {
  createRenderContext,
  applyTypography,
  renderPdfAndCountPages,
  closeRenderContext,
  type RenderParams,
} from '../src/engine/render-pdf.js';
import { closeSharedBrowser } from '../src/engine/browser-pool.js';
import { DEFAULT_MARGINS, type Margins } from '../src/types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Word 简体中文版 A4 默认值：上下 2.54cm、左右 3.18cm */
const WORD_MARGINS: Margins = { top: 25.4, bottom: 25.4, left: 31.8, right: 31.8 };

async function main() {
  const fileName = process.argv[2] || 'poli-econ.md';
  const fontSize = Number(process.argv[3] || 12); // Word 默认小四 = 12pt
  const marginPreset = (process.argv[4] || 'word') as 'word' | 'narrow';
  const margins = marginPreset === 'narrow' ? DEFAULT_MARGINS : WORD_MARGINS;

  const fixturesDir = path.join(__dirname, 'fixtures');
  const markdown = readFileSync(path.join(fixturesDir, fileName), 'utf-8');

  console.log(
    `[baseline] ${fileName} | ${fontSize}pt 单栏 normal 行距 | 页边距 ${marginPreset}` +
      `（上下 ${margins.top}mm / 左右 ${margins.left}mm）`
  );

  const { html } = await markdownToHtml(markdown, { imageBaseDir: fixturesDir });
  const params: RenderParams = {
    paperSize: 'A4',
    margins,
    density: 'normal',
    orientation: 'portrait',
    columns: 1,
  };

  const ctx = await createRenderContext(html, params);
  try {
    await applyTypography(ctx, fontSize, 'normal');
    const { pdfBuffer, pageCount } = await renderPdfAndCountPages(ctx, params);
    const outputPath = path.join(
      fixturesDir,
      fileName.replace(/\.md$/, `.baseline-${marginPreset}.pdf`)
    );
    writeFileSync(outputPath, pdfBuffer);
    console.log(`[baseline] 渲染完成: ${pageCount} 页  输出: ${outputPath}`);
  } finally {
    await closeRenderContext(ctx);
  }
}

main()
  .catch((err) => {
    console.error('[baseline] 失败:', err);
    process.exitCode = 1;
  })
  .finally(() => closeSharedBrowser());

/**
 * 按拼装结果渲染 PDF：每页一个固定尺寸容器，每个块按绝对定位摆放。
 * 块的宽度/字号/样式与 measure-blocks 完全一致，保证测量高度和最终渲染吻合。
 *
 * 两层：
 * - renderRectsPdf：核心渲染器，输入每块的 (页, x, y, 宽) 矩形，不关心坐标怎么来的；
 * - renderLayoutPdf：列模式适配层，把 (页, 栏, 跨栏, y) 的 Placement 换算成矩形。
 *   网格模式的换算在 grid-layout.ts（单位格坐标 + gutter 内缩）。
 */
import { PDFDocument } from 'pdf-lib';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Density, Margins, PaperSize, ResolvedOrientation } from '../types/index.js';
import { DENSITY_CONFIG, PAPER_SIZES } from '../types/index.js';
import { withPage } from './browser-pool.js';
import { markdownToHtml } from './md-to-html.js';
import {
  KATEX_CSS_INLINED,
  PRINT_CSS,
  applyAtomScaling,
  renderMermaidDiagrams,
  uniquifyMermaidIds,
} from './render-assets.js';
import type { ContentBlock } from './chunk-markdown.js';
import type { Placement } from './pack-blocks.js';

/** 一个块的最终版面矩形（高度由内容自然决定，不用给） */
export interface BlockRect {
  id: string;
  /** 0-based 页码 */
  page: number;
  /** 距内容区左边缘 mm */
  xMm: number;
  /** 距内容区顶部 mm */
  yMm: number;
  /** 内容盒宽度 mm */
  wMm: number;
}

export interface RectRenderOptions {
  paperSize: PaperSize;
  orientation: ResolvedOrientation;
  margins: Margins;
  fontSize: number; // pt
  density: Density;
  /** 本地图片解析基准目录，透传给 markdownToHtml 做 base64 内嵌 */
  imageBaseDir?: string;
}

export interface LayoutRenderOptions extends RectRenderOptions {
  columnsPerPage: number;
  /** 栏间距 mm（与拼装/测量时一致） */
  columnGapMm: number;
}

/** 与 render-pdf.ts 相同的宽高对调逻辑 */
function paperDims(paperSize: PaperSize, orientation: ResolvedOrientation) {
  const p = PAPER_SIZES[paperSize];
  return orientation === 'landscape' ? { width: p.height, height: p.width } : p;
}

export function columnWidthMm(opts: LayoutRenderOptions): number {
  const paper = paperDims(opts.paperSize, opts.orientation);
  const contentW = paper.width - opts.margins.left - opts.margins.right;
  return (contentW - (opts.columnsPerPage - 1) * opts.columnGapMm) / opts.columnsPerPage;
}

/** 核心渲染器：按矩形列表绝对定位每个块，打印成 PDF */
export async function renderRectsPdf(
  blocks: ContentBlock[],
  rects: BlockRect[],
  opts: RectRenderOptions
): Promise<{ pdfBuffer: Buffer; pageCount: number }> {
  const paper = paperDims(opts.paperSize, opts.orientation);
  const contentW = paper.width - opts.margins.left - opts.margins.right;
  const contentH = paper.height - opts.margins.top - opts.margins.bottom;
  const config = DENSITY_CONFIG[opts.density];

  const byId = new Map(blocks.map((b) => [b.id, b]));
  const pageCountLogical = rects.reduce((m, r) => Math.max(m, r.page + 1), 0);

  // 逐页生成绝对定位的块
  const pagesHtml: string[] = [];
  for (let page = 0; page < pageCountLogical; page++) {
    const blockHtmls: string[] = [];
    for (const rect of rects.filter((r) => r.page === page)) {
      const block = byId.get(rect.id);
      if (!block) continue;
      const { html } = await markdownToHtml(block.markdown, { imageBaseDir: opts.imageBaseDir });
      const uniqueHtml = uniquifyMermaidIds(html, block.id);
      blockHtmls.push(
        `<div class="hh-page layout-block" style="left:${rect.xMm}mm;top:${rect.yMm}mm;width:${rect.wMm}mm">${uniqueHtml}</div>`
      );
    }
    pagesHtml.push(`<div class="layout-page">${blockHtmls.join('\n')}</div>`);
  }

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  ${KATEX_CSS_INLINED}
  :root {
    --content-width: ${contentW}mm;
    --content-height: ${contentH}mm;
    --font-size: ${opts.fontSize}pt;
    --line-height: ${config.lineHeight};
    --paragraph-spacing: ${config.paragraphSpacing}em;
    --columns: 1;
    --column-gap: 0mm;
  }
  body { margin: 0; }
  .layout-page {
    position: relative;
    width: ${contentW}mm;
    height: ${contentH}mm;
    overflow: hidden;
  }
  .layout-page:not(:last-child) { break-after: page; }
  .layout-block { position: absolute; }
  /* 块内首元素顶部外边距会撑歪 y 定位，压掉它 */
  .layout-block > :first-child { margin-top: 0; }
  ${PRINT_CSS}
</style>
</head>
<body data-density="${opts.density}">
${pagesHtml.join('\n')}
</body>
</html>`;

  const tempFilePath = path.join(os.tmpdir(), `halfhalf-layout-${randomUUID()}.html`);
  await fs.writeFile(tempFilePath, fullHtml, 'utf-8');

  try {
    const pdfBuffer = await withPage(async (page) => {
      await page.goto(`file://${tempFilePath}`, { waitUntil: 'domcontentloaded' });
      await renderMermaidDiagrams(page);
      // 与测量阶段一致：等图片解码完成，再做原子缩放，保证量出的高度和最终渲染吻合
      await page.evaluate(() =>
        Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {})))
      );
      await applyAtomScaling(page);

      return page.pdf({
        width: `${paper.width}mm`,
        height: `${paper.height}mm`,
        margin: {
          top: `${opts.margins.top}mm`,
          bottom: `${opts.margins.bottom}mm`,
          left: `${opts.margins.left}mm`,
          right: `${opts.margins.right}mm`,
        },
        printBackground: true,
      });
    });

    const doc = await PDFDocument.load(pdfBuffer);
    return { pdfBuffer: Buffer.from(pdfBuffer), pageCount: doc.getPageCount() };
  } finally {
    await fs.unlink(tempFilePath).catch(() => {});
  }
}

/** 列模式适配层：把 (页, 栏, 跨栏, y) 的拼装结果换算成矩形后渲染 */
export async function renderLayoutPdf(
  blocks: ContentBlock[],
  placements: Placement[],
  opts: LayoutRenderOptions
): Promise<{ pdfBuffer: Buffer; pageCount: number }> {
  const colW = columnWidthMm(opts);
  const rects: BlockRect[] = placements.map((pl) => ({
    id: pl.id,
    page: pl.page,
    xMm: pl.column * (colW + opts.columnGapMm),
    yMm: pl.yMm,
    // 跨栏块的宽度 = span 个栏宽 + 中间夹着的 (span-1) 个栏间距
    wMm: pl.span * colW + (pl.span - 1) * opts.columnGapMm,
  }));
  return renderRectsPdf(blocks, rects, opts);
}

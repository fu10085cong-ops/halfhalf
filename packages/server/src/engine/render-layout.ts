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

/**
 * 调试叠加层：画出网格列线、每个块的方框和标签，用来目视检查排版。
 * 只用 outline/background/绝对定位标签实现——它们都不参与布局计算，
 * 所以调试版和正式版的排版结果逐像素一致，看到的就是真实布局。
 */
export interface GridOverlay {
  /** 单位格边长 mm（画列线的间距） */
  unitMm: number;
  /** 横向格数（列线条数） */
  unitsX: number;
  /** 块间留白 mm（用来把盒宽反推成格数标在标签上） */
  gutterMm: number;
}

export interface RectRenderOptions {
  paperSize: PaperSize;
  orientation: ResolvedOrientation;
  margins: Margins;
  fontSize: number; // pt
  density: Density;
  /** 本地图片解析基准目录，透传给 markdownToHtml 做 base64 内嵌 */
  imageBaseDir?: string;
  /** 给了就渲染调试叠加层（网格线 + 块方框 + 标签） */
  overlay?: GridOverlay;
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
  const ov = opts.overlay;
  const pagesHtml: string[] = [];
  for (let page = 0; page < pageCountLogical; page++) {
    const blockHtmls: string[] = [];
    for (const rect of rects.filter((r) => r.page === page)) {
      const block = byId.get(rect.id);
      if (!block) continue;
      const { html } = await markdownToHtml(block.markdown, { imageBaseDir: opts.imageBaseDir });
      const uniqueHtml = uniquifyMermaidIds(html, block.id);
      // 标签绝对定位到盒子上方的 gutter 里，不挤占内容。必须放在内容"之后"：
      // 放前面会顶掉 `.layout-block > :first-child { margin-top: 0 }` 的作用对象，
      // 让块首元素的上边距复活、内容整体下移——调试版就不等于真实版了。
      const label = ov
        ? `<span class="hh-debug-label">${block.id}·${Math.round((rect.wMm + ov.gutterMm) / ov.unitMm)}格</span>`
        : '';
      blockHtmls.push(
        `<div class="hh-page layout-block" style="left:${rect.xMm}mm;top:${rect.yMm}mm;width:${rect.wMm}mm">${uniqueHtml}${label}</div>`
      );
    }
    pagesHtml.push(
      `<div class="layout-page${ov ? ' hh-debug' : ''}">${blockHtmls.join('\n')}</div>`
    );
  }

  // 网格线用重复渐变画在页底（横竖各一层）；outline/背景都不参与布局，排版与正式版一致
  const overlayCss = ov
    ? `
  /*
   * 线宽必须 ≥1 CSS px（1px = 0.2646mm）。原先用 0.12mm ≈ 0.45px 是亚像素的，
   * Chromium 栅格化渐变时会每隔一条把线采样丢掉，看起来间距翻倍（15.9mm 而非 7.92mm），
   * 像是"网格不是单位长度"——其实格子没错，是线画丢了。
   */
  .layout-page.hh-debug {
    background-image:
      repeating-linear-gradient(
        to right,
        rgba(30, 90, 200, 0.30) 0,
        rgba(30, 90, 200, 0.30) 0.3mm,
        transparent 0.3mm,
        transparent ${ov.unitMm}mm
      ),
      repeating-linear-gradient(
        to bottom,
        rgba(30, 90, 200, 0.18) 0,
        rgba(30, 90, 200, 0.18) 0.3mm,
        transparent 0.3mm,
        transparent ${ov.unitMm}mm
      );
    outline: 0.4pt solid rgba(30, 90, 200, 0.5);
  }
  /*
   * 红框画的是"盒子"边界而不是内容盒：内容盒被 gutter 内缩了半格，直接给它描边会让
   * 标着 8 格的块看起来只跨 7 格、和网格线对不上。outline-offset 把描边外扩半个 gutter，
   * 正好落在盒子边界上 —— 于是 N 格的块严丝合缝跨 N 个格子，相邻块的框刚好相切，
   * 框与文字之间那圈白就是 gutter 本身。outline 不参与布局，排版仍与正式版一致。
   */
  .hh-debug .layout-block {
    outline: 0.6pt solid rgba(200, 30, 30, 0.65);
    outline-offset: ${ov.gutterMm / 2}mm;
    /* 白底让块从网格线上"浮起来"（只铺内容盒，留白处透出网格便于看清 gutter） */
    background: rgba(255, 255, 255, 0.8);
  }
  .hh-debug-label {
    position: absolute;
    right: 0;
    bottom: calc(100% + ${ov.gutterMm / 2}mm);
    font-size: 4.5pt;
    line-height: 1.1;
    font-family: "SF Mono", Menlo, monospace;
    color: rgba(200, 30, 30, 0.9);
    white-space: nowrap;
  }`
    : '';

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
  /* 块内首元素顶部外边距会撑歪 y 定位，压掉它；尾元素底部外边距是盒内不可见空白
     （块间分隔由 gutter 负责），一并压掉——两条规则必须与测量侧 .measure-block 严格对齐，
     否则测量高 ≠ 渲染高（首边距曾只在渲染侧删，每块虚高一截标题上边距） */
  .layout-block > :first-child { margin-top: 0; }
  .layout-block > :last-child { margin-bottom: 0; }
  ${PRINT_CSS}
  ${overlayCss}
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

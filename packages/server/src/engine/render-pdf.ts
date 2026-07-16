import type { Page } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Density, Margins, PaperSize, ResolvedOrientation } from '../types/index.js';
import { PAPER_SIZES, DENSITY_CONFIG } from '../types/index.js';
import { openPage } from './browser-pool.js';
import { KATEX_CSS_INLINED, PRINT_CSS, renderMermaidDiagrams } from './render-assets.js';

export interface RenderParams {
  paperSize: PaperSize;
  margins: Margins;
  density: Density;
  orientation: ResolvedOrientation;
  /** 分栏数；createRenderContext 用它设初始 CSS 变量，后续可通过 applyColumns 改（用于 auto 搜索） */
  columns: number;
}

/** 横版就是把纸张宽高对调，页边距仍然按 top/bottom/left/right 挂在物理边上，不跟着旋转 */
function getPaperDimensionsMm(paperSize: PaperSize, orientation: ResolvedOrientation) {
  const paper = PAPER_SIZES[paperSize];
  return orientation === 'landscape'
    ? { width: paper.height, height: paper.width }
    : { width: paper.width, height: paper.height };
}

export interface RenderContext {
  page: Page;
  tempFilePath: string;
}

/**
 * 建立一次渲染上下文：写入临时 HTML 文件（用于让 KaTeX 字体等相对路径资源能通过 file:// 正常加载）、
 * 在共享 Chromium（browser-pool，免每次数百 ms 冷启动）上开独立 page，并完成一次性的
 * Mermaid 预渲染（结果与字号无关，不需要在二分搜索里重复渲染）。
 */
export async function createRenderContext(
  bodyHtml: string,
  params: RenderParams
): Promise<RenderContext> {
  const page = await openPage();

  const paper = getPaperDimensionsMm(params.paperSize, params.orientation);
  const contentWidthMm = paper.width - params.margins.left - params.margins.right;
  const contentHeightMm = paper.height - params.margins.top - params.margins.bottom;

  const fullHtml = wrapHtml(bodyHtml, contentWidthMm, contentHeightMm, params.columns);
  const tempFilePath = path.join(os.tmpdir(), `halfhalf-${randomUUID()}.html`);
  await fs.writeFile(tempFilePath, fullHtml, 'utf-8');

  await page.goto(`file://${tempFilePath}`, { waitUntil: 'domcontentloaded' });
  await renderMermaidDiagrams(page);

  return { page, tempFilePath };
}

function wrapHtml(
  bodyHtml: string,
  contentWidthMm: number,
  contentHeightMm: number,
  columns: number
): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  ${KATEX_CSS_INLINED}

  :root {
    --content-width: ${contentWidthMm}mm;
    --content-height: ${contentHeightMm}mm;
    --font-size: 12pt;
    --line-height: 1.15;
    --paragraph-spacing: 0.2em;
    --columns: ${columns};
    --column-gap: 5mm;
  }
  ${PRINT_CSS}
</style>
</head>
<body>
<div class="hh-page">${bodyHtml}</div>
</body>
</html>`;
}

/** 调整字号/行高/段落间距，不重新加载页面、不重跑 Mermaid */
export async function applyTypography(
  ctx: RenderContext,
  fontSize: number,
  density: Density
): Promise<void> {
  const config = DENSITY_CONFIG[density];
  await ctx.page.evaluate(
    ({ fontSize, lineHeight, paragraphSpacing, density }) => {
      const root = document.documentElement;
      root.style.setProperty('--font-size', `${fontSize}pt`);
      root.style.setProperty('--line-height', String(lineHeight));
      root.style.setProperty('--paragraph-spacing', `${paragraphSpacing}em`);
      // print.css 里按 [data-density] 作用域的密度专属规则（如 cram 的标题行内化）靠它生效
      document.body.dataset.density = density;
    },
    {
      fontSize,
      lineHeight: config.lineHeight,
      paragraphSpacing: config.paragraphSpacing,
      density,
    }
  );
}

/**
 * 调整分栏数，不重新加载页面、不重跑 Mermaid。栏数只是一个 CSS 变量（column-count），
 * 所以 columns='auto' 时可以在同一个渲染上下文里反复切换栏数，不需要重开浏览器。
 */
export async function applyColumns(ctx: RenderContext, columns: number): Promise<void> {
  await ctx.page.evaluate((columns) => {
    document.documentElement.style.setProperty('--columns', String(columns));
  }, columns);
}

/**
 * 按当前字号/栏数的实际渲染宽度，判定哪些"不可重排的原子块"（独立公式、表格）塞不进当前栏，
 * 只给这些真正超栏的元素加 column-span:all 让它通栏，能塞进栏的保持在栏内。
 * 必须在每次 pdf() 之前跑（字号和栏数都会改变元素宽度和栏宽），确保页数统计和最终 PDF 一致。
 *
 * 两类原子块的"超栏"表现不同，要分别判定：
 * - 表格：会整体撑破所在栏、变得比栏还宽（rect.width > 栏宽）
 * - 公式：外框被 overflow 限制在栏宽内，超出部分是内部溢出（scrollWidth > clientWidth）
 */
async function markOverflowingAtoms(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pageEl = document.querySelector<HTMLElement>('.hh-page');
    if (!pageEl) return;

    const atoms = Array.from(
      document.querySelectorAll<HTMLElement>('.katex-display, table')
    );
    // 先全部复位成不通栏，才能量出它们"待在栏内时"的真实宽度
    atoms.forEach((el) => {
      el.style.columnSpan = 'none';
    });

    // 用一个零高度探针块量出当前栏宽（块级元素在多栏里会占满一栏宽度）
    const probe = document.createElement('div');
    probe.style.cssText = 'width:auto;height:0;margin:0;padding:0;border:0;';
    pageEl.insertBefore(probe, pageEl.firstChild);
    const columnWidth = probe.getBoundingClientRect().width;
    probe.remove();

    atoms.forEach((el) => {
      const breaksOut = el.getBoundingClientRect().width > columnWidth + 1; // 表格撑破栏
      const internalOverflow = el.scrollWidth - el.clientWidth > 1; // 公式内部溢出
      if (breaksOut || internalOverflow) {
        el.style.columnSpan = 'all';
      }
    });
  });
}

export async function renderPdfAndCountPages(
  ctx: RenderContext,
  params: RenderParams
): Promise<{ pdfBuffer: Buffer; pageCount: number }> {
  await markOverflowingAtoms(ctx.page);

  const paper = getPaperDimensionsMm(params.paperSize, params.orientation);
  const pdfBuffer = await ctx.page.pdf({
    width: `${paper.width}mm`,
    height: `${paper.height}mm`,
    margin: {
      top: `${params.margins.top}mm`,
      bottom: `${params.margins.bottom}mm`,
      left: `${params.margins.left}mm`,
      right: `${params.margins.right}mm`,
    },
    printBackground: true,
  });

  const doc = await PDFDocument.load(pdfBuffer);
  return { pdfBuffer: Buffer.from(pdfBuffer), pageCount: doc.getPageCount() };
}

export async function closeRenderContext(ctx: RenderContext): Promise<void> {
  // 只关 page，共享浏览器保持温热（生命周期归 browser-pool 管）
  await ctx.page.close();
  await fs.unlink(ctx.tempFilePath).catch(() => {
    // 临时文件清理失败不影响主流程
  });
}

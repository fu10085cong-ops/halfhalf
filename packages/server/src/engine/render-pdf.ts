import { chromium, type Browser, type Page } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { createRequire } from 'node:module';
import { readFileSync, promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Density, Margins, PaperSize, ResolvedOrientation } from '../types/index.js';
import { PAPER_SIZES, DENSITY_CONFIG } from '../types/index.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MERMAID_SCRIPT_PATH = require.resolve('mermaid/dist/mermaid.min.js');
const KATEX_CSS_PATH = require.resolve('katex/dist/katex.min.css');
const KATEX_FONTS_DIR = path.join(path.dirname(KATEX_CSS_PATH), 'fonts');
const PRINT_CSS = readFileSync(path.join(__dirname, '../templates/print.css'), 'utf-8');

const FONT_MIME_TYPES: Record<string, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
};

/**
 * katex.min.css 用相对路径 url(fonts/xxx.woff2) 引用字体。我们的 HTML 是写到系统临时目录
 * 再用 file:// 打开的，和 katex 包本身不在同一目录树下——Chromium 对 file:// 页面访问其他
 * file:// 资源有跨目录限制，即使把路径改写成绝对 file:// 路径也可能被挡下来，表现为公式
 * 完全没有专用字体/间距（上下标错位、根号缺横线）。这里直接把字体文件转成 base64 内嵌进
 * CSS，彻底绕开任何跨目录/跨域的文件访问限制。
 */
const KATEX_CSS_INLINED = readFileSync(KATEX_CSS_PATH, 'utf-8').replace(
  /url\(fonts\/([^)]+)\)/g,
  (_match, fileName: string) => {
    const ext = fileName.split('.').pop() ?? '';
    const mime = FONT_MIME_TYPES[ext] ?? 'application/octet-stream';
    const fontBuffer = readFileSync(path.join(KATEX_FONTS_DIR, fileName));
    return `url(data:${mime};base64,${fontBuffer.toString('base64')})`;
  }
);

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
  browser: Browser;
  page: Page;
  tempFilePath: string;
}

/**
 * 建立一次渲染上下文：写入临时 HTML 文件（用于让 KaTeX 字体等相对路径资源能通过 file:// 正常加载）、
 * 打开 Chromium 页面，并完成一次性的 Mermaid 预渲染（结果与字号无关，不需要在二分搜索里重复渲染）。
 */
export async function createRenderContext(
  bodyHtml: string,
  params: RenderParams
): Promise<RenderContext> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const paper = getPaperDimensionsMm(params.paperSize, params.orientation);
  const contentWidthMm = paper.width - params.margins.left - params.margins.right;
  const contentHeightMm = paper.height - params.margins.top - params.margins.bottom;

  const fullHtml = wrapHtml(bodyHtml, contentWidthMm, contentHeightMm, params.columns);
  const tempFilePath = path.join(os.tmpdir(), `halfhalf-${randomUUID()}.html`);
  await fs.writeFile(tempFilePath, fullHtml, 'utf-8');

  await page.goto(`file://${tempFilePath}`, { waitUntil: 'domcontentloaded' });
  await renderMermaidDiagrams(page);

  return { browser, page, tempFilePath };
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

async function renderMermaidDiagrams(page: Page): Promise<void> {
  const hasMermaid = await page.evaluate(
    () => document.querySelector('.hh-mermaid-pending') !== null
  );
  if (!hasMermaid) return;

  await page.addScriptTag({ path: MERMAID_SCRIPT_PATH });
  await page.evaluate(async () => {
    const mermaidApi = (window as unknown as { mermaid: any }).mermaid;
    mermaidApi.initialize({ startOnLoad: false, theme: 'neutral' });

    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('.hh-mermaid-pending')
    );
    for (const node of nodes) {
      const base64 = node.dataset.source || '';
      const source = new TextDecoder().decode(
        Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      );
      try {
        const { svg } = await mermaidApi.render(`${node.id}-svg`, source);
        const wrapper = document.createElement('div');
        wrapper.className = 'hh-mermaid';
        wrapper.innerHTML = svg;

        // Mermaid 会在 <svg> 上写死 style="max-width: ...px"，内联样式优先级比我们的
        // CSS 类规则高，会盖掉页面内容区的缩放限制，导致图表按原始尺寸整页铺开。
        // 这里直接覆盖同一个 style 属性，让图表按内容区宽度等比缩放。
        const svgEl = wrapper.querySelector('svg');
        if (svgEl) {
          svgEl.removeAttribute('width');
          svgEl.removeAttribute('height');
          svgEl.style.maxWidth = '100%';
          svgEl.style.width = '100%';
          svgEl.style.height = 'auto';
        }

        node.replaceWith(wrapper);
      } catch (err) {
        const fallback = document.createElement('pre');
        fallback.className = 'hh-mermaid-error';
        fallback.textContent = `Mermaid 渲染失败: ${String(err)}`;
        node.replaceWith(fallback);
      }
    }
  });
}

/** 调整字号/行高/段落间距，不重新加载页面、不重跑 Mermaid */
export async function applyTypography(
  ctx: RenderContext,
  fontSize: number,
  density: Density
): Promise<void> {
  const config = DENSITY_CONFIG[density];
  await ctx.page.evaluate(
    ({ fontSize, lineHeight, paragraphSpacing }) => {
      const root = document.documentElement;
      root.style.setProperty('--font-size', `${fontSize}pt`);
      root.style.setProperty('--line-height', String(lineHeight));
      root.style.setProperty('--paragraph-spacing', `${paragraphSpacing}em`);
    },
    { fontSize, lineHeight: config.lineHeight, paragraphSpacing: config.paragraphSpacing }
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
  await ctx.browser.close();
  await fs.unlink(ctx.tempFilePath).catch(() => {
    // 临时文件清理失败不影响主流程
  });
}

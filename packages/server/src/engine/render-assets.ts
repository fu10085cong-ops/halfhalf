/**
 * 渲染共享资产：KaTeX 内联样式、打印样式、Mermaid 预渲染。
 * render-pdf.ts（整页排版/导出）和 measure-blocks.ts（分块测量）都依赖这些，抽出来避免重复。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Page } from 'playwright';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MERMAID_SCRIPT_PATH = require.resolve('mermaid/dist/mermaid.min.js');
const KATEX_CSS_PATH = require.resolve('katex/dist/katex.min.css');
const KATEX_FONTS_DIR = path.join(path.dirname(KATEX_CSS_PATH), 'fonts');

/** 打印/排版样式表（分页、原子块保护、多栏规则等） */
export const PRINT_CSS = readFileSync(path.join(__dirname, '../templates/print.css'), 'utf-8');

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
export const KATEX_CSS_INLINED = readFileSync(KATEX_CSS_PATH, 'utf-8').replace(
  /url\(fonts\/([^)]+)\)/g,
  (_match, fileName: string) => {
    const ext = fileName.split('.').pop() ?? '';
    const mime = FONT_MIME_TYPES[ext] ?? 'application/octet-stream';
    const fontBuffer = readFileSync(path.join(KATEX_FONTS_DIR, fileName));
    return `url(data:${mime};base64,${fontBuffer.toString('base64')})`;
  }
);

/**
 * markdownToHtml 每次调用都从 hh-mermaid-0 开始编号，同一页面嵌多个块的 HTML 时
 * mermaid 占位 id 会互相撞车，导致 renderMermaidDiagrams 渲染错乱。
 * 嵌入前用块自己的 id 做前缀把占位 id 唯一化。
 */
export function uniquifyMermaidIds(html: string, prefix: string): string {
  return html.replaceAll('id="hh-mermaid-', `id="hh-mermaid-${prefix}-`);
}

/**
 * 原子内容缩放：表格/独立公式不能像正文一样换行重排，比容器宽时会横向溢出。
 * 这里把超宽的原子整体等比缩小（transform: scale）到恰好塞进所在块的宽度，
 * 并用负 margin 回收缩放腾出的纵向空间，让后续内容自然上移。
 *
 * 测量（measure-blocks）和最终渲染（render-layout）必须调用同一套缩放逻辑，
 * 否则量出的高度和实际渲染对不上。缩放系数写进 data-hh-scale，供测量侧读取。
 * 幂等：重复调用会先复位再重算。
 */
export async function applyAtomScaling(page: Page): Promise<void> {
  await page.evaluate(() => {
    const atoms = Array.from(
      document.querySelectorAll<HTMLElement>('.hh-page table, .hh-page .katex-display')
    );
    for (const el of atoms) {
      el.style.transform = '';
      el.style.transformOrigin = '';
      el.style.marginBottom = '';
      el.style.width = '';
      delete el.dataset.hhScale;
    }
    for (const el of atoms) {
      const container = el.closest<HTMLElement>('.hh-page');
      if (!container) continue;
      const cw = container.clientWidth;
      // 表格超宽表现为盒子本身比容器宽，缩放盒子即可；公式（overflow-x:auto）超宽发生在
      // 盒子内部——纸上没有滚动条，超出部分会被直接裁掉，缩放外盒子救不回已裁内容。
      // 所以先把盒子放开到内容宽（消除内部裁剪），再统一按“盒子比容器宽”缩放。
      if (el.scrollWidth > el.clientWidth + 1) {
        el.style.width = 'max-content';
      }
      const naturalW = el.getBoundingClientRect().width;
      if (naturalW > cw + 1) {
        const s = cw / naturalW;
        const layoutH = el.offsetHeight; // transform 不改变布局高度，用负 margin 回收视觉差
        el.style.transform = `scale(${s})`;
        el.style.transformOrigin = 'top left';
        el.style.marginBottom = `${-layoutH * (1 - s)}px`;
        el.dataset.hhScale = String(s);
      } else {
        el.style.width = '';
      }
    }
  });
}

/**
 * 把页面里的 mermaid 占位块（.hh-mermaid-pending）在浏览器内渲染成内联 SVG。
 * 与字号/栏数无关，只需在页面加载后跑一次。没有 mermaid 块时直接返回。
 */
export async function renderMermaidDiagrams(page: Page): Promise<void> {
  const hasMermaid = await page.evaluate(
    () => document.querySelector('.hh-mermaid-pending') !== null
  );
  if (!hasMermaid) return;

  await page.addScriptTag({ path: MERMAID_SCRIPT_PATH });
  await page.evaluate(async () => {
    const mermaidApi = (window as unknown as { mermaid: any }).mermaid;
    mermaidApi.initialize({ startOnLoad: false, theme: 'neutral' });

    const nodes = Array.from(document.querySelectorAll<HTMLElement>('.hh-mermaid-pending'));
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
        // CSS 类规则高，会盖掉容器的缩放限制，导致图表按原始尺寸铺开。这里覆盖它。
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

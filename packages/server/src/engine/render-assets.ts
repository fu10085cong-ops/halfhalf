/**
 * 渲染共享资产：KaTeX 内联样式、打印样式、Mermaid 预渲染。
 * render-layout.ts（网格排版/导出）和 measure-blocks.ts（分块测量）都依赖这些，抽出来避免重复。
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
    // 第四类原子：代码块（pre）。white-space: pre 禁折行（折行毁缩进/注释语义，H4），
    // 超宽走与表格同一条"放开到内容宽 → 整体缩放"的路。
    const atoms = Array.from(
      document.querySelectorAll<HTMLElement>('.hh-page table, .hh-page .katex-display, .hh-page pre')
    );
    // 第三类原子：**行内**公式（$...$）。它不参与 .katex-display 的缩放，又不能像文字换行，
    // 长分式在窄柱里会横向溢出、被页边裁掉（真实判例：数据分析材料的皮尔逊公式整段
    // 用行内写法，13pt/6 格下分母尾部被裁）。只在真溢出时缩放，短行内公式零影响。
    const inlineKatex = Array.from(document.querySelectorAll<HTMLElement>('.hh-page .katex')).filter(
      (el) => !el.closest('.katex-display')
    );
    const codeLines = Array.from(
      document.querySelectorAll<HTMLElement>('.hh-page pre .line')
    );
    for (const el of [...atoms, ...inlineKatex, ...codeLines]) {
      el.style.transform = '';
      el.style.transformOrigin = '';
      el.style.marginBottom = '';
      el.style.width = '';
      el.style.maxWidth = '';
      el.style.whiteSpace = '';
      el.style.display = '';
      delete el.dataset.hhScale;
    }
    // 紧凑表 nowrap 探针（在通用缩放之前）：单元格全是短词条的"速查表"，CJK 会在
    // 容器变窄时先竖折（"不稳"折成两行）而永远不触发溢出，表格原子保护形同虚设
    // （真实判例：cs 材料复杂度速查表 12 格下被挤成竖条）。给它禁折行量出自然宽：
    // 装得下 → 保持 nowrap（零成本告别竖折）；略超宽（缩放 ≥0.75 可救）→ 保持
    // nowrap 交给下面的通用缩放；太宽 → 退回折行渲染，但把"假想缩放"记进
    // data-hh-scale 让选档避开这个档往宽档推。单元格像句子的散文表不碰——折行是对的。
    for (const el of atoms) {
      if (el.tagName !== 'TABLE') continue;
      const container = el.closest<HTMLElement>('.hh-page');
      if (!container) continue;
      const cells = Array.from(el.querySelectorAll('th, td'));
      const compact =
        cells.length > 0 && cells.every((c) => (c.textContent ?? '').trim().length <= 16);
      if (!compact) continue;
      el.style.whiteSpace = 'nowrap';
      const cw = container.clientWidth;
      const naturalW = el.getBoundingClientRect().width;
      if (naturalW > cw + 1 && cw / naturalW < 0.75) {
        el.style.whiteSpace = '';
        el.dataset.hhScale = String(cw / naturalW);
      }
    }
    // 代码块逐行缩放：一行超宽只缩那一行（Shiki 每行是一个 .line span），
    // 其余行保持全尺寸——此前整块按最长行缩放，一条长行连累全部代码变小。
    // 行级 data-hh-scale 照常汇入块 scale（最差行进 minScale 选档保护）。
    // 布局高度不变（transform 不参与布局），测量与渲染天然一致。
    for (const el of atoms) {
      if (el.tagName !== 'PRE') continue;
      const lines = Array.from(el.querySelectorAll<HTMLElement>('.line'));
      if (lines.length === 0) continue; // 无行结构（fallback pre）走下面的整块缩放
      const cs = getComputedStyle(el);
      const avail =
        el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      for (const line of lines) {
        const w = line.getBoundingClientRect().width;
        if (w > avail + 1) {
          const s = Math.max(avail / w, 0.1);
          line.style.display = 'inline-block'; // transform 对非替换行内元素不生效
          line.style.transform = `scale(${s})`;
          line.style.transformOrigin = 'left center';
          line.dataset.hhScale = String(s);
        }
      }
    }
    for (const el of atoms) {
      if (el.tagName === 'PRE' && el.querySelector('.line')) continue; // 已逐行处理
      const container = el.closest<HTMLElement>('.hh-page');
      if (!container) continue;
      const cw = container.clientWidth;
      // 表格超宽表现为盒子本身比容器宽，缩放盒子即可；公式（overflow-x:auto）超宽发生在
      // 盒子内部——纸上没有滚动条，超出部分会被直接裁掉，缩放外盒子救不回已裁内容。
      // 所以先把盒子放开到内容宽（消除内部裁剪；pre 有 max-width:100%，一并放开），
      // 再统一按“盒子比容器宽”缩放。
      if (el.scrollWidth > el.clientWidth + 1) {
        el.style.width = 'max-content';
        el.style.maxWidth = 'none';
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
        el.style.maxWidth = '';
      }
    }
    for (const el of inlineKatex) {
      const container = el.closest<HTMLElement>('.hh-page');
      if (!container) continue;
      const contRect = container.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      // 行内元素从行中某处起排，可用宽度 = 容器内容右缘 − 公式左缘（不是整个容器宽）
      const available = contRect.left + container.clientWidth - r.left;
      if (r.width > available + 1) {
        const s = Math.max(available / r.width, 0.1);
        el.style.display = 'inline-block'; // transform 对非替换行内元素不生效
        el.style.transform = `scale(${s})`;
        el.style.transformOrigin = 'left center';
        el.dataset.hhScale = String(s);
        // 缩放系数进 data-hh-scale：测量侧会把它算进块的最小缩放（minScale 选档保护），
        // 挤不下的行内公式会自然把块推向更宽的档，而不是缩到看不清
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

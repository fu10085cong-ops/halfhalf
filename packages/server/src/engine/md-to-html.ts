import MarkdownIt from 'markdown-it';
import markdownItKatex from 'markdown-it-katex';
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * KaTeX 原生不支持部分物理常用宏（矢量、微分算符、单位），
 * 这里补一批常用宏，覆盖不到的语法会按普通 LaTeX 渲染或报错降级。
 */
const PHYSICS_MACROS: Record<string, string> = {
  '\\vec': '\\boldsymbol{#1}',
  '\\dv': '\\frac{d#1}{d#2}',
  '\\pdv': '\\frac{\\partial#1}{\\partial#2}',
  '\\unit': '\\,\\mathrm{#1}',
  '\\abs': '\\left|#1\\right|',
};

const SHIKI_LANGS: BundledLanguage[] = [
  'javascript', 'typescript', 'jsx', 'tsx', 'python', 'java', 'c', 'cpp',
  'go', 'rust', 'bash', 'json', 'html', 'css', 'markdown', 'sql', 'yaml',
];
const SHIKI_THEME = 'github-light';

export const MERMAID_PENDING_CLASS = 'hh-mermaid-pending';

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [SHIKI_THEME],
      langs: SHIKI_LANGS,
    });
  }
  return highlighterPromise;
}

export interface MdToHtmlResult {
  html: string;
  hasMermaidBlocks: boolean;
}

export interface MdToHtmlOptions {
  /**
   * 本地图片相对路径的解析基准目录。给了它才会把本地图片读出来转成 base64 内嵌——
   * 因为最终 HTML 是写到临时目录用 file:// 打开的，相对路径会解析失败（跟 KaTeX 字体同一个坑）。
   * data: / http(s): 的 src 原样透传（web 上传场景图片本就是 data URI）。
   */
  imageBaseDir?: string;
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** 把本地图片路径转成 base64 data URI；已是 data:/http(s): 或无法读取时原样返回（不崩、不丢） */
function inlineImageSrc(src: string, baseDir?: string): string {
  if (/^(data:|https?:)/i.test(src)) return src;
  if (!baseDir) return src;
  try {
    const abs = path.isAbsolute(src) ? src : path.resolve(baseDir, src);
    const mime = IMAGE_MIME[path.extname(abs).toLowerCase()];
    if (!mime) return src;
    return `data:${mime};base64,${readFileSync(abs).toString('base64')}`;
  } catch {
    return src; // 文件不存在等：留原样，浏览器显示裂图，不崩溃
  }
}

/**
 * 将 Markdown 转换为可直接打印的 HTML 片段。
 * - 代码块用 Shiki 高亮成带内联样式的静态 HTML，不依赖运行时 JS
 * - 数学/物理公式用 KaTeX 同步渲染
 * - mermaid 代码块先转换成占位 div（真正渲染需要浏览器环境，交给 render-pdf 中的预渲染阶段）
 * - 图片打上统一 class，交给 print.css 做页面内等比缩放
 */
export async function markdownToHtml(
  markdown: string,
  options?: MdToHtmlOptions
): Promise<MdToHtmlResult> {
  const highlighter = await getHighlighter();
  const loadedLangs = new Set(highlighter.getLoadedLanguages());
  let mermaidIndex = 0;

  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
  md.use(markdownItKatex, { throwOnError: false, macros: PHYSICS_MACROS });

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const lang = (token.info || '').trim().split(/\s+/)[0] || 'text';
    const code = token.content;

    if (lang === 'mermaid') {
      const id = `hh-mermaid-${mermaidIndex++}`;
      const encodedSource = Buffer.from(code, 'utf-8').toString('base64');
      return `<div class="${MERMAID_PENDING_CLASS}" id="${id}" data-source="${encodedSource}"></div>`;
    }

    const safeLang = loadedLangs.has(lang as BundledLanguage) ? lang : 'text';
    try {
      return highlighter.codeToHtml(code, { lang: safeLang, theme: SHIKI_THEME });
    } catch {
      return `<pre class="hh-code-fallback"><code>${md.utils.escapeHtml(code)}</code></pre>`;
    }
  };

  md.renderer.rules.image = (tokens, idx, mdOptions, _env, self) => {
    const token = tokens[idx];
    token.attrSet('class', 'hh-image');
    token.attrSet('loading', 'eager');
    const srcIdx = token.attrIndex('src');
    if (srcIdx >= 0 && token.attrs) {
      token.attrs[srcIdx][1] = inlineImageSrc(token.attrs[srcIdx][1], options?.imageBaseDir);
    }
    return self.renderToken(tokens, idx, mdOptions);
  };

  const html = md.render(markdown);
  return { html, hasMermaidBlocks: mermaidIndex > 0 };
}

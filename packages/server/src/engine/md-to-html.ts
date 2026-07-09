import MarkdownIt from 'markdown-it';
import markdownItKatex from 'markdown-it-katex';
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';

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

/**
 * 将 Markdown 转换为可直接打印的 HTML 片段。
 * - 代码块用 Shiki 高亮成带内联样式的静态 HTML，不依赖运行时 JS
 * - 数学/物理公式用 KaTeX 同步渲染
 * - mermaid 代码块先转换成占位 div（真正渲染需要浏览器环境，交给 render-pdf 中的预渲染阶段）
 * - 图片打上统一 class，交给 print.css 做页面内等比缩放
 */
export async function markdownToHtml(markdown: string): Promise<MdToHtmlResult> {
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

  md.renderer.rules.image = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];
    token.attrSet('class', 'hh-image');
    token.attrSet('loading', 'eager');
    return self.renderToken(tokens, idx, options);
  };

  const html = md.render(markdown);
  return { html, hasMermaidBlocks: mermaidIndex > 0 };
}

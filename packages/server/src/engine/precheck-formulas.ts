/**
 * 公式预检：不开浏览器，把每块 Markdown 干跑一遍现有渲染管线，收集 KaTeX 渲染失败的公式。
 * throwOnError:false 时 KaTeX 不抛错，而是把错误公式降级成红字
 * <span class="katex-error" title="ParseError: ...">原始 LaTeX</span>——
 * 用户往往到 PDF 里才看见。这里提前扫出这些降级，带块位置上报，
 * 也是将来 AI 改写公式的安全网（改写后再预检一遍，错了就打回）。
 */
import { markdownToHtml } from './md-to-html.js';
import type { ContentBlock } from './chunk-markdown.js';

export interface FormulaIssue {
  blockId: string;
  /** 所在块的标题（前言块为空串），用于给用户定位 */
  blockTitle: string;
  /** KaTeX 的错误信息（通常是 ParseError，含公式内出错位置） */
  message: string;
}

const ENTITY_MAP: Record<string, string> = {
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
};

function decodeEntities(s: string): string {
  return s.replace(/&quot;|&#39;|&#x27;|&lt;|&gt;|&amp;/g, (m) => ENTITY_MAP[m]);
}

export async function precheckFormulas(blocks: ContentBlock[]): Promise<FormulaIssue[]> {
  const issues: FormulaIssue[] = [];
  for (const b of blocks) {
    const { html } = await markdownToHtml(b.markdown);
    for (const tag of html.match(/<span\b[^>]*katex-error[^>]*>/g) ?? []) {
      const title = tag.match(/title="([^"]*)"/);
      issues.push({
        blockId: b.id,
        blockTitle: b.title,
        message: decodeEntities(title?.[1] ?? '未知 KaTeX 错误'),
      });
    }
  }
  return issues;
}

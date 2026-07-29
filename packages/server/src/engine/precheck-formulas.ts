/**
 * 公式预检：直接把每块里的 `$...$` / `$$...$$` 交给 KaTeX 干跑一遍，收集渲染失败的公式。
 * 它同时是 AI 改写公式的安全网（`ai-compress` 的 `formulaClean`：改写后再预检一遍，错了就打回）。
 *
 * **不能借道 markdown-it-katex 的红字降级来判定**（2026-07-29 判例，从
 * `feat/document-intelligence-complete` 分支捞回）：老实现是渲染一遍 HTML、再扫
 * `<span class="katex-error">`。实测 9 个用例，它漏掉了 `$\foobarbaz{x}$` 这一类
 * **未知命令**——markdown-it-katex 吞掉异常、按原文回退，产出里根本没有 katex-error 类，
 * 闸于是判"公式干净"放行。而未知命令恰恰是 AI 改写最常见的错法（编造一个不存在的宏），
 * 也就是说这个安全网在它最该起作用的场景上有假阴性。
 *
 * 现在直接以 `throwOnError: true` 调 KaTeX，同一批用例 5/5 抓到、4/4 正常公式不误报。
 * `strict: 'ignore'` 是因为"数学模式里出现中文"只是 KaTeX 的可渲染警告、不是失败——
 * 而正文里的 `$30 元，那本 $45` 会被下面的正则当成一段行内公式扫到，
 * 不关掉就会往 stderr 刷一堆与缺陷无关的警告（ParseError 不受 strict 影响，照抛）。
 */
import katex from 'katex';
import { PHYSICS_MACROS } from './md-to-html.js';
import type { ContentBlock } from './chunk-markdown.js';

export interface FormulaIssue {
  blockId: string;
  /** 所在块的标题（前言块为空串），用于给用户定位 */
  blockTitle: string;
  /** KaTeX 的错误信息（通常是 ParseError，含公式内出错位置） */
  message: string;
}

/** 围栏代码里的 `$` 是程序文本（`echo "$PATH"`），不是公式。 */
function withoutFencedCode(markdown: string): string {
  return markdown.replace(/^\s*```[\s\S]*?^\s*```\s*$/gmu, '');
}

/** `$$...$$` 可跨行；`$...$` 不跨行，且 `\$` 是转义的美元符号不开公式。 */
const FORMULA_RE = /\$\$([\s\S]*?)\$\$|(?<!\\)\$([^$\n]+?)\$/g;

export async function precheckFormulas(blocks: ContentBlock[]): Promise<FormulaIssue[]> {
  const issues: FormulaIssue[] = [];
  for (const block of blocks) {
    for (const match of withoutFencedCode(block.markdown).matchAll(FORMULA_RE)) {
      const displayMode = match[1] !== undefined;
      const latex = displayMode ? match[1] : match[2];
      if (!latex?.trim()) continue;
      try {
        katex.renderToString(latex, {
          displayMode,
          throwOnError: true,
          strict: 'ignore',
          macros: PHYSICS_MACROS,
        });
      } catch (error) {
        issues.push({
          blockId: block.id,
          blockTitle: block.title,
          message: error instanceof Error ? error.message : '未知 KaTeX 错误',
        });
      }
    }
  }
  return issues;
}

/**
 * 渲染管线的 KaTeX 现代命令回归锁（2026-07-29 从 feat/document-intelligence-complete 捞回）。
 *
 * PHYSICS_MACROS 把 `\vec` 展开成 `\boldsymbol{#1}`——一旦 markdown-it-katex 内部
 * 绑定的 KaTeX 版本退回到不支持 `\boldsymbol` 的老版，物理公式会整片渲染成红色源码，
 * 而这在几何和页数上完全看不出来，只有真去看 PDF 才发现。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownToHtml } from '../../src/engine/md-to-html.js';

test('\\boldsymbol 正常渲染，不退化成红色源码', async () => {
  const { html } = await markdownToHtml('$$\\nabla \\cdot \\boldsymbol{E} = \\frac{\\rho}{\\varepsilon_0}$$');
  assert.match(html, /katex/u);
  assert.match(html, /class="mord boldsymbol"/u);
  assert.doesNotMatch(html, /katex-error/u);
});

test('\\vec 宏经 PHYSICS_MACROS 展开后同样是 boldsymbol', async () => {
  const { html } = await markdownToHtml('$\\vec{F} = m\\vec{a}$');
  assert.match(html, /class="mord boldsymbol"/u);
  assert.doesNotMatch(html, /katex-error/u);
});

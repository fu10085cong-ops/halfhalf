/**
 * 公式预检回归锁（2026-07-29 判例）：老实现借道 markdown-it-katex 的红字降级判定，
 * 对**未知命令**有假阴性——而它是 `ai-compress` 判 `formulaClean` 的唯一依据，
 * 也就是说 AI 编造一个不存在的宏时，安全网会放行。详见 precheck-formulas.ts 顶部注释。
 *
 * 锁两侧：该抓的抓（尤其未知命令），不该误报的不误报（货币、代码里的 `$`、正常公式）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precheckFormulas } from '../../src/engine/precheck-formulas.js';
import { chunkMarkdown } from '../../src/engine/chunk-markdown.js';

const check = (markdown: string) => precheckFormulas(chunkMarkdown(markdown));

test('未知命令必须被抓到——AI 改写最常见的错法，也是老实现漏掉的那一格', async () => {
  const issues = await check('由此可得 $\\foobarbaz{x}$ 成立。');
  assert.equal(issues.length, 1, '编造的宏不能当成干净公式放行');
  assert.match(issues[0].message, /KaTeX/);
});

test('其余坏公式一并抓到', async () => {
  for (const bad of ['$\\frac{a}$', '$$\\begin{matrix} a$$', '$a}$', '$\\left( a$']) {
    assert.ok((await check(bad)).length > 0, `应判不合格：${bad}`);
  }
});

test('正常公式与散文里的 $ 都不误报', async () => {
  const clean = [
    '$E=mc^2$',
    '$\\vec{F} = m\\vec{a}$', // 走 PHYSICS_MACROS，宏必须跟渲染管线用同一份
    '$$\\int_0^1 x\\,dx = \\frac12$$',
    '这本书 $30 元，那本 $45 元。', // 正文货币，不是公式
    '价格是 \\$30。', // 转义美元符
    '```python\nprint(f"${price}")\n```', // 围栏代码里的 $
    '用 `echo "$PATH"` 查看。',
  ];
  for (const markdown of clean) {
    assert.deepEqual(await check(markdown), [], `不应误报：${markdown}`);
  }
});

test('报出的问题带块定位', async () => {
  const [issue] = await check('## 相对论\n\n公式 $\\frac{a}$ 有误。');
  assert.equal(issue.blockTitle, '相对论');
  assert.ok(issue.blockId);
});

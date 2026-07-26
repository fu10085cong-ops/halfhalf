/**
 * 切块器的行为锁——重点是"无标题超长文本兜底细分"（Word 粘贴灾难的修复）：
 * 修复前它整篇成为一个不可拆巨块 → 最宽档独占一页 → 字号飙到上限、内容被裁。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown, stripHtmlComments } from '../../src/engine/chunk-markdown.js';

test('HTML 注释被剥掉(来源注释不进统计/渲染),围栏内的注释保留', () => {
  const md = '# 标题\n\n<!-- 来源:xxx -->\n\n正文。\n\n```html\n<!-- 这是代码内容 -->\n```';
  const stripped = stripHtmlComments(md);
  assert.ok(!stripped.includes('来源:xxx'));
  assert.ok(stripped.includes('<!-- 这是代码内容 -->'));
  const blocks = chunkMarkdown(md);
  assert.ok(blocks.every((b) => !b.markdown.includes('来源:xxx')));
});

/** 生成 n 段、每段约 120 字的无标题散文 */
function plainParagraphs(n: number): string {
  return Array.from({ length: n }, (_, i) => `第${i}段。${'内容'.repeat(58)}`).join('\n\n');
}

test('无标题长文本 → 按段落兜底细分成多块，不再是单个巨块', () => {
  const text = plainParagraphs(20); // 约 2400 字
  const blocks = chunkMarkdown(text);
  assert.ok(blocks.length > 1, `应细分为多块，实际 ${blocks.length}`);
  // 每块不超过 maxBlockChars(800) 太多（单段超长才允许超）
  for (const b of blocks) {
    assert.ok(b.markdown.length <= 900, `块 ${b.id} 长 ${b.markdown.length}，粒度失控`);
  }
  // 阅读顺序与内容都不丢（空行归一后逐段对得上）
  const joined = blocks.map((b) => b.markdown).join('\n\n');
  assert.equal(joined, text);
});

test('无标题但不超长的文本保持一个前言块（行为不变）', () => {
  const text = '一小段话。\n\n又一小段话。';
  const blocks = chunkMarkdown(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, '');
});

test('单段超长且无空行 → 保持一块，不断句', () => {
  const text = '句子'.repeat(600); // 1200 字无空行
  const blocks = chunkMarkdown(text);
  assert.equal(blocks.length, 1);
});

test('围栏内的空行不算段落分界', () => {
  const code = '```python\n\na = 1\n\n\nb = 2\n\n```';
  const text = `${plainParagraphs(8)}\n\n${code}\n\n${plainParagraphs(8).replaceAll('第', '再')}`;
  const blocks = chunkMarkdown(text);
  const withCode = blocks.filter((b) => b.markdown.includes('```'));
  assert.equal(withCode.length, 1, '围栏应完整落在一个块里');
  assert.ok(withCode[0].markdown.includes(code), '围栏内容（含空行）不能被拆散');
});

test('带标题的超长叶子节不受兜底影响（既有判例基线不动）', () => {
  const longLeaf = `# 总标题\n\n## 唯一一节\n\n${plainParagraphs(20)}`;
  const blocks = chunkMarkdown(longLeaf);
  // ## 节没有更深层标题：尽管超长，仍保持"标题块"整体，不做段落细分
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, '总标题');
});

test('结构良好的材料切块行为不变（标题切分 + 前言块）', () => {
  const doc = `# 文档\n\n引言一句。\n\n## 一\n\n正文 A。\n\n## 二\n\n正文 B。`;
  const blocks = chunkMarkdown(doc);
  assert.deepEqual(
    blocks.map((b) => b.title),
    ['文档', '一', '二']
  );
});

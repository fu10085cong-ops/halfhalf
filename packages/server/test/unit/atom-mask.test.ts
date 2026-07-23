/**
 * 原子遮罩回归（纯函数，不开浏览器/不加载 Shiki，毫秒级）：
 * - 往返无损：各类刚性原子（围栏/行内码/公式/表格/图片/标题）遮罩后再回填 === 原文
 * - 遮罩确实把原子换成哨兵、把散文留下
 * - isPureAtom 正确识别"无正文可精简"的纯原子块
 * - checkSentinels 抓得住丢失/重复/杜撰——这是"原子没被 AI 动过"的判据
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskAtoms, unmaskAtoms, isPureAtom, checkSentinels } from '../../src/engine/atom-mask.js';

test('往返无损：各类原子遮罩后再回填 === 原文', () => {
  const md = [
    '## 标题不该被改写',
    '',
    '这是散文，含行内公式 $E=mc^2$ 和行内代码 `malloc()`，都不能动。',
    '',
    '$$\\int_0^1 x\\,dx = \\frac{1}{2}$$',
    '',
    '```python',
    'def f(x):',
    '    return x | 0  # 注释里有 $ 和 | 也不该被误扫',
    '```',
    '',
    '| 列A | 列B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '![截图](data:image/png;base64,AAAA)',
    '',
    '普通结尾散文。',
  ].join('\n');
  const { masked, atoms } = maskAtoms(md);
  assert.equal(unmaskAtoms(masked, atoms), md);
});

test('遮罩把原子换成哨兵、散文原样留下', () => {
  const { masked } = maskAtoms('前 $x$ 后');
  assert.equal(masked, '前 〔HH0〕 后');
});

test('围栏代码优先遮罩：内部的 $ | 不被公式/表格误扫', () => {
  const md = '```\na | b $x$\n```';
  const { masked, atoms } = maskAtoms(md);
  assert.equal(atoms.length, 1); // 整个围栏一个原子，内部符号没被拆
  assert.equal(unmaskAtoms(masked, atoms), md);
});

test('isPureAtom：纯公式块=无正文，有讲解=有正文', () => {
  assert.equal(isPureAtom(maskAtoms('$$a+b$$').masked), true);
  assert.equal(isPureAtom(maskAtoms('## 只有标题').masked), true);
  assert.equal(isPureAtom(maskAtoms('讲解一下 $$a+b$$ 的含义').masked), false);
});

test('checkSentinels：完整/丢失/重复/杜撰越界', () => {
  assert.equal(checkSentinels('〔HH0〕正文〔HH1〕', 2), true);
  assert.equal(checkSentinels('无占位符纯散文', 0), true);
  assert.equal(checkSentinels('〔HH0〕', 2), false); // 丢失 HH1
  assert.equal(checkSentinels('〔HH0〕〔HH0〕〔HH1〕', 2), false); // HH0 重复
  assert.equal(checkSentinels('〔HH0〕〔HH1〕〔HH5〕', 2), false); // 杜撰越界 HH5
});

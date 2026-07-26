/**
 * 长注释行拆分（code-comments.ts）：注释是散文可拆，代码一个字符不动。
 * 判例来源：cs-programming 五、排序要点——一条 60+ 列的中文注释把整块拖去宽档。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLongCodeComments, displayCols } from '../../src/engine/code-comments.js';

test('整行长中文注释拆成多行同前缀注释,每行不超预算,文本无损', () => {
  const src = '// 快排:分区 + 递归,不稳定,平均 O(nlogn),最坏 O(n^2)(已有序时)\nint x = 1;';
  const out = splitLongCodeComments(src, 'c');
  const lines = out.split('\n');
  assert.ok(lines.length >= 3, `应拆成 ≥2 行注释 + 1 行代码,实得 ${lines.length} 行`);
  assert.equal(lines[lines.length - 1], 'int x = 1;', '代码行不动');
  const commentLines = lines.slice(0, -1);
  for (const l of commentLines) {
    assert.ok(l.startsWith('// '), `续行保留注释前缀: ${l}`);
    // 42 = 预算 40 + 标点悬挂余量 2:断点标点(逗号/顿号)留在行尾而不是甩去下一行开头
    assert.ok(displayCols(l) <= 42, `不超预算+悬挂余量: ${l} (${displayCols(l)})`);
  }
  assert.ok(!/^\/\/ [,，、。;；]/.test(commentLines[1] ?? ''), '续行不以标点开头');
  // 拼回去(去前缀、去因断行清理的首尾空格)应还原原文的非空白字符序列
  const joined = commentLines.map((l) => l.slice(3)).join('');
  const orig = src.split('\n')[0].slice(3);
  assert.equal(joined.replace(/\s/g, ''), orig.replace(/\s/g, ''), '注释文本无损');
});

test('行尾长注释挪到代码行上方,代码部分保序不动', () => {
  const src = '*p = 20;          // 通过指针会改掉 a 的值,此时 a == 20,考试常考这个陷阱';
  const out = splitLongCodeComments(src, 'c').split('\n');
  assert.ok(out.length >= 2);
  assert.equal(out[out.length - 1], '*p = 20;', '代码行在注释下方且右侧空白被裁');
  for (const l of out.slice(0, -1)) assert.ok(l.startsWith('// '));
});

test('长代码行(无注释)一个字符不动——交给逐行缩放', () => {
  const src = 'int very_long_function_name(int alpha, int beta, int gamma, int delta);';
  assert.equal(splitLongCodeComments(src, 'c'), src);
});

test('字符串字面量里的 // 不当注释(引号配平守卫)', () => {
  const src = 'const u = "http://example.com/a/very/long/path/segment/here/xxxxxxxxxx";';
  assert.equal(splitLongCodeComments(src, 'js'), src);
});

test('python # 注释同样拆;未知语言原样返回', () => {
  const py = '# 这是一条特别特别长的说明文字,讲了半天原理,考试要点全在这一行里面,必须拆开';
  const outPy = splitLongCodeComments(py, 'python').split('\n');
  assert.ok(outPy.length >= 2);
  for (const l of outPy) assert.ok(l.startsWith('# ') && displayCols(l) <= 40);

  const txt = '这行没有任何注释语法但很长很长很长很长很长很长很长很长很长很长很长很长很长';
  assert.equal(splitLongCodeComments(txt, 'text'), txt);
});

test('短行与缩进注释保持原样;缩进的长注释续行保留缩进', () => {
  const short = '    // 短注释\nint y;';
  assert.equal(splitLongCodeComments(short, 'c'), short);

  const indented = '    // 缩进的超长注释:讲解为什么这里必须先保存后继节点否则链表会断掉找不回来了';
  const out = splitLongCodeComments(indented, 'c').split('\n');
  assert.ok(out.length >= 2);
  for (const l of out) assert.ok(l.startsWith('    // '), `保留缩进: "${l}"`);
});

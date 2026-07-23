/**
 * AI 精简安全网回归：注入假的 chatComplete 走通全流程，不花 token、不联网。
 * （会加载一次 Shiki——公式预检安全网走真实 md-to-html 管线；node --test 按文件分进程，
 *  只有本文件付这个启动代价。）
 *
 * 覆盖四条安全网分支 + 两类跳过：
 * - 改写更短 + 原子保全 → ok，且按 range 拼接回写后公式逐字保留
 * - 模型丢了占位符 → atomsPreserved=false，保留原文
 * - 改写引入非法公式 → formulaClean=false，保留原文
 * - 改写没变短 → ok=false（未见精简），但改写可信仍给出
 * - 纯原子块 / 图片块 → skipped，且根本不调 AI
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressMarkdown } from '../../src/engine/ai-compress.js';
import type { AiCompressRequest, BlockSuggestion } from '../../src/types/index.js';

const PROVIDER = { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'test' };

const DOC = [
  '## 概念',
  '',
  '操作系统是管理计算机硬件与软件资源的系统软件，负责进程调度、内存管理、文件系统与设备驱动等核心职责，是应用程序与硬件之间的桥梁。',
  '',
  '## 公式',
  '',
  '由定义可得能量与质量的关系，这是相对论的重要结论，务必牢记：',
  '',
  '$$E = mc^2$$',
].join('\n');

const MARKER = '请压缩下面这段内容：\n\n';
function extractMasked(messages: { role: string; content: string }[]): string {
  const user = messages[messages.length - 1].content;
  return user.slice(user.indexOf(MARKER) + MARKER.length);
}

const req = (markdown: string, blockIds?: string[]): AiCompressRequest => ({
  markdown,
  provider: PROVIDER,
  blockIds,
});

/** 把每段散文压成"要点"两字、哨兵原位保留 —— 合法的"改短且保全原子" */
const shrinkFake = async (_p: unknown, messages: { role: string; content: string }[]) => {
  const masked = extractMasked(messages);
  return masked
    .split(/(〔HH\d+〕)/)
    .map((p) => (/〔HH\d+〕/.test(p) ? p : p.trim() ? '要点' : p))
    .join('');
};

/** 原样回声 —— 改写没变短 */
const identityFake = async (_p: unknown, messages: { role: string; content: string }[]) =>
  extractMasked(messages);

/** 丢掉第一个哨兵 —— 模拟模型动了公式/代码 */
const dropSentinelFake = async (_p: unknown, messages: { role: string; content: string }[]) =>
  extractMasked(messages).replace(/〔HH\d+〕/, '');

/** 附一个完整但非法的公式 —— 回填后引入新 KaTeX 错误 */
const formulaLeakFake = async (_p: unknown, messages: { role: string; content: string }[]) =>
  extractMasked(messages) + '\n\n$\\frac{a}$';

const byId = (list: BlockSuggestion[], id: string) => list.find((s) => s.blockId === id)!;

test('改写更短 + 原子保全 → ok=true，且拼接回写后公式逐字保留', async () => {
  const { suggestions, summary } = await compressMarkdown(req(DOC), { chat: shrinkFake });
  assert.equal(suggestions.length, 2);
  for (const s of suggestions) {
    assert.equal(s.safety.ok, true);
    assert.ok(s.charsAfter < s.charsBefore);
  }
  assert.equal(summary.compressed, 2);
  assert.ok(summary.charsAfter < summary.charsBefore);

  // 模拟前端"接受全部 ok 建议"：按 range.start 降序拼接回写
  let out = DOC;
  [...suggestions]
    .filter((s) => s.safety.ok)
    .sort((a, b) => b.range.start - a.range.start)
    .forEach((s) => {
      out = out.slice(0, s.range.start) + s.suggested + '\n\n' + out.slice(s.range.end);
    });
  assert.ok(out.includes('$$E = mc^2$$'), '公式必须逐字保留');
  assert.ok(out.includes('## 公式') && out.includes('## 概念'), '标题必须保留');
  assert.ok(out.length < DOC.length, '整体应更短');
});

test('模型丢了占位符 → atomsPreserved=false，保留原文', async () => {
  const { suggestions } = await compressMarkdown(req(DOC), { chat: dropSentinelFake });
  const s = byId(suggestions, 'block-1'); // 含公式的块
  assert.equal(s.safety.ok, false);
  assert.equal(s.safety.atomsPreserved, false);
  assert.equal(s.suggested, s.original);
});

test('改写引入非法公式 → formulaClean=false，保留原文', async () => {
  const { suggestions } = await compressMarkdown(req(DOC), { chat: formulaLeakFake });
  const s = byId(suggestions, 'block-0'); // 纯散文块，原文无公式错误
  assert.equal(s.safety.ok, false);
  assert.equal(s.safety.formulaClean, false);
  assert.equal(s.suggested, s.original);
});

test('改写没变短 → ok=false（未见精简）', async () => {
  const { suggestions } = await compressMarkdown(req(DOC), { chat: identityFake });
  const s = byId(suggestions, 'block-0');
  assert.equal(s.safety.ok, false);
  assert.match(s.safety.reason ?? '', /未见明显缩短/);
});

test('纯原子块 / 图片块 → skipped，且不调 AI', async () => {
  let called = 0;
  const spyFake = async () => {
    called++;
    return '不该被调用';
  };
  const md = ['$$a+b$$', '', '![图](data:image/png;base64,AAAA)'].join('\n');
  const { suggestions } = await compressMarkdown(req(md), { chat: spyFake });
  assert.equal(called, 0, '纯原子/图片块不应触发 AI 调用');
  assert.ok(suggestions.every((s) => s.skipped));
});

test('blockIds 子集：未选中的块跳过、不调 AI', async () => {
  let called = 0;
  const countingShrink = async (_p: unknown, messages: { role: string; content: string }[]) => {
    called++;
    return shrinkFake(_p, messages);
  };
  const { suggestions } = await compressMarkdown(req(DOC, ['block-0']), { chat: countingShrink });
  assert.equal(called, 1, '只应精简 block-0');
  assert.equal(byId(suggestions, 'block-0').safety.ok, true);
  assert.equal(byId(suggestions, 'block-1').skipped, true);
  assert.match(byId(suggestions, 'block-1').safety.reason ?? '', /未选中/);
});

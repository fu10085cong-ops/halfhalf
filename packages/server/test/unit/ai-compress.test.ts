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
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUserPrompt, compressMarkdown } from '../../src/engine/ai-compress.js';
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

/**
 * 把每段散文压成"要点"两字，**标题行与哨兵原样保留** —— 合法的"改短且保全原子"。
 * 标题行单独放行是因为标题不再遮罩成哨兵（2026-07-29 判例，见 atom-mask 的 MaskOptions）：
 * 一个守规矩的模型会照抄标题，这个假实现必须同样守规矩，否则测的就不是安全网而是假实现。
 */
const shrinkLine = (line: string) =>
  /^#{1,6}[ \t]/.test(line)
    ? line
    : line
        .split(/(〔HH\d+〕)/)
        .map((p) => (/〔HH\d+〕/.test(p) ? p : p.trim() ? '要点' : p))
        .join('');

const shrinkFake = async (_p: unknown, messages: { role: string; content: string }[]) =>
  extractMasked(messages).split('\n').map(shrinkLine).join('\n');

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

/** 标题不遮罩后,"AI 没动标题"由 checkHeadingsPreserved 兜底——这是安全网①之二 */
test('模型改写了标题 → atomsPreserved=false，保留原文', async () => {
  const rewriteHeadingFake = async (_p: unknown, messages: { role: string; content: string }[]) =>
    extractMasked(messages)
      .split('\n')
      .map((l) => (/^#{1,6}[ \t]/.test(l) ? `${l}（模型擅自改了）` : shrinkLine(l)))
      .join('\n');
  const { suggestions } = await compressMarkdown(req(DOC), { chat: rewriteHeadingFake });
  const s = byId(suggestions, 'block-0');
  assert.equal(s.safety.ok, false);
  assert.equal(s.safety.atomsPreserved, false);
  assert.equal(s.suggested, s.original, '标题被动过就整块作废');
  assert.match(s.safety.reason ?? '', /标题/);
});

test('模型删掉标题 → 同样判原子未保全', async () => {
  const dropHeadingFake = async (_p: unknown, messages: { role: string; content: string }[]) =>
    extractMasked(messages)
      .split('\n')
      .filter((l) => !/^#{1,6}[ \t]/.test(l))
      .map(shrinkLine)
      .join('\n');
  const { suggestions } = await compressMarkdown(req(DOC), { chat: dropHeadingFake });
  assert.equal(byId(suggestions, 'block-0').safety.atomsPreserved, false);
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

/**
 * 提示词内容锁(2026-07-29 首轮评测判例):提示词曾写「章节标题…不要输出」,
 * 而当时标题被遮罩成正文首行的哨兵——模型照做删掉哨兵,安全网①逐块判失败,
 * 精简对带标题的块恒定失效。假 AI 单测永远测不到这类"提示词与遮罩打架"的缺陷
 * (假 AI 总是守规矩),它是被 L3 评测(pnpm eval)抓出来的。
 */
test('用户提示词不得出现"不要输出"——它会被模型套用到必须保留的内容上', () => {
  const prompt = buildUserPrompt('进程与线程的区别', '## 进程与线程的区别\n\n一段正文。');
  assert.ok(!/不要输出/.test(prompt), '"不要输出"会诱导模型删掉标题行或哨兵');
  assert.match(prompt, /进程与线程的区别/, '章节上下文仍要给');
});

test('系统提示词把"标题原样保留"写死', () => {
  const src = readFileSync(
    new URL('../../src/engine/ai-compress.ts', import.meta.url),
    'utf-8'
  );
  const prompt = src.split('const SYSTEM_PROMPT = `')[1].split('`;')[0];
  assert.match(prompt, /标题行/, '标题不再遮罩后,唯一的事前约束就是这条提示词');
  assert.match(prompt, /原样逐字保留/);
});

test('无标题块不加标题说明行', () => {
  assert.equal(buildUserPrompt('', '一段正文。'), '请压缩下面这段内容：\n\n一段正文。');
});

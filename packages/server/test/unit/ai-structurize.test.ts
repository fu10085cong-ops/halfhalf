/**
 * ⓪ 结构化入口的行为锁：体检判据 / 围栏剥离 / 追问一轮的编排。
 * AI 调用全部注入假流式函数，不花 token、不联网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkStructure,
  stripOuterFence,
  structurize,
  type StreamFn,
} from '../../src/engine/ai-structurize.js';
import type { ChatMessage } from '../../src/engine/ai-provider.js';

const GOOD_MD = `# 数据分析基础

## 一、核心指标

均值公式 $\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n}x_i$，反映集中趋势。

## 二、方差

样本方差 $S^2$ 衡量离散程度，越小越稳定。`;

// —— stripOuterFence ——

test('stripOuterFence: 剥掉包住整个文档的 ```markdown 围栏', () => {
  assert.equal(stripOuterFence('```markdown\n# 标题\n\n正文\n```'), '# 标题\n\n正文');
  assert.equal(stripOuterFence('```\n# 标题\n```'), '# 标题');
});

test('stripOuterFence: 正常文档与内部代码围栏不受影响', () => {
  assert.equal(stripOuterFence(GOOD_MD), GOOD_MD);
  const withInnerFence = '# 标题\n\n```python\nprint(1)\n```\n\n结尾正文';
  assert.equal(stripOuterFence(withInnerFence), withInnerFence);
});

// —— checkStructure ——

test('checkStructure: 结构良好的 md 通过', async () => {
  const check = await checkStructure(GOOD_MD);
  assert.equal(check.ok, true);
  assert.deepEqual(check.problems, []);
  assert.ok(check.blockCount >= 2);
});

test('checkStructure: 无标题纯文本被拒并点名分节', async () => {
  const check = await checkStructure('这是一大段没有任何标题的纯文本，讲了很多内容。');
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.includes('标题')));
});

test('checkStructure: 单节超长且无法细分 → 巨型块问题', async () => {
  const giant = `# 总标题\n\n## 唯一一节\n\n${'字'.repeat(1700)}`;
  const check = await checkStructure(giant);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.includes('巨型')));
});

test('checkStructure: KaTeX 渲染不了的公式被扫出', async () => {
  // \frac{a 缺右花括号 → ParseError → katex-error（\undefinedcommand 反而会被静默渲染，实测排除）
  const broken = `# 标题\n\n## 一节\n\n公式 $\\frac{a$ 有问题。`;
  const check = await checkStructure(broken);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.includes('公式')));
});

test('checkStructure: 空输出直接拒', async () => {
  const check = await checkStructure('   ');
  assert.equal(check.ok, false);
  assert.equal(check.blockCount, 0);
});

// —— structurize 编排 ——

const provider = { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'test' };

/** 依次返回给定输出的假流式函数；记录每次调用的 messages 供断言 */
function fakeStream(outputs: string[]): { fn: StreamFn; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  let i = 0;
  const fn: StreamFn = async (_p, messages, onDelta) => {
    calls.push(messages);
    const out = outputs[i++];
    // 拆两段回调，模拟真实流式
    if (out.length > 5) {
      onDelta(out.slice(0, 5));
      onDelta(out.slice(5));
    } else {
      onDelta(out);
    }
    return out;
  };
  return { fn, calls };
}

test('structurize: 一次通过 → attempts=1，不追问', async () => {
  const { fn, calls } = fakeStream([GOOD_MD]);
  const deltas: { text: string; attempt: number }[] = [];
  let retried = false;
  const result = await structurize(
    '原始材料',
    provider,
    {
      onDelta: (text, attempt) => deltas.push({ text, attempt }),
      onRetry: () => {
        retried = true;
      },
    },
    { streamFn: fn }
  );
  assert.equal(result.attempts, 1);
  assert.equal(result.check.ok, true);
  assert.equal(result.markdown, GOOD_MD);
  assert.equal(retried, false);
  assert.equal(calls.length, 1);
  assert.ok(deltas.every((d) => d.attempt === 1));
  assert.equal(deltas.map((d) => d.text).join(''), GOOD_MD);
});

test('structurize: 首轮体检不过 → 带问题追问一轮并采用修正稿', async () => {
  const bad = '没有标题的一坨输出';
  const { fn, calls } = fakeStream([bad, GOOD_MD]);
  let retryProblems: string[] = [];
  const attempts = new Set<number>();
  const result = await structurize(
    '原始材料',
    provider,
    {
      onDelta: (_text, attempt) => attempts.add(attempt),
      onRetry: (problems) => {
        retryProblems = problems;
      },
    },
    { streamFn: fn }
  );
  assert.equal(result.attempts, 2);
  assert.equal(result.check.ok, true);
  assert.equal(result.markdown, GOOD_MD);
  assert.ok(retryProblems.some((p) => p.includes('标题')));
  assert.deepEqual([...attempts].sort(), [1, 2]);
  // 追问的对话里带上了首轮输出与体检结论
  assert.equal(calls.length, 2);
  const retryMessages = calls[1];
  assert.equal(retryMessages.length, 4);
  assert.equal(retryMessages[2].role, 'assistant');
  assert.equal(retryMessages[2].content, bad);
  assert.ok(retryMessages[3].content.includes('结构体检'));
});

test('structurize: 修正轮仍不过 → 照常返回且 check.ok=false（让前端提示）', async () => {
  const bad1 = '第一轮没标题';
  const bad2 = '第二轮还是没标题';
  const { fn } = fakeStream([bad1, bad2]);
  const result = await structurize(
    '原始材料',
    provider,
    { onDelta: () => {}, onRetry: () => {} },
    { streamFn: fn }
  );
  assert.equal(result.attempts, 2);
  assert.equal(result.check.ok, false);
  assert.equal(result.markdown, bad2);
});

test('checkStructure: Pandoc 伪表格分隔行被抓(真材料 db-systems 判例);GFM 表格与围栏内横线不误报', async () => {
  const pandoc = `# 数据库\n\n## 概念\n\n  名称                   含义\n  ---------------------- ------------------------------------\n  数据(Data)             描述客观事物的符号记录\n`;
  const bad = await checkStructure(pandoc);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes('伪表格')), JSON.stringify(bad.problems));

  const gfm = `# 数据库\n\n## 概念\n\n| 名称 | 含义 |\n|---|---|\n| 数据 | 符号记录 |\n`;
  const good = await checkStructure(gfm);
  assert.ok(!good.problems.some((p) => p.includes('伪表格')));

  const fenced = '# 代码\n\n## 示例\n\n```text\n------ ------\n```\n正文。';
  const code = await checkStructure(fenced);
  assert.ok(!code.problems.some((p) => p.includes('伪表格')), '围栏内横线是代码内容');
});

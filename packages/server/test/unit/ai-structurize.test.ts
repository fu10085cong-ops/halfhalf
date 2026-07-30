/**
 * ⓪ 结构化入口的行为锁：体检判据 / 围栏剥离 / 追问一轮的编排。
 * AI 调用全部注入假流式函数，不花 token、不联网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STRICT_ORDER_MARK,
  STRUCTURIZE_SYSTEM_PROMPT,
  checkFabrication,
  checkStructure,
  hasStrictSourceOrder,
  prosePayload,
  stripOuterFence,
  structurize,
  type StreamFn,
} from '../../src/engine/ai-structurize.js';
import { chunkMarkdown } from '../../src/engine/chunk-markdown.js';
import { markdownToHtml } from '../../src/engine/md-to-html.js';
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

// —— 元素封闭子集(docs/FORMAT.md §2)——

test('白名单:超链接被拒,图片与围栏/公式里的链接形态不误报', async () => {
  const linked = `# 标题\n\n## 一节\n\n详见[官方文档](https://example.com/doc)与 <https://example.com>。`;
  const bad = await checkStructure(linked);
  assert.ok(bad.problems.some((p) => p.includes('超链接')), JSON.stringify(bad.problems));

  const image = `# 标题\n\n## 一节\n\n![截图](https://example.com/a.png)\n\n正文文字。`;
  const ok = await checkStructure(image);
  assert.ok(!ok.problems.some((p) => p.includes('超链接')), '图片不是超链接');

  const fenced = '# 标题\n\n## 一节\n\n```text\n[a](https://x.com)\n```\n正文。';
  const code = await checkStructure(fenced);
  assert.ok(!code.problems.some((p) => p.includes('超链接')), '围栏内是代码内容');
});

test('白名单:Unicode 上下标被拒,LaTeX 上下标不受影响', async () => {
  const uni = `# 标题\n\n## 一节\n\n面积是 x² 加 H₂O 的量。`;
  const bad = await checkStructure(uni);
  assert.ok(bad.problems.some((p) => p.includes('上下标')), JSON.stringify(bad.problems));

  const latex = `# 标题\n\n## 一节\n\n面积是 $x^2$ 加 $H_2O$ 的量。`;
  const ok = await checkStructure(latex);
  assert.ok(!ok.problems.some((p) => p.includes('上下标')));
});

test('白名单:分隔线与 setext 下划线被拒;GFM 表格分隔行不误报', async () => {
  const divided = `# 标题\n\n## 一节\n\n上半部分。\n\n---\n\n下半部分。`;
  const bad = await checkStructure(divided);
  assert.ok(bad.problems.some((p) => p.includes('分隔线')), JSON.stringify(bad.problems));

  const gfm = `# 标题\n\n## 一节\n\n| 名称 | 含义 |\n|---|---|\n| 数据 | 记录 |`;
  const ok = await checkStructure(gfm);
  assert.ok(!ok.problems.some((p) => p.includes('分隔线')), '表格分隔行有管道,不是分隔线');
});

test('白名单:裸 HTML 标签被拒;散文比较符与公式里的尖括号不误报', async () => {
  const html = `# 标题\n\n## 一节\n\n第一行<br>第二行,水是 H<sub>2</sub>O。`;
  const bad = await checkStructure(html);
  assert.ok(bad.problems.some((p) => p.includes('HTML')), JSON.stringify(bad.problems));

  const prose = `# 标题\n\n## 一节\n\n若 a<b 且 c>d,则交换。公式 $x<y$ 同理。`;
  const ok = await checkStructure(prose);
  assert.ok(!ok.problems.some((p) => p.includes('HTML')), '比较符散文不是 HTML');
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

/**
 * 严格源序标记（2026-07-30 判例）：用户的「一~十四 考点全集」第一页顺序被打乱——
 * repack 页内换位在装不下时会掉到高度序。实测 12 份固定材料，第 1 页普遍有逆序
 * （poli-econ 184 对、java-oop 49 对），一直存在只是从没量过。
 *
 * 定案是让 structurize 判定顺序刚性、写进材料首行，用户可覆盖。这几条锁住这条链路：
 * 判据必须在提示词里、标记形态不许漂、检测函数两侧都对。
 */
test('系统提示词写死了顺序判据与标记原文', () => {
  assert.match(STRUCTURIZE_SYSTEM_PROMPT, /halfhalf:source-order=strict/, '标记原文必须给全');
  assert.match(STRUCTURIZE_SYSTEM_PROMPT, /编号/, '要给具体信号,不能只说"有没有顺序"');
  assert.match(STRUCTURIZE_SYSTEM_PROMPT, /步骤|流程|推导/);
  assert.match(STRUCTURIZE_SYSTEM_PROMPT, /拿不准就不写/, '要给出不确定时的偏向');
});

test('标记常量与检测正则同源——两边不许各写一份', () => {
  assert.ok(hasStrictSourceOrder(STRICT_ORDER_MARK), '常量自己必须被自己的正则认出');
});

test('hasStrictSourceOrder 两侧都对', () => {
  assert.equal(hasStrictSourceOrder(`${STRICT_ORDER_MARK}\n\n# 标题\n\n正文。`), true);
  assert.equal(hasStrictSourceOrder('<!--  halfhalf:source-order=strict  -->'), true, '容空格');
  assert.equal(hasStrictSourceOrder('# 标题\n\n正文。'), false);
  assert.equal(hasStrictSourceOrder('正文里提到 source-order 这个词'), false, '散文提及不算');
});

test('顺序标记不进块、也不渲染成可见文字', async () => {
  const md = `${STRICT_ORDER_MARK}\n\n# 标题\n\n一段正文。`;
  const blocks = chunkMarkdown(md);
  assert.ok(!blocks.some((b) => /source-order/.test(b.markdown)), '切块器必须剥掉');
  const { html } = await markdownToHtml(md);
  assert.doesNotMatch(html, /source-order/, 'html:false 会把注释转义成可见文字,必须先剥');
});

/**
 * 编造检测（2026-07-30 判例，详见 ai-structurize.ts 里 checkFabrication 的注释）：
 * 输入 18 字「死锁四条件 互斥 占有并等待 不可剥夺 循环等待」，产出 ~160 字，
 * 把四个条件的定义整段编了出来，复跑两次都编。提示词里的「只重组，不新增知识」没管住。
 *
 * 锁四件事：判据两侧都对、口径必须剔公式（否则 LaTeX 转换被误判成膨胀）、
 * 疑似编造要单独打标（界面上要与结构瑕疵区别对待）、闸不合格必须触发追问。
 */
test('prosePayload 只数公式区外的中文——LaTeX 转换不算膨胀', () => {
  // 同一份内容，Unicode 形态与 LaTeX 形态的散文载荷必须相等
  assert.equal(prosePayload('判别式 Δ = p² - 4q'), prosePayload('判别式 $\\Delta = p^2 - 4q$'));
  assert.equal(prosePayload('代码 ```py\nprint(123)\n```'), 2, '围栏代码不计入');
  assert.equal(prosePayload('| 列 |\n|---|\n| 值 |'), 2, '表格分隔行不计入');
});

test('编造检测：该抓的抓', () => {
  const input = '死锁四条件 互斥 占有并等待 不可剥夺 循环等待';
  const fabricated =
    '# 死锁四条件\n\n## 互斥\n资源一次只能被一个进程使用，若另一个进程请求该资源，' +
    '必须等待直到资源被释放。\n\n## 占有并等待\n进程已经占有了至少一个资源，' +
    '同时又在等待其他进程占有的资源，这是死锁形成的重要前提条件。\n\n' +
    '## 不可剥夺\n资源不能被强制从占有它的进程中剥夺，只能由占有它的进程主动释放。';
  assert.equal(checkFabrication(input, fabricated).length, 1, '整段编定义必须被抓到');
  assert.match(checkFabrication(input, fabricated)[0], /新增/);
});

test('编造检测：不该误报的不误报', () => {
  const input = '死锁四条件 互斥 占有并等待 不可剥夺 循环等待';
  // 忠实重组：只加标题结构，一个字没编
  assert.deepEqual(
    checkFabrication(input, '# 死锁四条件\n\n## 互斥\n\n## 占有并等待\n\n## 不可剥夺\n\n## 循环等待'),
    []
  );
  // 纯公式材料：入 0 中文，出若干结构标签——常数项就是为它留的，纯比率会误杀
  assert.deepEqual(
    checkFabrication('y=ax^2+bx+c  Δ=b^2-4ac', '# 二次方程\n\n标准形式：$y=ax^2+bx+c$\n\n判别式：$\\Delta=b^2-4ac$'),
    []
  );
  // 剥噪声导致产出更短，天然合规
  assert.deepEqual(checkFabrication('第 3 页 页脚\n\n进程是资源分配的基本单位', '# 进程\n\n进程是资源分配的基本单位'), []);
});

test('疑似编造要单独打标,并触发追问一轮', async () => {
  const input = '死锁四条件 互斥 占有并等待 不可剥夺 循环等待';
  const bloat =
    '# 死锁四条件\n\n## 互斥\n资源一次只能被一个进程使用，其他进程请求时必须等待释放，' +
    '这是并发控制的基本要求。\n\n## 占有并等待\n进程已占有资源同时等待其他资源，' +
    '这一条件是死锁形成的关键环节之一。\n\n## 不可剥夺\n资源只能由占有者主动释放。';
  const faithful = '# 死锁四条件\n\n## 互斥\n\n## 占有并等待\n\n## 不可剥夺\n\n## 循环等待';
  let calls = 0;
  const fake: StreamFn = async (_p, _m, onDelta) => {
    calls += 1;
    const out = calls === 1 ? bloat : faithful;
    onDelta(out);
    return out;
  };
  const retries: string[][] = [];
  const r = await structurize(input, provider, { onDelta: () => {}, onRetry: (p) => retries.push(p) }, { streamFn: fake });
  assert.equal(calls, 2, '编造必须触发追问一轮');
  assert.equal(retries.length, 1);
  assert.match(retries[0].join(''), /新增/, '追问里要写明是新增内容,AI 才知道删什么');
  assert.equal(r.check.ok, true, '追问后忠实产出应当放行');
  assert.equal(r.check.fabricationSuspected, false);
});

test('追问后仍在编 → 闸黑且打上 fabricationSuspected', async () => {
  const input = '死锁四条件 互斥 占有并等待 不可剥夺 循环等待';
  const bloat =
    '# 死锁四条件\n\n## 互斥\n资源一次只能被一个进程使用，其他进程请求时必须等待释放，' +
    '这是并发控制的基本要求。\n\n## 占有并等待\n进程已占有资源同时等待其他资源，' +
    '这一条件是死锁形成的关键环节之一。\n\n## 不可剥夺\n资源只能由占有者主动释放。';
  const fake: StreamFn = async (_p, _m, onDelta) => {
    onDelta(bloat);
    return bloat;
  };
  const r = await structurize(input, provider, { onDelta: () => {}, onRetry: () => {} }, { streamFn: fake });
  assert.equal(r.check.ok, false);
  assert.equal(r.check.fabricationSuspected, true, '界面要靠这个标记把保真问题与结构问题分开显示');
});

/**
 * 行内混排 $$ 的白名单锁（2026-07-30，Docker 冒烟验证目检发现）。
 *
 * 这是**闸与渲染器判断不一致的第二例**：precheckFormulas 扫 `$$...$$` 拿到公式体、
 * KaTeX 渲染通过 → 判"公式干净"，而渲染器（markdown-it-katex 的 math_block）
 * 只认独立成行的形态，`能量关系：$$E = mc^2$$` 会被整段当普通文字，
 * **`$$` 原样印进小抄**。今早修的那例方向相反（渲染器显红字而预检不认）。
 */
test('行内混排的 $$ 被拒——渲染器不认它，$$ 会原样印出来', async () => {
  const r = await checkStructure('# 标题\n\n## 一节\n\n能量与质量的关系：$$E = mc^2$$');
  assert.equal(r.ok, false);
  assert.match(r.problems.join(''), /独立成行/);
  assert.match(r.problems.join(''), /行内公式/, '要给出替代写法,否则 AI 不知道怎么改');
});

test('合法的四种公式写法都不误报', async () => {
  for (const [what, md] of [
    ['独立成行 $$', '# 标题\n\n## 一节\n\n关系：\n\n$$E = mc^2$$'],
    ['行内单 $', '# 标题\n\n## 一节\n\n能量关系 $E = mc^2$ 很重要，务必牢记这条结论。'],
    ['多行块级 $$', '# 标题\n\n## 一节\n\n推导：\n\n$$\n\\int_0^1 x dx = \\frac12\n$$'],
    ['表格单元里的 $', '# 标题\n\n## 一节\n\n| 名称 | 式子 |\n|---|---|\n| 质能 | $E=mc^2$ |'],
  ] as [string, string][]) {
    assert.equal((await checkStructure(md)).ok, true, `不该拒:${what}`);
  }
});

test('渲染器与判据对 $$ 的解析必须一致——两边都验', async () => {
  // 判据放行的写法，渲染器必须真渲染成 KaTeX；判据拒掉的写法，渲染器确实不认
  const ok = '关系：\n\n$$E = mc^2$$';
  const bad = '关系：$$E = mc^2$$';
  const { html: okHtml } = await markdownToHtml(ok);
  assert.match(okHtml, /class="katex/, '判据放行的写法必须真被渲染');
  assert.doesNotMatch(okHtml, /\$\$/, '不该有 $$ 残留');
  const { html: badHtml } = await markdownToHtml(bad);
  assert.match(badHtml, /\$\$/, '判据拒掉的写法确实会漏 $$ ——这就是拒它的理由');
});

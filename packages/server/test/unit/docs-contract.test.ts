/**
 * 文档契约锁（2026-07-30 立）。
 *
 * **为什么需要它**：一天之内发现三处文档与代码不符——FORMAT.md 说 HTML 注释
 * "引擎全链路无视"（渲染层其实会把它转义成可见文字）；RULES.md 说 monotonicOrder
 * "冻结套件里没有判例"（其实全套件都有这个问题，只是没量过）；我自己写的
 * "MiniMax 换域名了"（从 diff 推断，没验，是错的）。
 *
 * 项目的判据、阈值、口径全部沉在 RULES.md / FORMAT.md / TESTING.md 里，
 * 这三份文档的权威性已经接近"宪法"——**而代码有 191 个锁，文档一个都没有**。
 * 文档越权威，错了越危险，因为没人会去质疑它。
 *
 * 这份测试把文档里**可机械验证的断言**变成契约。两类锁：
 * - **双向数值锁**：阈值必须同时出现在文档表格和它归属的源文件里。
 *   改代码忘改文档会红，改文档忘改代码也会红。
 * - **行为锁**：文档承诺的行为（"注释全链路无视"）直接跑一遍验。
 *
 * 它不校验文风，只校验事实。加新判据时同步加一行，成本一分钟。
 */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown } from '../../src/engine/chunk-markdown.js';
import { markdownToHtml } from '../../src/engine/md-to-html.js';
import { SCENE_THRESHOLDS } from '../../src/engine/scene-presets.js';
import { STRICT_ORDER_MARK, checkStructure } from '../../src/engine/ai-structurize.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SRC = path.join(ROOT, 'packages/server/src');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf-8');
const src = (p: string) => readFileSync(path.join(SRC, p), 'utf-8');

const RULES = read('RULES.md');
const FORMAT = read('docs/FORMAT.md');
const TESTING = read('TESTING.md');

/** §1.7 口径总表的正文（不含表头与表后小结） */
const ORDER_TABLE = RULES.slice(RULES.indexOf('### 1.7'), RULES.indexOf('**贯穿全表的设计模式'));

// ─────────────────────────────────────────────────────────────
// 一、§1.7 识别判据口径总表：双向数值锁
// ─────────────────────────────────────────────────────────────

/**
 * 每条：[判据名（文档行里必须出现）, 文档里的阈值字面量, 源文件, 代码里必须出现的原文]。
 * 代码片段刻意抄成完整表达式而不只是数字——单个 `0.01` 在别处也可能出现，
 * 只有连着运算符才能确认锁的是同一个判据。
 */
const THRESHOLDS: [string, string, string, string][] = [
  ['PDF 页路由 → `hybrid`', '0.01', 'engine/knowledge-ir.ts', "ratio >= 0.01 ? 'hybrid'"],
  ['PDF 页路由 → `ocr`', '0', 'engine/knowledge-ir.ts', "characterCount === 0 ? 'ocr'"],
  ['节点 kind → formula（主）', '0.08', 'engine/knowledge-ir.ts', "if (ratio >= 0.08) return 'formula'"],
  ['节点 kind → heading', '60', 'engine/knowledge-ir.ts', 'normalized.length <= 60'],
  ['节点 kind → formula（兜底）', '220', 'engine/knowledge-ir.ts', 'normalized.length <= 220'],
  ['requiresVisualFallback', '0（零容忍）', 'engine/knowledge-ir.ts', 'requiresVisualFallback = ratio > 0'],
  ['节点 `confidence`', '2.4', 'engine/knowledge-ir.ts', 'ratio * 2.4'],
  ['OCR_REQUIRED', '20', 'engine/document-import.ts', 'Math.max(20, document.numPages * 6)'],
  ['整篇转视觉', '0.4', 'engine/document-import.ts', 'fallback.length >= 3 && fallback.length / pageCount >= 0.4'],
  ['双栏归属', '0.47', 'engine/document-import.ts', 'center(b) < 0.47'],
  ['双栏归属', '0.53', 'engine/document-import.ts', 'center(b) > 0.53'],
  ['通栏分隔块', '0.62', 'engine/document-import.ts', '>= 0.62'],
  ['PDF 换行', '0.45', 'engine/document-import.ts', '* 0.45'],
  ['PDF 换行', '0.18', 'engine/document-import.ts', 'height * 0.18'],
  ['公式裁决否决', '0.85', 'engine/adjudicate.ts', 'RELATIVE_FORMULA_FLOOR = 0.85'],
  ['栅格 `blank`', '0.00045', 'workers/inspect_pdf.py', 'ink_ratio < 0.00045'],
  ['栅格墨点判定', '238', 'workers/inspect_pdf.py', 'value < 238'],
  ['栅格 `nearEdge`', '0.006', 'workers/inspect_pdf.py', '0.006'],
  ['检索去重', '0.6', 'engine/source-quality.ts', 'DUPLICATE_CONTENT_THRESHOLD = 0.6'],
  ['重点规划主题匹配', '0.5', 'engine/restructure-plan.ts', '>= 0.5'],
  ['学科建议', '2', 'engine/subject-rules.ts', 'count >= 1 : count >= 2'],
  ['EXTRACT_EMPTY', '30', 'engine/url-import.ts', 'MIN_CONTENT_CHARS = 30'],
  ['EMPTY_DOCUMENT', '2', 'engine/document-import.ts', 'characterCount < 2 && imageCount === 0'],
];

test('§1.7 表格里的每条阈值都还在代码里（改代码忘改文档 → 这里红）', () => {
  for (const [name, , file, snippet] of THRESHOLDS) {
    assert.ok(
      src(file).includes(snippet),
      `§1.7 的「${name}」说代码里有 \`${snippet}\`，但 ${file} 里找不到——` +
        `要么代码改了没同步文档，要么文档一开始就写错`
    );
  }
});

test('§1.7 表格里的每条阈值都还写在文档里（改文档忘改代码 → 这里红）', () => {
  for (const [name, literal] of THRESHOLDS) {
    const row = ORDER_TABLE.split('\n').find((l) => l.startsWith('|') && l.includes(name));
    assert.ok(row, `§1.7 里少了「${name}」这一行——判据不许悄悄从总表消失`);
    assert.ok(
      row.includes(literal),
      `§1.7 的「${name}」行里应当出现阈值 ${literal}，实际是：${row}`
    );
  }
});

/** SCENE_THRESHOLDS 是九个会被反复调参的数，最容易文档腐烂，逐个对 */
test('SCENE_THRESHOLDS 的九个值与 §1.7 一致', () => {
  const expected: [keyof typeof SCENE_THRESHOLDS, string, string][] = [
    ['visualImageCount', '2', '`imageHeavy`'],
    ['visualImageRatio', '0.15', '`imageHeavy`'],
    ['displayPer1000', '5', '`formulaHeavy`'],
    ['formulaMinDisplay', '4', '`formulaHeavy`'],
    ['formulaBandLow', '3', 'B1 模糊带'],
    ['formulaBandHigh', '8', 'B1 模糊带'],
    ['codeMinBlocks', '4', '`codeHeavy`'],
    ['tableMinCount', '3', 'H3 表格可读'],
    ['cramCharCount', '1500', '`bigText`'],
  ];
  for (const [key, literal, rowName] of expected) {
    assert.equal(
      String(SCENE_THRESHOLDS[key]),
      literal,
      `SCENE_THRESHOLDS.${key} 与 §1.7 的「${rowName}」行不符`
    );
    const row = ORDER_TABLE.split('\n').find((l) => l.startsWith('|') && l.includes(rowName));
    assert.ok(row?.includes(literal), `§1.7 的「${rowName}」行里应出现 ${literal}`);
  }
});

test('§1.7 表格行数与实际锁住的条数不脱节', () => {
  const rows = ORDER_TABLE.split('\n').filter((l) => l.startsWith('|') && !l.startsWith('|---') && !l.includes('判据表达式'));
  assert.ok(rows.length >= 25, `总表只剩 ${rows.length} 行，判据是不是被删掉了`);
  // 锁住的条数明显少于表格行数时，说明新判据进了表但没进锁
  assert.ok(
    THRESHOLDS.length + 9 >= rows.length,
    `总表有 ${rows.length} 行，但只锁了 ${THRESHOLDS.length}+9 条——新判据进表时要同步加锁`
  );
});

// ─────────────────────────────────────────────────────────────
// 二、FORMAT.md 的行为承诺：直接跑一遍验
// ─────────────────────────────────────────────────────────────

test('FORMAT.md 说 HTML 注释"全链路无视"——切块与渲染都必须真剥', async () => {
  assert.match(FORMAT, /HTML 注释/, 'FORMAT.md 必须仍在声明这条方言');
  const md = `<!-- 给人看的元数据 -->\n\n# 标题\n\n一段正文。`;
  assert.ok(
    !chunkMarkdown(md).some((b) => /给人看的元数据/.test(b.markdown)),
    '切块器必须剥掉注释'
  );
  const { html } = await markdownToHtml(md);
  assert.doesNotMatch(
    html,
    /给人看的元数据/,
    'markdownToHtml 的 html:false 会把注释转义成可见文字，必须先剥（2026-07-30 判例）'
  );
});

test('FORMAT.md §6 声明的内部方言，代码里都还认', () => {
  for (const dialect of ['HH_SOURCE_PAGE', 'halfhalf:source-order=strict', 'data URI']) {
    assert.ok(FORMAT.includes(dialect), `FORMAT.md §6 应当声明方言 ${dialect}`);
  }
  assert.ok(
    src('engine/chunk-markdown.ts').includes('HH_SOURCE_PAGE'),
    'FORMAT.md 说切块器对保真页图特殊处理'
  );
  assert.ok(
    src('engine/ai-structurize.ts').includes(STRICT_ORDER_MARK),
    'FORMAT.md 说严格源序标记由 structurize 写出'
  );
});

test('FORMAT.md 禁用的元素，结构化闸真的拒（抽三类）', async () => {
  const good = '# 标题\n\n## 一节\n\n一段足够长的正文，用来让结构闸有东西可看。';
  assert.equal((await checkStructure(good)).ok, true, '正常文档不许误报');
  for (const [what, bad] of [
    ['超链接', '# 标题\n\n## 一节\n\n见 [官网](https://example.com) 的说明。'],
    ['分隔线', '# 标题\n\n## 一节\n\n一段正文。\n\n---\n\n又一段。'],
    ['Unicode 上下标', '# 标题\n\n## 一节\n\n质能方程写作 E=mc²，其中 c 是光速。'],
  ] as [string, string][]) {
    assert.ok(FORMAT.includes(what) || RULES.includes(what), `FORMAT.md 应当点名禁用「${what}」`);
    assert.equal((await checkStructure(bad)).ok, false, `结构化闸必须拒掉「${what}」`);
  }
});

// ─────────────────────────────────────────────────────────────
// 三、TESTING.md 的结构承诺
// ─────────────────────────────────────────────────────────────

test('TESTING.md §2 点名的每个 L2 测试文件都真实存在', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const present = new Set(readdirSync(dir));
  const named = [...TESTING.matchAll(/`([a-z0-9-]+\.test\.ts)`/g)].map((m) => m[1]);
  assert.ok(named.length >= 8, `TESTING.md 里只解析到 ${named.length} 个测试文件名，格式是不是变了`);
  for (const f of new Set(named)) {
    assert.ok(present.has(f), `TESTING.md §2 点名了 ${f}，但 test/unit/ 下没有这个文件`);
  }
});

test('TESTING.md §2 点名的每个 L1 闸函数都还在代码里', () => {
  const all = ['engine', 'routes']
    .flatMap((d) => readdirSync(path.join(SRC, d)).map((f) => path.join(d, f)))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => src(f))
    .join('\n');
  for (const gate of [
    'checkStructure',
    'checkElementWhitelist',
    'precheckFormulas',
    'isAcceptableTrial',
    'validateDocument',
    'validateInputs',
  ]) {
    assert.ok(TESTING.includes(gate), `TESTING.md §2 应当点名闸 ${gate}`);
    assert.ok(all.includes(`function ${gate}`), `TESTING.md 点名的闸 ${gate} 在代码里找不到定义`);
  }
});

/**
 * TESTING.md §3 立的规矩：门禁强度不能靠读代码猜，每个跑分器头注释必须自报家门。
 * 这条锁的是"规矩本身被执行"——新加一个跑分器忘了写强度，这里就红。
 *
 * 管辖范围从 package.json 反推：**注册成 pnpm 命令的才算跑分器**（它会被当判据用），
 * `run-ab` / `run-grid` / `run-scene` 是开发期诊断工具、只手动 npx 调，不在 §3 之内。
 * 这样界定是自维护的——把一个诊断脚本升格成 pnpm 命令，它自动进入锁的范围。
 */
test('TESTING.md §3：每个注册成 pnpm 命令的跑分器都自报门禁强度', () => {
  const testDir = fileURLToPath(new URL('..', import.meta.url));
  const pkg = JSON.parse(src('../package.json')) as { scripts: Record<string, string> };
  const runners = Object.entries(pkg.scripts)
    .map(([cmd, body]) => [cmd, body.match(/test\/(run-[\w-]+\.ts)/)?.[1]] as const)
    .filter((x): x is readonly [string, string] => Boolean(x[1]));
  assert.ok(runners.length >= 5, `只找到 ${runners.length} 个注册跑分器，package.json 是不是变了`);
  for (const [cmd, file] of runners) {
    const head = readFileSync(path.join(testDir, file), 'utf-8').slice(0, 1200);
    assert.match(
      head,
      /门禁型|对账型|观察型/,
      `${file}（pnpm ${cmd}）的头注释里没写门禁强度——TESTING.md §3 要求每个跑分器自报家门`
    );
  }
});

test('TESTING.md §3 强度表里点名的脚本，package.json 里都有对应命令', () => {
  const pkg = JSON.parse(src('../package.json')) as { scripts: Record<string, string> };
  for (const cmd of ['test', 'bench', 'bench:document', 'bench:research', 'eval', 'qc:render']) {
    assert.ok(TESTING.includes(`pnpm ${cmd}`), `TESTING.md 应当点名 pnpm ${cmd}`);
    assert.ok(pkg.scripts[cmd], `TESTING.md 点名了 pnpm ${cmd}，但 package.json 里没这个脚本`);
  }
});

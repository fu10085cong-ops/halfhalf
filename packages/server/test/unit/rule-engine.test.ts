/**
 * 规则引擎回归（不开浏览器）：十一个 fixture 的行为判例（RULES.md §1.6）。
 * - 单触发画像：引擎参数必须与对应预设完全等价（预设 = 命名快捷方式，不能漂移）
 * - 多触发画像：差异必须恰好是"另一条硬约束的钳制叠加进来"（交集），并给并存提示
 * - 统计口径回归锁：test.md 表格误判、公式计数等修过的 bug 不许复发
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chunkMarkdown } from '../../src/engine/chunk-markdown.js';
import { SCENE_PRESETS, analyzeContent } from '../../src/engine/scene-presets.js';
import { deriveLayoutParams } from '../../src/engine/rule-engine.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const statsOf = (file: string) =>
  analyzeContent(chunkMarkdown(readFileSync(path.join(FIXTURES, file), 'utf-8')));

/** 单触发画像：引擎输出必须与预设逐字段等价 */
const EQUIVALENT: [string, keyof typeof SCENE_PRESETS, string][] = [
  ['os-large.md', 'text-cram', 'S1'],
  ['politics.md', 'text-cram', 'S1'],
  // 真实材料（2026-07-20）：大文本+公式+表格三混合，公式 4.9/千字差 0.1 未过 H1 线，
  // 判 cram 且实际输出可读（短公式不怕挤）——公式线的真材料下界判例
  ['poli-econ.md', 'text-cram', 'S1'],
  ['formula-heavy.md', 'formula', 'H1'],
  ['test.md', 'formula', 'H1'],
  ['calc-monthly.md', 'formula', 'H1'],
  ['image-test.md', 'visual', 'H2'],
  ['code-heavy.md', 'code', 'H4'],
  ['table-heavy.md', 'balanced', 'S3'],
  ['random-topic.md', 'balanced', 'S3'],
];

for (const [file, sceneId, expectedRule] of EQUIVALENT) {
  test(`${file} → ${sceneId}（${expectedRule}）与预设等价`, () => {
    const r = deriveLayoutParams(statsOf(file));
    const preset = SCENE_PRESETS[sceneId];
    assert.equal(r.sceneEquivalent, sceneId);
    assert.ok(r.trace.some((e) => e.rule === expectedRule), `应触发 ${expectedRule}`);
    assert.equal(r.params.density, preset.density);
    assert.equal(r.params.minScale, preset.minScale);
    assert.equal(r.params.maxAspect, preset.maxAspect);
    assert.equal(r.params.gutterMm, preset.gutterMm);
    assert.deepEqual(r.params.widthTiers ?? null, preset.widthTiers ?? null);
    assert.equal(r.warning, undefined, '单触发不该有并存提示');
  });
}

test('image-formula.md：H1∩H2 交集——公式保护与图片让位同时成立', () => {
  const r = deriveLayoutParams(statsOf('image-formula.md'));
  const rules = r.trace.filter((e) => e.kind === 'hard').map((e) => e.rule);
  assert.deepEqual(rules.sort(), ['H1', 'H2']);
  assert.equal(r.params.minScale, 0.85, 'H1 的下界赢过 H2 的 0.7');
  assert.equal(r.params.density, 'compact', 'H2 的密度上界生效');
  assert.deepEqual(r.params.widthTiers, [8, 12, 16, 24], 'H1 削窄档生效');
  assert.ok(r.warning, '多类刚性原子并存应有提示');
});

test('sample.md：H1∩H4 交集恰与公式档参数重合，且有并存提示', () => {
  const r = deriveLayoutParams(statsOf('sample.md'));
  const rules = r.trace.filter((e) => e.kind === 'hard').map((e) => e.rule);
  assert.deepEqual(rules.sort(), ['H1', 'H4']);
  assert.equal(r.params.minScale, 0.85, 'max(0.85, 0.75)');
  assert.ok(r.warning);
});

// ── 统计口径回归锁（修过的 bug 不许复发） ──

test('test.md：表格分隔行不再把 --- 水平线误判成表格（曾报 6 张）', () => {
  const s = statsOf('test.md');
  assert.equal(s.tableCount, 1);
  assert.equal(s.displayFormulaCount, 28, '真实材料的独立公式数（复刻判例曾低估一半）');
});

test('sample.md：代码围栏参与统计（曾被直接摘掉、编程课隐形）', () => {
  assert.equal(statsOf('sample.md').codeBlockCount, 5);
});

test('poli-econ.md（真实）：统计口径锁定——公式 32、表 5、正文远超 cram 线', () => {
  const s = statsOf('poli-econ.md');
  assert.equal(s.displayFormulaCount, 32);
  assert.equal(s.tableCount, 5);
  assert.ok(s.charCount > 5000, `剥后正文应远超 cram 线，实际 ${s.charCount}`);
  const per1000 = (s.displayFormulaCount / s.charCount) * 1000;
  assert.ok(per1000 < 5, `本判例的价值就在公式密度低于保护线（实测 ${per1000.toFixed(1)}），若统计口径变了需重新校准`);
});

test('politics.md：纯文字材料无刚性原子', () => {
  const s = statsOf('politics.md');
  assert.equal(s.displayFormulaCount, 0);
  assert.equal(s.codeBlockCount, 0);
  assert.equal(s.imageBlockCount, 0);
});

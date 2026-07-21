/**
 * 学科层回归（不开浏览器）：
 * - 声明才生效：不声明学科 = 力学层兜底，零参数变化
 * - H3 只在"表=core 的学科 + 表够多"时触发；表=support 不触发
 * - S2 的学科入口：orderRigidity weak → 自动开跨页回填
 * - 纪律检查：每条学科规则的 evidence 非空（防退化硬规矩之一）
 * - 识别只是建议：suggestSubject 不改变任何参数
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chunkMarkdown } from '../../src/engine/chunk-markdown.js';
import { analyzeContent } from '../../src/engine/scene-presets.js';
import { deriveLayoutParams } from '../../src/engine/rule-engine.js';
import { SUBJECT_RULES, suggestSubject } from '../../src/engine/subject-rules.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const read = (f: string) => readFileSync(path.join(FIXTURES, f), 'utf-8');
const statsOf = (f: string) => analyzeContent(chunkMarkdown(read(f)));

test('不声明学科 = 力学层兜底（无 H3/S2，不回填）', () => {
  const r = deriveLayoutParams(statsOf('politics.md'));
  assert.equal(r.params.backfill, false);
  assert.ok(r.trace.every((e) => e.rule !== 'S2' && e.rule !== 'H3'));
});

test('声明 politics（顺序弱）→ S2 自动开跨页回填', () => {
  const r = deriveLayoutParams(statsOf('politics.md'), { subject: SUBJECT_RULES.politics });
  assert.equal(r.params.backfill, true);
  assert.ok(r.trace.some((e) => e.rule === 'S2'));
});

test('table-heavy + 声明 os（表=core）→ H3 触发，minScale 抬到 0.7', () => {
  const r = deriveLayoutParams(statsOf('table-heavy.md'), { subject: SUBJECT_RULES.os });
  assert.ok(r.trace.some((e) => e.rule === 'H3'));
  assert.equal(r.params.minScale, 0.7);
});

test('table-heavy + 声明 politics（表=support）→ H3 不触发', () => {
  const r = deriveLayoutParams(statsOf('table-heavy.md'), { subject: SUBJECT_RULES.politics });
  assert.ok(r.trace.every((e) => e.rule !== 'H3'));
});

test('识别建议：politics.md → politics，test.md → calculus；建议不是声明', () => {
  assert.equal(suggestSubject(read('politics.md'))?.id, 'politics');
  assert.equal(suggestSubject(read('test.md'))?.id, 'calculus');
});

test('纪律：每条学科规则 evidence 非空且不是套话', () => {
  for (const rule of Object.values(SUBJECT_RULES)) {
    assert.ok(rule.evidence.trim().length >= 10, `${rule.id} 的 evidence 太短，写不出观察就别加规则`);
    assert.ok(rule.aliases.length > 0, `${rule.id} 缺关键词`);
  }
});

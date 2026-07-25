/**
 * 特征速查（不开浏览器，毫秒级）：每个 fixture 一行——剥后字数/公式/表格/代码/图片
 * + 规则引擎判定（场景、触发规则、警告）+ 学科识别建议。
 * 实验第一步"现象定位"和第五步"固化对账"都用它；RULES.md §1.6 判例表的特征列以此为准。
 *
 * 用法：
 *   npx tsx test/dump-features.ts               # 全部 fixtures/*.md
 *   npx tsx test/dump-features.ts poli-econ.md  # 只看指定文件（可多个）
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chunkMarkdown } from '../src/engine/chunk-markdown.js';
import { analyzeContent } from '../src/engine/scene-presets.js';
import { deriveLayoutParams } from '../src/engine/rule-engine.js';
import { suggestSubject } from '../src/engine/subject-rules.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const files =
  process.argv.length > 2
    ? process.argv.slice(2)
    : readdirSync(fixturesDir).filter((f) => f.endsWith('.md')).sort();

for (const file of files) {
  const md = readFileSync(path.join(fixturesDir, file), 'utf-8');
  const s = analyzeContent(chunkMarkdown(md));
  const per1000 = s.charCount > 0 ? (s.displayFormulaCount / s.charCount) * 1000 : 0;
  const r = deriveLayoutParams(s);
  const subject = suggestSubject(md);

  console.log(
    `${file.padEnd(18)} ${String(s.charCount).padStart(5)}字 · ` +
      `$$${s.displayFormulaCount}(${per1000.toFixed(1)}/千) · 表${s.tableCount} · ` +
      `码${s.codeBlockCount} · 图${s.imageBlockCount} · ${s.blockCount}块`
  );
  console.log(
    `${''.padEnd(18)} → ${r.sceneEquivalent} [${r.trace.map((e) => e.rule).join(',') || '默认'}]` +
      `${subject ? ` · 学科建议:${subject.id}` : ''}${r.warning ? `\n${''.padEnd(18)} ⚠️ ${r.warning}` : ''}`
  );
}

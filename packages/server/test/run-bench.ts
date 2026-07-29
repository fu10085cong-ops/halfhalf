/**
 * 固定基准跑分器（EXPERIMENT.md「固定基准」节）：一条命令回答"这次改动让引擎变好还是变坏"。
 * **对账型**（强度定义见仓库根 TESTING.md §3）：与冻结基线逐项 diff，由人裁决，不置 exit code。
 *
 *   npx tsx test/run-bench.ts             # 跑固定套件,与 bench-baseline.json 对照,打印 Δ 表
 *   npx tsx test/run-bench.ts --update    # 接受当前结果为新基线(改完引擎、确认提升后执行)
 *
 * 纪律（RULES §4 / 2026-07-26 定调）：
 * - 套件与参数**冻结**——每份材料按它在 RULES §1.6 判例表的条件跑,不许临时改;
 *   加新材料 = 加一行 SUITE + `--update`,在提交里说明。
 * - 改引擎的提交必须附跑分对照;基线更新与引擎改动同一个提交,数字不许口算。
 * - 填充率口径 = **盒面积/内容区面积**（含 gutter、伸展后高度）——与 /api/scene
 *   diagnostics 一致;历史文档里出现过的"内容面积口径"(略低几个点)以本口径为准。
 * - 耗时仅供参考(机器/负载相关),不做回归判据。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chunkMarkdown } from '../src/engine/chunk-markdown.js';
import { analyzeContent } from '../src/engine/scene-presets.js';
import { deriveLayoutParams } from '../src/engine/rule-engine.js';
import { searchAdjudicated } from '../src/engine/adjudicate.js';
import { closeSharedBrowser } from '../src/engine/browser-pool.js';
import { PX_PER_MM } from '../src/engine/measure-blocks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const BASELINE_PATH = path.join(__dirname, 'bench-baseline.json');

/** 冻结套件:文件 × 判例条件(对应 RULES §1.6 各行的实验口径) */
const SUITE = [
  { file: 'poli-econ.md', targetPages: 2, marginMm: 10, reorder: false },
  { file: 'test.md', targetPages: 1, marginMm: 10, reorder: false },
  { file: 'data-analysis.md', targetPages: 2, marginMm: 6, reorder: true },
  { file: 'cs-programming.md', targetPages: 2, marginMm: 10, reorder: false },
  { file: 'os-large.md', targetPages: 2, marginMm: 10, reorder: false },
  { file: 'code-heavy.md', targetPages: 1, marginMm: 10, reorder: false },
  { file: 'prob-band.md', targetPages: 1, marginMm: 10, reorder: false },
  { file: 'network-tables.md', targetPages: 1, marginMm: 10, reorder: false },
  { file: 'word-paste.md', targetPages: 1, marginMm: 10, reorder: false },
  { file: 'history-long.md', targetPages: 2, marginMm: 10, reorder: false },
  // 真实材料（2026-07-26 入库）：编程课/表格课画像的第一批真判例
  { file: 'java-oop.md', targetPages: 2, marginMm: 10, reorder: false },
  { file: 'db-systems.md', targetPages: 2, marginMm: 10, reorder: false },
] as const;

interface BenchRow {
  file: string;
  scene: string;
  fontSize: number;
  pages: number;
  within: boolean;
  /** 每页填充率 %(盒面积/内容区面积,含 gutter、伸展后高度) */
  fills: number[];
  oversized: number;
  cramped: number;
  /** B1 模糊带双跑裁决是否触发 */
  b1: boolean;
  /** 参考值,不做回归判据 */
  ms: number;
}

async function benchOne(entry: (typeof SUITE)[number]): Promise<BenchRow> {
  const markdown = readFileSync(path.join(FIXTURES, entry.file), 'utf-8');
  const blocks = chunkMarkdown(markdown);
  const stats = analyzeContent(blocks);
  const derived = deriveLayoutParams(stats, { allowReorder: entry.reorder, subject: undefined });
  const m = entry.marginMm;
  const started = Date.now();
  const { outcome, derived: finalDerived } = await searchAdjudicated(
    {
      markdown,
      targetPages: entry.targetPages,
      paperSize: 'A4' as const,
      orientation: 'portrait' as const,
      margins: { top: m, bottom: m, left: m, right: m },
      stretchFill: true,
    },
    derived
  );
  const ms = Date.now() - started;
  const { best, grid } = outcome;

  const contentW = grid.unitsX * grid.unitMm;
  const contentH = 297 - 2 * m;
  const pageArea = contentW * contentH;
  const byId = new Map(best.measurements.map((x) => [x.id, x]));
  const fillMm2 = new Map<number, number>();
  for (const pl of best.placements) {
    const mm = byId.get(pl.id);
    if (!mm) continue;
    const st = best.stretched?.[pl.id];
    const hMm = (st ? st.heightPx : mm.heightPx) / PX_PER_MM + grid.gutterMm;
    fillMm2.set(pl.page, (fillMm2.get(pl.page) ?? 0) + pl.span * grid.unitMm * hMm);
  }
  const fills = [...fillMm2.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, area]) => Math.round((area / pageArea) * 100));

  return {
    file: entry.file,
    scene: finalDerived.sceneEquivalent,
    fontSize: best.fontSize,
    pages: best.pages,
    within: outcome.withinTargetPages,
    fills,
    oversized: best.oversized.length,
    cramped: best.cramped.length,
    b1: finalDerived.trace.some((t) => t.rule === 'B1'),
    ms,
  };
}

function fmtDelta(cur: number, base: number | undefined, unit = ''): string {
  if (base === undefined || cur === base) return '';
  const d = cur - base;
  return ` (${d > 0 ? '+' : ''}${Number.isInteger(d) ? d : d.toFixed(1)}${unit})`;
}

async function main() {
  const update = process.argv.includes('--update');
  const baseline: Record<string, BenchRow> = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))
    : {};

  const rows: BenchRow[] = [];
  for (const entry of SUITE) {
    const row = await benchOne(entry);
    rows.push(row);
    const b = baseline[row.file];
    const warn =
      (row.oversized ? ` 超高${row.oversized}` : '') + (row.cramped ? ` cramped${row.cramped}` : '');
    console.log(
      `${row.file.padEnd(20)} ${row.scene.padEnd(9)} ` +
        `${row.fontSize}pt${fmtDelta(row.fontSize, b?.fontSize, 'pt')}  ` +
        `${row.pages}页${fmtDelta(row.pages, b?.pages, '页')}${row.within ? '' : '(未达标)'}  ` +
        `填充 ${row.fills.map((f, i) => `${f}%${fmtDelta(f, b?.fills?.[i])}`).join('/')}` +
        `${row.b1 ? '  ⚖️B1' : ''}${warn}  ${(row.ms / 1000).toFixed(1)}s`
    );
  }

  if (update) {
    const out = Object.fromEntries(rows.map((r) => [r.file, r]));
    writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8');
    console.log(`\n[bench] 基线已更新: ${BASELINE_PATH}`);
  } else if (Object.keys(baseline).length === 0) {
    console.log('\n[bench] 尚无基线——用 --update 生成首轮基线');
  } else {
    const changed = rows.filter((r) => {
      const b = baseline[r.file];
      return (
        !b ||
        b.fontSize !== r.fontSize ||
        b.pages !== r.pages ||
        b.fills.join() !== r.fills.join() ||
        b.oversized !== r.oversized ||
        b.cramped !== r.cramped
      );
    });
    console.log(
      changed.length === 0
        ? '\n[bench] 与基线完全一致'
        : `\n[bench] ${changed.length} 项与基线有出入(见上表括号内 Δ)——提升请 --update 入库,回归请修`
    );
  }
  await closeSharedBrowser();
}

main().catch((err) => {
  console.error('[bench] 失败:', err);
  process.exitCode = 1;
});

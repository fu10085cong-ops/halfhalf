/**
 * AI 产出质量评测器（TESTING.md L3）：固定评测材料 × 真 AI × 确定性指标 × 基线对账。
 * 排版有 `pnpm bench`，AI 环节有的就是这个——回答"改了提示词/换了模型之后产出变好还是变坏"。
 *
 *   pnpm eval                 # 跑全部环节，与 eval-baseline.json 逐项对账
 *   pnpm eval -- structurize  # 只跑一个环节
 *   pnpm eval -- --update     # 接受当前结果为新基线
 *
 * 纪律（同 run-bench）：
 * - 材料与锚点**冻结**在 test/eval/manifest.json，不许为了让数字好看临时改锚点；
 *   加材料 = 加一条 manifest + `--update`，在提交里说明。
 * - 改提示词/换模型的提交必须附评测对照；基线更新与改动放同一个提交。
 * - **对账型不是门禁型**：AI 有随机性，回归不置 exit code，由人裁决（缺 key 才 exit 2）。
 *   唯一的红线是锚点召回率——它下降必须解释，不许当噪声放过。
 * - 打分**不用 AI 评委**：评分器自身漂移会毁掉基线对账。只测能确定性度量的属性。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveServerProvider, structurize } from '../src/engine/ai-structurize.js';
import { compressMarkdown } from '../src/engine/ai-compress.js';
import type { AiProviderConfig, BlockSuggestion } from '../src/types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = path.join(__dirname, 'eval');
const BASELINE_PATH = path.join(EVAL_DIR, 'eval-baseline.json');

interface EvalMaterial {
  file: string;
  portrait: string;
  anchors: string[];
  noise: string[];
}
interface Manifest {
  structurize: EvalMaterial[];
  compress: EvalMaterial[];
}

/**
 * 锚点匹配前的归一化：去掉空白与 Markdown/LaTeX 的装饰字符，只留"内容骨架"。
 * 这样 `$E(X) = np$` 与 `E(X)=np`、代码里的 `lo = mid + 1` 与锚点 `lo=mid+1` 都能对上——
 * 我们要测的是"知识点还在不在"，不是"排版格式一不一样"。
 */
function norm(s: string): string {
  return s.replace(/[\s$*_`\\|~#>-]/g, '');
}

/** 命中的锚点 / 未命中的锚点 */
function matchAnchors(output: string, anchors: string[]): { hit: number; missed: string[] } {
  const haystack = norm(output);
  const missed = anchors.filter((a) => !haystack.includes(norm(a)));
  return { hit: anchors.length - missed.length, missed };
}

/** 被剥除的噪声数（噪声**不在**产出里 = 剥掉了） */
function countStripped(output: string, noise: string[]): number {
  const haystack = norm(output);
  return noise.filter((n) => !haystack.includes(norm(n))).length;
}

const pct = (a: number, b: number): number => (b === 0 ? 100 : Math.round((a / b) * 1000) / 10);

interface EvalRow {
  stage: 'structurize' | 'compress';
  file: string;
  /** 锚点召回率 %（红线指标） */
  anchorRecall: number;
  /** 未命中的锚点（诊断用，不参与对账判定） */
  missed: string[];
  /** 噪声剥除率 % */
  noiseStripped: number;
  /** 产出是否过了该环节自己的闸 */
  gateOk: boolean;
  /** structurize: AI 轮次(1=一次过, 2=修正轮)；compress: 安全网通过的块数 */
  attempts?: number;
  okBlocks?: number;
  totalBlocks?: number;
  /** 正文字数变化 */
  charsIn: number;
  charsOut: number;
  /** 闸未过时的原因（诊断用） */
  problems?: string[];
  ms: number;
}

async function evalStructurize(m: EvalMaterial, provider: AiProviderConfig): Promise<EvalRow> {
  const src = readFileSync(path.join(EVAL_DIR, 'structurize', m.file), 'utf-8');
  const started = Date.now();
  const result = await structurize(src, provider, { onDelta: () => {}, onRetry: () => {} });
  const ms = Date.now() - started;
  const { hit, missed } = matchAnchors(result.markdown, m.anchors);
  return {
    stage: 'structurize',
    file: m.file,
    anchorRecall: pct(hit, m.anchors.length),
    missed,
    noiseStripped: pct(countStripped(result.markdown, m.noise), m.noise.length),
    gateOk: result.check.ok,
    attempts: result.attempts,
    charsIn: src.length,
    charsOut: result.markdown.length,
    problems: result.check.ok ? undefined : result.check.problems,
    ms,
  };
}

/** 「接受全部 ok 建议」后的文档——精简的锚点要在这份合成稿上查 */
function applyAllOk(src: string, suggestions: BlockSuggestion[]): string {
  const accepted = suggestions.filter((s) => s.safety.ok).sort((a, b) => b.range.start - a.range.start);
  let out = src;
  for (const s of accepted) {
    out = out.slice(0, s.range.start) + s.suggested + out.slice(s.range.end);
  }
  return out;
}

async function evalCompress(m: EvalMaterial, provider: AiProviderConfig): Promise<EvalRow> {
  const src = readFileSync(path.join(EVAL_DIR, 'compress', m.file), 'utf-8');
  const started = Date.now();
  const res = await compressMarkdown({ markdown: src, provider });
  const ms = Date.now() - started;
  const merged = applyAllOk(src, res.suggestions);
  const { hit, missed } = matchAnchors(merged, m.anchors);
  // 安全网触发的原因分布——退化时用它定位是哪道网在拦
  const failures = res.suggestions
    .filter((s) => !s.skipped && !s.safety.ok && s.safety.reason)
    .map((s) => s.safety.reason!);
  return {
    stage: 'compress',
    file: m.file,
    anchorRecall: pct(hit, m.anchors.length),
    missed,
    noiseStripped: 100,
    // 精简的"闸"= 没有任何一块因原子丢失/公式错误被拦（未见缩短不算闸失败）
    gateOk: res.suggestions.every((s) => s.safety.atomsPreserved && s.safety.formulaClean),
    okBlocks: res.summary.compressed,
    // 分母只算"够格进 AI 的块"——纯标题/图片/过短块是合法跳过,算进去会低估
    totalBlocks: res.suggestions.filter((s) => !s.skipped).length,
    charsIn: res.summary.charsBefore,
    charsOut: res.summary.charsAfter,
    problems: failures.length > 0 ? [...new Set(failures)] : undefined,
    ms,
  };
}

/** 有界并发，保持结果同序 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/** 与基线的差异等级：red=红线(召回下降/闸翻黑)、yellow=显著、灰=噪声 */
function diffLine(cur: EvalRow, base: EvalRow | undefined): string {
  if (!base) return '  (基线里没有这条——新材料)';
  const notes: string[] = [];
  if (cur.anchorRecall < base.anchorRecall) {
    notes.push(`🔴 锚点召回 ${base.anchorRecall}→${cur.anchorRecall}%（红线,必须解释）`);
  } else if (cur.anchorRecall > base.anchorRecall) {
    notes.push(`🟢 锚点召回 ${base.anchorRecall}→${cur.anchorRecall}%`);
  }
  if (cur.gateOk !== base.gateOk) {
    // structurize 的闸黑 = 产出结构不合格（真回归）；compress 的闸黑 = 安全网拦下了某块，
    // 属于"安全降级、原文保留"，弱模型上本就偶发——降为黄线，别让它刷假红。
    const red = cur.stage === 'structurize';
    notes.push(cur.gateOk ? '🟢 闸由黑转绿' : `${red ? '🔴' : '🟡'} 闸由绿转黑`);
  }
  if (cur.okBlocks !== undefined && base.okBlocks !== undefined && cur.okBlocks !== base.okBlocks) {
    notes.push(`${cur.okBlocks > base.okBlocks ? '🟢' : '🟡'} 采纳块 ${base.okBlocks}→${cur.okBlocks}`);
  }
  const dNoise = cur.noiseStripped - base.noiseStripped;
  if (Math.abs(dNoise) > 5) notes.push(`${dNoise > 0 ? '🟢' : '🟡'} 噪声剥除 ${base.noiseStripped}→${cur.noiseStripped}%`);
  if (cur.attempts !== undefined && base.attempts !== undefined && cur.attempts !== base.attempts) {
    notes.push(`${cur.attempts < base.attempts ? '🟢' : '🟡'} 轮次 ${base.attempts}→${cur.attempts}`);
  }
  const curRate = pct(cur.charsIn - cur.charsOut, cur.charsIn);
  const baseRate = pct(base.charsIn - base.charsOut, base.charsIn);
  if (Math.abs(curRate - baseRate) > 5) notes.push(`🟡 缩减率 ${baseRate}→${curRate}%`);
  return notes.length > 0 ? '  ' + notes.join('  ') : '';
}

function fmtRow(r: EvalRow): string {
  const rate = pct(r.charsIn - r.charsOut, r.charsIn);
  const tail =
    r.stage === 'structurize'
      ? `${r.attempts} 轮 · 噪声剥除 ${r.noiseStripped}%`
      : `${r.okBlocks}/${r.totalBlocks} 块采纳(可精简块)`;
  return (
    `${r.file.padEnd(24)} 锚点 ${String(r.anchorRecall).padStart(5)}%  ` +
    `闸 ${r.gateOk ? '✓' : '✗'}  ${tail} · 字数 ${rate > 0 ? '−' : '+'}${Math.abs(rate)}%  ${(r.ms / 1000).toFixed(1)}s`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const only = args.find((a) => a === 'structurize' || a === 'compress');

  const provider = resolveServerProvider();
  if (!provider) {
    console.error('[eval] 需要 HALFHALF_AI_ENDPOINT / MODEL / KEY 三个环境变量');
    process.exitCode = 2;
    return;
  }

  const manifest = JSON.parse(readFileSync(path.join(EVAL_DIR, 'manifest.json'), 'utf-8')) as Manifest;
  const baseline: Record<string, EvalRow> = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))
    : {};

  const rows: EvalRow[] = [];
  for (const stage of ['structurize', 'compress'] as const) {
    if (only && only !== stage) continue;
    const materials = manifest[stage];
    console.log(`\n=== ${stage}（${materials.length} 份材料）===`);
    // 并发 3：够快，又不至于撞服务商速率限制
    const staged = await mapLimit(materials, 3, (m) =>
      stage === 'structurize' ? evalStructurize(m, provider) : evalCompress(m, provider)
    );
    for (const r of staged) {
      rows.push(r);
      console.log(fmtRow(r));
      const d = diffLine(r, baseline[`${r.stage}/${r.file}`]);
      if (d) console.log(d);
      if (r.missed.length > 0) console.log(`  未命中锚点: ${r.missed.join('、')}`);
      if (r.problems) console.log(`  闸/安全网: ${r.problems.join(' | ')}`);
    }
    const meanRecall = staged.reduce((a, r) => a + r.anchorRecall, 0) / staged.length;
    const gatePass = staged.filter((r) => r.gateOk).length;
    console.log(
      `小计: 平均锚点召回 ${meanRecall.toFixed(1)}% · 闸通过 ${gatePass}/${staged.length}` +
        (stage === 'structurize'
          ? ` · 一次过闸 ${staged.filter((r) => r.attempts === 1 && r.gateOk).length}/${staged.length}`
          : '')
    );
  }

  if (update) {
    const merged = { ...baseline };
    for (const r of rows) merged[`${r.stage}/${r.file}`] = r;
    writeFileSync(BASELINE_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    console.log(`\n[eval] 基线已更新: ${BASELINE_PATH}`);
  } else if (Object.keys(baseline).length === 0) {
    console.log('\n[eval] 尚无基线——用 --update 生成首轮基线');
  } else {
    const red = rows.filter((r) => {
      const b = baseline[`${r.stage}/${r.file}`];
      if (!b) return false;
      // 红线 = 知识丢了(锚点召回下降) 或 结构化产出不合格；
      // compress 的安全网拦截是安全降级，不算红线（见 diffLine）
      return r.anchorRecall < b.anchorRecall || (r.stage === 'structurize' && b.gateOk && !r.gateOk);
    });
    console.log(
      red.length === 0
        ? '\n[eval] 无红线回归（锚点召回未降、闸未转黑）'
        : `\n[eval] 🔴 ${red.length} 项红线回归: ${red.map((r) => r.file).join('、')}——必须解释或修复`
    );
  }
}

main().catch((err) => {
  console.error('[eval] 失败:', err);
  process.exitCode = 1;
});

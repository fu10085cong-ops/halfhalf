/**
 * 场景端到端：分块 → 内容统计 → 场景推荐（或强制指定）→ 公式预检 → 网格搜索 → 渲染。
 * "分类讨论"的入口：内容极多的课走极限文本，公式课走理科公式，截图课走图文混排。
 *
 * 用法：
 *   cd packages/server
 *   npx tsx test/run-scene.ts <文件名> [目标页数] [scene]
 *     scene 省略 = 自动推荐（打印统计和推荐理由）
 *     scene 指定 = 强制预设（text-cram / formula / visual / balanced），模拟"用户可改"
 *
 * 示例：
 *   npx tsx test/run-scene.ts formula-heavy.md 1            # 自动推荐，应命中理科公式
 *   npx tsx test/run-scene.ts formula-heavy.md 1 text-cram  # 强制极限文本，对比公式被缩小的差别
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chunkMarkdown } from '../src/engine/chunk-markdown.js';
import {
  SCENE_PRESETS,
  analyzeContent,
  recommendScene,
  type SceneId,
} from '../src/engine/scene-presets.js';
import { renderGridPdf, searchGridFontSize } from '../src/engine/grid-layout.js';
import { precheckFormulas } from '../src/engine/precheck-formulas.js';
import { closeSharedBrowser } from '../src/engine/browser-pool.js';
import { PX_PER_MM } from '../src/engine/measure-blocks.js';
import { DEFAULT_MARGINS } from '../src/types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const fileName = process.argv[2] || 'random-topic.md';
  const targetPages = Number(process.argv[3] || 1);
  const forcedScene = process.argv[4] as SceneId | undefined;
  const fixturesDir = path.join(__dirname, 'fixtures');
  const markdown = readFileSync(path.join(fixturesDir, fileName), 'utf-8');

  // ① 分块 + 内容统计 + 场景推荐
  const blocks = chunkMarkdown(markdown);
  const stats = analyzeContent(blocks);
  const rec = recommendScene(stats);
  console.log(
    `[run-scene] ${fileName} | 正文≈${stats.charCount}字 独立公式${stats.displayFormulaCount} 行内公式${stats.inlineFormulaCount} 图片块${stats.imageBlockCount} 表格${stats.tableCount} 共${stats.blockCount}块`
  );
  console.log(`[run-scene] 推荐场景: ${SCENE_PRESETS[rec.scene].name}（${rec.scene}）—— ${rec.reason}`);

  if (forcedScene && !SCENE_PRESETS[forcedScene]) {
    throw new Error(`未知场景: ${forcedScene}（可选 ${Object.keys(SCENE_PRESETS).join(' / ')}）`);
  }
  const preset = SCENE_PRESETS[forcedScene ?? rec.scene];
  if (forcedScene) console.log(`[run-scene] 用户强制: ${preset.name}（${preset.id}）`);
  console.log(
    `[run-scene] 预设参数: density=${preset.density} minScale=${preset.minScale} maxAspect=${preset.maxAspect}` +
      `${preset.gutterMm !== undefined ? ` gutter=${preset.gutterMm}mm` : ''}${preset.widthTiers ? ` tiers=${preset.widthTiers.join('/')}` : ''}`
  );

  // ② 公式预检
  const issues = await precheckFormulas(blocks);
  for (const issue of issues) {
    console.log(`[run-scene] ⚠️ 公式错误 @${issue.blockId}「${issue.blockTitle}」: ${issue.message}`);
  }

  // ③ 按预设跑网格搜索
  const outcome = await searchGridFontSize(
    {
      markdown,
      targetPages,
      paperSize: 'A4',
      orientation: 'portrait',
      margins: DEFAULT_MARGINS,
      density: preset.density,
      strategy: preset.strategy,
      minScale: preset.minScale,
      maxAspect: preset.maxAspect,
      gutterMm: preset.gutterMm,
      widthTiers: preset.widthTiers ? [...preset.widthTiers] : undefined,
      imageBaseDir: fixturesDir,
    },
    (t) => console.log(`   试 ${t.fontSize}pt → ${t.pages} 页`)
  );
  const { grid, best } = outcome;

  console.log(`\n[run-scene] 最优字号: ${best.fontSize}pt  实际 ${best.pages} 页  达标: ${outcome.withinTargetPages}`);
  const sizeNote = best.measurements
    .map((m) => {
      const hUnits = Math.ceil((m.heightPx / PX_PER_MM + grid.gutterMm) / grid.unitMm);
      return `${m.id}:${m.span}×${hUnits}格${m.scale < 1 ? `(×${m.scale.toFixed(2)})` : ''}`;
    })
    .join(' ');
  console.log(`[run-scene] 块尺寸: ${sizeNote}`);
  if (best.oversized.length) {
    const hint =
      preset.id === 'formula'
        ? '例题/推导块超过一页高，建议拆小节或精简'
        : '内容会被纵向截断，建议增加目标页数或精简';
    console.log(`[run-scene] ⚠️ 超高块: ${best.oversized.join(', ')}（${hint}）`);
  }
  if (best.cramped.length) console.log(`[run-scene] ⚠️ 缩到下限以下: ${best.cramped.join(', ')}`);

  // ④ 渲染
  const { pdfBuffer, pageCount } = await renderGridPdf(outcome.blocks, best.placements, grid, {
    paperSize: 'A4',
    orientation: 'portrait',
    margins: DEFAULT_MARGINS,
    fontSize: best.fontSize,
    density: preset.density,
    imageBaseDir: fixturesDir,
  });
  const outputPath = path.join(fixturesDir, fileName.replace(/\.md$/, '.scene.pdf'));
  writeFileSync(outputPath, pdfBuffer);
  console.log(`[run-scene] 渲染完成: PDF ${pageCount} 页  输出: ${outputPath}`);
}

main()
  .catch((err) => {
    console.error('[run-scene] 失败:', err);
    process.exitCode = 1;
  })
  .finally(() => closeSharedBrowser());

/**
 * 手动验证脚本：分块 + 测量。把 fixture 切块后，在给定栏宽下量出每块高度，打印出来。
 * 用来确认测量是否合理（块越大高度越大、公式/代码块高度符合预期）。
 *
 * 用法：
 *   cd packages/server
 *   npx tsx test/run-measure.ts [文件名] [栏宽mm] [字号pt] [maxSpan]
 *
 * 示例（A4 竖版三栏，每栏约 (210-20-10)/3 ≈ 60mm）：
 *   npx tsx test/run-measure.ts random-topic.md 60 9 3
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chunkMarkdown } from '../src/engine/chunk-markdown.js';
import { measureBlocks, PX_PER_MM } from '../src/engine/measure-blocks.js';
import { closeSharedBrowser } from '../src/engine/browser-pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const fileName = process.argv[2] || 'random-topic.md';
  const widthMm = Number(process.argv[3] || 60);
  const fontSize = Number(process.argv[4] || 9);
  const maxSpan = Number(process.argv[5] || 3);
  const markdown = readFileSync(path.join(__dirname, 'fixtures', fileName), 'utf-8');

  const blocks = chunkMarkdown(markdown);

  console.log(`[run-measure] 文件: ${fileName}  栏宽: ${widthMm}mm  字号: ${fontSize}pt  maxSpan: ${maxSpan}`);
  console.log(`[run-measure] 切出 ${blocks.length} 块，开始测量...\n`);

  const measurements = await measureBlocks(blocks, {
    columnWidthPx: widthMm * PX_PER_MM,
    columnGapPx: 5 * PX_PER_MM,
    maxSpan,
    fontSize,
    density: 'normal',
  });

  let totalHeightMm = 0;
  for (const m of measurements) {
    const block = blocks.find((b) => b.id === m.id)!;
    const heightMm = m.heightPx / PX_PER_MM;
    totalHeightMm += heightMm;
    const label = block.title || '（前言）';
    const spanNote = m.span > 1 ? ` [跨${m.span}栏]` : '';
    const scaleNote = m.scale < 1 ? ` [缩放×${m.scale.toFixed(2)}]` : '';
    const crampedNote = m.belowMinScale ? ' ⚠️低于可读下限' : '';
    console.log(`  ${m.id.padEnd(9)} ${heightMm.toFixed(0).padStart(4)}mm 高${spanNote}${scaleNote}${crampedNote}   ${label}`);
  }

  // A4 竖版内容区高度约 297-20=277mm；粗略估算需要多少"栏高"
  console.log(`\n[run-measure] 所有块累计高度: ${totalHeightMm.toFixed(0)}mm（跨栏块按其跨栏宽度下的高度计）`);
  console.log(`[run-measure] 参考：A4 竖版内容区约 277mm 高/栏`);
}

main()
  .catch((err) => {
    console.error('[run-measure] 失败:', err);
    process.exitCode = 1;
  })
  .finally(() => closeSharedBrowser());

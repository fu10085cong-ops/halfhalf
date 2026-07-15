/**
 * 手动验证脚本：把 fixture 跑一遍分块器，打印每个内容块的标题、层级和字符数，
 * 用来肉眼确认分块粒度是否合理（不需要浏览器）。
 *
 * 用法：
 *   cd packages/server
 *   npx tsx test/run-chunk.ts [文件名] [splitLevel]
 *
 * 示例：
 *   npx tsx test/run-chunk.ts random-topic.md        # 默认按 <=2 级标题切
 *   npx tsx test/run-chunk.ts random-topic.md 3      # 按 <=3 级标题切（更细）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chunkMarkdown } from '../src/engine/chunk-markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fileName = process.argv[2] || 'random-topic.md';
const splitLevel = Number(process.argv[3] || 2);
const markdown = readFileSync(path.join(__dirname, 'fixtures', fileName), 'utf-8');

const blocks = chunkMarkdown(markdown, { splitLevel });

console.log(`[run-chunk] 文件: ${fileName}  splitLevel: ${splitLevel}`);
console.log(`[run-chunk] 共切出 ${blocks.length} 个块：\n`);

for (const b of blocks) {
  const label = b.title || '（前言）';
  const preview = b.markdown.replace(/\n/g, ' ').slice(0, 40);
  console.log(
    `  ${b.id.padEnd(9)} L${b.level}  ${String(b.markdown.length).padStart(5)}字  ${label}`
  );
  console.log(`            ${preview}${b.markdown.length > 40 ? '…' : ''}`);
}

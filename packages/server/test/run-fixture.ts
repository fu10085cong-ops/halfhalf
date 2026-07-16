/**
 * 手动验证脚本：直接调用排版引擎跑指定的 markdown 文件，不经过 HTTP/SSE。
 * 用于快速排查 Mermaid 路径解析、KaTeX 字体加载、Shiki 高亮等本地环境相关的集成风险点。
 *
 * 用法：
 *   cd packages/server
 *   npx tsx test/run-fixture.ts [targetPages] [文件名（相对 fixtures/ 目录）] [orientation] [columns]
 *
 * 示例：
 *   npx tsx test/run-fixture.ts 2                                # 默认跑 fixtures/sample.md，目标 2 页，竖版单栏
 *   npx tsx test/run-fixture.ts 2 random-topic.md landscape      # 横版单栏
 *   npx tsx test/run-fixture.ts 2 random-topic.md portrait 2     # 竖版固定 2 栏
 *   npx tsx test/run-fixture.ts 2 random-topic.md portrait auto  # 竖版自动挑栏数
 *   npx tsx test/run-fixture.ts 2 random-topic.md auto auto      # 方向和栏数都自动，全局择优
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { searchOptimalFontSize } from '../src/engine/binary-search.js';
import { closeSharedBrowser } from '../src/engine/browser-pool.js';
import { DEFAULT_MARGINS, type Columns, type Orientation } from '../src/types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseColumns(arg: string | undefined): Columns {
  if (!arg || arg === '1') return 1;
  if (arg === 'auto') return 'auto';
  const n = Number(arg);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

async function main() {
  const targetPages = Number(process.argv[2] || 2);
  const fileName = process.argv[3] || 'sample.md';
  const orientation = (process.argv[4] || 'portrait') as Orientation;
  const columns = parseColumns(process.argv[5]);
  const fixturePath = path.join(__dirname, 'fixtures', fileName);
  const markdown = readFileSync(fixturePath, 'utf-8');

  console.log(`[run-fixture] 输入文件: ${fileName}`);
  console.log(`[run-fixture] 目标页数: ${targetPages}`);
  console.log(`[run-fixture] 纸张方向: ${orientation}`);
  console.log(`[run-fixture] 分栏数: ${columns}`);
  console.log('[run-fixture] 开始二分搜索...');

  const outcome = await searchOptimalFontSize(
    {
      markdown,
      targetPages,
      paperSize: 'A4',
      margins: DEFAULT_MARGINS,
      density: 'normal',
      precision: 0.5,
      orientation,
      columns,
    },
    (record) => {
      console.log(
        `  迭代[${record.orientation}/${record.columns}栏]: fontSize=${record.fontSize}pt pages=${record.pages} withinLimit=${record.withinLimit}`
      );
    }
  );

  const outputName = fileName.replace(/\.md$/, '.output.pdf');
  const outputPath = path.join(__dirname, 'fixtures', outputName);
  writeFileSync(outputPath, outcome.pdfBuffer);

  console.log('[run-fixture] 完成');
  console.log(`  最佳字号: ${outcome.optimalFontSize}pt`);
  console.log(`  最终方向: ${outcome.orientation}`);
  console.log(`  最终栏数: ${outcome.columns}`);
  console.log(`  实际页数: ${outcome.actualPages}`);
  console.log(`  是否达标: ${outcome.actualPages <= targetPages}`);
  console.log(`  迭代次数: ${outcome.iterations}`);
  console.log(`  PDF 输出: ${outputPath}`);
}

main()
  .catch((err) => {
    console.error('[run-fixture] 失败:', err);
    process.exitCode = 1;
  })
  // 流式引擎现在也走共享浏览器，不关掉子进程会拖住 Node 不退出
  .finally(() => closeSharedBrowser());

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { importTextPdf, selectPdfVisualPages } from '../src/engine/document-import.js';
import { countSuspiciousCharacters } from '../src/engine/knowledge-ir.js';

const input = process.argv.slice(2).find((argument) => argument !== '--') || process.env.HALFHALF_PDF_BENCH_FILE;
if (!input) {
  console.error('Usage: pnpm bench:document -- <path-to-pdf>');
  process.exit(2);
}

const absolutePath = path.resolve(input);
const buffer = await readFile(absolutePath);
const startedAt = performance.now();
const imported = await importTextPdf(buffer, path.basename(absolutePath), buffer.length);
const elapsedMs = Math.round(performance.now() - startedAt);
const pageHeadings = [...imported.markdown.matchAll(/^##\s+\u7b2c\s+(\d+)\s+\u9875$/gmu)].map(
  (match) => Number(match[1])
);
const expectedOrder = Array.from(
  { length: imported.summary.pageCount ?? 0 },
  (_, index) => index + 1
);
const orderPreserved = JSON.stringify(pageHeadings) === JSON.stringify(expectedOrder);
const editableSuspiciousChars = countSuspiciousCharacters(imported.markdown);
const visualPageCount = (imported.markdown.match(/HH_SOURCE_PAGE_\d+/gu) ?? []).length;
const legacyPlaceholderCount = (
  imported.markdown.match(/\u516c\u5f0f\/\u7b26\u53f7\u533a\u57df\u5f85\u8bc6\u522b/gu) ?? []
).length;
const expectedVisualPages = selectPdfVisualPages(
  imported.summary.quality?.pages ?? [],
  imported.summary.pageCount ?? 0
);
const anchoredNodes = imported.knowledge?.nodes.filter(
  (node) => node.sourceAnchors.length > 0 && node.sourceAnchors.every((anchor) => anchor.page)
).length ?? 0;

const result = {
  file: path.basename(absolutePath),
  sizeBytes: buffer.length,
  elapsedMs,
  pageCount: imported.summary.pageCount,
  textPageCount: imported.summary.textPageCount,
  characterCount: imported.summary.characterCount,
  knowledgeNodeCount: imported.knowledge?.nodes.length ?? 0,
  anchoredNodes,
  sourceOrder: imported.knowledge?.sourceOrder,
  pageHeadings,
  orderPreserved,
  editableSuspiciousChars,
  quality: imported.summary.quality,
  visualPageCount,
  expectedVisualPageCount: expectedVisualPages.length,
  legacyPlaceholderCount,
  warnings: imported.summary.warnings,
  gates: {
    completedWithinFiveMinutes: elapsedMs < 300_000,
    allNodesAnchored: anchoredNodes === (imported.knowledge?.nodes.length ?? 0),
    strictPageOrder: orderPreserved,
    noPrivateUseCharactersInMarkdown: editableSuspiciousChars === 0,
    visualFallbackCoverage: visualPageCount === expectedVisualPages.length,
    noLegacyPlaceholders: legacyPlaceholderCount === 0,
    imageBase64ExcludedFromCharacterCount: visualPageCount === 0 || imported.summary.characterCount < imported.markdown.length / 10,
  },
};

console.log(JSON.stringify(result, null, 2));

if (
  !result.gates.completedWithinFiveMinutes ||
  !result.gates.allNodesAnchored ||
  !result.gates.strictPageOrder ||
  !result.gates.noPrivateUseCharactersInMarkdown ||
  !result.gates.visualFallbackCoverage ||
  !result.gates.noLegacyPlaceholders ||
  !result.gates.imageBase64ExcludedFromCharacterCount
) {
  process.exitCode = 1;
}

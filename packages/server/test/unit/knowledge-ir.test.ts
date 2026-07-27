import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildKnowledgeDocument,
  countSuspiciousCharacters,
  sanitizeExtractedText,
} from '../../src/engine/knowledge-ir.js';

test('legacy PDF private-use characters are detected and removed from editable text', () => {
  const raw = `E = ${String.fromCharCode(0xe001)} ${String.fromCharCode(0xe002)} H`;
  assert.equal(countSuspiciousCharacters(raw), 2);
  const clean = sanitizeExtractedText(raw);
  assert.doesNotMatch(clean, /[\uE000-\uF8FF]/u);
  assert.match(clean, /E =/);
});

test('KnowledgeIR preserves page anchors and routes suspicious pages to hybrid parsing', () => {
  const document = buildKnowledgeDocument({
    fileHash: 'abc123',
    pageCount: 2,
    blocks: [
      {
        id: 'p1-b1',
        page: 1,
        text: 'Boundary condition definition',
        bbox: [0.1, 0.2, 0.8, 0.3],
        fontHeight: 12,
      },
      {
        id: 'p2-b1',
        page: 2,
        text: `formula ${String.fromCharCode(0xe111)}`,
        bbox: [0.2, 0.4, 0.6, 0.5],
        fontHeight: 10,
      },
    ],
  });

  assert.equal(document.sourceOrder, 'strict');
  assert.equal(document.nodes.length, 2);
  assert.deepEqual(document.nodes[0].sourceAnchors[0].bbox, [0.1, 0.2, 0.8, 0.3]);
  assert.equal(document.nodes[1].kind, 'formula');
  assert.equal(document.nodes[1].requiresVisualFallback, true);
  assert.equal(document.nodes[1].sourceAnchors[0].method, 'visual-fallback');
  assert.equal(document.quality?.nativePageCount, 1);
  assert.equal(document.quality?.hybridPageCount, 1);
});

test('a page with no native blocks is explicitly routed to OCR', () => {
  const document = buildKnowledgeDocument({
    fileHash: 'empty-page',
    pageCount: 2,
    blocks: [
      {
        id: 'p1-b1',
        page: 1,
        text: 'native text',
        bbox: [0, 0, 1, 0.1],
        fontHeight: 10,
      },
    ],
  });

  assert.equal(document.quality?.pages[1].page, 2);
  assert.equal(document.quality?.pages[1].route, 'ocr');
  assert.equal(document.quality?.ocrPageCount, 1);
});

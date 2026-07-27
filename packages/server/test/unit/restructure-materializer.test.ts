import assert from 'node:assert/strict';
import test from 'node:test';
import { materializeRestructure, MaterializeError } from '../../src/engine/restructure-materializer.js';
import { createRestructurePlan } from '../../src/engine/restructure-plan.js';
import type { KnowledgeDocument } from '../../src/types/index.js';

const document: KnowledgeDocument = {
  schemaVersion: 1,
  fileHash: 'materialize-fixture',
  sourceOrder: 'strict',
  pageCount: 2,
  nodes: [
    {
      id: 'cover',
      kind: 'text',
      text: 'teacher metadata',
      sourceAnchors: [{ page: 1, method: 'native-text' }],
      dependencies: [],
      confidence: 1,
      orderRigidity: 'soft',
      requiresVisualFallback: false,
    },
    {
      id: 'core',
      kind: 'formula',
      text: 'core equation',
      sourceAnchors: [{ page: 2, method: 'visual-fallback' }],
      dependencies: [],
      confidence: 0.3,
      orderRigidity: 'strict',
      requiresVisualFallback: true,
    },
  ],
};

const sourceMarkdown = [
  '<!-- halfhalf:source-order=strict -->',
  '## \u7b2c 1 \u9875',
  '![HH_SOURCE_PAGE_1](halfhalf-image://page-one)',
  '## \u7b2c 2 \u9875',
  '![HH_SOURCE_PAGE_2](halfhalf-image://page-two)',
].join('\n\n');

test('materializer omits whole visual pages only when every node is omitted', () => {
  const plan = createRestructurePlan(document, {
    goal: 'review',
    targetPages: 1,
    omitNodeIds: ['cover'],
    mustKeepNodeIds: ['core'],
  });
  const result = materializeRestructure(document, plan, sourceMarkdown);

  assert.equal(result.summary.omittedPages, 1);
  assert.equal(result.summary.keptPages, 1);
  assert.equal(result.summary.visualPages, 1);
  assert.doesNotMatch(result.markdown, /HH_SOURCE_PAGE_1/);
  assert.match(result.markdown, /HH_SOURCE_PAGE_2/);
  assert.match(result.markdown, /\u5fc5\u7559/u);
});

test('materialization is deterministic and source-grounded', () => {
  const plan = createRestructurePlan(document, {
    goal: 'review',
    targetPages: 2,
    mustKeepNodeIds: ['core'],
  });
  const first = materializeRestructure(document, plan, sourceMarkdown);
  const second = materializeRestructure(document, plan, sourceMarkdown);

  assert.equal(first.revisionId, second.revisionId);
  assert.equal(first.markdown, second.markdown);
  assert.equal((first.markdown.match(/HH_SOURCE_PAGE_/g) ?? []).length, 2);
  assert.ok(first.operations.some((operation) => operation.nodeId === 'core'));
});

test('materializer rejects a plan from another source file', () => {
  const plan = createRestructurePlan(document, { goal: 'review', targetPages: 2 });
  const wrongDocument = { ...document, fileHash: 'other-source' };

  assert.throws(
    () => materializeRestructure(wrongDocument, plan, sourceMarkdown),
    (error: unknown) => error instanceof MaterializeError
  );
});

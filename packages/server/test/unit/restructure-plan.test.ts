import assert from 'node:assert/strict';
import test from 'node:test';
import { createRestructurePlan } from '../../src/engine/restructure-plan.js';
import type { KnowledgeDocument } from '../../src/types/index.js';

const document: KnowledgeDocument = {
  schemaVersion: 1,
  fileHash: 'focus-fixture',
  sourceOrder: 'strict',
  pageCount: 2,
  nodes: [
    {
      id: 'maxwell',
      kind: 'formula',
      text: 'Maxwell equations',
      sourceAnchors: [{ page: 1, bbox: [0, 0, 1, 0.2], method: 'native-text' }],
      dependencies: [],
      confidence: 1,
      orderRigidity: 'strict',
      requiresVisualFallback: false,
    },
    {
      id: 'boundary',
      kind: 'condition',
      text: 'Boundary conditions and physical meaning',
      sourceAnchors: [{ page: 1, bbox: [0, 0.2, 1, 0.4], method: 'native-text' }],
      dependencies: ['maxwell'],
      confidence: 1,
      orderRigidity: 'strict',
      requiresVisualFallback: false,
    },
    {
      id: 'legacy-formula',
      kind: 'formula',
      text: 'formula region pending recognition',
      sourceAnchors: [{ page: 2, bbox: [0, 0, 1, 0.2], method: 'visual-fallback' }],
      dependencies: [],
      confidence: 0.2,
      orderRigidity: 'strict',
      requiresVisualFallback: true,
    },
    {
      id: 'teacher',
      kind: 'text',
      text: '\u8096\u9ad8\u6807 \u6559\u6388 Email: teacher@example.edu',
      sourceAnchors: [{ page: 2, bbox: [0, 0.8, 1, 1], method: 'native-text' }],
      dependencies: [],
      confidence: 1,
      orderRigidity: 'soft',
      requiresVisualFallback: false,
    },
  ],
};

test('explicit must-keep wins over omit and is never silently removed', () => {
  const plan = createRestructurePlan(document, {
    goal: 'exam review',
    targetPages: 4,
    mustKeepNodeIds: ['maxwell'],
    omitNodeIds: ['maxwell', 'teacher'],
  });

  const maxwell = plan.decisions.find((item) => item.nodeId === 'maxwell');
  const teacher = plan.decisions.find((item) => item.nodeId === 'teacher');
  assert.equal(maxwell?.priority, 'must');
  assert.notEqual(maxwell?.action, 'omit');
  assert.equal(teacher?.action, 'omit');
  assert.match(plan.warnings.join('\n'), /must wins/);
});

test('focus topics raise matching nodes and control explanation depth', () => {
  const plan = createRestructurePlan(document, {
    goal: 'explain boundary conditions',
    targetPages: 4,
    topics: [
      {
        query: 'Boundary conditions',
        priority: 'must',
        explanationDepth: 'deep',
      },
    ],
  });

  const boundary = plan.decisions.find((item) => item.nodeId === 'boundary');
  assert.equal(boundary?.priority, 'must');
  assert.equal(boundary?.explanationDepth, 'deep');
  assert.equal(boundary?.action, 'explain');
  assert.equal(boundary?.areaWeight, 4);
});

test('low-confidence formula nodes keep source visuals until OCR is confirmed', () => {
  const plan = createRestructurePlan(document, {
    goal: 'formula sheet',
    targetPages: 2,
  });

  const formula = plan.decisions.find((item) => item.nodeId === 'legacy-formula');
  assert.equal(formula?.action, 'visual_keep');
  assert.equal(plan.summary.visualFallbacks, 1);
  assert.equal(formula?.sourceAnchors[0].page, 2);
});

test('omit topics override defaults and understand common metadata intent', () => {
  const plan = createRestructurePlan(document, {
    goal: 'exam review',
    targetPages: 2,
    topics: [
      {
        query: '\u6559\u5e08\u4fe1\u606f',
        priority: 'omit',
        explanationDepth: 'none',
      },
    ],
  });

  const teacher = plan.decisions.find((item) => item.nodeId === 'teacher');
  const maxwell = plan.decisions.find((item) => item.nodeId === 'maxwell');
  assert.equal(teacher?.priority, 'omit');
  assert.equal(teacher?.action, 'omit');
  assert.notEqual(maxwell?.priority, 'omit');
  assert.equal(plan.summary.omitted, 1);
});

test('a specific formula topic does not promote every formula node', () => {
  const specificDocument: KnowledgeDocument = {
    schemaVersion: 1,
    fileHash: 'specific-formula',
    sourceOrder: 'strict',
    pageCount: 2,
    nodes: [
      {
        id: 'maxwell-cn',
        kind: 'formula',
        text: '\u9ea6\u514b\u65af\u97e6\u65b9\u7a0b',
        sourceAnchors: [{ page: 1, method: 'native-text' }],
        dependencies: [],
        confidence: 1,
        orderRigidity: 'strict',
        requiresVisualFallback: false,
      },
      {
        id: 'fourier-cn',
        kind: 'formula',
        text: '\u5085\u91cc\u53f6\u53d8\u6362\u516c\u5f0f',
        sourceAnchors: [{ page: 2, method: 'native-text' }],
        dependencies: [],
        confidence: 1,
        orderRigidity: 'strict',
        requiresVisualFallback: false,
      },
    ],
  };
  const plan = createRestructurePlan(specificDocument, {
    goal: 'exam review',
    targetPages: 2,
    topics: [
      {
        query: '\u9ea6\u514b\u65af\u97e6\u65b9\u7a0b',
        priority: 'must',
        explanationDepth: 'deep',
      },
    ],
  });

  assert.equal(plan.decisions.find((item) => item.nodeId === 'maxwell-cn')?.priority, 'must');
  assert.notEqual(plan.decisions.find((item) => item.nodeId === 'fourier-cn')?.priority, 'must');
});

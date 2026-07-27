import type {
  ExplanationDepth,
  FocusPriority,
  FocusSpec,
  FocusTopic,
  KnowledgeDocument,
  KnowledgeNode,
  RestructurePlan,
  TransformAction,
  TransformDecision,
} from '../types/index.js';

const PRIORITY_RANK: Record<FocusPriority, number> = {
  omit: 0,
  supporting: 1,
  key: 2,
  must: 3,
};

const AREA_WEIGHT: Record<FocusPriority, number> = {
  omit: 0,
  supporting: 1,
  key: 2.5,
  must: 4,
};

export class FocusSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FocusSpecError';
  }
}

function normalizeText(text: string): string {
  return text.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function queryParts(query: string): string[] {
  const normalized = query.toLocaleLowerCase().trim();
  const parts = normalized
    .split(/[\s,;|/]+/u)
    .map((part) => normalizeText(part))
    .filter((part) => part.length >= 2);
  return parts.length > 0 ? [...new Set(parts)] : [normalizeText(normalized)].filter(Boolean);
}

function semanticIntentMatch(topic: FocusTopic, node: KnowledgeNode): boolean {
  const query = normalizeText(topic.query);
  const source = `${node.text} ${node.rawText ?? ''}`;
  const kindIntents: Array<[KnowledgeNode['kind'], string[]]> = [
    ['formula', ['\u516c\u5f0f', '\u65b9\u7a0b']],
    ['example', ['\u4f8b\u9898', '\u4e60\u9898', '\u6848\u4f8b']],
    ['definition', ['\u5b9a\u4e49', '\u6982\u5ff5']],
    ['condition', ['\u9002\u7528\u6761\u4ef6', '\u8fb9\u754c\u6761\u4ef6']],
    ['warning', ['\u6613\u9519', '\u6ce8\u610f\u4e8b\u9879']],
  ];
  for (const [kind, intents] of kindIntents) {
    if (
      node.kind === kind &&
      intents.some((intent) => query === intent || query === `\u6240\u6709${intent}`)
    ) {
      return true;
    }
  }

  const metadataIntents = [
    '\u6559\u5e08\u4fe1\u606f',
    '\u8001\u5e08\u4fe1\u606f',
    '\u8054\u7cfb\u65b9\u5f0f',
    '\u5c01\u9762\u4fe1\u606f',
  ];
  if (
    metadataIntents.some((intent) => query.includes(intent)) &&
    /(\u6559\u6388|\u8001\u5e08|\u6559\u5e08|\u529e\u516c\u5ba4|email|\u5b66\u9662|\u7cfb)/iu.test(source)
  ) {
    return true;
  }

  return false;
}

function topicMatchScore(topic: FocusTopic, node: KnowledgeNode): number {
  const nodeText = normalizeText(`${node.text} ${node.rawText ?? ''}`);
  const parts = queryParts(topic.query);
  if (parts.length === 0 || !nodeText) return 0;
  if (nodeText.includes(normalizeText(topic.query))) return 1;
  if (semanticIntentMatch(topic, node)) return 1;
  const matched = parts.filter((part) => nodeText.includes(part)).length;
  return matched / parts.length;
}

function strongerPriority(a: FocusPriority, b: FocusPriority): FocusPriority {
  return PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b;
}

function defaultPriority(node: KnowledgeNode): FocusPriority {
  if (node.kind === 'heading' || node.kind === 'definition' || node.kind === 'condition') {
    return 'key';
  }
  if (node.kind === 'formula' || node.kind === 'warning') return 'key';
  return 'supporting';
}

function actionFor(
  node: KnowledgeNode,
  priority: FocusPriority,
  depth: ExplanationDepth
): TransformAction {
  if (priority === 'omit') return 'omit';
  if (node.requiresVisualFallback) return 'visual_keep';
  if (priority === 'must') return depth === 'deep' ? 'explain' : 'keep_exact';
  if (priority === 'key') return depth === 'none' ? 'keep_exact' : 'explain';
  return depth === 'none' ? 'keep_exact' : 'summarize';
}

function validateDocument(document: KnowledgeDocument): void {
  if (document.schemaVersion !== 1 || !document.fileHash || !Array.isArray(document.nodes)) {
    throw new FocusSpecError('document must be a valid KnowledgeIR v1 payload');
  }
  const ids = new Set<string>();
  for (const node of document.nodes) {
    if (!node.id || ids.has(node.id)) {
      throw new FocusSpecError(`duplicate or empty knowledge node id: ${node.id || '(empty)'}`);
    }
    ids.add(node.id);
  }
}

export function normalizeFocusSpec(focus: FocusSpec): FocusSpec {
  if (!focus || typeof focus.goal !== 'string') {
    throw new FocusSpecError('focus.goal must be a string');
  }
  if (!Number.isInteger(focus.targetPages) || focus.targetPages < 1 || focus.targetPages > 50) {
    throw new FocusSpecError('focus.targetPages must be an integer from 1 to 50');
  }
  if (focus.minFontPt !== undefined && (focus.minFontPt < 6 || focus.minFontPt > 18)) {
    throw new FocusSpecError('focus.minFontPt must be from 6 to 18');
  }
  const topics = (focus.topics ?? [])
    .filter((topic) => topic && typeof topic.query === 'string' && topic.query.trim())
    .map((topic) => ({
      query: topic.query.trim(),
      priority: topic.priority,
      explanationDepth: topic.explanationDepth,
    }));
  return {
    ...focus,
    goal: focus.goal.trim(),
    targetPages: focus.targetPages,
    minFontPt: focus.minFontPt ?? 8,
    defaultExplanationDepth: focus.defaultExplanationDepth ?? 'brief',
    mustKeepNodeIds: [...new Set(focus.mustKeepNodeIds ?? [])],
    omitNodeIds: [...new Set(focus.omitNodeIds ?? [])],
    topics,
  };
}

export function createRestructurePlan(
  document: KnowledgeDocument,
  rawFocus: FocusSpec
): RestructurePlan {
  validateDocument(document);
  const focus = normalizeFocusSpec(rawFocus);
  const knownIds = new Set(document.nodes.map((node) => node.id));
  const must = new Set(focus.mustKeepNodeIds);
  const omit = new Set(focus.omitNodeIds);
  const warnings: string[] = [];

  for (const id of [...must, ...omit]) {
    if (!knownIds.has(id)) warnings.push(`focus references unknown node: ${id}`);
  }
  for (const id of must) {
    if (omit.has(id)) warnings.push(`node ${id} is both must and omit; must wins`);
  }

  const decisions: TransformDecision[] = document.nodes.map((node) => {
    let priority = defaultPriority(node);
    let depth = focus.defaultExplanationDepth ?? 'brief';
    let reason = `default ${node.kind} policy`;

    for (const topic of focus.topics ?? []) {
      const score = topicMatchScore(topic, node);
      if (score < 0.5 || topic.priority === 'omit' || topic.priority === 'must') continue;
      const next = strongerPriority(priority, topic.priority);
      if (next !== priority && next !== topic.priority) continue;
      priority = next;
      depth = topic.explanationDepth ?? depth;
      reason = `matched focus topic: ${topic.query}`;
    }

    const matchedOmit = (focus.topics ?? []).find(
      (topic) => topic.priority === 'omit' && topicMatchScore(topic, node) >= 0.5
    );
    const matchedMust = (focus.topics ?? []).find(
      (topic) => topic.priority === 'must' && topicMatchScore(topic, node) >= 0.5
    );
    if (matchedOmit) {
      priority = 'omit';
      depth = 'none';
      reason = `matched omit topic: ${matchedOmit.query}`;
    }
    if (matchedMust) {
      priority = 'must';
      depth = matchedMust.explanationDepth ?? depth;
      reason = `matched must topic: ${matchedMust.query}`;
    }

    if (omit.has(node.id) && !must.has(node.id)) {
      priority = 'omit';
      depth = 'none';
      reason = 'explicit omit node';
    }

    if (must.has(node.id)) {
      priority = 'must';
      reason = 'explicit must-keep node';
    }

    const action = actionFor(node, priority, depth);
    if (node.requiresVisualFallback && priority !== 'omit') {
      reason += '; low-confidence symbols require source visual';
    }
    return {
      nodeId: node.id,
      priority,
      action,
      explanationDepth: depth,
      areaWeight: AREA_WEIGHT[priority],
      reason,
      sourceAnchors: node.sourceAnchors,
    };
  });

  const summary = {
    mustKeep: decisions.filter((item) => item.priority === 'must').length,
    key: decisions.filter((item) => item.priority === 'key').length,
    supporting: decisions.filter((item) => item.priority === 'supporting').length,
    omitted: decisions.filter((item) => item.priority === 'omit').length,
    visualFallbacks: decisions.filter((item) => item.action === 'visual_keep').length,
  };
  if (summary.visualFallbacks > 0) {
    warnings.push(`${summary.visualFallbacks} nodes require source visuals until OCR is confirmed`);
  }

  return {
    schemaVersion: 1,
    fileHash: document.fileHash,
    focus,
    decisions,
    summary,
    warnings,
  };
}

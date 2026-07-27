import { createHash } from 'node:crypto';
import type {
  KnowledgeDocument,
  RestructurePlan,
  TransformDecision,
} from '../types/index.js';

export interface MaterializeOperation {
  type: 'keep-source-page' | 'omit-source-page' | 'keep-node' | 'omit-node';
  page?: number;
  nodeId?: string;
  reason: string;
}

export interface MaterializeResult {
  schemaVersion: 1;
  revisionId: string;
  markdown: string;
  operations: MaterializeOperation[];
  summary: {
    keptPages: number;
    omittedPages: number;
    keptNodes: number;
    omittedNodes: number;
    visualPages: number;
  };
  warnings: string[];
}

export class MaterializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterializeError';
  }
}

interface SourcePageSection {
  page: number;
  markdown: string;
  visual: boolean;
}

function splitSourcePages(markdown: string): SourcePageSection[] {
  const matches = [...markdown.matchAll(/^##\s+\u7b2c\s+(\d+)\s+\u9875\s*$/gmu)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? markdown.length;
    const section = markdown.slice(start, end).trim();
    return {
      page: Number(match[1]),
      markdown: section,
      visual: /!\[HH_SOURCE_PAGE_\d+\]\(/u.test(section),
    };
  });
}

function decisionRank(decision: TransformDecision): number {
  return { omit: 0, supporting: 1, key: 2, must: 3 }[decision.priority];
}

function pageHeading(page: number, decisions: TransformDecision[]): string {
  const strongest = [...decisions].sort((a, b) => decisionRank(b) - decisionRank(a))[0];
  if (!strongest || strongest.priority === 'supporting') return `## \u7b2c ${page} \u9875`;
  const label = strongest.priority === 'must' ? '\u5fc5\u7559' : '\u91cd\u70b9';
  const topic = strongest.reason.match(/matched (?:must|focus) topic:\s*([^;]+)/u)?.[1]?.trim();
  return `## \u7b2c ${page} \u9875 \u00b7 ${label}${topic ? `\uff1a${topic.slice(0, 28)}` : ''}`;
}

function replacePageHeading(section: string, heading: string): string {
  return section.replace(/^##\s+\u7b2c\s+\d+\s+\u9875\s*$/mu, heading);
}

function cleanNodeText(text: string): string {
  return text
    .replace(/[\uE000-\uF8FF\uFFFD\u25A1]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function sourcePageForDecision(decision: TransformDecision): number | undefined {
  return decision.sourceAnchors.find((anchor) => anchor.page !== undefined)?.page;
}

function validateInputs(
  document: KnowledgeDocument,
  plan: RestructurePlan,
  sourceMarkdown: string
): void {
  if (!sourceMarkdown.trim()) throw new MaterializeError('sourceMarkdown is required');
  if (document.schemaVersion !== 1 || plan.schemaVersion !== 1) {
    throw new MaterializeError('KnowledgeIR v1 and RestructurePlan v1 are required');
  }
  if (document.fileHash !== plan.fileHash) {
    throw new MaterializeError('plan does not belong to this source document');
  }
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  for (const decision of plan.decisions) {
    if (!nodeIds.has(decision.nodeId)) {
      throw new MaterializeError(`plan references unknown node: ${decision.nodeId}`);
    }
  }
}

export function materializeRestructure(
  document: KnowledgeDocument,
  plan: RestructurePlan,
  sourceMarkdown: string
): MaterializeResult {
  validateInputs(document, plan, sourceMarkdown);
  const sections = splitSourcePages(sourceMarkdown);
  const decisionById = new Map(plan.decisions.map((decision) => [decision.nodeId, decision]));
  const operations: MaterializeOperation[] = [];
  const output: string[] = ['<!-- halfhalf:source-order=strict -->'];
  let keptPages = 0;
  let omittedPages = 0;
  let visualPages = 0;

  for (const section of sections) {
    const nodes = document.nodes.filter((node) =>
      node.sourceAnchors.some((anchor) => anchor.page === section.page)
    );
    const decisions = nodes
      .map((node) => decisionById.get(node.id))
      .filter((decision): decision is TransformDecision => Boolean(decision));
    const kept = decisions.filter((decision) => decision.priority !== 'omit');
    if (decisions.length > 0 && kept.length === 0) {
      omittedPages += 1;
      operations.push({
        type: 'omit-source-page',
        page: section.page,
        reason: 'all knowledge nodes on this page were omitted',
      });
      continue;
    }

    const heading = pageHeading(section.page, kept);
    if (section.visual) {
      visualPages += 1;
      keptPages += 1;
      output.push(replacePageHeading(section.markdown, heading));
      operations.push({
        type: 'keep-source-page',
        page: section.page,
        reason: 'visual page kept atomically to preserve formulas and spatial relationships',
      });
      continue;
    }

    const selected = nodes
      .map((node) => ({ node, decision: decisionById.get(node.id) }))
      .filter(({ decision }) => decision && decision.priority !== 'omit')
      .map(({ node }) => cleanNodeText(node.text))
      .filter(Boolean);
    if (selected.length > 0) {
      keptPages += 1;
      output.push(`${heading}\n\n${[...new Set(selected)].join('\n\n')}`);
    } else {
      keptPages += 1;
      output.push(replacePageHeading(section.markdown, heading));
    }
  }

  if (sections.length === 0) {
    const selected = document.nodes
      .map((node) => ({ node, decision: decisionById.get(node.id) }))
      .filter(({ decision }) => decision && decision.priority !== 'omit')
      .map(({ node }) => cleanNodeText(node.text))
      .filter(Boolean);
    output.push([...new Set(selected)].join('\n\n'));
  }

  for (const decision of plan.decisions) {
    operations.push({
      type: decision.priority === 'omit' ? 'omit-node' : 'keep-node',
      nodeId: decision.nodeId,
      page: sourcePageForDecision(decision),
      reason: decision.reason,
    });
  }

  const markdown = output.filter(Boolean).join('\n\n').trim();
  const revisionId = createHash('sha256')
    .update(document.fileHash)
    .update(JSON.stringify(plan.focus))
    .update(markdown)
    .digest('hex')
    .slice(0, 16);
  const omittedNodes = plan.decisions.filter((decision) => decision.priority === 'omit').length;
  return {
    schemaVersion: 1,
    revisionId,
    markdown,
    operations,
    summary: {
      keptPages,
      omittedPages,
      keptNodes: plan.decisions.length - omittedNodes,
      omittedNodes,
      visualPages,
    },
    warnings: [
      ...(visualPages > 0
        ? ['原图页作为原子单元：图像内的节点级省略会被记录，但不会破坏性裁剪原图。']
        : []),
      '本次应用为确定性、可追溯变换；新增解释性文字需由 AI 生成后交给用户确认。',
    ],
  };
}

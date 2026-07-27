import type {
  DocumentPageQuality,
  DocumentQualityReport,
  KnowledgeDocument,
  KnowledgeNode,
  KnowledgeNodeKind,
  SourceAnchor,
} from '../types/index.js';

export interface NativeSourceBlock {
  id: string;
  page: number;
  text: string;
  bbox: [number, number, number, number];
  fontHeight: number;
}

const PUA_RE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
const BAD_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const REPLACEMENT_RE = /\uFFFD/g;
const SUSPICIOUS_RUN_RE =
  /(?:[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]\s*)+/gu;

const VISUAL_FALLBACK_LABEL = '\u3014\u516c\u5f0f/\u7b26\u53f7\u533a\u57df\u5f85\u8bc6\u522b\u3015';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function normalizeBbox(
  bbox: [number, number, number, number]
): [number, number, number, number] {
  const [x0, y0, x1, y1] = bbox;
  return [
    clamp01(Math.min(x0, x1)),
    clamp01(Math.min(y0, y1)),
    clamp01(Math.max(x0, x1)),
    clamp01(Math.max(y0, y1)),
  ];
}

export function countSuspiciousCharacters(text: string): number {
  return (
    [...text.matchAll(PUA_RE)].length +
    [...text.matchAll(REPLACEMENT_RE)].length +
    [...text.matchAll(BAD_CONTROL_RE)].length
  );
}

export function suspiciousRatio(text: string): number {
  const count = [...text].filter((character) => !/\s/u.test(character)).length;
  return count === 0 ? 0 : countSuspiciousCharacters(text) / count;
}

// Never leak legacy font PUA characters into editable Markdown.
export function sanitizeExtractedText(text: string): string {
  return text
    .replace(SUSPICIOUS_RUN_RE, VISUAL_FALLBACK_LABEL)
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function inferKnowledgeKind(text: string, ratio: number): KnowledgeNodeKind {
  const normalized = text.trim();
  if (ratio >= 0.08) return 'formula';
  if (/^(?:\u5b9a\u4e49|\u6982\u5ff5)[:\uFF1A\s]/u.test(normalized)) return 'definition';
  if (/^(?:\u6761\u4ef6|\u9002\u7528\u6761\u4ef6|\u8fb9\u754c\u6761\u4ef6)[:\uFF1A\s]/u.test(normalized)) return 'condition';
  if (/^(?:\u4f8b|\u4f8b\u9898|\u4e60\u9898|\u89e3)[:\uFF1A\d\s]/u.test(normalized)) return 'example';
  if (/^(?:\u6ce8\u610f|\u8b66\u544a|\u6613\u9519|\u63d0\u9192)[:\uFF1A\s]/u.test(normalized)) return 'warning';
  if (/^(?:\u6b65\u9aa4|\u65b9\u6cd5|\u8fc7\u7a0b|\u7b97\u6cd5)[:\uFF1A\s]/u.test(normalized)) return 'procedure';
  if (/(?:\u533a\u522b|\u5bf9\u6bd4|\u6bd4\u8f83|\u76f8\u540c\u70b9|\u4e0d\u540c\u70b9)/u.test(normalized)) return 'comparison';
  if (
    normalized.length <= 60 &&
    !/[\u3002\uFF1B\uFF01\uFF1F.!?]$/u.test(normalized) &&
    /(?:\u7ae0|\u8282|\u590d\u4e60|\u77e5\u8bc6\u70b9|\u5b9a\u7406|\u516c\u5f0f|\u573a|\u7535\u78c1|\u7535\u8def|\u7cfb\u7edf)/u.test(normalized)
  ) {
    return 'heading';
  }
  if (
    normalized.length <= 220 &&
    /[=\u2248\u2260\u2264\u2265\u2211\u222b\u221a\u2202\u2207\u221e\u00b1\u00d7\u00f7\u2192\u2190\u2194]|\\(?:frac|sum|int|sqrt|partial)\b/u.test(normalized)
  ) {
    return 'formula';
  }
  return normalized ? 'text' : 'unknown';
}

function confidenceForBlock(text: string, ratio: number): number {
  if (!text.trim()) return 0;
  return Math.round(Math.max(0.1, 1 - Math.min(0.9, ratio * 2.4)) * 100) / 100;
}

interface SourceCluster {
  firstIndex: number;
  items: NativeSourceBlock[];
  bbox: [number, number, number, number];
}

function nearSameLine(
  a: [number, number, number, number],
  b: [number, number, number, number]
): boolean {
  const aHeight = Math.max(0.001, a[3] - a[1]);
  const bHeight = Math.max(0.001, b[3] - b[1]);
  const centerDelta = Math.abs((a[1] + a[3]) / 2 - (b[1] + b[3]) / 2);
  const verticalOverlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const sameBand = verticalOverlap >= -0.008 || centerDelta <= Math.max(aHeight, bHeight) * 0.8;
  const horizontalGap = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]));
  return sameBand && horizontalGap <= 0.035;
}

function unionBbox(
  a: [number, number, number, number],
  b: [number, number, number, number]
): [number, number, number, number] {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/** Merge glyph-level PowerPoint PDF fragments into source-sized line regions. */
export function coalesceNativeBlocks(blocks: NativeSourceBlock[]): NativeSourceBlock[] {
  const clusters: SourceCluster[] = [];
  for (const [index, block] of blocks.entries()) {
    // Compare against the cluster's first baseline, not its growing union box.
    // This prevents a dense formula table from transitively merging a whole page.
    const match = clusters.find(
      (cluster) =>
        cluster.items[0]?.page === block.page &&
        nearSameLine(cluster.items[0].bbox, block.bbox)
    );
    if (!match) {
      clusters.push({ firstIndex: index, items: [block], bbox: block.bbox });
      continue;
    }

    match.items.push(block);
    match.bbox = unionBbox(match.bbox, block.bbox);
  }

  const perPageCount = new Map<number, number>();
  return clusters
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map((cluster) => {
      const page = cluster.items[0].page;
      const next = (perPageCount.get(page) ?? 0) + 1;
      perPageCount.set(page, next);
      const items = [...cluster.items].sort((a, b) => a.bbox[0] - b.bbox[0]);
      return {
        id: `p${page}-b${next}`,
        page,
        text: items.map((item) => item.text).join(' ').replace(/[ \t]+/g, ' ').trim(),
        bbox: normalizeBbox(cluster.bbox),
        fontHeight: Math.max(...items.map((item) => item.fontHeight)),
      };
    });
}

export function buildPdfQualityReport(
  pageCount: number,
  blocks: NativeSourceBlock[]
): DocumentQualityReport {
  const pages: DocumentPageQuality[] = [];
  let suspiciousCharacterCount = 0;
  let totalCharacterCount = 0;

  for (let page = 1; page <= pageCount; page += 1) {
    const pageBlocks = blocks.filter((block) => block.page === page);
    const text = pageBlocks.map((block) => block.text).join('');
    const characterCount = [...text].filter((character) => !/\s/u.test(character)).length;
    const suspicious = countSuspiciousCharacters(text);
    const ratio = characterCount === 0 ? 0 : suspicious / characterCount;
    const route = characterCount === 0 ? 'ocr' : ratio >= 0.01 ? 'hybrid' : 'native';

    totalCharacterCount += characterCount;
    suspiciousCharacterCount += suspicious;
    pages.push({
      page,
      characterCount,
      suspiciousCharacterCount: suspicious,
      suspiciousRatio: Math.round(ratio * 10_000) / 10_000,
      blockCount: pageBlocks.length,
      route,
    });
  }

  return {
    suspiciousCharacterCount,
    suspiciousRatio:
      totalCharacterCount === 0
        ? 0
        : Math.round((suspiciousCharacterCount / totalCharacterCount) * 10_000) / 10_000,
    nativePageCount: pages.filter((page) => page.route === 'native').length,
    hybridPageCount: pages.filter((page) => page.route === 'hybrid').length,
    ocrPageCount: pages.filter((page) => page.route === 'ocr').length,
    pages,
  };
}

export function buildKnowledgeDocument(input: {
  fileHash: string;
  pageCount: number;
  blocks: NativeSourceBlock[];
}): KnowledgeDocument {
  const quality = buildPdfQualityReport(input.pageCount, input.blocks);
  const nodes: KnowledgeNode[] = input.blocks
    .map((block): KnowledgeNode | null => {
      const rawText = block.text.trim();
      if (!rawText) return null;
      const ratio = suspiciousRatio(rawText);
      const text = sanitizeExtractedText(rawText);
      const requiresVisualFallback = ratio > 0;
      const sourceAnchor: SourceAnchor = {
        page: block.page,
        bbox: normalizeBbox(block.bbox),
        method: requiresVisualFallback ? 'visual-fallback' : 'native-text',
      };
      return {
        id: block.id,
        kind: inferKnowledgeKind(rawText, ratio),
        text,
        rawText: rawText === text ? undefined : rawText,
        sourceAnchors: [sourceAnchor],
        dependencies: [],
        confidence: confidenceForBlock(rawText, ratio),
        orderRigidity: 'strict',
        requiresVisualFallback,
      };
    })
    .filter((node): node is KnowledgeNode => node !== null);

  return {
    schemaVersion: 1,
    fileHash: input.fileHash,
    sourceOrder: 'strict',
    pageCount: input.pageCount,
    nodes,
    quality,
  };
}

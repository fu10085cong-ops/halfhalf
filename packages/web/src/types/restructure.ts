export type KnowledgeNodeKind =
  | 'heading'
  | 'concept'
  | 'definition'
  | 'formula'
  | 'condition'
  | 'procedure'
  | 'comparison'
  | 'example'
  | 'warning'
  | 'text'
  | 'unknown';

export interface SourceAnchor {
  page?: number;
  bbox?: [number, number, number, number];
  method: 'native-text' | 'ocr' | 'formula-ocr' | 'visual-fallback';
}

export interface KnowledgeNode {
  id: string;
  kind: KnowledgeNodeKind;
  text: string;
  rawText?: string;
  latex?: string;
  sourceAnchors: SourceAnchor[];
  dependencies: string[];
  confidence: number;
  orderRigidity: 'strict' | 'soft';
  requiresVisualFallback: boolean;
}

export interface DocumentQualityReport {
  suspiciousCharacterCount: number;
  suspiciousRatio: number;
  nativePageCount: number;
  hybridPageCount: number;
  ocrPageCount: number;
  pages: Array<{
    page: number;
    characterCount: number;
    suspiciousCharacterCount: number;
    suspiciousRatio: number;
    blockCount: number;
    route: 'native' | 'hybrid' | 'ocr';
  }>;
}

export interface KnowledgeDocument {
  schemaVersion: 1;
  fileHash: string;
  sourceOrder: 'strict' | 'soft';
  pageCount?: number;
  nodes: KnowledgeNode[];
  quality?: DocumentQualityReport;
}

export type FocusPriority = 'must' | 'key' | 'supporting' | 'omit';
export type ExplanationDepth = 'none' | 'brief' | 'standard' | 'deep';

export interface FocusSpec {
  goal: string;
  targetPages: number;
  mustKeepNodeIds?: string[];
  omitNodeIds?: string[];
  topics?: Array<{
    query: string;
    priority: FocusPriority;
    explanationDepth?: ExplanationDepth;
  }>;
  defaultExplanationDepth?: ExplanationDepth;
  minFontPt?: number;
}

export interface RestructurePlan {
  schemaVersion: 1;
  fileHash: string;
  focus: FocusSpec;
  decisions: Array<{
    nodeId: string;
    priority: FocusPriority;
    action: 'keep_exact' | 'explain' | 'summarize' | 'merge' | 'visual_keep' | 'omit';
    explanationDepth: ExplanationDepth;
    areaWeight: number;
    reason: string;
    sourceAnchors: SourceAnchor[];
  }>;
  summary: {
    mustKeep: number;
    key: number;
    supporting: number;
    omitted: number;
    visualFallbacks: number;
  };
  warnings: string[];
}

export interface MaterializeResult {
  schemaVersion: 1;
  revisionId: string;
  markdown: string;
  operations: Array<{
    type: 'keep-source-page' | 'omit-source-page' | 'keep-node' | 'omit-node';
    page?: number;
    nodeId?: string;
    reason: string;
  }>;
  summary: {
    keptPages: number;
    omittedPages: number;
    keptNodes: number;
    omittedNodes: number;
    visualPages: number;
  };
  warnings: string[];
}

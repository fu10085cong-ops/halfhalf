/** 纸张尺寸定义 */
export type PaperSize = 'A4' | 'A5' | 'Letter';

/** 排版密度。'cram' 是照着真实半开卷小抄校准的极限档：分隔靠细线不靠留白，
 *  标题行内化（不放大、不独占空间），重点靠粗体承担扫读 */
export type Density = 'compact' | 'normal' | 'loose' | 'cram';

/** 纸张方向 */
export type ResolvedOrientation = 'portrait' | 'landscape';

/** 页边距（单位 mm） */
export interface Margins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 纸张尺寸预设 */
export const PAPER_SIZES: Record<PaperSize, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
  Letter: { width: 215.9, height: 279.4 },
};

/** 默认页边距 */
export const DEFAULT_MARGINS: Margins = {
  top: 10,
  bottom: 10,
  left: 10,
  right: 10,
};

/** 密度对应的行高配置。cram 的其余压缩规则（标题/列表/表格）在 print.css 里按
 *  [data-density='cram'] 作用域生效 */
export const DENSITY_CONFIG: Record<Density, { lineHeight: number; paragraphSpacing: number }> = {
  compact: { lineHeight: 1.05, paragraphSpacing: 0.1 },
  normal: { lineHeight: 1.15, paragraphSpacing: 0.2 },
  loose: { lineHeight: 1.3, paragraphSpacing: 0.4 },
  cram: { lineHeight: 1.0, paragraphSpacing: 0.05 },
};

/** 二分搜索配置 */
export const SEARCH_CONFIG = {
  minFontSize: 6,
  maxFontSize: 24,
  defaultPrecision: 0.5,
  maxIterations: 20,
} as const;

/**
 * 所有接口统一的错误响应形状——不管是普通 HTTP 4xx/5xx 的 JSON body，
 * 还是 SSE 里的 error 事件 data，字段名都是 `error`，前端只需要认一种形状。
 */
export interface ApiErrorResponse {
  error: string;
}

/** POST /api/ai/proxy 的请求体形状 */
export interface AiProxyRequest {
  /** 目标 AI 服务商的完整 API 地址，必须是 https 且域名在白名单内 */
  endpoint: string;
  /** 会与 Content-Type: application/json 合并后转发给上游，用来放 Authorization 等认证头 */
  headers?: Record<string, string>;
  /** 原样 JSON.stringify 后作为请求体转发给上游，具体形状由目标服务商的 API 决定 */
  body: unknown;
}

/**
 * BYOK（用户自带 key）的 AI 服务商配置。v1 只支持 OpenAI 兼容的 /chat/completions 形状。
 * key 放在 headers 的 Authorization 里，只在单次请求内存中存在，不落日志/不落盘（同 /ai/proxy）。
 */
export interface AiProviderConfig {
  /** 完整 API 地址，必须 https 且域名在白名单内（复用 /ai/proxy 的校验） */
  endpoint: string;
  /** 模型名，如 'gpt-4o-mini' */
  model: string;
  /** 认证头等，会与 Content-Type 合并转发；BYOK key 放这里（Authorization: Bearer ...） */
  headers?: Record<string, string>;
  /** 采样温度，默认 0.2（低温保真，避免改写走样） */
  temperature?: number;
}

/**
 * POST /api/ai/structurize 的请求体（⓪ 结构化入口：任意粘贴内容 → 标准 .md）。
 * provider 省略时用服务器统一 key（env HALFHALF_AI_ENDPOINT/MODEL/KEY）。
 */
export interface AiStructurizeRequest {
  /** 任意形态的粘贴内容（Word 文本/课件/聊天记录），非 Markdown 也行 */
  content: string;
  provider?: AiProviderConfig;
}

/** POST /api/ai/chat（SSE）的请求体形状——多轮材料对话，服务端无状态 */
export interface AiChatRequest {
  /** 对话历史（含本轮用户消息，末条必须是 user）；服务端只保留最近若干条 */
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** 参与对话的材料全文（客户端每次全量带上；可为空 = 无材料闲聊会被 prompt 挡回） */
  context?: string;
  provider?: AiProviderConfig;
}

/** POST /api/ai/compress 的请求体形状 */
export interface AiCompressRequest {
  /** 待精简的完整 Markdown（图片以 data: URI 内嵌，同 /api/scene） */
  markdown: string;
  provider: AiProviderConfig;
  /** 只精简这些块（chunkMarkdown 的 block id）；省略 = 全部正文块 */
  blockIds?: string[];
  options?: {
    /** 认为"确实精简了"的最小正文缩减字数，默认 4；不足则标 ok=false，不误报为可用建议 */
    minReductionChars?: number;
  };
}

/** 单块改写的安全网结论（三道校验：占位符完整 / 无新公式错误 / 确实缩短） */
export interface AtomSafety {
  /** 三道校验都过才为 true；false 时建议默认不勾选，但仍展示让用户看原因 */
  ok: boolean;
  /** 刚性原子占位符逐一回来、无丢失/重复/杜撰 */
  atomsPreserved: boolean;
  /** 回填后公式预检未引入原文没有的 KaTeX 错误 */
  formulaClean: boolean;
  /** ok=false 时的人话原因（占位符丢失/重复、引入公式错误、未产生精简、纯原子块、AI 调用失败等） */
  reason?: string;
}

/** 单个内容块的精简建议（原文 vs 建议，供前端展示 diff、逐块接受/拒绝） */
export interface BlockSuggestion {
  blockId: string;
  blockTitle: string;
  kind: 'text' | 'image';
  original: string;
  /** 改写后的 Markdown；被跳过/被安全网打回时 === original */
  suggested: string;
  /** 剥掉标记后的正文字数（口径同 analyzeContent） */
  charsBefore: number;
  charsAfter: number;
  /** 该块在提交时那份 markdown 里的字符区间 [start, end)，供前端按降序拼接回写 */
  range: { start: number; end: number };
  /** 纯原子块或不在 blockIds 里 → 未调用 AI */
  skipped: boolean;
  safety: AtomSafety;
}

/** 批量精简的汇总（前端展示"共 N 块、成功精简 M 块、正文 X→Y 字"） */
export interface AiCompressSummary {
  total: number;
  compressed: number;
  charsBefore: number;
  charsAfter: number;
}

/** POST /api/ai/compress 的响应体形状（批量一次性返回，非流式） */
export interface AiCompressResponse {
  suggestions: BlockSuggestion[];
  summary: AiCompressSummary;
}

/**
 * KnowledgeIR：导入产物的可追溯中间表示。每个节点都带页锚点，
 * 保证转换后的任何一条内容都能回指原文件的位置。
 */
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

export type SourceExtractionMethod =
  | 'native-text'
  | 'ocr'
  | 'formula-ocr'
  | 'visual-fallback';

export interface SourceAnchor {
  /** 1-based source page number. */
  page?: number;
  /** Optional normalized page bounds: [x0, y0, x1, y1]. */
  bbox?: [number, number, number, number];
  method: SourceExtractionMethod;
}

export interface KnowledgeNode {
  id: string;
  kind: KnowledgeNodeKind;
  text: string;
  /** 原始提取文本；仅在清洗改动过 text 时才带上，用于人工核对。 */
  rawText?: string;
  latex?: string;
  sourceAnchors: SourceAnchor[];
  dependencies: string[];
  confidence: number;
  orderRigidity: 'strict' | 'soft';
  /** True when this node should fall back to a source image crop. */
  requiresVisualFallback: boolean;
}

export type PdfPageRoute = 'native' | 'hybrid' | 'ocr';

export interface DocumentPageQuality {
  page: number;
  characterCount: number;
  suspiciousCharacterCount: number;
  suspiciousRatio: number;
  blockCount: number;
  route: PdfPageRoute;
}

export interface DocumentQualityReport {
  suspiciousCharacterCount: number;
  suspiciousRatio: number;
  nativePageCount: number;
  hybridPageCount: number;
  ocrPageCount: number;
  pages: DocumentPageQuality[];
}

export interface KnowledgeDocument {
  schemaVersion: 1;
  fileHash: string;
  sourceOrder: 'strict' | 'soft';
  pageCount?: number;
  nodes: KnowledgeNode[];
  quality?: DocumentQualityReport;
}

/** 用户意图：哪些必留、哪些可省、讲到多深。mustKeep 永远压过 omit。 */
export type FocusPriority = 'must' | 'key' | 'supporting' | 'omit';
export type ExplanationDepth = 'none' | 'brief' | 'standard' | 'deep';

export interface FocusTopic {
  query: string;
  priority: FocusPriority;
  explanationDepth?: ExplanationDepth;
}

export interface FocusSpec {
  goal: string;
  targetPages: number;
  mustKeepNodeIds?: string[];
  omitNodeIds?: string[];
  topics?: FocusTopic[];
  defaultExplanationDepth?: ExplanationDepth;
  minFontPt?: number;
}

export type TransformAction =
  | 'keep_exact'
  | 'explain'
  | 'summarize'
  | 'merge'
  | 'visual_keep'
  | 'omit';

export interface TransformDecision {
  nodeId: string;
  priority: FocusPriority;
  action: TransformAction;
  explanationDepth: ExplanationDepth;
  areaWeight: number;
  reason: string;
  sourceAnchors: SourceAnchor[];
}

export interface RestructurePlan {
  schemaVersion: 1;
  fileHash: string;
  focus: FocusSpec;
  decisions: TransformDecision[];
  summary: {
    mustKeep: number;
    key: number;
    supporting: number;
    omitted: number;
    visualFallbacks: number;
  };
  warnings: string[];
}

/** POST /api/import/document、/api/import/url 的导入结果。 */
export type ImportedDocumentKind = 'docx' | 'pdf' | 'url';

export interface DocumentImportSummary {
  kind: ImportedDocumentKind;
  /** 文件名；URL 导入时为网页标题（取不到则为域名） */
  originalName: string;
  sizeBytes: number;
  characterCount: number;
  paragraphCount: number;
  headingCount: number;
  tableCount: number;
  imageCount: number;
  pageCount?: number;
  textPageCount?: number;
  /** URL 导入时的最终地址（跟随重定向后） */
  sourceUrl?: string;
  /** PDF 逐页提取质量诊断；docx/url 导入不产出。 */
  quality?: DocumentQualityReport;
  warnings: string[];
}

export interface ImportedDocument {
  markdown: string;
  summary: DocumentImportSummary;
  /** 可追溯知识节点；目前只有 PDF 导入产出。 */
  knowledge?: KnowledgeDocument;
}

/** 与后端共享的类型定义(请求体前端各处内联构造,这里只镜像响应形状) */

/** 场景预设 id（POST /api/scene） */
export type SceneId = 'text-cram' | 'formula' | 'code' | 'visual' | 'balanced';

export interface SceneStats {
  charCount: number;
  displayFormulaCount: number;
  inlineFormulaCount: number;
  imageBlockCount: number;
  tableCount: number;
  codeBlockCount: number;
  blockCount: number;
}

/** /api/scene 诊断：单块的档位/落页/缩放（网页测试台用） */
export interface BlockDiagnostic {
  id: string;
  title: string;
  kind: 'text' | 'image';
  /** 选定宽度档位（格数） */
  span: number;
  /** 落页（1-based）；null = 未落位 */
  page: number | null;
  /** 盒高（含 gutter）mm */
  heightMm: number | null;
  /** 块内原子最小缩放（含表格）；公式单独看 formulaScale */
  scale: number;
  formulaScale: number;
  belowMinScale: boolean;
  oversized: boolean;
  /** 满版伸展后的块级字号 pt（null = 未放大，用全局字号） */
  stretchedPt?: number | null;
}

export interface SceneDiagnostics {
  grid: { unitsX: number; unitMm: number; gutterMm: number; widthTiers: number[] };
  blocks: BlockDiagnostic[];
  /** 每页填充率 %（拼装几何估算；超高块可能推过 100） */
  pageFill: number[];
  overallFill: number;
  elapsedMs: number;
}

/** GET /api/fixtures 列表项（开发环境的测试材料速载） */
export interface FixtureInfo {
  name: string;
  sizeKb: number;
}

export interface SceneResult {
  /** 自动从内容标题派生的下载文件名（含 .pdf） */
  fileName: string;
  stats: SceneStats;
  recommended: { scene: SceneId; name: string; reason: string; warning?: string };
  /** rule trace：实际触发的排版规则记账（H=硬约束，S=软偏好），自动模式的参数由它决定 */
  trace: { rule: string; kind: 'hard' | 'soft' | 'adjudication'; detail: string }[];
  /** 用户声明的学科 id（null = 未声明） */
  subject: string | null;
  /** 关键词识别建议（≠ 声明，用户选了才生效） */
  subjectSuggestion: { id: string; name: string; matchedAliases: string[] } | null;
  usedScene: SceneId;
  usedSceneName: string;
  fontSize: number;
  pages: number;
  withinTargetPages: boolean;
  history: { fontSize: number; pages: number }[];
  warnings: {
    oversized: string[];
    cramped: string[];
    formulaIssues: { blockId: string; blockTitle: string; message: string }[];
  };
  /** 测试台诊断（老响应可能没有，前端判空使用） */
  diagnostics?: SceneDiagnostics;
  jobId: string;
}

/** BYOK AI 服务商配置（POST /api/ai/compress）；v1 只支持 OpenAI 兼容 /chat/completions 形状 */
export interface AiProviderConfig {
  endpoint: string;
  model: string;
  /** 认证头等；BYOK key 放这里（Authorization: Bearer ...） */
  headers?: Record<string, string>;
  temperature?: number;
}

/** 单块改写的安全网结论（占位符完整 / 无新公式错误 / 确实缩短） */
export interface AtomSafety {
  ok: boolean;
  atomsPreserved: boolean;
  formulaClean: boolean;
  reason?: string;
}

/** 单个内容块的精简建议（原文 vs 建议，供逐块展示 diff、接受/拒绝） */
export interface BlockSuggestion {
  blockId: string;
  blockTitle: string;
  kind: 'text' | 'image';
  original: string;
  suggested: string;
  charsBefore: number;
  charsAfter: number;
  /** 该块在提交那份 markdown 里的字符区间 [start, end)，按降序拼接回写 */
  range: { start: number; end: number };
  skipped: boolean;
  safety: AtomSafety;
}

export interface AiCompressSummary {
  total: number;
  compressed: number;
  charsBefore: number;
  charsAfter: number;
}

/** POST /api/ai/compress 的响应（批量一次性返回） */
export interface AiCompressResponse {
  suggestions: BlockSuggestion[];
  summary: AiCompressSummary;
}
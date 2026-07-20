/** 与后端共享的类型定义 */

export type PaperSize = 'A4' | 'A5' | 'Letter';
export type Density = 'compact' | 'normal' | 'loose' | 'cram';
/** 'auto' 会并行试竖版和横版，取字号更大的结果 */
export type Orientation = 'portrait' | 'landscape' | 'auto';
export type ResolvedOrientation = 'portrait' | 'landscape';
/** 具体数字固定栏数；'auto' 让引擎自动挑最优栏数 */
export type Columns = number | 'auto';

export interface OptimizeRequest {
  markdown: string;
  targetPages: number;
  paperSize?: PaperSize;
  margins?: { top: number; bottom: number; left: number; right: number };
  density?: Density;
  precision?: number;
  cleanup?: boolean;
  /** 默认 'portrait'，跟历史行为一致 */
  orientation?: Orientation;
  /** 默认 1（单栏）；传数字固定栏数，传 'auto' 自动挑最优栏数 */
  columns?: Columns;
}

export interface IterationRecord {
  fontSize: number;
  pages: number;
  withinLimit: boolean;
  timestamp: number;
  message?: string;
  orientation: ResolvedOrientation;
  columns: number;
}

export interface OptimizeResult {
  optimalFontSize: number;
  actualPages: number;
  iterations: number;
  history: IterationRecord[];
  withinTargetPages: boolean;
  jobId: string;
  orientation: ResolvedOrientation;
  columns: number;
}

/** 场景预设 id（POST /api/scene） */
export type SceneId = 'text-cram' | 'formula' | 'code' | 'visual' | 'balanced';

export interface SceneRequest {
  markdown: string;
  targetPages?: number;
  /** 'auto'（默认）= 按内容特征推荐 */
  scene?: SceneId | 'auto';
  orientation?: ResolvedOrientation;
  /** true = PDF 叠加网格线/块方框/标签，用于看清排版（不改变排版本身） */
  debug?: boolean;
}

export interface SceneStats {
  charCount: number;
  displayFormulaCount: number;
  inlineFormulaCount: number;
  imageBlockCount: number;
  tableCount: number;
  codeBlockCount: number;
  blockCount: number;
}

export interface SceneResult {
  /** 自动从内容标题派生的下载文件名（含 .pdf） */
  fileName: string;
  stats: SceneStats;
  recommended: { scene: SceneId; name: string; reason: string; warning?: string };
  /** rule trace：实际触发的排版规则记账（H=硬约束，S=软偏好），自动模式的参数由它决定 */
  trace: { rule: string; kind: 'hard' | 'soft'; detail: string }[];
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
  jobId: string;
}

/** POST /api/render 的请求体——单次预览，不参与搜索，不支持 orientation/columns 的 'auto' */
export interface RenderPreviewRequest {
  markdown: string;
  fontSize: number;
  paperSize?: PaperSize;
  margins?: { top: number; bottom: number; left: number; right: number };
  density?: Density;
  orientation?: ResolvedOrientation;
  columns?: number;
  cleanup?: boolean;
}
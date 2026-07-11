/** 与后端共享的类型定义 */

export type PaperSize = 'A4' | 'A5' | 'Letter';
export type Density = 'compact' | 'normal' | 'loose';
/** 'auto' 会并行试竖版和横版，取字号更大的结果 */
export type Orientation = 'portrait' | 'landscape' | 'auto';
export type ResolvedOrientation = 'portrait' | 'landscape';

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
}

export interface IterationRecord {
  fontSize: number;
  pages: number;
  withinLimit: boolean;
  timestamp: number;
  message?: string;
  orientation: ResolvedOrientation;
}

export interface OptimizeResult {
  optimalFontSize: number;
  actualPages: number;
  iterations: number;
  history: IterationRecord[];
  withinTargetPages: boolean;
  jobId: string;
  orientation: ResolvedOrientation;
}

/** POST /api/render 的请求体——单次预览，不参与搜索，不支持 orientation='auto' */
export interface RenderPreviewRequest {
  markdown: string;
  fontSize: number;
  paperSize?: PaperSize;
  margins?: { top: number; bottom: number; left: number; right: number };
  density?: Density;
  orientation?: ResolvedOrientation;
  cleanup?: boolean;
}
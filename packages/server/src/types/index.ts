/** 纸张尺寸定义 */
export type PaperSize = 'A4' | 'A5' | 'Letter';

/** 排版密度 */
export type Density = 'compact' | 'normal' | 'loose';

/** 页边距（单位 mm） */
export interface Margins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 优化请求参数 */
export interface OptimizeRequest {
  markdown: string;
  targetPages: number;
  paperSize?: PaperSize;
  margins?: Margins;
  density?: Density;
  precision?: number;
  /** 是否在排版前跑一遍确定性的格式清理（空行折叠、代码语言标注归一化等），默认不开启 */
  cleanup?: boolean;
}

/** 单次迭代记录 */
export interface IterationRecord {
  fontSize: number;
  pages: number;
  withinLimit: boolean;
  timestamp: number;
}

/** 优化结果 */
export interface OptimizeResult {
  optimalFontSize: number;
  actualPages: number;
  iterations: number;
  history: IterationRecord[];
  /** 是否成功控制在目标页数内；内容过长时可能为 false，此时返回的是最小字号下的最佳结果 */
  withinTargetPages: boolean;
  /** 用于下载最终 PDF 的任务 ID */
  jobId: string;
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

/** 密度对应的行高配置 */
export const DENSITY_CONFIG: Record<Density, { lineHeight: number; paragraphSpacing: number }> = {
  compact: { lineHeight: 1.05, paragraphSpacing: 0.1 },
  normal: { lineHeight: 1.15, paragraphSpacing: 0.2 },
  loose: { lineHeight: 1.3, paragraphSpacing: 0.4 },
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
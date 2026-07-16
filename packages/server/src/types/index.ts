/** 纸张尺寸定义 */
export type PaperSize = 'A4' | 'A5' | 'Letter';

/** 排版密度。'cram' 是照着真实半开卷小抄校准的极限档：分隔靠细线不靠留白，
 *  标题行内化（不放大、不独占空间），重点靠粗体承担扫读 */
export type Density = 'compact' | 'normal' | 'loose' | 'cram';

/** 纸张方向。'auto' 会并行试竖版和横版两轮完整搜索，取字号更大的结果——总耗时不明显增加，但峰值内存/CPU 占用接近翻倍（共享 Chromium 上两个 page 同时渲染） */
export type Orientation = 'portrait' | 'landscape' | 'auto';

/** 单次搜索实际采用的纸张方向（'auto' 只是请求参数，落到具体某一轮搜索时一定是这两者之一） */
export type ResolvedOrientation = 'portrait' | 'landscape';

/**
 * 分栏数。具体数字（1/2/3…）表示固定栏数；'auto' 表示让引擎在 1~maxAutoColumns 之间
 * 自动挑能撑出最大字号的栏数。栏数和字号一样是 CSS 变量，切换栏数不需要重开浏览器，
 * 所以 'auto' 只是在同一个渲染上下文里多跑几轮字号搜索，不会成倍增加浏览器实例。
 */
export type Columns = number | 'auto';

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
  /** 纸张方向，默认 'portrait'（竖版，跟历史行为一致，不额外增加耗时） */
  orientation?: Orientation;
  /** 分栏数，默认 1（单栏，跟历史行为一致）。传具体数字固定栏数，传 'auto' 让引擎自动挑最优栏数 */
  columns?: Columns;
}

/** 单次迭代记录 */
export interface IterationRecord {
  fontSize: number;
  pages: number;
  withinLimit: boolean;
  timestamp: number;
  /** 本轮迭代测试的纸张方向；只有 orientation='auto' 时才会同时出现 portrait 和 landscape 的记录 */
  orientation: ResolvedOrientation;
  /** 本轮迭代测试的分栏数；columns='auto' 时不同轮次会出现不同的栏数 */
  columns: number;
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
  /** 最终采用的纸张方向；orientation='auto' 时是搜索结果字号更大的那一个 */
  orientation: ResolvedOrientation;
  /** 最终采用的分栏数；columns='auto' 时是搜索结果字号更大的那个栏数 */
  columns: number;
}

/**
 * POST /api/render 的请求体——单次渲染预览，不参与二分搜索，用于让用户在跑完整优化前
 * 先看一眼某个字号/方向组合下的排版效果（比如切换横竖版之后想先预览再决定）。
 */
export interface RenderPreviewRequest {
  markdown: string;
  /** 必填，预览用的字号（pt），必须落在 SEARCH_CONFIG.minFontSize~maxFontSize 区间内 */
  fontSize: number;
  paperSize?: PaperSize;
  margins?: Margins;
  density?: Density;
  /** 默认 'portrait'；预览接口不支持 'auto'（auto 是搜索两个方向取最优，单次预览没有"取最优"这个概念） */
  orientation?: ResolvedOrientation;
  /** 默认 1；预览接口只接受具体栏数，不支持 'auto'（同 orientation） */
  columns?: number;
  cleanup?: boolean;
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
  /** columns='auto' 时尝试的最大栏数（从 1 试到这个值）。栏数太多每栏会窄到放不下内容，超过实际收益后停止 */
  maxAutoColumns: 4,
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
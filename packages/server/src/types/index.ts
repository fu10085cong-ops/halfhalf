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
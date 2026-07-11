import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type {
  ApiErrorResponse,
  IterationRecord,
  OptimizeRequest,
  OptimizeResult,
} from '../types/index.js';
import { DEFAULT_MARGINS, DENSITY_CONFIG, PAPER_SIZES, SEARCH_CONFIG } from '../types/index.js';
import { searchOptimalFontSize } from '../engine/binary-search.js';
import { cleanupMarkdown } from '../engine/markdown-cleanup.js';
import { saveJob } from '../engine/job-store.js';

export const optimizeRouter = Router();

const VALID_PAPER_SIZES = new Set(Object.keys(PAPER_SIZES));
const VALID_DENSITIES = new Set(Object.keys(DENSITY_CONFIG));

/**
 * 校验 /api/optimize 的请求体，返回第一条校验失败的错误信息；全部通过则返回 null。
 * 目的是把无效输入挡在接口边界，而不是让它带着垃圾值一路走到排版引擎深处才崩溃
 * （比如无效的 paperSize 会让 render-pdf.ts 里的 PAPER_SIZES[paperSize] 变成 undefined）。
 */
function validateOptimizeRequest(body: OptimizeRequest): string | null {
  if (!body.markdown || typeof body.markdown !== 'string') {
    return '缺少 markdown 字段';
  }
  if (!body.targetPages || typeof body.targetPages !== 'number' || body.targetPages < 1) {
    return 'targetPages 必须是 >= 1 的数字';
  }
  if (body.paperSize !== undefined && !VALID_PAPER_SIZES.has(body.paperSize)) {
    return `paperSize 必须是 ${[...VALID_PAPER_SIZES].join('/')} 之一`;
  }
  if (body.density !== undefined && !VALID_DENSITIES.has(body.density)) {
    return `density 必须是 ${[...VALID_DENSITIES].join('/')} 之一`;
  }
  if (body.precision !== undefined && (typeof body.precision !== 'number' || body.precision <= 0)) {
    return 'precision 必须是大于 0 的数字';
  }
  if (body.margins !== undefined) {
    const { top, bottom, left, right } = body.margins;
    const values = [top, bottom, left, right];
    if (values.some((v) => typeof v !== 'number' || v < 0)) {
      return 'margins 的 top/bottom/left/right 必须都是 >= 0 的数字';
    }
  }
  return null;
}

/**
 * POST /api/optimize
 * 接收 Markdown 和排版参数，通过二分搜索找到最佳字号，SSE 流式返回搜索过程。
 * 详细的请求/响应字段说明见 packages/server/API.md。
 */
optimizeRouter.post('/optimize', async (req: Request, res: Response) => {
  const body = req.body as OptimizeRequest;

  const validationError = validateOptimizeRequest(body);
  if (validationError) {
    const response: ApiErrorResponse = { error: validationError };
    res.status(400).json(response);
    return;
  }

  // 填充默认值（margins 按字段合并，避免用户只传部分边距时把其余边距重置为 undefined）
  // cleanup 默认不开启：格式清理是用户主动选择的操作，不悄悄改动用户输入的内容
  const params: Required<OptimizeRequest> = {
    markdown: body.cleanup ? cleanupMarkdown(body.markdown) : body.markdown,
    targetPages: body.targetPages,
    paperSize: body.paperSize || 'A4',
    margins: { ...DEFAULT_MARGINS, ...body.margins },
    density: body.density || 'normal',
    precision: body.precision || SEARCH_CONFIG.defaultPrecision,
    cleanup: body.cleanup ?? false,
  };

  // SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const outcome = await searchOptimalFontSize(params, (record: IterationRecord) => {
      sendEvent('progress', record);
    });

    const jobId = uuidv4();
    saveJob(jobId, outcome.pdfBuffer);

    const result: OptimizeResult = {
      optimalFontSize: outcome.optimalFontSize,
      actualPages: outcome.actualPages,
      iterations: outcome.iterations,
      history: outcome.history,
      withinTargetPages: outcome.actualPages <= params.targetPages,
      jobId,
    };

    sendEvent('result', result);
    res.end();
  } catch (error) {
    // SSE 的 error 事件和普通 HTTP 错误响应用同一个 ApiErrorResponse 形状（字段名都是 error），
    // 前端不需要为 SSE 场景单独处理一套不同的错误字段名。
    const message = error instanceof Error ? error.message : '未知错误';
    const response: ApiErrorResponse = { error: message };
    sendEvent('error', response);
    res.end();
  }
});

/**
 * POST /api/render
 * 使用指定字号渲染 PDF 预览（单次，不参与搜索）。尚未实现。
 */
optimizeRouter.post('/render', (_req: Request, res: Response) => {
  const response: ApiErrorResponse = { error: '/api/render 尚未实现' };
  res.status(501).json(response);
});
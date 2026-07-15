import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type {
  ApiErrorResponse,
  IterationRecord,
  OptimizeRequest,
  OptimizeResult,
  RenderPreviewRequest,
} from '../types/index.js';
import { DEFAULT_MARGINS, DENSITY_CONFIG, PAPER_SIZES, SEARCH_CONFIG } from '../types/index.js';
import { searchOptimalFontSize } from '../engine/binary-search.js';
import { markdownToHtml } from '../engine/md-to-html.js';
import {
  applyTypography,
  closeRenderContext,
  createRenderContext,
  renderPdfAndCountPages,
} from '../engine/render-pdf.js';
import { cleanupMarkdown } from '../engine/markdown-cleanup.js';
import { saveJob } from '../engine/job-store.js';
import { derivePdfName } from '../engine/pdf-name.js';

export const optimizeRouter: Router = Router();

const VALID_PAPER_SIZES = new Set(Object.keys(PAPER_SIZES));
const VALID_DENSITIES = new Set(Object.keys(DENSITY_CONFIG));
const VALID_ORIENTATIONS = new Set(['portrait', 'landscape', 'auto']);
const VALID_PREVIEW_ORIENTATIONS = new Set(['portrait', 'landscape']);
/** 显式指定固定栏数时的上限，防止传入荒谬的大值把每栏挤到没意义 */
const MAX_EXPLICIT_COLUMNS = 12;

/** 校验固定栏数（正整数且不超过上限）。返回错误信息或 null */
function validateFixedColumns(columns: unknown): string | null {
  if (typeof columns !== 'number' || !Number.isInteger(columns) || columns < 1) {
    return 'columns 必须是 >= 1 的整数，或 "auto"';
  }
  if (columns > MAX_EXPLICIT_COLUMNS) {
    return `columns 不能超过 ${MAX_EXPLICIT_COLUMNS}`;
  }
  return null;
}

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
  if (body.orientation !== undefined && !VALID_ORIENTATIONS.has(body.orientation)) {
    return `orientation 必须是 ${[...VALID_ORIENTATIONS].join('/')} 之一`;
  }
  // columns 可以是 'auto' 或固定的正整数
  if (body.columns !== undefined && body.columns !== 'auto') {
    const columnsError = validateFixedColumns(body.columns);
    if (columnsError) return columnsError;
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
    orientation: body.orientation || 'portrait',
    columns: body.columns ?? 1,
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
    saveJob(jobId, outcome.pdfBuffer, derivePdfName(params.markdown));

    const result: OptimizeResult = {
      optimalFontSize: outcome.optimalFontSize,
      actualPages: outcome.actualPages,
      iterations: outcome.iterations,
      history: outcome.history,
      withinTargetPages: outcome.actualPages <= params.targetPages,
      jobId,
      orientation: outcome.orientation,
      columns: outcome.columns,
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
 * 校验 /api/render 的请求体。跟 /api/optimize 的区别是没有 targetPages/precision，
 * 多了必填的 fontSize（单次渲染要一个确定的字号，不是搜索区间）。
 */
function validateRenderRequest(body: RenderPreviewRequest): string | null {
  if (!body.markdown || typeof body.markdown !== 'string') {
    return '缺少 markdown 字段';
  }
  if (
    typeof body.fontSize !== 'number' ||
    body.fontSize < SEARCH_CONFIG.minFontSize ||
    body.fontSize > SEARCH_CONFIG.maxFontSize
  ) {
    return `fontSize 必须是 ${SEARCH_CONFIG.minFontSize}~${SEARCH_CONFIG.maxFontSize} 之间的数字`;
  }
  if (body.paperSize !== undefined && !VALID_PAPER_SIZES.has(body.paperSize)) {
    return `paperSize 必须是 ${[...VALID_PAPER_SIZES].join('/')} 之一`;
  }
  if (body.density !== undefined && !VALID_DENSITIES.has(body.density)) {
    return `density 必须是 ${[...VALID_DENSITIES].join('/')} 之一`;
  }
  if (body.orientation !== undefined && !VALID_PREVIEW_ORIENTATIONS.has(body.orientation)) {
    return `orientation 必须是 ${[...VALID_PREVIEW_ORIENTATIONS].join('/')} 之一（预览接口不支持 auto）`;
  }
  // 预览接口只接受固定栏数，不支持 'auto'（同 orientation，单次预览没有"取最优"的概念）
  if (body.columns !== undefined) {
    const columnsError = validateFixedColumns(body.columns);
    if (columnsError) return columnsError;
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
 * POST /api/render
 * 使用指定字号渲染单次 PDF 预览，不参与二分搜索。用于用户切换纸张方向/字号后
 * 想先看一眼效果再决定要不要跑完整的 /api/optimize。
 * 响应直接是 PDF 二进制（Content-Disposition: inline，适合前端用 iframe/embed 内嵌预览），
 * 页数通过 X-Page-Count 响应头返回。
 */
optimizeRouter.post('/render', async (req: Request, res: Response) => {
  const body = req.body as RenderPreviewRequest;

  const validationError = validateRenderRequest(body);
  if (validationError) {
    const response: ApiErrorResponse = { error: validationError };
    res.status(400).json(response);
    return;
  }

  const markdown = body.cleanup ? cleanupMarkdown(body.markdown) : body.markdown;
  const paperSize = body.paperSize || 'A4';
  const margins = { ...DEFAULT_MARGINS, ...body.margins };
  const density = body.density || 'normal';
  const orientation = body.orientation || 'portrait';
  const columns = body.columns ?? 1;

  try {
    const { html } = await markdownToHtml(markdown);
    const ctx = await createRenderContext(html, { paperSize, margins, density, orientation, columns });

    try {
      await applyTypography(ctx, body.fontSize, density);
      const { pdfBuffer, pageCount } = await renderPdfAndCountPages(ctx, {
        paperSize,
        margins,
        density,
        orientation,
        columns,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
      res.setHeader('X-Page-Count', String(pageCount));
      res.send(pdfBuffer);
    } finally {
      await closeRenderContext(ctx);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    const response: ApiErrorResponse = { error: message };
    res.status(500).json(response);
  }
});
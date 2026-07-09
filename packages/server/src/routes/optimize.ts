import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { IterationRecord, OptimizeRequest, OptimizeResult } from '../types/index.js';
import { DEFAULT_MARGINS, SEARCH_CONFIG } from '../types/index.js';
import { searchOptimalFontSize } from '../engine/binary-search.js';
import { cleanupMarkdown } from '../engine/markdown-cleanup.js';
import { saveJob } from '../engine/job-store.js';

export const optimizeRouter = Router();

/**
 * POST /api/optimize
 * 接收 Markdown 和排版参数，通过二分搜索找到最佳字号
 * 使用 SSE 流式返回搜索过程
 */
optimizeRouter.post('/optimize', async (req: Request, res: Response) => {
  const body = req.body as OptimizeRequest;

  // 参数校验
  if (!body.markdown || typeof body.markdown !== 'string') {
    res.status(400).json({ error: '缺少 markdown 字段' });
    return;
  }
  if (!body.targetPages || body.targetPages < 1) {
    res.status(400).json({ error: 'targetPages 必须 >= 1' });
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
    const message = error instanceof Error ? error.message : '未知错误';
    sendEvent('error', { message });
    res.end();
  }
});

/**
 * POST /api/render
 * 使用指定字号渲染 PDF 预览（单次，不参与搜索）
 */
optimizeRouter.post('/render', async (_req: Request, res: Response) => {
  // TODO: 单次渲染预览
  res.json({ message: 'render endpoint (TODO)', fontSize: _req.body?.fontSize });
});
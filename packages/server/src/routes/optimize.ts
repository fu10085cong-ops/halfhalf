import { Router, Request, Response } from 'express';
import type { OptimizeRequest, OptimizeResult } from '../types/index.js';
import { DEFAULT_MARGINS, SEARCH_CONFIG } from '../types/index.js';

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

  // 填充默认值
  const params: Required<OptimizeRequest> = {
    markdown: body.markdown,
    targetPages: body.targetPages,
    paperSize: body.paperSize || 'A4',
    margins: body.margins || DEFAULT_MARGINS,
    density: body.density || 'normal',
    precision: body.precision || SEARCH_CONFIG.defaultPrecision,
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
    // TODO: 实际二分搜索逻辑将在 engine 模块中实现
    // 当前返回占位结果
    sendEvent('progress', {
      fontSize: 12,
      pages: 5,
      withinLimit: true,
      message: '二分搜索引擎尚未实现，返回占位数据',
    });

    const result: OptimizeResult = {
      optimalFontSize: 12,
      actualPages: 5,
      iterations: 1,
      history: [],
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
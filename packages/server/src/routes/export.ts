import { Router, Request, Response } from 'express';
import type { ApiErrorResponse } from '../types/index.js';
import { getJob } from '../engine/job-store.js';

export const exportRouter: Router = Router();

/**
 * GET /api/download/:jobId/pdf
 * 下载最终优化后的 PDF。jobId 来自 /api/optimize 的 SSE result 事件，任务在内存中保留 30 分钟。
 */
exportRouter.get('/download/:jobId/pdf', (req: Request, res: Response) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    const response: ApiErrorResponse = { error: '任务不存在或已过期' };
    res.status(404).json(response);
    return;
  }
  const fileName = job.fileName ?? `halfhalf-${req.params.jobId}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  // filename* 才能携带中文（RFC 5987）；filename 留一个纯 ASCII 兜底给老客户端
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="halfhalf.pdf"; filename*=UTF-8''${encodeURIComponent(fileName)}`
  );
  res.send(job.pdfBuffer);
});

/**
 * GET /api/download/:jobId/docx
 * 下载 DOCX。尚未实现，预留给后续 Pandoc 集成。
 */
exportRouter.get('/download/:jobId/docx', (_req: Request, res: Response) => {
  const response: ApiErrorResponse = { error: 'DOCX 导出功能尚未实现' };
  res.status(501).json(response);
});
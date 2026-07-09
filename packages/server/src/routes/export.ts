import { Router, Request, Response } from 'express';
import { getJob } from '../engine/job-store.js';

export const exportRouter = Router();

/**
 * GET /api/download/:jobId/pdf
 * 下载最终优化后的 PDF
 */
exportRouter.get('/download/:jobId/pdf', (req: Request, res: Response) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: '任务不存在或已过期' });
    return;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="halfhalf-${req.params.jobId}.pdf"`);
  res.send(job.pdfBuffer);
});

/**
 * GET /api/download/:jobId/docx
 * 下载 DOCX（预留接口）
 */
exportRouter.get('/download/:jobId/docx', (_req: Request, res: Response) => {
  // 预留：后续通过 Pandoc 实现
  res.status(501).json({ error: 'DOCX 导出功能即将支持' });
});
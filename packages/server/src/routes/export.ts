import { Router, Request, Response } from 'express';

export const exportRouter = Router();

/**
 * GET /api/download/:jobId/pdf
 * 下载最终优化后的 PDF
 */
exportRouter.get('/download/:jobId/pdf', (_req: Request, res: Response) => {
  // TODO: 从任务存储中获取 PDF 并返回
  res.status(501).json({ error: 'PDF 导出功能尚未实现' });
});

/**
 * GET /api/download/:jobId/docx
 * 下载 DOCX（预留接口）
 */
exportRouter.get('/download/:jobId/docx', (_req: Request, res: Response) => {
  // 预留：后续通过 Pandoc 实现
  res.status(501).json({ error: 'DOCX 导出功能即将支持' });
});
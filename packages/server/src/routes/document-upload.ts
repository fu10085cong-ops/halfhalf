import { Router, type Request } from 'express';
import multer from 'multer';
import {
  DocumentImportError,
  importDocx,
  importTextPdf,
} from '../engine/document-import.js';
import {
  cancelImportJob,
  createImportJob,
  getImportJob,
  importQueueLimits,
  ImportQueueError,
  listImportJobs,
  releaseImportSlot,
  tryAcquireImportSlot,
} from '../engine/import-job-store.js';

export const documentUploadRouter: Router = Router();

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
    fields: 0,
    parts: 2,
  },
});

function recoverUtf8FileName(name: string): string {
  // Some multipart clients still interpret UTF-8 filenames as latin1.
  if (!/[ÃÂä¸­æ–‡]/.test(name)) return name;
  try {
    const recovered = Buffer.from(name, 'latin1').toString('utf8');
    return recovered.includes('�') ? name : recovered;
  } catch {
    return name;
  }
}

documentUploadRouter.post('/import/document', (req, res) => {
  upload.single('file')(req, res, async (uploadError) => {
    if (uploadError) {
      if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          code: 'FILE_TOO_LARGE',
          error: '文件超过 20 MB。请先压缩图片或拆分文档后再导入。',
        });
        return;
      }
      res.status(400).json({
        code: 'UPLOAD_FAILED',
        error: uploadError instanceof Error ? uploadError.message : '文件上传失败。',
      });
      return;
    }

    if (!req.file) {
      res.status(400).json({ code: 'FILE_REQUIRED', error: '请选择要导入的文件。' });
      return;
    }

    const originalName = recoverUtf8FileName(req.file.originalname);
    const lowerName = originalName.toLowerCase();

    if (!lowerName.endsWith('.docx') && !lowerName.endsWith('.pdf')) {
      res.status(415).json({
        code: 'UNSUPPORTED_FILE',
        error: lowerName.endsWith('.doc')
          ? '旧版 .doc 暂不能直接解析，请在 Word 中“另存为 .docx”后再拖入。'
          : '当前支持 .docx、可复制文字的 PDF 和图片。',
      });
      return;
    }

    // 同步解析同样吃 pdfjs + PyMuPDF 的资源，必须占用与异步队列同一份并发额度
    if (!tryAcquireImportSlot()) {
      res.status(429).json({
        code: 'IMPORT_BUSY',
        error: '服务器正在解析其他文档，请稍后重试。',
      });
      return;
    }

    try {
      const result = lowerName.endsWith('.docx')
        ? await importDocx(req.file.buffer, originalName, req.file.size)
        : await importTextPdf(req.file.buffer, originalName, req.file.size);

      res.json(result);
    } catch (error) {
      if (error instanceof DocumentImportError) {
        res.status(error.status).json({
          code: error.code,
          error: error.message,
          details: error.details,
        });
        return;
      }
      res.status(500).json({
        code: 'IMPORT_FAILED',
        error: error instanceof Error ? error.message : '文档解析失败。',
      });
    } finally {
      releaseImportSlot();
    }
  });
});

function importOwner(req: Request): string {
  const header = req.get('x-halfhalf-client')?.trim().slice(0, 128);
  return header || req.ip || 'anonymous';
}

documentUploadRouter.get('/import/jobs/limits', (_req, res) => {
  res.json(importQueueLimits);
});

documentUploadRouter.get('/import/jobs', (req, res) => {
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit) ? requestedLimit : 20;
  res.json({ jobs: listImportJobs(importOwner(req), limit) });
});

documentUploadRouter.post('/import/jobs', (req, res) => {
  upload.single('file')(req, res, async (uploadError) => {
    if (uploadError) {
      if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          code: 'FILE_TOO_LARGE',
          error: '文件超过 20 MB。请先压缩图片或拆分文档后再导入。',
        });
        return;
      }
      res.status(400).json({
        code: 'UPLOAD_FAILED',
        error: uploadError instanceof Error ? uploadError.message : '文件上传失败。',
      });
      return;
    }

    if (!req.file) {
      res.status(400).json({ code: 'FILE_REQUIRED', error: '请选择要导入的文件。' });
      return;
    }

    const originalName = recoverUtf8FileName(req.file.originalname);
    const lowerName = originalName.toLowerCase();
    if (!lowerName.endsWith('.docx') && !lowerName.endsWith('.pdf')) {
      res.status(415).json({
        code: 'UNSUPPORTED_FILE',
        error: lowerName.endsWith('.doc')
          ? '旧版 .doc 暂不能直接解析，请先另存为 .docx。'
          : '当前异步解析支持 .docx 和 PDF。',
      });
      return;
    }

    try {
      const fileBuffer = req.file.buffer;
      const fileSize = req.file.size;
      const job = createImportJob({
        owner: importOwner(req),
        fileName: originalName,
        sizeBytes: fileSize,
        task: async (signal, report) =>
          lowerName.endsWith('.docx')
            ? await importDocx(fileBuffer, originalName, fileSize, {
                signal,
                onProgress: report,
              })
            : await importTextPdf(fileBuffer, originalName, fileSize, {
                signal,
                onProgress: report,
              }),
      });
      res.status(202).json(job);
    } catch (error) {
      if (error instanceof ImportQueueError) {
        res.status(error.status).json({ code: error.code, error: error.message });
        return;
      }
      res.status(500).json({
        code: 'IMPORT_JOB_CREATE_FAILED',
        error: error instanceof Error ? error.message : '无法创建解析任务。',
      });
    }
  });
});

documentUploadRouter.get('/import/jobs/:jobId', (req, res) => {
  const job = getImportJob(req.params.jobId, importOwner(req));
  if (!job) {
    res.status(404).json({ code: 'IMPORT_JOB_NOT_FOUND', error: '解析任务不存在或已过期。' });
    return;
  }
  res.json(job);
});

documentUploadRouter.delete('/import/jobs/:jobId', (req, res) => {
  const job = cancelImportJob(req.params.jobId, importOwner(req));
  if (!job) {
    res.status(404).json({ code: 'IMPORT_JOB_NOT_FOUND', error: '解析任务不存在或已过期。' });
    return;
  }
  res.json(job);
});

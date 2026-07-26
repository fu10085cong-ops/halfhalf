import { Router } from 'express';
import multer from 'multer';
import {
  DocumentImportError,
  importDocx,
  importTextPdf,
} from '../engine/document-import.js';

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
    return recovered.includes('\uFFFD') ? name : recovered;
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

    try {
      const result = lowerName.endsWith('.docx')
        ? await importDocx(req.file.buffer, originalName, req.file.size)
        : lowerName.endsWith('.pdf')
          ? await importTextPdf(req.file.buffer, originalName, req.file.size)
          : null;

      if (!result) {
        res.status(415).json({
          code: 'UNSUPPORTED_FILE',
          error: lowerName.endsWith('.doc')
            ? '旧版 .doc 暂不能直接解析，请在 Word 中“另存为 .docx”后再拖入。'
            : '当前支持 .docx、可复制文字的 PDF 和图片。',
        });
        return;
      }

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
    }
  });
});

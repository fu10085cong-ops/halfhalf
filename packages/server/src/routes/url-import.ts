/**
 * POST /api/import/url —— 网页链接 → 正文抽取 → Markdown（Studio 左栏「网页 URL」入口）。
 * SSRF 防护、大小/超时限制全在 engine/url-import.ts；这里只做请求校验、限流与错误映射。
 * 网页内容只在本次请求内存中处理，不落盘。
 */
import { Router, Request, Response } from 'express';
import type { ApiErrorResponse } from '../types/index.js';
import { DocumentImportError } from '../engine/document-import.js';
import { importUrl } from '../engine/url-import.js';

export const urlImportRouter: Router = Router();

// 抓取接口的滥用防线（它让服务器替人发请求）：每 IP 每小时 HALFHALF_URL_RATE_LIMIT 次（默认 30）
const RATE_LIMIT = Math.max(1, Number(process.env.HALFHALF_URL_RATE_LIMIT) || 30);
const RATE_WINDOW_MS = 60 * 60 * 1000;
const rateHits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const list = (rateHits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_LIMIT) {
    rateHits.set(key, list);
    return true;
  }
  list.push(now);
  rateHits.set(key, list);
  return false;
}

urlImportRouter.post('/import/url', async (req: Request, res: Response) => {
  const { url } = (req.body ?? {}) as { url?: unknown };
  if (typeof url !== 'string' || url.trim() === '') {
    res.status(400).json({ error: 'url 不能为空' } satisfies ApiErrorResponse);
    return;
  }
  if (rateLimited(req.ip ?? 'unknown')) {
    res.status(429).json({
      error: `太频繁了：每小时最多抓取 ${RATE_LIMIT} 个网页，请稍后再试`,
    } satisfies ApiErrorResponse);
    return;
  }

  try {
    const result = await importUrl(url);
    res.json(result);
  } catch (error) {
    if (error instanceof DocumentImportError) {
      res.status(error.status).json({
        code: error.code,
        error: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
      return;
    }
    const message = error instanceof Error ? error.message : '未知错误';
    res.status(500).json({ code: 'IMPORT_FAILED', error: `网页导入失败：${message}` });
  }
});

import { Router, Request, Response } from 'express';
import type { AiProxyRequest, ApiErrorResponse } from '../types/index.js';

export const aiRouter: Router = Router();

/**
 * BYOK 场景下允许转发到的 AI 服务商域名。用户自己的 key、自己承担调用费用，
 * 这里只是防止这个转发接口被当成任意网址的开放代理（SSRF）。
 */
const ALLOWED_HOSTS = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
]);

/**
 * POST /api/ai/proxy
 * 通用 BYOK AI 转发接口：不关心具体任务是"审核""精简"还是别的什么，
 * 只负责把请求体原样转发给用户指定的 AI 服务商 API，再把响应原样返回。
 * 用户的 API key 放在 headers 里传入，只存在于这一次请求的内存中，不落日志、不落盘。
 */
aiRouter.post('/ai/proxy', async (req: Request, res: Response) => {
  const { endpoint, headers, body } = req.body as AiProxyRequest;

  if (!endpoint || typeof endpoint !== 'string') {
    const response: ApiErrorResponse = { error: '缺少 endpoint 字段' };
    res.status(400).json(response);
    return;
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    const response: ApiErrorResponse = { error: 'endpoint 不是合法的 URL' };
    res.status(400).json(response);
    return;
  }

  if (url.protocol !== 'https:') {
    const response: ApiErrorResponse = { error: '仅支持 https 端点' };
    res.status(400).json(response);
    return;
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    const response: ApiErrorResponse = { error: `不支持的服务商域名: ${url.hostname}` };
    res.status(400).json(response);
    return;
  }

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(headers || {}),
      },
      body: JSON.stringify(body ?? {}),
      // 上游挂起时不能让这个请求悬死；60s 足够覆盖长文生成
      signal: AbortSignal.timeout(60_000),
    });

    const contentType = upstream.headers.get('content-type') || 'application/json';
    const text = await upstream.text();

    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);
    res.send(text);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      const response: ApiErrorResponse = { error: '转发失败: 上游响应超时（60s）' };
      res.status(504).json(response);
      return;
    }
    const message = error instanceof Error ? error.message : '未知错误';
    const response: ApiErrorResponse = { error: `转发失败: ${message}` };
    res.status(502).json(response);
  }
});

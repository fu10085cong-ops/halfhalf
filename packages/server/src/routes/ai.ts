import { Router, Request, Response } from 'express';

export const aiRouter = Router();

/**
 * BYOK 场景下允许转发到的 AI 服务商域名。用户自己的 key、自己承担调用费用，
 * 这里只是防止这个转发接口被当成任意网址的开放代理（SSRF）。
 */
const ALLOWED_HOSTS = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
]);

interface AiProxyRequest {
  endpoint: string;
  headers?: Record<string, string>;
  body: unknown;
}

/**
 * POST /api/ai/proxy
 * 通用 BYOK AI 转发接口：不关心具体任务是"审核""精简"还是别的什么，
 * 只负责把请求体原样转发给用户指定的 AI 服务商 API，再把响应原样返回。
 * 用户的 API key 放在 headers 里传入，只存在于这一次请求的内存中，不落日志、不落盘。
 */
aiRouter.post('/ai/proxy', async (req: Request, res: Response) => {
  const { endpoint, headers, body } = req.body as AiProxyRequest;

  if (!endpoint || typeof endpoint !== 'string') {
    res.status(400).json({ error: '缺少 endpoint 字段' });
    return;
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    res.status(400).json({ error: 'endpoint 不是合法的 URL' });
    return;
  }

  if (url.protocol !== 'https:') {
    res.status(400).json({ error: '仅支持 https 端点' });
    return;
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    res.status(400).json({ error: `不支持的服务商域名: ${url.hostname}` });
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
    });

    const contentType = upstream.headers.get('content-type') || 'application/json';
    const text = await upstream.text();

    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);
    res.send(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    res.status(502).json({ error: `转发失败: ${message}` });
  }
});

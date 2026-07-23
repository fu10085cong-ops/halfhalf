import { Router, Request, Response } from 'express';
import type { AiProxyRequest, AiCompressRequest, ApiErrorResponse } from '../types/index.js';
import { validateEndpoint, forwardRaw, AiTimeoutError } from '../engine/ai-provider.js';
import { compressMarkdown } from '../engine/ai-compress.js';

export const aiRouter: Router = Router();

/**
 * POST /api/ai/proxy
 * 通用 BYOK AI 转发接口：不关心具体任务是"审核""精简"还是别的什么，
 * 只负责把请求体原样转发给用户指定的 AI 服务商 API，再把响应原样返回。
 * 用户的 API key 放在 headers 里传入，只存在于这一次请求的内存中，不落日志、不落盘。
 * 域名白名单/转发/超时逻辑收在 engine/ai-provider.ts，与 /ai/compress 共用。
 */
aiRouter.post('/ai/proxy', async (req: Request, res: Response) => {
  const { endpoint, headers, body } = req.body as AiProxyRequest;

  const check = validateEndpoint(endpoint);
  if (check.error || !check.url) {
    const response: ApiErrorResponse = { error: check.error ?? 'endpoint 非法' };
    res.status(400).json(response);
    return;
  }

  try {
    const upstream = await forwardRaw(check.url, headers, body);
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.contentType);
    res.send(upstream.text);
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

/** /ai/compress 请求校验：返回中文错误串或 null */
function validateCompress(body: AiCompressRequest): string | null {
  if (!body || typeof body !== 'object') return '请求体缺失';
  if (!body.markdown || typeof body.markdown !== 'string') return 'markdown 必须是非空字符串';
  if (!body.provider || typeof body.provider !== 'object') return '缺少 provider 配置';
  const { provider } = body;
  const check = validateEndpoint(provider.endpoint);
  if (check.error) return check.error;
  if (!provider.model || typeof provider.model !== 'string') return 'provider.model 必须是非空字符串';
  if (
    provider.temperature !== undefined &&
    (typeof provider.temperature !== 'number' || provider.temperature < 0)
  ) {
    return 'provider.temperature 必须是 >= 0 的数字';
  }
  if (body.blockIds !== undefined && !Array.isArray(body.blockIds)) {
    return 'blockIds 必须是数组';
  }
  return null;
}

/**
 * POST /api/ai/compress
 * AI 语义级精简：分块 → 遮罩刚性原子 → 只把散文交给用户自带 key 的 AI 改写 → 回填 →
 * 三道安全网（占位符完整/无新公式错误/确实缩短）→ 批量返回逐块"原文 vs 建议"。
 * 结果只是建议，前端展示 diff、用户逐块接受后才回写，不自动改文档。
 * 与 /ai/proxy 同样的 BYOK 隐私姿态：key 只在单次请求内存里，不落日志/不落盘。
 */
aiRouter.post('/ai/compress', async (req: Request, res: Response) => {
  const body = req.body as AiCompressRequest;

  const err = validateCompress(body);
  if (err) {
    const response: ApiErrorResponse = { error: err };
    res.status(400).json(response);
    return;
  }

  try {
    const result = await compressMarkdown(body);
    res.json(result);
  } catch (error) {
    if (error instanceof AiTimeoutError) {
      const response: ApiErrorResponse = { error: 'AI 精简失败: 上游响应超时' };
      res.status(504).json(response);
      return;
    }
    const message = error instanceof Error ? error.message : '未知错误';
    const response: ApiErrorResponse = { error: `AI 精简失败: ${message}` };
    res.status(500).json(response);
  }
});

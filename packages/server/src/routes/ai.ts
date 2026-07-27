import { Router, Request, Response } from 'express';
import type {
  AiProxyRequest,
  AiCompressRequest,
  AiStructurizeRequest,
  AiChatRequest,
  AiProviderConfig,
  ApiErrorResponse,
} from '../types/index.js';
import {
  validateEndpoint,
  forwardRaw,
  AiTimeoutError,
  PROVIDER_PRESETS,
} from '../engine/ai-provider.js';
import { compressMarkdown } from '../engine/ai-compress.js';
import { structurize, resolveServerProvider } from '../engine/ai-structurize.js';
import { chatRespond, type ChatTurn } from '../engine/ai-chat.js';

export const aiRouter: Router = Router();

/**
 * GET /api/ai/providers
 * 「AI 设置」下拉的服务商预设清单（静态常量，与 BYOK 白名单同源维护）。
 * 只是候选项——用户仍可手填任何白名单内的端点。
 */
aiRouter.get('/ai/providers', (_req: Request, res: Response) => {
  res.json({ providers: PROVIDER_PRESETS });
});

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

// —— structurize / chat 共用的滥用防线（两者都可能花部署者的 key 钱）——
// 内存滑动窗口限流：每 IP 每小时 HALFHALF_AI_RATE_LIMIT 次（默认 10）；
// 输入长度上限 HALFHALF_AI_MAX_INPUT 字符（默认 6 万，约一门课的完整讲义）。
const RATE_LIMIT = Math.max(1, Number(process.env.HALFHALF_AI_RATE_LIMIT) || 10);
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_INPUT_CHARS = Math.max(1000, Number(process.env.HALFHALF_AI_MAX_INPUT) || 60_000);
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

/** BYOK provider 的形状校验（endpoint 白名单 + model），与 /ai/compress 同口径 */
function validateProvider(provider: AiProviderConfig): string | null {
  const check = validateEndpoint(provider.endpoint);
  if (check.error) return check.error;
  if (!provider.model || typeof provider.model !== 'string') {
    return 'provider.model 必须是非空字符串';
  }
  return null;
}

/**
 * key 解析（structurize / chat 共用）：BYOK（走白名单）> 服务器统一 key（端点受信任）> 报错。
 * 返回 error 时已带 HTTP 状态，路由直接回 JSON。
 */
function resolveProvider(
  byok: AiProviderConfig | undefined
): { provider: AiProviderConfig; trustEndpoint: boolean } | { status: number; error: string } {
  if (byok) {
    const err = validateProvider(byok);
    if (err) return { status: 400, error: err };
    return { provider: byok, trustEndpoint: false };
  }
  const serverProvider = resolveServerProvider();
  if (!serverProvider) {
    return {
      status: 501,
      error: '服务器未配置 AI（HALFHALF_AI_ENDPOINT/MODEL/KEY），请在「AI 设置」里填自己的 key',
    };
  }
  return { provider: serverProvider, trustEndpoint: true };
}

/**
 * POST /api/ai/structurize（SSE 流式）
 * ⓪ 结构化入口：任意粘贴内容 → 标准 .md（DESIGN.md）。只重组不新增知识。
 * key 解析顺序：请求带 provider（BYOK，走白名单）> 服务器统一 key（env，端点受信任）> 501。
 * SSE 事件：delta {text, attempt} / retry {problems} / result {markdown, check, attempts} / error {error}。
 */
aiRouter.post('/ai/structurize', async (req: Request, res: Response) => {
  const body = req.body as AiStructurizeRequest;
  if (!body || typeof body.content !== 'string' || body.content.trim() === '') {
    res.status(400).json({ error: 'content 不能为空' } satisfies ApiErrorResponse);
    return;
  }
  if (body.content.length > MAX_INPUT_CHARS) {
    res.status(413).json({
      error: `内容超过 ${MAX_INPUT_CHARS} 字上限，请分段转换`,
    } satisfies ApiErrorResponse);
    return;
  }

  // BYOK 优先（用户花自己的钱），否则服务器统一 key
  const resolved = resolveProvider(body.provider);
  if ('error' in resolved) {
    res.status(resolved.status).json({ error: resolved.error } satisfies ApiErrorResponse);
    return;
  }
  const { provider, trustEndpoint } = resolved;

  if (rateLimited(req.ip ?? 'unknown')) {
    res.status(429).json({
      error: `太频繁了：每小时最多 ${RATE_LIMIT} 次结构化，请稍后再试`,
    } satisfies ApiErrorResponse);
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await structurize(
      body.content,
      provider,
      {
        onDelta: (text, attempt) => send('delta', { text, attempt }),
        onRetry: (problems) => send('retry', { problems }),
      },
      { trustEndpoint }
    );
    send('result', result);
  } catch (error) {
    const message =
      error instanceof AiTimeoutError
        ? '上游响应超时'
        : error instanceof Error
          ? error.message
          : '未知错误';
    send('error', { error: `结构化失败: ${message}` });
  } finally {
    res.end();
  }
});

/** /ai/chat 请求校验：返回中文错误串或 null（长度上限单独走 413） */
function validateChat(body: AiChatRequest): string | null {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return 'messages 不能为空';
  }
  for (const m of body.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      return 'messages 里的 role 只能是 user / assistant';
    }
    if (typeof m.content !== 'string' || m.content.trim() === '') {
      return 'messages 里的 content 必须是非空字符串';
    }
  }
  if (body.messages[body.messages.length - 1].role !== 'user') {
    return '最后一条消息必须是 user';
  }
  if (body.context !== undefined && typeof body.context !== 'string') {
    return 'context 必须是字符串';
  }
  return null;
}

/**
 * POST /api/ai/chat（SSE 流式）
 * 多轮材料对话：围绕客户端带来的材料回答/改写/给排版建议（红线在 engine/ai-chat.ts 的
 * system prompt）。服务端无状态：材料 + 历史每次全量带上，不落盘不留存。
 * key 解析、限流、输入上限与 /ai/structurize 完全同一套。
 * SSE 事件：delta {text} / result {reply} / error {error}。
 */
aiRouter.post('/ai/chat', async (req: Request, res: Response) => {
  const body = req.body as AiChatRequest;
  const err = validateChat(body);
  if (err) {
    res.status(400).json({ error: err } satisfies ApiErrorResponse);
    return;
  }
  const totalChars =
    (body.context?.length ?? 0) + body.messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars > MAX_INPUT_CHARS) {
    res.status(413).json({
      error: `材料 + 对话超过 ${MAX_INPUT_CHARS} 字上限，请减少参与对话的材料`,
    } satisfies ApiErrorResponse);
    return;
  }

  const resolved = resolveProvider(body.provider);
  if ('error' in resolved) {
    res.status(resolved.status).json({ error: resolved.error } satisfies ApiErrorResponse);
    return;
  }

  if (rateLimited(req.ip ?? 'unknown')) {
    res.status(429).json({
      error: `太频繁了：每小时最多 ${RATE_LIMIT} 次 AI 调用，请稍后再试`,
    } satisfies ApiErrorResponse);
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await chatRespond(
      { context: body.context ?? '', messages: body.messages as ChatTurn[] },
      resolved.provider,
      { onDelta: (text) => send('delta', { text }) },
      { trustEndpoint: resolved.trustEndpoint }
    );
    send('result', result);
  } catch (error) {
    const message =
      error instanceof AiTimeoutError
        ? '上游响应超时'
        : error instanceof Error
          ? error.message
          : '未知错误';
    send('error', { error: `对话失败: ${message}` });
  } finally {
    res.end();
  }
});

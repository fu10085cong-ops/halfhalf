/**
 * BYOK AI 服务商接入的共享层：域名白名单校验 + 原样转发 + OpenAI 兼容的对话调用。
 * 由 /api/ai/proxy（原样转发）和 /api/ai/compress（构造请求 + 解析响应）共用，
 * 把"哪些域名可达""怎么发请求""60s 超时"这些安全/传输关注点收在一处。
 *
 * key 只存在于单次请求的内存里（放在传入的 headers 中），本模块不记录日志、不落盘。
 */
import type { AiProviderConfig } from '../types/index.js';

/**
 * BYOK 场景下允许转发到的 AI 服务商域名。用户自己的 key、自己承担调用费用，
 * 白名单只是防止转发接口被当成任意网址的开放代理（SSRF）。
 * 可选环境变量 HALFHALF_AI_ALLOW_LOCALHOST=1 放开 localhost——仅供本地无 token 联调
 * （见 test/ 里的 echo server），默认关闭，绝不要在生产开。
 */
export const ALLOWED_HOSTS = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
]);

function isAllowedHost(hostname: string): boolean {
  if (ALLOWED_HOSTS.has(hostname)) return true;
  if (
    process.env.HALFHALF_AI_ALLOW_LOCALHOST === '1' &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
  ) {
    return true;
  }
  return false;
}

export interface EndpointCheck {
  url?: URL;
  error?: string;
}

/** 校验 endpoint：必须是 https（localhost 联调时放行 http）且域名在白名单内 */
export function validateEndpoint(endpoint: unknown): EndpointCheck {
  if (!endpoint || typeof endpoint !== 'string') {
    return { error: '缺少 endpoint 字段' };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { error: 'endpoint 不是合法的 URL' };
  }
  const localhostOk =
    process.env.HALFHALF_AI_ALLOW_LOCALHOST === '1' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !localhostOk) {
    return { error: '仅支持 https 端点' };
  }
  if (!isAllowedHost(url.hostname)) {
    return { error: `不支持的服务商域名: ${url.hostname}` };
  }
  return { url };
}

export interface RawForwardResult {
  status: number;
  contentType: string;
  text: string;
}

/**
 * 原样把 POST 请求转发给上游 AI 服务商，返回上游的状态码/content-type/原文。
 * 上游挂起时用 AbortSignal.timeout 兜底，不让请求悬死。抛出的错误里区分超时。
 */
export async function forwardRaw(
  url: URL,
  headers: Record<string, string> | undefined,
  body: unknown,
  timeoutMs = 60_000,
): Promise<RawForwardResult> {
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(headers || {}),
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: upstream.status,
    contentType: upstream.headers.get('content-type') || 'application/json',
    text: await upstream.text(),
  };
}

/** 上游超时会抛这个，供调用方映射成 504 */
export class AiTimeoutError extends Error {
  constructor() {
    super('上游响应超时');
    this.name = 'AiTimeoutError';
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * OpenAI 兼容的 /chat/completions 调用：构造请求体、转发、从 choices[0].message.content 取回答。
 * 只认 OpenAI 形状的响应（v1 只支持这一种格式）；字段缺失时抛清晰错误，不静默返回空串。
 */
export async function chatComplete(
  provider: AiProviderConfig,
  messages: ChatMessage[],
  timeoutMs = 60_000,
): Promise<string> {
  const check = validateEndpoint(provider.endpoint);
  if (check.error || !check.url) {
    throw new Error(check.error ?? 'endpoint 非法');
  }

  const requestBody = {
    model: provider.model,
    temperature: provider.temperature ?? 0.2,
    stream: false,
    messages,
  };

  let result: RawForwardResult;
  try {
    result = await forwardRaw(check.url, provider.headers, requestBody, timeoutMs);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new AiTimeoutError();
    }
    throw error;
  }

  if (result.status < 200 || result.status >= 300) {
    // 上游错误原文往往含服务商的具体报错（额度/模型名/鉴权），截断后带上便于用户定位
    const snippet = result.text.slice(0, 300);
    throw new Error(`上游返回 ${result.status}: ${snippet}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new Error('上游响应不是合法 JSON（该接口只支持 OpenAI 兼容格式）');
  }

  const content = (parsed as { choices?: { message?: { content?: unknown } }[] })
    ?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('上游响应缺少 choices[0].message.content（该接口只支持 OpenAI 兼容格式）');
  }
  return content;
}

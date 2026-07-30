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
  'api.deepseek.com',
  'dashscope.aliyuncs.com',
  'open.bigmodel.cn',
  // MiniMax 国内与国际两个端点都在服务（2026-07-29 实测均返回 401 而非无法连接），
  // 用户拿哪个 key 就该能填哪个域名，两个都放行。
  'api.minimaxi.com',
  'api.minimax.io',
]);

/**
 * 前端「AI 设置」下拉的服务商预设。与 ALLOWED_HOSTS 同源维护：
 * 每个 endpoint 的域名必须在白名单里（有单测锁），避免前端硬编码漂移。
 * defaultModel 挑各家便宜稳的默认档；keyUrl 是申请 key 的入口页。
 */
export interface AiProviderPreset {
  id: string;
  name: string;
  endpoint: string;
  defaultModel: string;
  keyUrl: string;
}

export const PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek（深度求索）',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    defaultModel: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'qwen',
    name: '通义千问（阿里云百炼）',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    defaultModel: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    defaultModel: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    endpoint: 'https://api.minimaxi.com/v1/chat/completions',
    defaultModel: 'MiniMax-Text-01',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
];

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
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(headers || {}),
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw describeNetworkError(error);
  }
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

/** 常见 errno → 人话，附「该查什么」。查不到就原样带上 code，总好过一句 fetch failed。 */
const NET_HINTS: Record<string, string> = {
  ENOTFOUND: 'DNS 解析不到这个域名（域名拼错，或本机 DNS/代理没生效）',
  EAI_AGAIN: 'DNS 暂时解析失败（网络不稳或 DNS 服务器无响应）',
  ECONNREFUSED: '对方拒绝连接（端口不对，或本机需要走代理才能出网）',
  ECONNRESET: '连接被中途重置（常见于代理/VPN 不稳，或被网络中间设备切断）',
  ETIMEDOUT: 'TCP 连接超时（网络不通，或被防火墙丢包）',
  EPROTO: 'TLS 握手失败（代理在中间解 HTTPS，或证书被替换）',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书验证不过（多半是代理/杀软在中间人解密）',
  CERT_HAS_EXPIRED: '对方证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: '对方用的是自签名证书',
  // undici 自己的码（不是 OS errno）。2026-07-30 实测:走代理时最常撞见的就是这个,
  // 消息里已带"attempted addresses",直接给出人话解释比只报 code 有用。
  UND_ERR_CONNECT_TIMEOUT: '建连超时（网络不通或代理/VPN 太慢,默认 10 秒）',
  UND_ERR_HEADERS_TIMEOUT: '上游收到请求但迟迟不回响应头（服务商过载或代理拦截）',
  UND_ERR_SOCKET: '连接在传输中断开（代理/VPN 不稳）',
};

/**
 * 把 undici 的 `fetch failed` 拆开。
 *
 * Node 的 fetch 出网失败时 `message` 恒为 "fetch failed"，真因埋在 `cause.code`/`cause.message`
 * 里。老代码直接 `throw error`，用户界面上只剩一句「结构化失败: fetch failed」——
 * 零信息量，连是 DNS 挂了还是证书不过都分不出，我们自己也没法远程判断
 * （2026-07-30 判例：用户 Word 转换恒失败，服务端一行日志都没有，只能靠加信息才定位）。
 */
export function describeNetworkError(error: unknown): Error {
  if (!(error instanceof Error) || error.message !== 'fetch failed') {
    return error instanceof Error ? error : new Error(String(error));
  }
  const cause = (error as { cause?: unknown }).cause;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? String((cause as { code: unknown }).code)
      : undefined;
  const detail =
    typeof cause === 'object' && cause !== null && 'message' in cause
      ? String((cause as { message: unknown }).message)
      : undefined;
  const hint = code ? NET_HINTS[code] : undefined;
  const parts = [hint ?? detail ?? '原因不明', code ? `[${code}]` : ''].filter(Boolean);
  return new Error(`连不上 AI 服务商：${parts.join(' ')}`);
}

export interface ChatStreamOptions {
  /** 总时长上限（含流式读取），默认 180s——结构化整份材料比单块精简耗时长 */
  timeoutMs?: number;
  /**
   * 信任 endpoint、跳过 BYOK 白名单：仅供**服务器 env 配置**的部署者自有端点
   * （部署者控制自己的机器，可指向本地 Ollama 等）。用户传入的 endpoint 绝不能开。
   */
  trustEndpoint?: boolean;
}

/**
 * OpenAI 兼容的流式对话调用（stream: true）：逐段回调 delta 文本，返回拼好的全文。
 * 解析 SSE 帧格式 `data: {json}`，终止标记 `data: [DONE]`。
 * 与 chatComplete 同样只认 OpenAI 形状；全程零输出时抛错，不静默返回空串。
 */
export async function chatCompleteStream(
  provider: AiProviderConfig,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  options?: ChatStreamOptions,
): Promise<string> {
  let url: URL;
  if (options?.trustEndpoint) {
    try {
      url = new URL(provider.endpoint);
    } catch {
      throw new Error('endpoint 不是合法的 URL');
    }
  } else {
    const check = validateEndpoint(provider.endpoint);
    if (check.error || !check.url) throw new Error(check.error ?? 'endpoint 非法');
    url = check.url;
  }

  let resp: globalThis.Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(provider.headers || {}) },
      body: JSON.stringify({
        model: provider.model,
        temperature: provider.temperature ?? 0.2,
        stream: true,
        messages,
      }),
      signal: AbortSignal.timeout(options?.timeoutMs ?? 180_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new AiTimeoutError();
    throw describeNetworkError(error);
  }
  if (!resp.ok || !resp.body) {
    const snippet = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`上游返回 ${resp.status}: ${snippet}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // 半截 JSON 或注释帧：跳过，不让单帧毁掉整个流
        }
        const delta = (parsed as { choices?: { delta?: { content?: unknown } }[] })
          ?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta !== '') {
          full += delta;
          onDelta(delta);
        }
      }
    }
  } catch (error) {
    // 读流中途超时也走同一个 AbortSignal，映射成统一的超时错误
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new AiTimeoutError();
    throw describeNetworkError(error);
  }
  if (full === '') {
    throw new Error('上游流式响应为空（该接口只支持 OpenAI 兼容格式）');
  }
  return full;
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

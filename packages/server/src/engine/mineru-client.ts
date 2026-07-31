/**
 * MinerU sidecar client (experimental).
 *
 * HalfHalf deliberately does not install MinerU, its models, or any OCR runtime in
 * the application image.  A separately operated `mineru-api` service is optional:
 * when HALFHALF_MINERU_API_URL is absent this module is inert.  That keeps the
 * existing native-text / source-visual fallback path as the product default.
 *
 * MinerU 3.x API contract used here:
 *   GET  /health
 *   POST /tasks (multipart, `files`, `return_md=true`)
 *   GET  /tasks/{task_id}
 *   GET  /tasks/{task_id}/result
 *
 * Do not treat a MinerU result as trusted Markdown yet.  A later integration must
 * preserve source anchors, run the input-format gate and keep low-confidence
 * formula/table regions as source visuals.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export class MineruError extends Error {
  constructor(
    public readonly code: 'MINERU_UNAVAILABLE' | 'MINERU_REJECTED' | 'MINERU_PROTOCOL_ERROR',
    message: string,
    public readonly status = 502
  ) {
    super(message);
  }
}

export interface MineruClientConfig {
  /** Base URL of a self-hosted mineru-api/router, for example http://127.0.0.1:8000. */
  baseUrl: string;
  timeoutMs?: number;
}

export interface MineruUpload {
  bytes: Uint8Array;
  filename: string;
  contentType?: string;
}

export interface MineruTask {
  taskId: string;
  /** MinerU owns the exact status vocabulary, so retain the upstream payload. */
  status?: string;
  queuedAhead?: number;
  raw: Record<string, unknown>;
}

export interface MineruResult {
  bytes: ArrayBuffer;
  contentType: string | null;
}

export type MineruFetch = (input: string, init?: RequestInit) => Promise<Response>;

function normalizedBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MineruError('MINERU_PROTOCOL_ERROR', 'MinerU 服务地址不是有效 URL。', 500);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MineruError('MINERU_PROTOCOL_ERROR', 'MinerU 服务地址只能使用 HTTP 或 HTTPS。', 500);
  }
  return parsed.toString().replace(/\/$/, '');
}

function objectPayload(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function taskFromPayload(payload: unknown): MineruTask {
  const raw = objectPayload(payload);
  const taskId = typeof raw.task_id === 'string' ? raw.task_id : '';
  if (!taskId) {
    throw new MineruError('MINERU_PROTOCOL_ERROR', 'MinerU 响应缺少 task_id，无法继续追踪解析任务。');
  }
  return {
    taskId,
    ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
    ...(typeof raw.queued_ahead === 'number' ? { queuedAhead: raw.queued_ahead } : {}),
    raw,
  };
}

/**
 * Thin client for a separately deployed MinerU service.  It is intentionally not
 * constructed from a browser-supplied URL: deployment config is the trust boundary.
 */
export class MineruClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: MineruClientConfig, private readonly fetcher: MineruFetch = fetch) {
    this.baseUrl = normalizedBaseUrl(config.baseUrl);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async health(): Promise<Record<string, unknown>> {
    return objectPayload(await this.json('/health'));
  }

  async submit(upload: MineruUpload): Promise<MineruTask> {
    if (!upload.filename.trim()) {
      throw new MineruError('MINERU_PROTOCOL_ERROR', 'MinerU 上传必须带文件名。', 400);
    }
    const form = new FormData();
    // Copy into an ArrayBuffer: Uint8Array may be backed by SharedArrayBuffer, which
    // is not accepted as a BlobPart by the DOM typings used by this project.
    const body = Uint8Array.from(upload.bytes).buffer;
    form.append('files', new Blob([body], { type: upload.contentType ?? 'application/octet-stream' }), upload.filename);
    // This spike deploys only the lightweight pipeline model set.  MinerU defaults
    // to hybrid-engine, which would try to load an uninstalled VLM and make a
    // configured sidecar look broken.  Keep the hardware-safe choice explicit.
    form.append('backend', 'pipeline');
    form.append('parse_method', 'auto');
    form.append('lang_list', 'ch');
    // Markdown is the smallest useful experimental output.  Rich auxiliary output
    // stays owned by the sidecar until the evidence contract is designed.
    form.append('return_md', 'true');
    return taskFromPayload(await this.json('/tasks', { method: 'POST', body: form }));
  }

  async task(taskId: string): Promise<MineruTask> {
    const safeTaskId = encodeURIComponent(taskId.trim());
    if (!safeTaskId) throw new MineruError('MINERU_PROTOCOL_ERROR', 'MinerU task_id 不能为空。', 400);
    return taskFromPayload(await this.json(`/tasks/${safeTaskId}`));
  }

  async result(taskId: string): Promise<MineruResult> {
    const safeTaskId = encodeURIComponent(taskId.trim());
    if (!safeTaskId) throw new MineruError('MINERU_PROTOCOL_ERROR', 'MinerU task_id 不能为空。', 400);
    const response = await this.request(`/tasks/${safeTaskId}/result`);
    return { bytes: await response.arrayBuffer(), contentType: response.headers.get('content-type') };
  }

  private async json(pathname: string, init?: RequestInit): Promise<unknown> {
    const response = await this.request(pathname, init);
    return response.json().catch(() => {
      throw new MineruError('MINERU_PROTOCOL_ERROR', 'MinerU 返回的不是 JSON。');
    });
  }

  private async request(pathname: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${pathname}`, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new MineruError('MINERU_UNAVAILABLE', `MinerU 服务连接失败：${detail}`);
    }
    if (response.ok) return response;

    const detail = await response.text().catch(() => '');
    throw new MineruError(
      'MINERU_REJECTED',
      `MinerU 服务拒绝了请求（HTTP ${response.status}）${detail ? `：${detail.slice(0, 500)}` : ''}`,
      response.status >= 400 && response.status < 500 ? response.status : 502
    );
  }
}

/** Returns null until a self-hosted sidecar is explicitly configured. */
export function createMineruClient(): MineruClient | null {
  const baseUrl = process.env.HALFHALF_MINERU_API_URL?.trim();
  return baseUrl ? new MineruClient({ baseUrl }) : null;
}

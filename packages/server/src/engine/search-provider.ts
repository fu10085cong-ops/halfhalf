/**
 * 联网检索的搜索源抽象。
 *
 * 这一层存在的理由被实测验证过一次：设计初稿打算用「模型内置联网」，实测发现
 * DeepSeek 传 enable_search 会 HTTP 200 静默忽略、内容全由模型凭记忆编造。
 * 换成智谱 web_search 时，因为有这层抽象，上层流水线一行没改。
 *
 * key 只存在于单次请求的内存里，本模块不记录日志、不落盘。
 */
import type { SearchHit } from '../types/index.js';
import { hostnameOf } from './source-quality.js';

export class SearchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 502
  ) {
    super(message);
    this.name = 'SearchError';
  }
}

export interface SearchProvider {
  readonly id: string;
  search(query: string, options?: { signal?: AbortSignal }): Promise<SearchHit[]>;
}

const SEARCH_TIMEOUT_MS = 30_000;

/** 智谱返回的单条结果。字段名以 2026-07-27 实测为准。 */
interface ZhipuSearchResultItem {
  title?: unknown;
  content?: unknown;
  link?: unknown;
  publish_date?: unknown;
}

/**
 * 把厂商响应映射成 SearchHit。没有 link 的条目直接丢弃——
 * 溯源是硬要求，拿不到 URL 的结果对本功能没有价值。
 */
export function mapZhipuResults(payload: unknown): SearchHit[] {
  const results = (payload as { search_result?: unknown })?.search_result;
  if (!Array.isArray(results)) return [];

  const hits: SearchHit[] = [];
  for (const raw of results as ZhipuSearchResultItem[]) {
    const url = typeof raw?.link === 'string' ? raw.link : '';
    const domain = url ? hostnameOf(url) : null;
    if (!domain) continue;

    const snippet = typeof raw?.content === 'string' ? raw.content.trim() : '';
    if (!snippet) continue;

    hits.push({
      title: typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim() : domain,
      snippet,
      url,
      domain,
      ...(typeof raw?.publish_date === 'string' && raw.publish_date
        ? { publishDate: raw.publish_date }
        : {}),
    });
  }
  return hits;
}

export interface ZhipuSearchConfig {
  apiKey: string;
  /** search_std / search_pro / search_pro_quark。实测 std 与 pro 结果相同，默认取 std。 */
  engine?: string;
  endpoint?: string;
}

const ZHIPU_SEARCH_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/web_search';

export class ZhipuSearchProvider implements SearchProvider {
  readonly id = 'zhipu';

  constructor(private readonly config: ZhipuSearchConfig) {}

  async search(query: string, options: { signal?: AbortSignal } = {}): Promise<SearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) throw new SearchError('SEARCH_EMPTY_QUERY', '检索关键词不能为空。', 400);

    // 实测密集调用时约两成会连接级失败（疑似限流）。只对连接失败重试一次，
    // 4xx/5xx 响应不重试——那是服务端的明确答复，重试只会浪费配额。
    try {
      return await this.searchOnce(trimmed, options.signal);
    } catch (error) {
      if (!(error instanceof SearchError) || error.code !== 'SEARCH_FETCH_FAILED') throw error;
      if (options.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 800));
      return this.searchOnce(trimmed, options.signal);
    }
  }

  private async searchOnce(trimmed: string, signal?: AbortSignal): Promise<SearchHit[]> {
    const options = { signal };
    let response: Response;
    try {
      response = await fetch(this.config.endpoint ?? ZHIPU_SEARCH_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          search_engine: this.config.engine ?? 'search_std',
          search_query: trimmed,
        }),
        signal: options.signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // fetch 的顶层 message 恒为 "fetch failed"，真正的原因（ECONNRESET / 证书 /
      // DNS / 超时）藏在 cause 里。不带上它，线上排查时等于什么都没说。
      const cause = (error as { cause?: unknown })?.cause;
      const causeText =
        cause instanceof Error
          ? `${(cause as NodeJS.ErrnoException).code ?? cause.name}: ${cause.message}`
          : cause
            ? String(cause)
            : '';
      const base = error instanceof Error ? error.message : String(error);
      throw new SearchError(
        'SEARCH_FETCH_FAILED',
        `搜索服务连接失败：${base}${causeText ? `（${causeText}）` : ''}`,
        502
      );
    }

    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail =
        (payload as { error?: { message?: string } })?.error?.message ?? `HTTP ${response.status}`;
      // 401/403 是配置问题，不该让用户以为是「搜不到」
      const status = response.status === 401 || response.status === 403 ? 501 : 502;
      throw new SearchError('SEARCH_REJECTED', `搜索服务拒绝了请求：${detail}`, status);
    }

    return mapZhipuResults(payload);
  }
}

/**
 * 按环境变量装配搜索源。没配 key 就明确返回 null，由上层报 501——
 * 绝不静默退化成让模型凭记忆生成（spec 第 2 节红线）。
 */
export function createSearchProvider(): SearchProvider | null {
  const apiKey = process.env.HALFHALF_SEARCH_KEY?.trim();
  if (!apiKey) return null;
  return new ZhipuSearchProvider({
    apiKey,
    engine: process.env.HALFHALF_SEARCH_ENGINE?.trim() || 'search_std',
  });
}

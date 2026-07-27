/**
 * URL 网页抓取（POST /api/import/url）：网页 → 正文抽取（Readability）→ Markdown。
 * Studio 左栏「网页 URL」入口的引擎层；产物与文档导入同形（ImportedDocument, kind='url'）。
 *
 * SSRF 是这里的头号威胁——公网部署下这个接口就是一个"替服务器发请求"的代理：
 * - 只允许 http/https
 * - 目标域名先 DNS 解析，任一解析结果落在私网/环回/链路本地/CGNAT 段即拒绝
 * - 重定向手动跟随（≤3 跳），每一跳重新过同样的校验
 * - 15s 超时、响应 ≤5MB、content-type 必须是 HTML
 * 残余风险（DNS 重绑定：校验后到发请求之间换解析）接受不管——接口在访问口令闸后面，
 * 且本服务无内网可探（单容器部署）。HALFHALF_URL_ALLOW_PRIVATE=1 仅供本地联调。
 *
 * 图片不导入（网页图片是远程 URL，渲染期再去抓既慢又漏隐私；排版管线只认 data URI）。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { ImportedDocument } from '../types/index.js';
import {
  DocumentImportError,
  countDocumentCharacters,
  countMatches,
  createTurndown,
  normalizeMarkdown,
} from './document-import.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** 抽出的正文少于这个字数按"没抽到"处理（动态渲染页/登录墙的典型表现） */
const MIN_CONTENT_CHARS = 30;
/** Readability 产物的采信线：小页面它会退化成"整页打包"（连导航一起带回），
 *  低于此长度宁可走确定性的剥壳 fallback（真实判例：tiny 页 nav 混入正文） */
const READABILITY_MIN_CHARS = 150;

// ---------- SSRF 防护 ----------

/** 私网/保留段 IPv4 判定（点分十进制） */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // 本网/私网/环回
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // 链路本地（云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网 172.16/12
  if (a === 192 && b === 168) return true; // 私网 192.168/16
  if (a === 192 && b === 0) return true; // 192.0.0/24 保留 + 192.0.2 文档段
  if (a >= 224) return true; // 组播 224/4 + 保留 240/4 + 广播
  return false;
}

/** 私网/保留地址判定（IPv4/IPv6 都认；IPv6 含 v4 映射形态） */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind !== 6) return true; // 不是合法 IP 一律拒
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true; // 未指定/环回
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // v4 映射
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(lower)) return true; // 链路本地 fe80::/10
  return false;
}

export interface UrlImportDeps {
  fetch?: typeof fetch;
  /** DNS 解析注入口（测试用）；返回全部地址，任一被拒即拦 */
  resolve?: (hostname: string) => Promise<string[]>;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
}

function privateAllowed(): boolean {
  return process.env.HALFHALF_URL_ALLOW_PRIVATE === '1';
}

/** 单跳校验：协议 + 域名解析后全部地址过私网闸。任何失败抛 DocumentImportError */
async function assertUrlAllowed(url: URL, deps: UrlImportDeps): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DocumentImportError('URL_INVALID', '只支持 http/https 链接', 400);
  }
  if (privateAllowed()) return;
  const bareHost = url.hostname.replace(/^\[|\]$/g, ''); // IPv6 字面量去掉方括号
  if (isIP(bareHost)) {
    if (isBlockedIp(bareHost)) {
      throw new DocumentImportError('URL_BLOCKED', '该地址指向内网/保留网段，已拒绝抓取', 403);
    }
    return;
  }
  if (bareHost === 'localhost' || bareHost.endsWith('.localhost') || bareHost.endsWith('.local')) {
    throw new DocumentImportError('URL_BLOCKED', '该地址指向内网/保留网段，已拒绝抓取', 403);
  }
  let addresses: string[];
  try {
    addresses = await (deps.resolve ?? defaultResolve)(bareHost);
  } catch {
    throw new DocumentImportError('FETCH_FAILED', `域名无法解析：${bareHost}`, 502);
  }
  if (addresses.length === 0 || addresses.some((ip) => isBlockedIp(ip))) {
    throw new DocumentImportError('URL_BLOCKED', '该地址指向内网/保留网段，已拒绝抓取', 403);
  }
}

// ---------- 抓取 ----------

/** 手动跟随重定向（每跳重新过 SSRF 校验），返回最终响应与最终 URL */
async function fetchWithGuards(
  startUrl: URL,
  deps: UrlImportDeps
): Promise<{ resp: Response; finalUrl: URL }> {
  const doFetch = deps.fetch ?? fetch;
  let current = startUrl;
  for (let hop = 0; ; hop++) {
    await assertUrlAllowed(current, deps);
    let resp: Response;
    try {
      resp = await doFetch(current.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': 'HalfHalf/0.1 (study material importer)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new DocumentImportError('FETCH_TIMEOUT', '网页响应超时（15s）', 504);
      }
      const message = error instanceof Error ? error.message : '未知错误';
      throw new DocumentImportError('FETCH_FAILED', `抓取失败：${message}`, 502);
    }
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location || hop >= MAX_REDIRECTS) {
        throw new DocumentImportError('FETCH_FAILED', '重定向过多或缺少目标地址', 502);
      }
      current = new URL(location, current);
      continue;
    }
    if (!resp.ok) {
      throw new DocumentImportError('FETCH_FAILED', `网页返回 HTTP ${resp.status}`, 502);
    }
    return { resp, finalUrl: current };
  }
}

/** 读响应体（≤5MB，超限中断），按 content-type/meta 里的 charset 解码 */
async function readHtml(resp: Response): Promise<{ html: string; sizeBytes: number }> {
  const contentType = resp.headers.get('content-type') ?? '';
  if (!/text\/html|application\/xhtml/i.test(contentType)) {
    throw new DocumentImportError(
      'NOT_HTML',
      `这个链接不是网页（${contentType.split(';')[0] || '未知类型'}）。PDF 请下载后用文件导入`,
      415
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = resp.body?.getReader();
  if (!reader) throw new DocumentImportError('FETCH_FAILED', '网页响应为空', 502);
  for (;;) {
    let done: boolean;
    let value: Uint8Array | undefined;
    try {
      ({ done, value } = await reader.read());
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new DocumentImportError('FETCH_TIMEOUT', '网页响应超时（15s）', 504);
      }
      throw error;
    }
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_HTML_BYTES) {
        void reader.cancel();
        throw new DocumentImportError('PAGE_TOO_LARGE', '网页超过 5MB，无法导入', 413);
      }
      chunks.push(value);
    }
  }
  const bytes = Buffer.concat(chunks);
  // charset：header 参数 > 头部 meta 嗅探 > utf-8（GBK 老站在国内仍常见）
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = bytes.subarray(0, 2048).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  let html: string;
  try {
    html = new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    html = new TextDecoder('utf-8').decode(bytes);
  }
  return { html, sizeBytes: total };
}

// ---------- 抽取 ----------

/** 正文抽取：Readability 优先，失败退回"剥掉导航壳后的整个 body" */
export function extractArticle(html: string, url: string): { title: string; contentHtml: string } {
  const { document } = parseHTML(html);
  const pageTitle = document.querySelector('title')?.textContent?.trim() ?? '';
  try {
    // Readability 会改传入的 DOM——失败走 fallback 时必须重新 parse
    const article = new Readability(document as unknown as Document, { charThreshold: 100 }).parse();
    if (article?.content && (article.textContent ?? '').trim().length >= READABILITY_MIN_CHARS) {
      return { title: article.title?.trim() || pageTitle, contentHtml: article.content };
    }
  } catch {
    /* 结构怪异的页面 Readability 可能直接抛——走 fallback */
  }
  const fresh = parseHTML(html).document;
  for (const tag of ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'iframe', 'svg']) {
    for (const el of [...fresh.querySelectorAll(tag)]) el.remove();
  }
  return {
    title: pageTitle || new URL(url).hostname,
    contentHtml: fresh.body?.innerHTML ?? '',
  };
}

// ---------- 主入口 ----------

export async function importUrl(rawUrl: string, deps: UrlImportDeps = {}): Promise<ImportedDocument> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new DocumentImportError('URL_INVALID', '不是合法的网页链接', 400);
  }

  const { resp, finalUrl } = await fetchWithGuards(url, deps);
  const { html, sizeBytes } = await readHtml(resp);
  const { title, contentHtml } = extractArticle(html, finalUrl.toString());

  const imageCount = countMatches(contentHtml, /<img(?:\s|>)/gi);
  const turndown = createTurndown();
  // 网页图片是远程 URL，不进材料（管线只认 data URI；渲染期远程抓取又慢又漏隐私）
  turndown.addRule('dropRemoteImages', { filter: 'img', replacement: () => '' });
  let markdown = normalizeMarkdown(turndown.turndown(contentHtml));
  if (markdown && !/^#\s/.test(markdown) && title) {
    markdown = `# ${title}\n\n${markdown}`;
  }

  const characterCount = countDocumentCharacters(markdown);
  if (!markdown || characterCount < MIN_CONTENT_CHARS) {
    throw new DocumentImportError(
      'EXTRACT_EMPTY',
      '没有从网页里抽到正文。内容可能由脚本动态生成或需要登录——试试直接复制网页文字粘贴',
      422
    );
  }

  return {
    markdown,
    summary: {
      kind: 'url',
      originalName: title || finalUrl.hostname,
      sizeBytes,
      characterCount,
      paragraphCount: countMatches(contentHtml, /<(?:p|li)(?:\s|>)/gi),
      headingCount: countMatches(contentHtml, /<h[1-6](?:\s|>)/gi),
      tableCount: countMatches(contentHtml, /<table(?:\s|>)/gi),
      imageCount,
      sourceUrl: finalUrl.toString(),
      warnings: [
        '网页正文由自动抽取获得，可能混入少量导航/推荐内容，导入后请核对。',
        ...(imageCount > 0 ? [`网页里的 ${imageCount} 张图片未导入（仅保留文本）。`] : []),
        '只导入你自己有权使用的学习材料。',
      ],
    },
  };
}

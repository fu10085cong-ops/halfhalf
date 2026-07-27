/**
 * 检索结果的质量闸：黑名单剔除 → 同源去重 → 域名加权排序。
 *
 * 全是纯函数，黑名单由调用方传入（读文件在 blocklist.ts）——这样单测不碰磁盘。
 *
 * 实测背景（见 spec 第 8 节）：智谱 web_search 对中文学科查询返回的十条里，
 * 常有四条来自同一个问答农场，且索引里没有 .edu.cn / 维基 / 教材源。
 * 所以这里的目标不是「挑出权威源」（库里没有），而是「别让同一个农场占满名额」。
 */
import type { SearchHit } from '../types/index.js';

/**
 * 域名加权。分数只用于排序，不设通过线——实测证明设线会把结果清零。
 * 这张表是排序算法的一部分，不是运维旋钮，所以留在代码里而非配置文件。
 */
const DOMAIN_WEIGHTS: { pattern: RegExp; weight: number; why: string }[] = [
  { pattern: /(^|\.)(edu|ac)\.[a-z]{2}$|(^|\.)edu$/i, weight: 100, why: '教育机构' },
  { pattern: /(^|\.)wikipedia\.org$|(^|\.)wikibooks\.org$/i, weight: 90, why: '维基' },
  { pattern: /(^|\.)zhuanlan\.zhihu\.com$/i, weight: 40, why: '知乎专栏' },
  { pattern: /(^|\.)zhihu\.com$/i, weight: 30, why: '知乎' },
  { pattern: /(^|\.)elecfans\.com$|(^|\.)eefocus\.com$|(^|\.)csdn\.net$/i, weight: 20, why: '专业社区' },
  { pattern: /(^|\.)(blog|cnblogs|jianshu|segmentfault)\./i, weight: 15, why: '技术博客' },
];

export function domainWeight(domain: string): number {
  for (const { pattern, weight } of DOMAIN_WEIGHTS) {
    if (pattern.test(domain)) return weight;
  }
  return 0;
}

/**
 * 后缀匹配：blocklist 里写 `sogou.com` 会挡掉 `wenwen.sogou.com`，
 * 但不会误伤 `notsogou.com`——必须落在点边界上。
 */
export function isBlocked(domain: string, blocklist: string[]): boolean {
  const host = domain.toLowerCase();
  return blocklist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * 只认 http/https。注意 `new URL('javascript:alert(1)')` **不会抛**——它解析成功
 * 但 hostname 为空串，所以必须显式挡协议和空 hostname，不能只靠 try/catch。
 */
export function hostnameOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export interface FilterReport {
  kept: SearchHit[];
  blockedDomains: string[];
  duplicateDomains: string[];
  /** 跨域名的内容重复——内容农场互相转载的典型特征 */
  duplicateContentDomains: string[];
  invalidUrlCount: number;
}

/** 归一化到只剩实义字符，好让转载时的排版差异不影响比对。 */
function normalizeForCompare(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

/**
 * 字符三元组的 Jaccard 相似度。中文没有词边界，按三元组比对比分词稳，
 * 也不需要额外依赖。
 */
export function contentSimilarity(a: string, b: string): number {
  const left = normalizeForCompare(a);
  const right = normalizeForCompare(b);
  if (left.length < 3 || right.length < 3) return left === right ? 1 : 0;

  const shingles = (text: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i + 3 <= text.length; i += 1) out.add(text.slice(i, i + 3));
    return out;
  };

  const setA = shingles(left);
  const setB = shingles(right);
  let intersection = 0;
  for (const gram of setA) if (setB.has(gram)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 超过这个相似度就认定是转载。0.6 是依据实测定的：真实跑出来的
 * tianqi.com 与 yebaike.com 两节内容近乎逐字相同，而正常讲同一知识点的
 * 不同来源（知乎 vs 360问答）相似度明显更低。
 */
const DUPLICATE_CONTENT_THRESHOLD = 0.6;

/**
 * 走完整道质量闸并返回可解释的账目——筛完为 0 时要能告诉用户
 * 「是被拦了」还是「本来就没搜到」，这两种情况的处理完全不同。
 */
export function filterSearchHits(
  hits: SearchHit[],
  blocklist: string[],
  limit: number
): FilterReport {
  const blockedDomains: string[] = [];
  const duplicateDomains: string[] = [];
  let invalidUrlCount = 0;

  const usable: SearchHit[] = [];
  for (const hit of hits) {
    const domain = hit.domain || hostnameOf(hit.url) || '';
    if (!domain) {
      invalidUrlCount += 1;
      continue;
    }
    if (isBlocked(domain, blocklist)) {
      if (!blockedDomains.includes(domain)) blockedDomains.push(domain);
      continue;
    }
    usable.push({ ...hit, domain });
  }

  // 同源去重：同一域名只留权重最高的那条；权重相同则保留搜索引擎给的原始次序
  const bestByDomain = new Map<string, { hit: SearchHit; index: number }>();
  for (const [index, hit] of usable.entries()) {
    const existing = bestByDomain.get(hit.domain);
    if (existing) {
      if (!duplicateDomains.includes(hit.domain)) duplicateDomains.push(hit.domain);
      continue;
    }
    bestByDomain.set(hit.domain, { hit, index });
  }

  const ranked = [...bestByDomain.values()]
    .sort((a, b) => {
      const byWeight = domainWeight(b.hit.domain) - domainWeight(a.hit.domain);
      return byWeight !== 0 ? byWeight : a.index - b.index;
    })
    .map((entry) => entry.hit);

  // 跨域名的内容去重：内容农场把同一篇文章挂在多个域名下，按域名去重挡不住。
  // 排序后再做，保证留下的是权重最高的那个域名。
  const duplicateContentDomains: string[] = [];
  const kept: SearchHit[] = [];
  for (const hit of ranked) {
    if (kept.length >= Math.max(1, limit)) break;
    const twin = kept.find(
      (accepted) => contentSimilarity(accepted.snippet, hit.snippet) >= DUPLICATE_CONTENT_THRESHOLD
    );
    if (twin) {
      if (!duplicateContentDomains.includes(hit.domain)) duplicateContentDomains.push(hit.domain);
      continue;
    }
    kept.push(hit);
  }

  return { kept, blockedDomains, duplicateDomains, duplicateContentDomains, invalidUrlCount };
}

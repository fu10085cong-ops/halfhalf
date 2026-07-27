/**
 * 检索黑名单：运维数据，不进前端。
 *
 * 访问口令是所有用户共享的、不区分身份，把黑名单做成 HTTP 接口等于让任何用户
 * 都能改它；做成文件则天然只有能碰服务器/数据卷的人能改。
 *
 * 增删改查 = 直接编辑 ${HALFHALF_DATA_DIR}/blocklist.txt。比对 mtime 热更，不用重启。
 * 未设 HALFHALF_DATA_DIR 时用内置清单且不落文件（开发环境保持零配置）。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 首次启动播种进文件的种子。之后以文件为唯一事实来源，不再与这里合并。 */
export const DEFAULT_BLOCKLIST = `# HalfHalf 检索黑名单
# 一行一个域名，# 开头为注释。后缀匹配：
#   写 sogou.com 会连 wenwen.sogou.com 一起挡
#   写完整域名则只挡那一个
# 改完即刻生效，不需要重启服务。

# 问答/内容农场
wenwen.sogou.com
zhidao.baidu.com
baijiahao.baidu.com

# 付费墙或登录墙的文库站——抓不到也读不全
max.book118.com
m.renrendoc.com
wk.baidu.com
doc.wendoc.com
`;

/** 把文件内容解析成域名数组。坏行跳过，绝不抛。 */
export function parseBlocklist(text: string): string[] {
  const domains: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // 容忍误粘的完整 URL 和大小写
    const candidate = line.replace(/^https?:\/\//i, '').split('/')[0].trim().toLowerCase();
    if (!candidate || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(candidate)) {
      console.warn(`[halfhalf] blocklist 跳过无法识别的一行: ${raw.slice(0, 80)}`);
      continue;
    }
    domains.push(candidate);
  }
  return [...new Set(domains)];
}

let cachedDomains: string[] | null = null;
let cachedMtimeMs = -1;

function blocklistPath(): string | null {
  const root = process.env.HALFHALF_DATA_DIR?.trim();
  return root ? path.join(path.resolve(root), 'blocklist.txt') : null;
}

/**
 * 取当前生效的黑名单。每次调用比对 mtime，变了才重读——文件只有几百字节，
 * 且检索本身有限流，这点开销可以忽略。
 */
export function loadBlocklist(): string[] {
  const file = blocklistPath();
  if (!file) {
    // 开发环境：内置清单，不落文件
    cachedDomains ??= parseBlocklist(DEFAULT_BLOCKLIST);
    return cachedDomains;
  }

  try {
    const mtimeMs = statSync(file).mtimeMs;
    if (cachedDomains && mtimeMs === cachedMtimeMs) return cachedDomains;
    cachedDomains = parseBlocklist(readFileSync(file, 'utf8'));
    cachedMtimeMs = mtimeMs;
    return cachedDomains;
  } catch {
    // 文件不存在 → 播种默认清单；播种失败也不能让检索挂掉
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, DEFAULT_BLOCKLIST, { encoding: 'utf8', flag: 'wx' });
      console.log(`[halfhalf] 已在 ${file} 播种默认检索黑名单`);
      cachedMtimeMs = statSync(file).mtimeMs;
    } catch {
      cachedMtimeMs = -1;
    }
    cachedDomains = parseBlocklist(DEFAULT_BLOCKLIST);
    return cachedDomains;
  }
}

/** 测试用：清掉进程内缓存，让下一次 loadBlocklist 重新读盘。 */
export function resetBlocklistCache(): void {
  cachedDomains = null;
  cachedMtimeMs = -1;
}

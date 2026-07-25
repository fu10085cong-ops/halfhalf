/**
 * 共享 Chromium 实例：进程内只冷启动一次，所有测量/渲染复用，每次调用开独立 page。
 *
 * 为什么需要：layout 引擎的字号二分搜索每轮都要"测量所有块 + 渲染"，之前每次
 * measureBlocks/renderLayoutPdf 都 launch 一个新浏览器（数百 ms 冷启动 × 每轮 2 次 ×
 * 6~8 轮），冷启动占了搜索耗时的大头。page 之间天然隔离，共享 browser 没有串扰。
 *
 * 注意：浏览器子进程会拖住 Node 进程不退出——脚本/服务收尾时必须调 closeSharedBrowser()。
 *
 * 并发控制：同时打开的 page 数上限 HALFHALF_MAX_PAGES（默认 3），超出的请求排队（FIFO）。
 * 多人同时点"生成"时不再无限开 page 互踩内存——单个请求内部是串行用页的，
 * 上限约等于"同时服务几个排版请求"。
 */
import { chromium, type Browser, type Page } from 'playwright';

let browserPromise: Promise<Browser> | null = null;

/**
 * 容器/受限环境下的 Chromium 启动参数：
 * - --disable-dev-shm-usage：Docker 默认 /dev/shm 仅 64MB，Chromium 会因共享内存不足崩溃，
 *   改用 /tmp 兜底。始终开，安全。
 * - --disable-gpu：无头服务器无 GPU，省一点资源。始终开，安全。
 * - --no-sandbox：以 root 跑容器时沙箱失效、无法启动，需 env 显式放开
 *   （HALFHALF_CHROMIUM_NO_SANDBOX=1）。只渲染用户自己的内容，单用户场景可接受。
 */
function chromiumLaunchArgs(): string[] {
  const args = ['--disable-dev-shm-usage', '--disable-gpu'];
  if (process.env.HALFHALF_CHROMIUM_NO_SANDBOX === '1') args.push('--no-sandbox');
  return args;
}

function getSharedBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const p = chromium.launch({ headless: true, args: chromiumLaunchArgs() }).then(
      (browser) => {
        // 浏览器意外死亡（崩溃/被系统回收/子进程被杀）时清掉缓存并复位并发名额，
        // 下一次调用自动重新拉起——否则连接池攥着死浏览器，之后所有请求
        // 都报 "browser has been closed"，只能重启后端才能恢复（真实事故，2026-07-23）
        browser.on('disconnected', () => {
          if (browserPromise === p) {
            browserPromise = null;
            resetSlots();
          }
        });
        return browser;
      },
      (err) => {
        // 启动失败也不能把 rejected promise 缓存住，否则一次失败永久失败
        if (browserPromise === p) browserPromise = null;
        throw err;
      }
    );
    browserPromise = p;
  }
  return browserPromise;
}

const MAX_PAGES = Math.max(1, Number(process.env.HALFHALF_MAX_PAGES) || 3);
let activePages = 0;
const waiters: (() => void)[] = [];

function acquireSlot(): Promise<void> {
  if (activePages < MAX_PAGES) {
    activePages++;
    return Promise.resolve();
  }
  // 名额直接移交给队首（activePages 不减不增），保证 FIFO 且无饥饿
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next();
  // 下限钳到 0：浏览器死亡复位后，死 page 迟到的 close 事件不能把名额减成负数
  else activePages = Math.max(0, activePages - 1);
}

/**
 * 浏览器死亡后的名额复位：死浏览器的 page 未必都来得及触发 close 事件释放名额，
 * 不复位的话名额会永久泄漏、排队者饿死。清零后按上限重新放行排队中的请求
 * （它们拿到名额后会经 getSharedBrowser 触发浏览器重启）。
 */
function resetSlots(): void {
  activePages = 0;
  while (waiters.length > 0 && activePages < MAX_PAGES) {
    activePages++;
    waiters.shift()!();
  }
}

/** 在共享浏览器上开一个新 page 执行 fn，结束后关 page（浏览器保持温热） */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await openPage();
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

/**
 * 在共享浏览器上开一个由调用方管理生命周期的 page——用于跨多次调用复用同一页面的
 * 长会话场景（如二分搜索的渲染上下文）。调用方用完必须自行 page.close()——
 * 并发名额挂在 page 的 close 事件上释放，不 close 就一直占着一个名额。
 */
export async function openPage(): Promise<Page> {
  await acquireSlot();
  try {
    const browser = await getSharedBrowser();
    const page = await browser.newPage();
    page.once('close', releaseSlot);
    return page;
  } catch (err) {
    releaseSlot();
    throw err;
  }
}

/** 关闭共享浏览器。脚本收尾/服务下线时调用，否则子进程会拖住 Node 不退出 */
export async function closeSharedBrowser(): Promise<void> {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  await (await pending).close();
}

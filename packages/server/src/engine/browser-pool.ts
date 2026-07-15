/**
 * 共享 Chromium 实例：进程内只冷启动一次，所有测量/渲染复用，每次调用开独立 page。
 *
 * 为什么需要：layout 引擎的字号二分搜索每轮都要"测量所有块 + 渲染"，之前每次
 * measureBlocks/renderLayoutPdf 都 launch 一个新浏览器（数百 ms 冷启动 × 每轮 2 次 ×
 * 6~8 轮），冷启动占了搜索耗时的大头。page 之间天然隔离，共享 browser 没有串扰。
 *
 * 注意：浏览器子进程会拖住 Node 进程不退出——脚本/服务收尾时必须调 closeSharedBrowser()。
 * 并发控制（多人共用时限制同时打开的 page 数）留给 /api/layout/* 接口化时做。
 */
import { chromium, type Browser, type Page } from 'playwright';

let browserPromise: Promise<Browser> | null = null;

function getSharedBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

/** 在共享浏览器上开一个新 page 执行 fn，结束后关 page（浏览器保持温热） */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

/** 关闭共享浏览器。脚本收尾/服务下线时调用，否则子进程会拖住 Node 不退出 */
export async function closeSharedBrowser(): Promise<void> {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  await (await pending).close();
}

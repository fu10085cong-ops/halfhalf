/**
 * URL 网页抓取的行为锁：
 * - SSRF 闸：私网/环回/链路本地/CGNAT/组播 IPv4+IPv6 全拒；DNS 解析出私网也拒；重定向逐跳复查
 * - 抽取：Readability 正文成 Markdown、标题成 H1、表格转 GFM、图片剥除
 * - 限制：非 HTML 415、抽不到正文 422
 * 全部通过 deps 注入（fetch/resolve），不出网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, extractArticle, importUrl } from '../../src/engine/url-import.js';
import { DocumentImportError } from '../../src/engine/document-import.js';

// ---------- SSRF ----------

test('私网/保留地址全部拒绝', () => {
  const blocked = [
    '127.0.0.1', '10.0.0.8', '172.16.5.4', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12::34', 'fe80::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1',
  ];
  for (const ip of blocked) assert.ok(isBlockedIp(ip), `${ip} 应被拒`);
});

test('公网地址放行', () => {
  const allowed = ['8.8.8.8', '1.2.3.4', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'];
  for (const ip of allowed) assert.ok(!isBlockedIp(ip), `${ip} 应放行`);
});

const PAGE = `<!doctype html><html><head><title>操作系统笔记</title></head><body>
<nav>首页 · 分类 · 关于</nav>
<article>
  <h1>进程调度</h1>
  <p>${'先来先服务（FCFS）按到达顺序执行，平均等待时间对短作业不友好。'.repeat(4)}</p>
  <p>${'时间片轮转（RR）给每个进程固定时间片，响应性好，上下文切换开销随时间片减小而增大。'.repeat(4)}</p>
  <table><tr><th>算法</th><th>特点</th></tr><tr><td>FCFS</td><td>简单</td></tr></table>
  <img src="https://example.com/a.png" alt="示意图">
</article>
<footer>版权所有</footer></body></html>`;

function fakeFetch(body: string, init?: { status?: number; contentType?: string; location?: string }) {
  return async (): Promise<Response> =>
    new Response(init?.status && init.status >= 300 && init.status < 400 ? null : body, {
      status: init?.status ?? 200,
      headers: {
        'content-type': init?.contentType ?? 'text/html; charset=utf-8',
        ...(init?.location ? { location: init.location } : {}),
      },
    });
}

const publicResolve = async () => ['93.184.216.34'];

test('DNS 解析到私网的域名被拒（403 URL_BLOCKED）', async () => {
  await assert.rejects(
    () => importUrl('https://evil.example.com/x', { fetch: fakeFetch(PAGE), resolve: async () => ['192.168.0.10'] }),
    (e: unknown) => e instanceof DocumentImportError && e.code === 'URL_BLOCKED' && e.status === 403
  );
});

test('IP 字面量直接拒;localhost 域名拒;file 协议拒', async () => {
  for (const url of ['http://169.254.169.254/latest/meta-data', 'http://localhost:3000/api', 'http://[::1]/']) {
    await assert.rejects(
      () => importUrl(url, { fetch: fakeFetch(PAGE) }),
      (e: unknown) => e instanceof DocumentImportError && e.code === 'URL_BLOCKED',
      url
    );
  }
  await assert.rejects(
    () => importUrl('file:///etc/passwd', { fetch: fakeFetch(PAGE) }),
    (e: unknown) => e instanceof DocumentImportError && e.code === 'URL_INVALID'
  );
});

test('重定向到私网地址被拦（逐跳复查）', async () => {
  let call = 0;
  const hopFetch = async (): Promise<Response> => {
    call++;
    if (call === 1) {
      return new Response(null, { status: 302, headers: { location: 'http://192.168.0.5/steal' } });
    }
    throw new Error('不应该发出第二跳请求');
  };
  await assert.rejects(
    () => importUrl('https://ok.example.com/', { fetch: hopFetch, resolve: publicResolve }),
    (e: unknown) => e instanceof DocumentImportError && e.code === 'URL_BLOCKED'
  );
});

// ---------- 抽取与限制 ----------

test('正常页面：正文成 Markdown,标题成 H1,表格转 GFM,图片剥除', async () => {
  const result = await importUrl('https://ok.example.com/notes', {
    fetch: fakeFetch(PAGE),
    resolve: publicResolve,
  });
  assert.equal(result.summary.kind, 'url');
  assert.ok(result.markdown.startsWith('# '), '应以 H1 开头');
  assert.ok(result.markdown.includes('先来先服务'), '正文应保留');
  assert.ok(result.markdown.includes('| 算法 |'), '表格应转 GFM');
  assert.ok(!result.markdown.includes('!['), '图片应剥除');
  assert.ok(!result.markdown.includes('版权所有'), '页脚不应混入');
  assert.equal(result.summary.imageCount, 1);
  assert.ok(result.summary.sourceUrl?.startsWith('https://ok.example.com'));
  assert.ok(result.summary.warnings.some((w) => w.includes('图片未导入')));
});

test('非 HTML 内容 415 NOT_HTML', async () => {
  await assert.rejects(
    () =>
      importUrl('https://ok.example.com/file.pdf', {
        fetch: fakeFetch('%PDF-1.4', { contentType: 'application/pdf' }),
        resolve: publicResolve,
      }),
    (e: unknown) => e instanceof DocumentImportError && e.code === 'NOT_HTML' && e.status === 415
  );
});

test('抽不到正文 422 EXTRACT_EMPTY（动态渲染页的典型表现）', async () => {
  const empty = '<!doctype html><html><head><title>SPA</title></head><body><div id="app"></div></body></html>';
  await assert.rejects(
    () => importUrl('https://ok.example.com/spa', { fetch: fakeFetch(empty), resolve: publicResolve }),
    (e: unknown) => e instanceof DocumentImportError && e.code === 'EXTRACT_EMPTY' && e.status === 422
  );
});

test('extractArticle：Readability 失败时退回剥壳 body,导航被剥掉', () => {
  const plain = `<html><head><title>短页</title></head><body>
    <nav>导航不该出现</nav><script>var x=1;</script>
    <p>只有一小段正文,Readability 阈值不够会走 fallback。</p></body></html>`;
  const { title, contentHtml } = extractArticle(plain, 'https://x.example.com/');
  assert.equal(title, '短页');
  assert.ok(contentHtml.includes('只有一小段正文'));
  assert.ok(!contentHtml.includes('导航不该出现'));
  assert.ok(!contentHtml.includes('var x=1'));
});

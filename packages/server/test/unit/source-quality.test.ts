import assert from 'node:assert/strict';
import test from 'node:test';
import {
  domainWeight,
  filterSearchHits,
  hostnameOf,
  isBlocked,
} from '../../src/engine/source-quality.js';
import { parseBlocklist, DEFAULT_BLOCKLIST } from '../../src/engine/blocklist.js';
import type { SearchHit } from '../../src/types/index.js';

function hit(url: string, title = 't', snippet = 's'): SearchHit {
  return { title, snippet, url, domain: new URL(url).hostname };
}

test('黑名单后缀匹配落在点边界上，不误伤相似域名', () => {
  const list = ['sogou.com'];
  assert.equal(isBlocked('sogou.com', list), true, '域名本身');
  assert.equal(isBlocked('wenwen.sogou.com', list), true, '子域');
  assert.equal(isBlocked('notsogou.com', list), false, '仅后缀相同不算——这是最容易写错的一处');
  assert.equal(isBlocked('sogou.com.evil.cn', list), false, '前缀相同也不算');
});

test('域名加权：教育机构与维基排在内容站之前', () => {
  assert.ok(domainWeight('phys.tsinghua.edu.cn') > domainWeight('zhuanlan.zhihu.com'));
  assert.ok(domainWeight('zh.wikipedia.org') > domainWeight('blog.csdn.net'));
  assert.ok(domainWeight('zhuanlan.zhihu.com') > domainWeight('www.aitaocui.cn'));
  assert.equal(domainWeight('www.aitaocui.cn'), 0, '不认识的域名权重为 0，但不被拒绝');
});

test('同源去重：实测中一个问答农场占了十条里的四条', () => {
  const hits = [
    hit('https://wenwen.sogou.com/a'),
    hit('https://wenwen.sogou.com/b'),
    hit('https://wenwen.sogou.com/c'),
    hit('https://wenwen.sogou.com/d'),
    hit('https://m.elecfans.com/x'),
    hit('https://k.sina.cn/y'),
  ];
  const report = filterSearchHits(hits, [], 4);

  const domains = report.kept.map((k) => k.domain);
  assert.equal(new Set(domains).size, domains.length, '同一域名不得出现两次');
  assert.deepEqual(report.duplicateDomains, ['wenwen.sogou.com']);
  assert.equal(report.kept.length, 3, '去重后只剩三个不同的源');
});

test('黑名单命中会记账，好让筛完为 0 时能告诉用户是被拦了', () => {
  const hits = [hit('https://baijiahao.baidu.com/a'), hit('https://zhuanlan.zhihu.com/p/1')];
  const report = filterSearchHits(hits, parseBlocklist(DEFAULT_BLOCKLIST), 4);

  assert.deepEqual(report.blockedDomains, ['baijiahao.baidu.com']);
  assert.equal(report.kept.length, 1);
  assert.equal(report.kept[0].domain, 'zhuanlan.zhihu.com');
});

test('加权决定排序，权重相同时保留搜索引擎给的原始次序', () => {
  const hits = [
    hit('https://www.aitaocui.cn/a'),
    hit('https://ispacesoft.com/b'),
    hit('https://phys.example.edu.cn/c'),
    hit('https://zhuanlan.zhihu.com/p/1'),
  ];
  const report = filterSearchHits(hits, [], 4);

  assert.deepEqual(
    report.kept.map((k) => k.domain),
    ['phys.example.edu.cn', 'zhuanlan.zhihu.com', 'www.aitaocui.cn', 'ispacesoft.com']
  );
});

test('坏 URL 被记数而不是让整批崩掉', () => {
  const hits: SearchHit[] = [
    { title: 't', snippet: 's', url: 'not a url', domain: '' },
    hit('https://zhuanlan.zhihu.com/p/1'),
  ];
  const report = filterSearchHits(hits, [], 4);

  assert.equal(report.invalidUrlCount, 1);
  assert.equal(report.kept.length, 1);
});

test('limit 生效且至少保留一条', () => {
  const hits = [
    hit('https://a.com/1'),
    hit('https://b.com/2'),
    hit('https://c.com/3'),
  ];
  assert.equal(filterSearchHits(hits, [], 2).kept.length, 2);
  assert.equal(filterSearchHits(hits, [], 0).kept.length, 1, 'limit 0 被钳到 1');
});

test('hostnameOf 对坏输入返回 null 而不是抛', () => {
  assert.equal(hostnameOf('https://example.com/x'), 'example.com');
  assert.equal(hostnameOf('javascript:alert(1)'), null, 'new URL 对它不抛，hostname 是空串');
  assert.equal(hostnameOf('data:text/html,<h1>x'), null);
  assert.equal(hostnameOf('file:///etc/passwd'), null);
  assert.equal(hostnameOf(''), null);
});

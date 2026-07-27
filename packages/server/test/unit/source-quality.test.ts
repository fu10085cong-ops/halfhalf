import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contentSimilarity,
  domainWeight,
  filterSearchHits,
  hostnameOf,
  isBlocked,
} from '../../src/engine/source-quality.js';
import { parseBlocklist, DEFAULT_BLOCKLIST } from '../../src/engine/blocklist.js';
import type { SearchHit } from '../../src/types/index.js';

/**
 * 默认正文必须**真正互不相同**——只改一两个字符不行，三元组相似度照样超阈值
 * 会被内容去重折叠，那是另一条规则的地盘。这里按序取一组语义无关的句子。
 */
const DISTINCT_SNIPPETS = [
  '春江潮水连海平，海上明月共潮生。',
  '锄禾日当午，汗滴禾下土。',
  '故人西辞黄鹤楼，烟花三月下扬州。',
  '床前明月光，疑是地上霜。',
  '两个黄鹂鸣翠柳，一行白鹭上青天。',
  '会当凌绝顶，一览众山小。',
];
let snippetCursor = 0;

function hit(url: string, title = 't', snippet?: string): SearchHit {
  const domain = new URL(url).hostname;
  const chosen = snippet ?? DISTINCT_SNIPPETS[snippetCursor++ % DISTINCT_SNIPPETS.length];
  return { title, snippet: chosen, url, domain };
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

test('跨域名内容去重：内容农场把同一篇文章挂在不同域名下', () => {
  // 取自真实 bench 输出：tianqi.com 与 yebaike.com 两节内容近乎逐字相同
  const farmText =
    '适用于内部为线性含源电路。只对外电路等效，对内电路不等效。可用于复杂电路分析，直至成为简单电路。适用于线性的有源二端网络。';
  const hits: SearchHit[] = [
    { title: 'a', snippet: farmText, url: 'https://www.tianqi.com/x', domain: 'www.tianqi.com' },
    { title: 'b', snippet: farmText + '可与诺顿定理结合使用。', url: 'https://www.yebaike.com/y', domain: 'www.yebaike.com' },
    {
      title: 'c',
      snippet: '线性电阻单口网络可等效为电压源和电阻串联。电压源电压等于负载开路时的电压uoc。',
      url: 'https://zhuanlan.zhihu.com/p/1',
      domain: 'zhuanlan.zhihu.com',
    },
  ];
  const report = filterSearchHits(hits, [], 4);

  assert.equal(report.kept.length, 2, '两个转载源只留一个');
  assert.equal(report.duplicateContentDomains.length, 1);
  assert.ok(
    report.kept.some((k) => k.domain === 'zhuanlan.zhihu.com'),
    '讲同一知识点但写法不同的来源必须保留'
  );
});

test('内容相似度：转载判高、不同写法判低', () => {
  const a = '戴维南定理适用于线性的有源二端网络，只对外电路等效。';
  assert.equal(contentSimilarity(a, a), 1, '完全相同');
  assert.ok(contentSimilarity(a, a + '另外还可与诺顿定理结合。') > 0.6, '加了尾巴仍算转载');
  assert.ok(
    contentSimilarity(a, '把复杂电路化简成一个电压源串联一个电阻，这就是等效的思路。') < 0.6,
    '讲同一件事但表述不同，不该被当成转载'
  );
  assert.equal(contentSimilarity('', ''), 1);
  assert.equal(contentSimilarity('ab', 'xy'), 0, '过短的输入不崩');
});

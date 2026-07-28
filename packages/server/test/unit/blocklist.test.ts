import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_BLOCKLIST,
  loadBlocklist,
  parseBlocklist,
  resetBlocklistCache,
} from '../../src/engine/blocklist.js';

function withDataDir(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(path.join(tmpdir(), 'halfhalf-blocklist-'));
  const previous = process.env.HALFHALF_DATA_DIR;
  process.env.HALFHALF_DATA_DIR = root;
  resetBlocklistCache();
  t.after(() => {
    if (previous === undefined) delete process.env.HALFHALF_DATA_DIR;
    else process.env.HALFHALF_DATA_DIR = previous;
    resetBlocklistCache();
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('解析：注释、空行、前后空格、大小写都能正确处理', () => {
  const parsed = parseBlocklist(`
# 这是注释
  wenwen.sogou.com

BaiJiaHao.Baidu.Com
   # 缩进的注释
`);
  assert.deepEqual(parsed, ['wenwen.sogou.com', 'baijiahao.baidu.com']);
});

test('解析：误粘完整 URL 会被还原成域名', () => {
  assert.deepEqual(parseBlocklist('https://wenwen.sogou.com/question/123'), ['wenwen.sogou.com']);
});

test('解析：坏行被跳过，其余照常生效，不抛异常', () => {
  const parsed = parseBlocklist('好域名.com\n这不是域名\n\nzhidao.baidu.com\n!!!');
  assert.deepEqual(parsed, ['zhidao.baidu.com'], '中文域名与乱码都被跳过');
});

test('解析：重复行只留一份', () => {
  assert.deepEqual(parseBlocklist('a.com\na.com\nA.COM'), ['a.com']);
});

test('未设 HALFHALF_DATA_DIR 时用内置清单且不落文件（开发环境零配置）', (t) => {
  const previous = process.env.HALFHALF_DATA_DIR;
  delete process.env.HALFHALF_DATA_DIR;
  resetBlocklistCache();
  t.after(() => {
    if (previous !== undefined) process.env.HALFHALF_DATA_DIR = previous;
    resetBlocklistCache();
  });

  const domains = loadBlocklist();
  assert.ok(domains.includes('wenwen.sogou.com'));
  assert.deepEqual(domains, parseBlocklist(DEFAULT_BLOCKLIST));
});

test('文件不存在时播种默认清单并生效', (t) => {
  const root = withDataDir(t);
  const domains = loadBlocklist();

  const seeded = readFileSync(path.join(root, 'blocklist.txt'), 'utf8');
  assert.ok(seeded.includes('wenwen.sogou.com'), '默认清单已写进文件');
  assert.ok(seeded.includes('#'), '注释一并写入，便于运维照着改');
  assert.ok(domains.includes('baijiahao.baidu.com'));
});

test('改文件后下次调用即生效，不需要重启（mtime 热更）', (t) => {
  const root = withDataDir(t);
  const file = path.join(root, 'blocklist.txt');

  assert.ok(loadBlocklist().includes('wenwen.sogou.com'));

  writeFileSync(file, 'only-this-one.com\n', 'utf8');
  // 同秒内写入可能撞上相同 mtime，显式往前拨以模拟真实的「过一会儿改了文件」
  const future = new Date(Date.now() + 2000);
  utimesSync(file, future, future);

  const after = loadBlocklist();
  assert.deepEqual(after, ['only-this-one.com'], '以文件为唯一事实来源');
  assert.equal(after.includes('wenwen.sogou.com'), false, '删掉的默认项不得借合并复活');
});

test('文件内容没变时不重复读盘（缓存生效）', (t) => {
  const root = withDataDir(t);
  const first = loadBlocklist();
  const second = loadBlocklist();
  assert.equal(first, second, '同一个数组引用 = 命中缓存');
});

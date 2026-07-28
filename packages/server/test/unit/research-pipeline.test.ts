import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assembleResearchMarkdown,
  buildSummaryPrompt,
  ResearchError,
  runResearch,
} from '../../src/engine/research-pipeline.js';
import { mapZhipuResults, SearchError } from '../../src/engine/search-provider.js';
import type { ImportedDocument, SearchHit } from '../../src/types/index.js';
import type { SearchProvider } from '../../src/engine/search-provider.js';

function hit(url: string, snippet = '一段解释', title = '标题'): SearchHit {
  return { title, snippet, url, domain: new URL(url).hostname };
}

function stubProvider(hits: SearchHit[] | (() => never)): SearchProvider {
  return {
    id: 'stub',
    async search() {
      if (typeof hits === 'function') hits();
      return hits as SearchHit[];
    },
  };
}

/** 记录模型有没有被调用——防静默退化那条回归锁靠它 */
function stubProviderConfig() {
  return { endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'x' };
}

test('映射：没有 link 的结果被丢弃（溯源是硬要求）', () => {
  const mapped = mapZhipuResults({
    search_result: [
      { title: 'a', content: '正文', link: 'https://good.com/1' },
      { title: 'b', content: '正文' },
      { title: 'c', content: '正文', link: 'not-a-url' },
      { title: 'd', content: '', link: 'https://empty.com/1' },
    ],
  });
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].domain, 'good.com');
});

test('映射：响应形状不对时返回空数组而不是抛', () => {
  assert.deepEqual(mapZhipuResults({}), []);
  assert.deepEqual(mapZhipuResults(null), []);
  assert.deepEqual(mapZhipuResults({ search_result: 'nope' }), []);
});

test('提示词把「不要补充片段之外的知识」写死，并逐源分块', () => {
  const prompt = buildSummaryPrompt('高斯定律', [
    hit('https://a.com/1', '片段一'),
    hit('https://b.com/2', '片段二'),
  ]);
  assert.match(prompt, /不要补充片段之外的任何知识/);
  assert.match(prompt, /【来源 1】a\.com/);
  assert.match(prompt, /【来源 2】b\.com/);
  assert.match(prompt, /截断处不要脑补续写/);
});

test('组装：正文不印 URL 清单——小抄版面寸土寸金，考场也点不开链接', () => {
  const md = assembleResearchMarkdown('高斯定律', '### 来自 a.com\n- 要点', [
    hit('https://a.com/1'),
    hit('https://b.com/2'),
  ]);
  assert.match(md, /非教材口径/, '安全提示必须留着');
  assert.match(md, /### 来自 a\.com/, '分节标题里的域名归属仍在');
  assert.equal(md.includes('https://a.com/1'), false, 'URL 不进正文');
  assert.equal(md.includes('### 来源'), false, '来源清单块不进正文');
});

test('溯源不丢：完整来源仍在 summary.sources 里，供界面展示回查', async () => {
  const doc = await runResearch(
    '高斯定律',
    {
      id: 'stub',
      async search() {
        return [hit('https://zhuanlan.zhihu.com/p/1', '片段一')];
      },
    },
    {
      provider: stubProviderConfig(),
      // 直接短路总结环节：这条用例只关心来源有没有被保留下来
    }
  ).catch((e) => e);
  // 没有真实模型可用时会抛 RESEARCH_SUMMARY_FAILED，错误里同样带着来源
  if (doc instanceof ResearchError) {
    assert.equal(doc.code, 'RESEARCH_SUMMARY_FAILED');
    assert.deepEqual(
      (doc.details?.sources as { domain: string }[]).map((s) => s.domain),
      ['zhuanlan.zhihu.com']
    );
    return;
  }
  const produced = doc as ImportedDocument;
  assert.deepEqual(
    produced.summary.sources?.map((source) => source.domain),
    ['zhuanlan.zhihu.com']
  );
});

test('回归锁：搜索返回 0 条时报错，且绝不调用总结模型', async () => {
  let summarizerCalled = false;
  const previous = process.env.HALFHALF_AI_ENDPOINT;
  process.env.HALFHALF_AI_ENDPOINT = 'https://open.bigmodel.cn/x';
  try {
    await assert.rejects(
      () =>
        runResearch('查不到的词', stubProvider([]), {
          provider: new Proxy(stubProviderConfig(), {
            get(target, key) {
              summarizerCalled = true;
              return Reflect.get(target, key);
            },
          }),
        }),
      (error: unknown) =>
        error instanceof ResearchError && error.code === 'RESEARCH_NO_RESULTS'
    );
    assert.equal(summarizerCalled, false, '没搜到就必须报错，不能退化成让模型凭记忆编');
  } finally {
    if (previous === undefined) delete process.env.HALFHALF_AI_ENDPOINT;
    else process.env.HALFHALF_AI_ENDPOINT = previous;
  }
});

test('全部被质量闸挡下时，错误里要带上被挡的域名——区别于「没搜到」', async () => {
  await assert.rejects(
    () =>
      runResearch('电路', stubProvider([hit('https://wenwen.sogou.com/q/1')]), {
        provider: stubProviderConfig(),
      }),
    (error: unknown) => {
      assert.ok(error instanceof ResearchError);
      assert.equal(error.code, 'RESEARCH_ALL_FILTERED');
      assert.deepEqual(error.details?.blockedDomains, ['wenwen.sogou.com']);
      return true;
    }
  );
});

test('空查询词直接拒绝', async () => {
  await assert.rejects(
    () => runResearch('   ', stubProvider([hit('https://a.com/1')])),
    (error: unknown) => error instanceof ResearchError && error.code === 'RESEARCH_EMPTY_QUERY'
  );
});

test('搜索源报错时映射成 ResearchError 并保留状态码', async () => {
  await assert.rejects(
    () =>
      runResearch(
        '电路',
        stubProvider(() => {
          throw new SearchError('SEARCH_REJECTED', '鉴权失败', 501);
        })
      ),
    (error: unknown) => {
      assert.ok(error instanceof ResearchError);
      assert.equal(error.code, 'SEARCH_REJECTED');
      assert.equal(error.status, 501, '配置问题不该被当成「搜不到」');
      return true;
    }
  );
});

test('取消：signal 已中断时立刻抛 AbortError，不发起搜索', async () => {
  const controller = new AbortController();
  controller.abort();
  let searched = false;
  const provider: SearchProvider = {
    id: 'stub',
    async search() {
      searched = true;
      return [hit('https://a.com/1')];
    },
  };
  await assert.rejects(
    () => runResearch('电路', provider, { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  );
  assert.equal(searched, false);
});

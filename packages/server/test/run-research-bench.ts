/**
 * 联网补洞的真实基准。不进 CI（要 key、结果不稳定），供人工判断质量。
 *
 *   HALFHALF_SEARCH_KEY=... HALFHALF_AI_* =... pnpm bench:research -- "戴维南定理 适用条件"
 *
 * 输出各阶段耗时、通过质量闸的域名、以及最终分节文档，好让人一眼看出
 * 「搜出来的东西到底好不好」——这是单测覆盖不到的那部分。
 */
import { performance } from 'node:perf_hooks';
import { loadBlocklist } from '../src/engine/blocklist.js';
import { runResearch, ResearchError } from '../src/engine/research-pipeline.js';
import { createSearchProvider } from '../src/engine/search-provider.js';
import { filterSearchHits } from '../src/engine/source-quality.js';

const query = process.argv.slice(2).find((a) => a !== '--') || process.env.HALFHALF_RESEARCH_QUERY;
if (!query) {
  console.error('用法: pnpm bench:research -- "<检索关键词>"');
  process.exit(2);
}

const provider = createSearchProvider();
if (!provider) {
  console.error('未设 HALFHALF_SEARCH_KEY —— 无法检索。');
  process.exit(2);
}

console.log(`查询词：${query}\n`);

// 先单独跑一次搜索，把质量闸的账目摊开给人看
const searchStart = performance.now();
const hits = await provider.search(query);
const searchMs = Math.round(performance.now() - searchStart);
console.log(`[搜索] ${searchMs}ms，返回 ${hits.length} 条`);
for (const h of hits) console.log(`   ${h.domain.padEnd(28)} ${h.snippet.length} 字  ${h.title.slice(0, 34)}`);

const report = filterSearchHits(hits, loadBlocklist(), 4);
console.log(`\n[质量闸] 采纳 ${report.kept.length} 条`);
console.log(`   被黑名单挡下: ${report.blockedDomains.join(', ') || '（无）'}`);
console.log(`   同源去重折叠: ${report.duplicateDomains.join(', ') || '（无）'}`);
console.log(`   坏 URL: ${report.invalidUrlCount}`);
console.log(`   采纳的域名: ${report.kept.map((k) => k.domain).join(', ')}`);

// 再跑完整链路（会重新搜一次，多花一次调用，换取和线上完全一致的路径）
const fullStart = performance.now();
try {
  const doc = await runResearch(query, provider, {
    onProgress: (p) => console.log(`   [${p.progress}%] ${p.message}`),
  });
  const fullMs = Math.round(performance.now() - fullStart);
  console.log(`\n[完整链路] ${fullMs}ms\n`);
  console.log('='.repeat(70));
  console.log(doc.markdown);
  console.log('='.repeat(70));
  console.log(`\n来源 ${doc.summary.sources?.length ?? 0} 个，正文 ${doc.summary.characterCount} 字`);
  for (const w of doc.summary.warnings) console.log(`  ⚠ ${w}`);
} catch (error) {
  if (error instanceof ResearchError) {
    console.error(`\n❌ ${error.code}: ${error.message}`);
    if (error.details) console.error('   details:', JSON.stringify(error.details));
    process.exit(1);
  }
  throw error;
}

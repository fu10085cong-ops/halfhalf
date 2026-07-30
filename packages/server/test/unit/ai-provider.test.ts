/**
 * AI 服务商层的契约锁：
 * - 下拉预设（PROVIDER_PRESETS）与 BYOK 白名单同源——预设端点必须全部过 validateEndpoint，
 *   否则用户从下拉选了服务商却被 400 拒掉（前端硬编码漂移的判例式防线）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_PRESETS,
  describeNetworkError,
  validateEndpoint,
} from '../../src/engine/ai-provider.js';

test('每个服务商预设的 endpoint 都通过白名单校验', () => {
  for (const preset of PROVIDER_PRESETS) {
    const check = validateEndpoint(preset.endpoint);
    assert.equal(check.error, undefined, `${preset.id}: ${check.error}`);
    assert.ok(check.url, `${preset.id} 应解析出 URL`);
  }
});

test('预设 id 唯一且关键字段非空', () => {
  const ids = new Set<string>();
  for (const preset of PROVIDER_PRESETS) {
    assert.ok(!ids.has(preset.id), `id 重复: ${preset.id}`);
    ids.add(preset.id);
    assert.ok(preset.name.trim());
    assert.ok(preset.defaultModel.trim());
    assert.ok(preset.keyUrl.startsWith('https://'));
  }
});

/**
 * 出网失败的可诊断性（2026-07-30 判例）：Node 的 fetch 出网失败时 message 恒为
 * "fetch failed"，真因埋在 cause.code 里。老代码裸抛，用户界面上只剩
 * 「结构化失败: fetch failed」——零信息量，DNS 挂了还是证书不过都分不出，
 * 服务端又没有日志，只能靠加信息才定位。这几条锁住"真因必须出现在文案里"。
 */
const fetchFailed = (cause: unknown) => Object.assign(new Error('fetch failed'), { cause });

test('fetch failed 必须拆出 errno 与人话解释', () => {
  const out = describeNetworkError(fetchFailed({ code: 'ENOTFOUND', message: 'getaddrinfo' }));
  assert.match(out.message, /连不上 AI 服务商/);
  assert.match(out.message, /DNS/, '要给出「该查什么」');
  assert.match(out.message, /ENOTFOUND/, 'errno 必须带上，供搜索');
  assert.doesNotMatch(out.message, /fetch failed/, '不许把无信息量的原文再抛给用户');
});

test('不认识的 errno 也要带上 code 和上游描述，不许退回 fetch failed', () => {
  const out = describeNetworkError(fetchFailed({ code: 'EWEIRD', message: 'something odd' }));
  assert.match(out.message, /EWEIRD/);
  assert.match(out.message, /something odd/);
});

test('没有 cause 时不崩，仍给出可辨识文案', () => {
  assert.match(describeNetworkError(new Error('fetch failed')).message, /连不上 AI 服务商/);
});

test('非 fetch failed 的错误原样透传——不许被这层改写', () => {
  const upstream = new Error('上游返回 401: no auth');
  assert.equal(describeNetworkError(upstream), upstream);
});

/**
 * 环境变量名拼装锁（2026-07-30 判例）：给 resolveServerProvider 加 EVAL_ 前缀分组时，
 * 默认前缀写成了空串，拼出 `HALFHALF_ENDPOINT`——**漏了 AI_**。
 * 服务端统一 key 当场失效、界面上材料转换全部返回 501，而 `pnpm test` 全绿:
 * 单测不碰真实 env，EVAL_ 那条路又恰好拼对，把主路径的断裂完全掩盖了。
 * 这条锁直接断言两组变量名的字面拼装结果。
 */
test('resolveServerProvider 读的是 HALFHALF_AI_* 与 HALFHALF_EVAL_*，名字不许拼错', async () => {
  const { resolveServerProvider } = await import('../../src/engine/ai-structurize.js');
  const saved = { ...process.env };
  const clear = () => {
    for (const k of Object.keys(process.env)) if (k.startsWith('HALFHALF_')) delete process.env[k];
  };
  try {
    clear();
    assert.equal(resolveServerProvider(), null, '什么都没设时必须返回 null');

    clear();
    process.env.HALFHALF_AI_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
    process.env.HALFHALF_AI_MODEL = 'main-model';
    process.env.HALFHALF_AI_KEY = 'k1';
    assert.equal(resolveServerProvider()?.model, 'main-model', '默认组必须读 HALFHALF_AI_*');
    assert.equal(resolveServerProvider('EVAL_')?.model, 'main-model', 'EVAL_ 缺配时整组回落到主组');

    process.env.HALFHALF_EVAL_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
    process.env.HALFHALF_EVAL_MODEL = 'weak-model';
    process.env.HALFHALF_EVAL_KEY = 'k2';
    assert.equal(resolveServerProvider('EVAL_')?.model, 'weak-model', 'EVAL_ 配齐时用评测组');
    assert.equal(resolveServerProvider()?.model, 'main-model', '评测组不许污染主组');

    // 混搭防线：评测组只配两项，必须整组回落，不能 endpoint 用评测组而 key 用主组
    delete process.env.HALFHALF_EVAL_KEY;
    const mixed = resolveServerProvider('EVAL_');
    assert.equal(mixed?.model, 'main-model');
    assert.match(mixed?.endpoint ?? '', /deepseek/, '端点也要跟着回落，不许混搭');
  } finally {
    clear();
    Object.assign(process.env, saved);
  }
});

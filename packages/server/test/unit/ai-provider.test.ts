/**
 * AI 服务商层的契约锁：
 * - 下拉预设（PROVIDER_PRESETS）与 BYOK 白名单同源——预设端点必须全部过 validateEndpoint，
 *   否则用户从下拉选了服务商却被 400 拒掉（前端硬编码漂移的判例式防线）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_PRESETS, validateEndpoint } from '../../src/engine/ai-provider.js';

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

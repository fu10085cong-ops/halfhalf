/**
 * BYOK AI 配置（endpoint/model/key）——localStorage key 沿用旧界面时代的命名，
 * 老用户已存的配置无缝继承；key 只存本地浏览器，请求时才进内存过后端。
 */
import type { AiProviderConfig } from '../../types';

export const AI_KEYS = {
  endpoint: 'hh.ai.endpoint',
  model: 'hh.ai.model',
  key: 'hh.ai.key',
} as const;

export const AI_DEFAULTS = {
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4o-mini',
} as const;

export const lsGet = (k: string, fallback = ''): string => {
  try {
    return localStorage.getItem(k) ?? fallback;
  } catch {
    return fallback;
  }
};

export const lsSet = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 隐私模式等禁用 localStorage：静默降级为本会话内存 */
  }
};

/** key 已填才算 BYOK；否则返回 null = 用服务器统一 key（未配置时接口返回 501） */
export function byokProvider(): AiProviderConfig | null {
  const key = lsGet(AI_KEYS.key).trim();
  if (!key) return null;
  return {
    endpoint: lsGet(AI_KEYS.endpoint, AI_DEFAULTS.endpoint),
    model: lsGet(AI_KEYS.model, AI_DEFAULTS.model),
    headers: { Authorization: `Bearer ${key}` },
  };
}

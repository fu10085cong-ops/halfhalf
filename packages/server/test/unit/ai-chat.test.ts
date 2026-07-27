/**
 * 多轮对话引擎（ai-chat）的行为锁：
 * - system prompt 含材料与学术诚信红线（做题/题库/新增知识的拒绝条款）
 * - 历史截断：只保留最近 CHAT_MAX_TURNS 条、单条截到 CHAT_MAX_TURN_CHARS
 * - chatRespond 经 streamFn 注入不花 token，流式回调与最终 reply 一致
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChatMessages,
  chatRespond,
  CHAT_MAX_TURNS,
  CHAT_MAX_TURN_CHARS,
  CHAT_SYSTEM_PROMPT,
  type ChatTurn,
} from '../../src/engine/ai-chat.js';
import type { ChatMessage } from '../../src/engine/ai-provider.js';
import type { AiProviderConfig } from '../../src/types/index.js';

const PROVIDER: AiProviderConfig = {
  endpoint: 'https://api.deepseek.com/v1/chat/completions',
  model: 'deepseek-chat',
};

test('system prompt 锁死红线关键词', () => {
  for (const keyword of ['不回答考试题目', '题库', '不补充材料之外的知识', '学术诚信']) {
    assert.ok(CHAT_SYSTEM_PROMPT.includes(keyword), `prompt 应包含「${keyword}」`);
  }
});

test('buildChatMessages：system 在首位且嵌入材料', () => {
  const msgs = buildChatMessages('# 微积分\n\n洛必达法则……', [
    { role: 'user', content: '洛必达在哪一节？' },
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('<material>'));
  assert.ok(msgs[0].content.includes('洛必达法则'));
  assert.equal(msgs[1].role, 'user');
});

test('buildChatMessages：无材料时提示先添加材料', () => {
  const msgs = buildChatMessages('   ', [{ role: 'user', content: '你好' }]);
  assert.ok(msgs[0].content.includes('尚未提供材料'));
});

test('历史只保留最近 CHAT_MAX_TURNS 条', () => {
  const turns: ChatTurn[] = [];
  for (let i = 0; i < CHAT_MAX_TURNS + 6; i++) {
    turns.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}` });
  }
  const msgs = buildChatMessages('材料', turns);
  assert.equal(msgs.length, 1 + CHAT_MAX_TURNS);
  // 最早的 6 条被丢弃，保留的第一条是 msg-6
  assert.equal(msgs[1].content, 'msg-6');
  assert.equal(msgs[msgs.length - 1].content, `msg-${CHAT_MAX_TURNS + 5}`);
});

test('单条超长消息截到 CHAT_MAX_TURN_CHARS', () => {
  const long = 'x'.repeat(CHAT_MAX_TURN_CHARS + 500);
  const msgs = buildChatMessages('材料', [{ role: 'user', content: long }]);
  assert.equal(msgs[1].content.length, CHAT_MAX_TURN_CHARS);
});

test('chatRespond：流式回调累积 = 最终 reply，messages 原样进 streamFn', async () => {
  let seen: ChatMessage[] = [];
  const fakeStream = async (
    _p: AiProviderConfig,
    messages: ChatMessage[],
    onDelta: (text: string) => void
  ): Promise<string> => {
    seen = messages;
    onDelta('答案在');
    onDelta('第二节。');
    return '答案在第二节。\n';
  };
  const deltas: string[] = [];
  const result = await chatRespond(
    { context: '# 材料', messages: [{ role: 'user', content: '在哪节？' }] },
    PROVIDER,
    { onDelta: (t) => deltas.push(t) },
    { streamFn: fakeStream }
  );
  assert.equal(result.reply, '答案在第二节。');
  assert.equal(deltas.join(''), '答案在第二节。');
  assert.equal(seen[0].role, 'system');
  assert.equal(seen[1].content, '在哪节？');
});

/**
 * 多轮 AI 对话（Studio 中栏的对话后端）：围绕用户材料回答/改写/给排版建议。
 *
 * 与 ⓪ 结构化（ai-structurize）、① 精简（ai-compress）的分工：那两个是单发任务，
 * 这里是自由多轮——但仍只围绕用户材料，学术诚信红线写死在 system prompt。
 *
 * 无状态设计：材料与对话历史每次由客户端全量带上，服务端不落盘不留存（隐私红线）；
 * 历史在服务端截断（最近 N 条 + 单条长度上限），防止客户端无限膨胀烧 token。
 *
 * 二期预留：改写产物写回 source 需要前端配合（工具通道），本层只返回普通 Markdown 文本，
 * 前端可整段复制/采用——接口形状（result {reply}）不堵死后续加结构化动作。
 */
import type { AiProviderConfig } from '../types/index.js';
import { type ChatMessage, type ChatStreamOptions } from './ai-provider.js';
import type { StreamFn } from './ai-structurize.js';
import { chatCompleteStream } from './ai-provider.js';

export const CHAT_SYSTEM_PROMPT = `你是 HalfHalf 的备考材料助手。用户正在把自己整理的复习材料排成半开卷小抄（允许带入考场的 A4 纸）。你只围绕下方 <material> 里的材料工作，可做三类事：
1. 回答关于材料内容的问题：解释、对比、定位（"某个知识点在哪一节"）。
2. 按用户指示改写材料：精简、合并、重组、转表格/要点。改写只重组不新增知识；输出用标准 Markdown（# 总标题、## 分节、$...$ 或 $$...$$ 的 LaTeX 公式、GFM 管道表格、\`\`\` 代码围栏），方便用户直接粘回材料。
3. 给排版取舍建议：目标页数塞不下时哪些内容可删可并、哪些适合转成表格、哪些是低频细节。

红线（不可越）：
- 不回答考试题目、不出题、不生成题库或答案、不猜"会考什么"。
- 不补充材料之外的知识；材料里没有的内容，直说材料里没有。
- 材料应是用户自己整理的笔记；若内容明显是真题/答案集，提醒学术诚信风险并拒绝处理。

回答用中文，简洁直接；改写类回复只给改写结果本身，不解释你做了什么。`;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** 历史截断：只保留最近 12 条消息（约 6 轮）——更早的上下文让用户重新粘材料表达 */
export const CHAT_MAX_TURNS = 12;
/** 单条消息长度上限（改材料的长回复也够用）；超长掐头留尾会破坏指代，直接截尾 */
export const CHAT_MAX_TURN_CHARS = 8000;

/**
 * 组装发给上游的 messages：system（prompt + 材料）+ 截断后的历史。
 * 材料放 system 里而不是首条 user——多轮里"第三节""刚才那段"的指代都以它为准。
 */
export function buildChatMessages(context: string, turns: ChatTurn[]): ChatMessage[] {
  const material = context.trim() || '（用户尚未提供材料——提醒用户先在左栏添加/勾选材料）';
  const system: ChatMessage = {
    role: 'system',
    content: `${CHAT_SYSTEM_PROMPT}\n\n<material>\n${material}\n</material>`,
  };
  const recent = turns.slice(-CHAT_MAX_TURNS).map((t) => ({
    role: t.role,
    content: t.content.length > CHAT_MAX_TURN_CHARS ? t.content.slice(0, CHAT_MAX_TURN_CHARS) : t.content,
  }));
  return [system, ...recent];
}

export interface ChatEvents {
  onDelta: (text: string) => void;
}

export interface ChatResult {
  reply: string;
}

export async function chatRespond(
  params: { context: string; messages: ChatTurn[] },
  provider: AiProviderConfig,
  events: ChatEvents,
  opts?: { trustEndpoint?: boolean; streamFn?: StreamFn },
): Promise<ChatResult> {
  const stream = opts?.streamFn ?? chatCompleteStream;
  const streamOpts: ChatStreamOptions = { trustEndpoint: opts?.trustEndpoint };
  const messages = buildChatMessages(params.context, params.messages);
  const reply = await stream(provider, messages, (d) => events.onDelta(d), streamOpts);
  return { reply: reply.trim() };
}

/**
 * 中栏 工作台：消息流（动作卡 + 自由对话）+ composer 胶囊
 * （对话输入行 → /api/ai/chat;动作行 = 「转换生料」「生成 PDF」两主按钮）。
 */
import { useEffect, useRef, useState } from 'react';
import MessageCard from './MessageCard';
import { useStudio } from './useStudioStore';
import { useStudioActions } from './useStudioActions';

export default function ChatStream() {
  const { state } = useStudio();
  const { convertAllRaw, generate, sendChat } = useStudioActions();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages]);

  const rawCount = state.sources.filter((s) => s.enabled && s.status === 'raw' && s.raw.trim()).length;
  const enabledCount = state.sources.filter((s) => s.enabled && (s.markdown || s.raw).trim()).length;

  const submitChat = () => {
    if (!draft.trim() || state.chatting) return;
    void sendChat(draft);
    setDraft('');
  };

  return (
    <div className="studio-col is-mid">
      <div className="studio-col-head">工作台</div>
      <div className="hh-chat-scroll" ref={scrollRef}>
        {state.messages.length === 0 && (
          <div className="hh-empty">
            <span className="hh-empty-icon" aria-hidden="true">💬</span>
            <b>转换、排版、提问都在这里进行</b>
            <br />
            ① 左栏添加材料 → ②「转换生料」整理成标准 Markdown → ③「生成 PDF」排成小抄。
            <br />
            也可以直接在下方输入框问材料相关的问题、让 AI 改写某一节。
          </div>
        )}
        {state.messages.map((m) => (
          <MessageCard key={m.id} msg={m} />
        ))}
      </div>
      <div className="hh-action-bar">
        <div className="hh-chat-row">
          <input
            type="text"
            className="hh-chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitChat();
            }}
            placeholder={
              enabledCount > 0
                ? '问材料相关的问题,或让 AI 改写/精简某一节…'
                : '先在左栏添加材料,再来提问'
            }
            disabled={state.chatting}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={submitChat}
            disabled={state.chatting || !draft.trim()}
          >
            {state.chatting ? '思考中…' : '发送'}
          </button>
        </div>
        <div className="hh-action-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={state.converting || rawCount === 0}
            title="对所有勾选且未转换的材料按序逐个跑 AI 结构化（每份一张卡）"
            onClick={() => void convertAllRaw()}
          >
            {state.converting ? '转换中…' : `🪄 转换生料${rawCount > 0 ? `（${rawCount}）` : ''}`}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={state.generating || enabledCount === 0}
            title="把勾选的材料按序拼接排版"
            onClick={() => void generate()}
          >
            {state.generating ? '排版中…' : '生成 PDF →'}
          </button>
          <span className="hh-action-hint">
            {enabledCount} 份材料参与 · 目标 {state.genConfig.targetPages} 页
          </span>
        </div>
      </div>
    </div>
  );
}

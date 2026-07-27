/**
 * 中栏 工作台：消息流（动作卡 + 自由对话）+ composer 胶囊
 * （对话输入行 → /api/ai/chat;动作行 = 「转换生料」「生成 PDF」两主按钮）。
 * spec: docs/superpowers/specs/2026-07-28-chat-column-design.md
 */
import { useEffect, useRef, useState } from 'react';
import MessageCard from './MessageCard';
import { IconChat } from './icons';
import { useStudio } from './useStudioStore';
import { useStudioActions } from './useStudioActions';

/** 贴底判定阈值:小于它视为"用户本来就在看最新内容",流式期间才跟随滚动 */
const PIN_THRESHOLD_PX = 40;
const INPUT_MAX_HEIGHT_PX = 132;

export default function ChatStream() {
  const { state } = useStudio();
  const { convertAllRaw, generate, sendChat, stopChat } = useStudioActions();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 是否贴底。ref 而非 state:滚动事件高频,不值得引发重渲 */
  const pinnedRef = useRef(true);
  const [draft, setDraft] = useState('');
  /** 圈定材料(null = 全部)。发送时按当时圈定拼上下文 */
  const [scope, setScope] = useState<string[] | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [state.messages]);

  const rawCount = state.sources.filter((s) => s.enabled && s.status === 'raw' && s.raw.trim()).length;
  const chatSources = state.sources.filter((s) => s.enabled && (s.markdown || s.raw).trim());
  const enabledCount = chatSources.length;

  const toggleScope = (id: string) => {
    setScope((prev) => {
      if (prev === null) return [id];
      if (prev.includes(id)) {
        const next = prev.filter((x) => x !== id);
        return next.length > 0 ? next : null;
      }
      return [...prev, id];
    });
  };

  const submitChat = () => {
    if (!draft.trim() || state.chatting) return;
    // 圈定里可能有已被删除的材料,发送前过滤;全空退回"全部"
    const effective = scope?.filter((id) => chatSources.some((s) => s.id === id));
    void sendChat(draft, effective?.length ? effective : undefined);
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };

  return (
    <div className="studio-col is-mid">
      <div className="studio-col-head">对话</div>
      <div
        className="hh-chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
        }}
      >
        {state.messages.length === 0 && (
          <div className="hh-empty">
            <span className="hh-empty-icon" aria-hidden="true"><IconChat size={26} /></span>
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
        {chatSources.length > 1 && (
          <div className="hh-chat-scope" role="group" aria-label="提问针对的材料范围">
            <button
              type="button"
              className={`hh-scope-chip${scope === null ? ' is-on' : ''}`}
              onClick={() => setScope(null)}
            >
              全部材料
            </button>
            {chatSources.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`hh-scope-chip${scope?.includes(s.id) ? ' is-on' : ''}`}
                title={`只把《${s.title}》给 AI 当上下文(可多选)`}
                onClick={() => toggleScope(s.id)}
              >
                {s.title.length > 12 ? `${s.title.slice(0, 12)}…` : s.title}
              </button>
            ))}
          </div>
        )}
        <div className="hh-chat-row">
          <textarea
            ref={inputRef}
            rows={1}
            className="hh-chat-input"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              // 自适应高度:先收起再按内容撑开,封顶约 6 行
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, INPUT_MAX_HEIGHT_PX)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submitChat();
              }
            }}
            placeholder={
              enabledCount > 0
                ? '问材料相关的问题,或让 AI 改写/精简某一节…(Shift+Enter 换行)'
                : '先在左栏添加材料,再来提问'
            }
            disabled={state.chatting}
          />
          {state.chatting ? (
            <button type="button" className="btn btn-secondary" onClick={stopChat}>
              停止
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={submitChat}
              disabled={!draft.trim()}
            >
              发送
            </button>
          )}
        </div>
        <div className="hh-action-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={state.converting || rawCount === 0}
            title="对所有勾选且未转换的材料按序逐个跑 AI 结构化（每份一张卡）"
            onClick={() => void convertAllRaw()}
          >
            {state.converting ? '转换中…' : `转换生料${rawCount > 0 ? `（${rawCount}）` : ''}`}
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

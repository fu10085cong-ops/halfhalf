/**
 * 中栏 操作流对话：消息列表（自动滚底）+ 底部动作条（「转换生料」「生成 PDF」两主按钮）。
 * 非自由聊天——每个动作一来一回;消息结构（role/kind）为未来多轮对话预留。
 */
import { useEffect, useRef } from 'react';
import MessageCard from './MessageCard';
import { useStudio } from './useStudioStore';
import { useStudioActions } from './useStudioActions';

export default function ChatStream() {
  const { state } = useStudio();
  const { convertAllRaw, generate } = useStudioActions();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages]);

  const rawCount = state.sources.filter((s) => s.enabled && s.status === 'raw' && s.raw.trim()).length;
  const enabledCount = state.sources.filter((s) => s.enabled && (s.markdown || s.raw).trim()).length;

  return (
    <div className="studio-col">
      <div className="studio-col-head">💬 工作台</div>
      <div className="hh-chat-scroll" ref={scrollRef}>
        {state.messages.length === 0 && (
          <div className="hh-empty">
            这里是操作流：每一步的转换过程、体检结论、排版结果都会以卡片进来。
            <br />
            ① 左栏添加材料 → ② 下方「转换生料」把生料整理成标准 Markdown → ③「生成
            PDF」排成小抄。
            <br />
            已经是规整 Markdown 的材料可以不转换直接生成。
          </div>
        )}
        {state.messages.map((m) => (
          <MessageCard key={m.id} msg={m} />
        ))}
      </div>
      <div className="hh-action-bar">
        <button
          type="button"
          className="hh-btn-secondary"
          disabled={state.converting || rawCount === 0}
          title="对所有勾选且未转换的材料按序逐个跑 AI 结构化（每份一张卡）"
          onClick={() => void convertAllRaw()}
        >
          {state.converting ? '转换中…' : `🪄 转换生料${rawCount > 0 ? `（${rawCount}）` : ''}`}
        </button>
        <button
          type="button"
          className="hh-btn-primary"
          disabled={state.generating || enabledCount === 0}
          title="把勾选的材料按序拼接排版"
          onClick={() => void generate()}
        >
          {state.generating ? '排版中…' : '📄 生成 PDF'}
        </button>
        <span className="hh-action-hint">
          {enabledCount} 份材料参与 · 目标 {state.genConfig.targetPages} 页
        </span>
      </div>
    </div>
  );
}

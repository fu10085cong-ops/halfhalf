/**
 * 对话流单卡：user 文本气泡 / convert 转换卡（流式预览+体检结论）/ pdf 结果卡（指标+预览/下载）。
 * convert/pdf 卡由动作随 phase 原地更新。
 */
import { useStudio, type StudioMessage } from './useStudioStore';

function ConvertCard({ msg }: { msg: StudioMessage }) {
  return (
    <>
      <b>🪄 转换《{msg.sourceTitle}》</b>
      {msg.phase === 'working' && (
        <span style={{ color: '#1d4ed8' }}>
          {' '}
          {msg.attempt && msg.attempt > 1 ? `修正轮转换中…` : 'AI 转换中…'}
        </span>
      )}
      {msg.text && <div style={{ color: '#1d4ed8' }}>⚙️ {msg.text}</div>}
      {msg.error && <div className="hh-msg-err">转换出错：{msg.error}</div>}
      {msg.preview && <pre className="hh-msg-stream">{msg.preview}</pre>}
      {msg.phase === 'done' && msg.check && (
        <div style={{ marginTop: 4 }}>
          {msg.check.ok ? (
            <span className="hh-msg-ok">✅ 结构体检通过（{msg.check.blockCount} 块）· 已写回材料</span>
          ) : (
            <span className="hh-msg-warn">
              ⚠️ 结构可能欠佳：{msg.check.problems.join('、')}（已写回材料，可在左栏点开修改）
            </span>
          )}
        </div>
      )}
    </>
  );
}

function PdfCard({ msg }: { msg: StudioMessage }) {
  const { dispatch } = useStudio();
  if (msg.phase === 'working') {
    return <span style={{ color: '#1d4ed8' }}>📐 排版中…（二分搜索字号，通常几秒到几十秒）</span>;
  }
  if (msg.phase === 'error' || !msg.pdf) {
    return <span className="hh-msg-err">生成失败：{msg.error ?? '未知错误'}</span>;
  }
  const p = msg.pdf;
  return (
    <>
      {p.withinTarget ? (
        <div className="hh-pdf-headline" style={{ color: '#15803d' }}>
          ✓ 已排进 {p.pages} 页 · 字号 {p.fontSize}pt
          {p.fill !== null && ` · 填充 ${p.fill}%`} —— 可以打印
        </div>
      ) : (
        <div className="hh-pdf-headline" style={{ color: '#b45309' }}>
          ⚠ 目标 {p.targetPages} 页塞不下：目前最优 {p.pages} 页 / {p.fontSize}pt
        </div>
      )}
      {p.warnings.map((w, i) => (
        <div key={i} className="hh-msg-warn">
          ⚠️ {w}
        </div>
      ))}
      <div className="hh-msg-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() =>
            dispatch({ type: 'set_overlay', overlay: { url: p.pdfUrl, fileName: p.fileName } })
          }
        >
          打开预览
        </button>
        <a href={p.pdfUrl} download={p.fileName} className="btn btn-secondary" style={{ textDecoration: 'none' }}>
          下载 {p.fileName}
        </a>
      </div>
    </>
  );
}

/** 自由对话的 AI 回复卡：流式期间显示缓冲，完成后显示完整 Markdown 文本 */
function ChatReplyCard({ msg }: { msg: StudioMessage }) {
  if (msg.phase === 'error') {
    return <span className="hh-msg-err">对话出错：{msg.error}</span>;
  }
  const body = msg.phase === 'done' ? msg.text : msg.preview;
  return (
    <div className="hh-chat-reply">
      {body || <span style={{ color: 'var(--color-accent-600)' }}>思考中…</span>}
    </div>
  );
}

export default function MessageCard({ msg }: { msg: StudioMessage }) {
  if (msg.role === 'user') {
    return <div className="hh-msg is-user">{msg.text}</div>;
  }
  return (
    <div className="hh-msg is-system">
      {msg.kind === 'convert' && <ConvertCard msg={msg} />}
      {msg.kind === 'pdf' && <PdfCard msg={msg} />}
      {msg.kind === 'chat' && <ChatReplyCard msg={msg} />}
      {msg.kind === 'text' && <span>{msg.text}</span>}
    </div>
  );
}

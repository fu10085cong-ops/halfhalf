/**
 * 对话流单卡：user 文本气泡 / convert 转换卡（流式预览+体检结论）/ pdf 结果卡（指标+预览/下载）。
 * convert/pdf 卡由动作随 phase 原地更新。
 */
import { IconAlert, IconCheck, IconGear, IconSliders, IconSparkle } from './icons';
import { useStudio, type StudioMessage } from './useStudioStore';
import { useStudioActions } from './useStudioActions';

function ConvertCard({ msg }: { msg: StudioMessage }) {
  return (
    <>
      <b>
        <IconSparkle size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
        转换《{msg.sourceTitle}》
      </b>
      {msg.phase === 'working' && (
        <span style={{ color: '#1d4ed8' }}>
          {' '}
          {msg.attempt && msg.attempt > 1 ? `修正轮转换中…` : 'AI 转换中…'}
        </span>
      )}
      {msg.text && (
        <div style={{ color: '#1d4ed8' }}>
          <IconGear size={12} style={{ verticalAlign: '-1px', marginRight: 4 }} />
          {msg.text}
        </div>
      )}
      {msg.error && <div className="hh-msg-err">转换出错：{msg.error}</div>}
      {msg.preview && <pre className="hh-msg-stream">{msg.preview}</pre>}
      {msg.phase === 'done' && msg.check && (
        <div style={{ marginTop: 4 }}>
          {msg.check.ok ? (
            <span className="hh-msg-ok">
              <IconCheck size={12} /> 结构体检通过（{msg.check.blockCount} 块）· 已写回材料
            </span>
          ) : (
            <span className="hh-msg-warn">
              <IconAlert /> 结构可能欠佳：{msg.check.problems.join('、')}（已写回材料，可在左栏点开修改）
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
    return (
      <span style={{ color: '#1d4ed8' }}>
        <IconSliders size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
        排版中…（二分搜索字号，通常几秒到几十秒）
      </span>
    );
  }
  if (msg.phase === 'error' || !msg.pdf) {
    return <span className="hh-msg-err">生成失败：{msg.error ?? '未知错误'}</span>;
  }
  const p = msg.pdf;
  return (
    <>
      {p.withinTarget ? (
        <div className="hh-pdf-headline" style={{ color: '#15803d' }}>
          <IconCheck size={12} /> 已排进 {p.pages} 页 · 字号 {p.fontSize}pt
          {p.fill !== null && ` · 填充 ${p.fill}%`} —— 可以打印
        </div>
      ) : (
        <div className="hh-pdf-headline" style={{ color: '#b45309' }}>
          <IconAlert /> 目标 {p.targetPages} 页塞不下：目前最优 {p.pages} 页 / {p.fontSize}pt
        </div>
      )}
      {p.warnings.map((w, i) => (
        <div key={i} className="hh-msg-warn">
          <IconAlert /> {w}
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

/** 生料引导卡（产品特色的自动引导）：新材料落卡即出——一键转换或跳过 AI。
 *  状态从当前 source 派生:已转换/已删除时按钮消失,卡片留痕不刷屏 */
function GuideCard({ msg }: { msg: StudioMessage }) {
  const { state } = useStudio();
  const { convertSingle, skipAi } = useStudioActions();
  const source = state.sources.find((s) => s.id === msg.sourceId);
  if (!source) {
    return <span className="text-muted">材料《{msg.sourceTitle}》已删除</span>;
  }
  if (source.status === 'converted') {
    return (
      <span className="hh-msg-ok" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <IconCheck size={13} />《{source.title}》已就绪，可以参与排版
      </span>
    );
  }
  return (
    <>
      <b>检测到生料《{source.title}》</b>
      <div className="text-muted" style={{ marginTop: 2 }}>
        转换成标准 Markdown 后排版更稳——伪表格、公式、章节结构都会被整理好；这是 HalfHalf
        的看家环节。右栏「一键转换并排版」可以整批处理。
      </div>
      <div className="hh-msg-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={state.converting}
          onClick={() => void convertSingle(source)}
        >
          立即转换这份
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          title="不经 AI，原样当成品参与排版（没配 AI key 时的直通路径）"
          onClick={() => skipAi(source)}
        >
          跳过 AI，原样用
        </button>
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
      {msg.kind === 'guide' && <GuideCard msg={msg} />}
      {msg.kind === 'text' && <span>{msg.text}</span>}
    </div>
  );
}

/**
 * 对话流单卡：user 文本气泡 / convert 转换卡（流式预览+体检结论）/ pdf 结果卡（指标+预览/下载）。
 * convert/pdf 卡由动作随 phase 原地更新。
 */
import { useState } from 'react';
import { renderMarkdown } from '../../lib/markdown';
import { IconAlert, IconCheck, IconGear, IconSliders, IconSparkle } from './icons';
import { makeSource, useStudio, type StudioMessage } from './useStudioStore';
import { useStudioActions } from './useStudioActions';

/** 501(AI 未配置)错误的统一引导:打开右栏「AI 设置」弹窗填 BYOK */
function GoAiSettings() {
  const { dispatch } = useStudio();
  return (
    <button
      type="button"
      className="btn btn-secondary hh-msg-retry"
      onClick={() => dispatch({ type: 'set_modal', modal: 'settings' })}
    >
      去 AI 设置
    </button>
  );
}

function ConvertCard({ msg }: { msg: StudioMessage }) {
  const { state } = useStudio();
  const { convertSingle, stopConvert } = useStudioActions();
  // 重试按 sourceId 找当前材料——卡片留痕期间材料可能已被删除
  const source = state.sources.find((s) => s.id === msg.sourceId);
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
          <button type="button" className="hh-msg-stop" onClick={stopConvert}>
            停止
          </button>
        </span>
      )}
      {msg.text && (
        <div style={{ color: '#1d4ed8' }}>
          <IconGear size={12} style={{ verticalAlign: '-1px', marginRight: 4 }} />
          {msg.text}
        </div>
      )}
      {msg.error && (
        <div className="hh-msg-err">
          转换出错：{msg.error}
          {msg.configError && <GoAiSettings />}
          {source && !msg.configError && (
            <button
              type="button"
              className="btn btn-secondary hh-msg-retry"
              disabled={state.converting}
              onClick={() => void convertSingle(source)}
            >
              重试
            </button>
          )}
        </div>
      )}
      {msg.preview && <pre className="hh-msg-stream">{msg.preview}</pre>}
      {msg.phase === 'done' && msg.check && (
        <div style={{ marginTop: 4 }}>
          {msg.check.ok ? (
            <span className="hh-msg-ok">
              <IconCheck size={12} /> 结构体检通过（{msg.check.blockCount} 块）· 已写回材料
            </span>
          ) : msg.check.fabricationSuspected ? (
            /* 保真问题与结构问题必须分开说。结构差只是版面欠佳；内容被 AI 添加，
               用户会当成自己的笔记打印进考场，必须显式要求核对。 */
            <span className="hh-msg-danger">
              <IconAlert /> <strong>产出可能含 AI 添加的内容,请核对后再用</strong>：
              {msg.check.problems.join('、')}（已写回材料，务必在左栏点开逐条对照原文）
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

/** 生料引导卡（产品特色的自动引导）：新材料落卡即出——转换是排版的必经环节。
 *  状态从当前 source 派生:已转换/已删除时按钮消失,卡片留痕不刷屏 */
function GuideCard({ msg }: { msg: StudioMessage }) {
  const { state } = useStudio();
  const { convertSingle } = useStudioActions();
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
        所有材料都要经 AI 转换成标准 Markdown 才能排版——伪表格、公式、章节结构会被统一整理，
        这是 HalfHalf 的看家环节。直接点「生成 PDF」也会自动先转换。没配 AI key？到「AI 设置」填一个。
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
      </div>
    </>
  );
}

/** 自由对话的 AI 回复卡：流式与完成态都渲染 Markdown;完成后给产物出口
 *  (存为新材料;圈定恰好一份时可写回该材料——raw 不动,"从原文重转"是后悔药) */
function ChatReplyCard({ msg }: { msg: StudioMessage }) {
  const { state, dispatch } = useStudio();
  const { sendChat, convertSingle, writeBackChat } = useStudioActions();
  const [savedAsSource, setSavedAsSource] = useState(false);
  if (msg.phase === 'error') {
    return (
      <span className="hh-msg-err">
        对话出错：{msg.error}
        {msg.prompt && (
          <button
            type="button"
            className="btn btn-secondary hh-msg-retry"
            disabled={state.chatting}
            onClick={() => void sendChat(msg.prompt!, msg.scopeIds)}
          >
            重试
          </button>
        )}
      </span>
    );
  }
  const body = msg.phase === 'done' ? msg.text : msg.preview;
  const done = msg.phase === 'done' && !!msg.text?.trim();
  const writeBackTarget =
    done && msg.scopeIds?.length === 1
      ? state.sources.find((s) => s.id === msg.scopeIds![0])
      : undefined;
  return (
    <>
      {body ? (
        <div
          className="hh-chat-reply hh-md"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
        />
      ) : (
        <span style={{ color: 'var(--color-accent-600)' }}>思考中…</span>
      )}
      {msg.stopped && <div className="text-muted">已手动停止,以上为部分回复</div>}
      {done && (
        <div className="hh-msg-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={savedAsSource}
            title="把这条回复经 AI 标准化后落成左栏材料(统一输入闸:对话产物也要过指定提示词)"
            onClick={() => {
              // 落成生料 + 立即自动过闸转换;转换失败也已入库,左栏亮「生料待转换」
              const src = makeSource({ kind: 'paste', raw: msg.text!, importSummary: 'AI 对话产物' });
              dispatch({ type: 'add_source', source: src });
              setSavedAsSource(true);
              if (!state.converting) void convertSingle(src);
            }}
          >
            {savedAsSource ? '已存入左栏' : '存为新材料'}
          </button>
          {writeBackTarget && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={state.converting}
              title="回复先经 AI 标准化,再覆盖该材料的整理稿;原文保留,可随时从原文重新转换"
              onClick={() => {
                if (
                  window.confirm(
                    `把这条回复经 AI 标准化后覆盖《${writeBackTarget.title}》的整理稿？原文仍保留，可随时「从原文重新转换」恢复。`
                  )
                ) {
                  void writeBackChat(writeBackTarget, msg.text!);
                }
              }}
            >
              写回《{writeBackTarget.title.length > 10 ? `${writeBackTarget.title.slice(0, 10)}…` : writeBackTarget.title}》
            </button>
          )}
        </div>
      )}
    </>
  );
}

export default function MessageCard({ msg }: { msg: StudioMessage }) {
  const { state } = useStudio();
  if (msg.role === 'user') {
    // 圈定标注:按 id 找当前标题,材料已删的份不列(数量对不上也不值得提醒)
    const scopedTitles = (msg.scopeIds ?? [])
      .map((id) => state.sources.find((s) => s.id === id)?.title)
      .filter((t): t is string => !!t);
    return (
      <div className="hh-msg is-user">
        {msg.text}
        {scopedTitles.length > 0 && (
          <div className="hh-msg-scope">针对：{scopedTitles.join('、')}</div>
        )}
      </div>
    );
  }
  return (
    <div className="hh-msg is-system">
      {msg.kind === 'convert' && <ConvertCard msg={msg} />}
      {msg.kind === 'pdf' && <PdfCard msg={msg} />}
      {msg.kind === 'chat' && <ChatReplyCard msg={msg} />}
      {msg.kind === 'guide' && <GuideCard msg={msg} />}
      {msg.kind === 'text' &&
        (msg.error ? (
          <span className="hh-msg-err">
            {msg.error}
            {msg.configError && <GoAiSettings />}
          </span>
        ) : (
          <span>{msg.text}</span>
        ))}
    </div>
  );
}

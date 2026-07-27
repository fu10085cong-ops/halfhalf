/**
 * ⓪ 材料转换（ChatIntake）：任意粘贴内容 → AI 流式产出标准 .md → 采用进排版文本框。
 * 应急路径的第一棒（DESIGN.md）；已有标准 Markdown 的用户直接跳过本区。
 *
 * SSE 事件契约见 packages/server/API.md 的 /api/ai/structurize：
 * delta{text,attempt} / retry{problems} / result{markdown,check,attempts} / error{error}。
 * attempt 变化 = 首轮体检不过、AI 在重写——预览缓冲要清空重新累积。
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../api';
import type { AiProviderConfig } from '../../types';

interface StructurizeCheck {
  ok: boolean;
  problems: string[];
  blockCount: number;
}

interface Props {
  /** BYOK 配置（key 已填才传）；null = 用服务器统一 key（未配置时接口返回 501） */
  provider: AiProviderConfig | null;
  /** generate=true 表示「采用并排版」：写入文本框后立刻触发生成 */
  onAdopt: (markdown: string, generate: boolean) => void;
  /** 文档导入（Word/PDF 提取产物）注入原料框：seq 变化触发追加。生料该走 AI 转换,
   *  不该直接进排版框——真实判例:用户把 docx 拖进本区却只得到一行文件名 */
  injected?: { text: string; seq: number } | null;
}

/** 解析 text/event-stream 帧（event: X / data: JSON），逐帧回调 */
async function consumeSse(
  resp: Response,
  on: (event: string, data: Record<string, unknown>) => void
): Promise<void> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!data) continue;
      try {
        on(event, JSON.parse(data) as Record<string, unknown>);
      } catch {
        /* 半截帧等异常：跳过单帧，不中断整个流 */
      }
    }
  }
}

export default function ChatIntake({ provider, onAdopt, injected }: Props) {
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<StructurizeCheck | null>(null);
  const [finalMd, setFinalMd] = useState<string | null>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  // 文档导入注入：追加进原料框（多文件可累加），自动展开本区并清掉上一轮转换的残留
  useEffect(() => {
    if (!injected) return;
    setRaw((cur) => (cur.trim() ? `${cur.trim()}\n\n${injected.text}` : injected.text));
    setPreview('');
    setCheck(null);
    setFinalMd(null);
    setError(null);
    setStatus('📄 文档内容已提取——点「转换为标准 Markdown」整理，或「跳过 AI」原样进排版框');
    if (detailsRef.current) detailsRef.current.open = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injected?.seq]);

  const convert = async () => {
    if (!raw.trim() || busy) return;
    setBusy(true);
    setError(null);
    setPreview('');
    setCheck(null);
    setFinalMd(null);
    setStatus('AI 转换中…');
    let attempt = 1;
    let acc = '';
    let gotResult = false;
    let streamError: string | null = null;
    try {
      const resp = await apiFetch('/api/ai/structurize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: raw, provider: provider ?? undefined }),
      });
      if (!resp.ok || !resp.headers.get('content-type')?.includes('event-stream')) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      await consumeSse(resp, (event, data) => {
        if (event === 'delta') {
          const a = Number(data.attempt) || 1;
          if (a !== attempt) {
            attempt = a;
            acc = '';
          }
          acc += String(data.text ?? '');
          setPreview(acc);
        } else if (event === 'retry') {
          const problems = (data.problems as string[]) ?? [];
          setStatus(`⚙️ 结构体检未过，AI 修正中（${problems.join('、')}）`);
        } else if (event === 'result') {
          gotResult = true;
          const md = String(data.markdown ?? '');
          setFinalMd(md);
          setPreview(md);
          setCheck((data.check as unknown as StructurizeCheck) ?? null);
          setStatus(null);
        } else if (event === 'error') {
          streamError = String(data.error ?? '未知错误');
        }
      });
      if (streamError) throw new Error(streamError);
      if (!gotResult) throw new Error('转换中断，未收到最终结果，请重试');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details
      open
      ref={detailsRef}
      style={{ border: '1px solid #cbd5e1', borderRadius: 4, padding: 8, fontSize: 13 }}
    >
      <summary style={{ cursor: 'pointer' }}>
        <b>🪄 材料转换</b>
        <span style={{ color: '#64748b' }}>
          {' '}
          —— 粘贴任意内容（Word/课件/聊天记录），AI 整理成标准 Markdown；已是 Markdown 可跳过
        </span>
      </summary>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onDrop={(e) => {
          // 拖文件进来时掐掉浏览器默认的"插入文件名"（真实判例:docx 拖进来只剩一行
          // 文件名喂给 AI）；不拦传播,外层 DocumentDropSurface 照常接住文件做导入
          if (e.dataTransfer?.files?.length) e.preventDefault();
        }}
        rows={5}
        spellCheck={false}
        placeholder="把原始材料粘到这里（可多次粘贴拼接）——不需要是 Markdown；Word/PDF 直接拖进页面"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          fontFamily: 'monospace',
          fontSize: 12,
          padding: 6,
          marginTop: 6,
          resize: 'vertical',
        }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
        <button onClick={convert} disabled={busy || !raw.trim()} style={{ fontWeight: 'bold' }}>
          {busy ? '转换中…' : '转换为标准 Markdown'}
        </button>
        <button
          onClick={() => onAdopt(raw, false)}
          disabled={busy || !raw.trim()}
          title="不经 AI，把原料原样写入下方排版文本框（没配 AI key 时的直通路径）"
        >
          跳过 AI，原样写入
        </button>
        {provider === null && (
          <span style={{ color: '#94a3b8' }}>
            将使用服务器配置的 AI；想用自己的 key 在「AI 设置」里填
          </span>
        )}
      </div>
      {status && <div style={{ color: '#1d4ed8', marginTop: 4 }}>{status}</div>}
      {error && <div style={{ color: '#b91c1c', marginTop: 4 }}>转换出错：{error}</div>}
      {preview && (
        <pre
          style={{
            margin: '6px 0 0',
            padding: 6,
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 3,
            fontFamily: 'monospace',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 180,
            overflow: 'auto',
          }}
        >
          {preview}
        </pre>
      )}
      {finalMd !== null && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
          {check &&
            (check.ok ? (
              <span style={{ color: '#15803d' }}>✅ 结构体检通过（{check.blockCount} 块）</span>
            ) : (
              <span style={{ color: '#b45309' }}>
                ⚠️ 结构可能欠佳：{check.problems.join('、')}（仍可采用，或改原文重试）
              </span>
            ))}
          <button onClick={() => onAdopt(finalMd, true)} style={{ fontWeight: 'bold' }}>
            采用并排版
          </button>
          <button onClick={() => onAdopt(finalMd, false)}>仅写入文本框</button>
        </div>
      )}
    </details>
  );
}

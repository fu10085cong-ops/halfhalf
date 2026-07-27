/**
 * 右栏栈式面板（精简 / 诊断 / 历史 / AI 设置）——点模块卡滑入,← 返回卡片列表。
 * 精简作用域 = 单个已转换 source（spec 已拍;组合级 range 映射是坑,二期再说）。
 */
import { useState } from 'react';
import { apiFetch } from '../../api';
import type { AiCompressResponse, AiCompressSummary, BlockSuggestion } from '../../types';
import { AI_DEFAULTS, AI_KEYS, byokProvider, lsGet, lsSet } from './aiConfig';
import { useStudio } from './useStudioStore';

/** 能否勾选应用：非跳过、有实际改动、原子/公式安全网都过 */
function isApplicable(s: BlockSuggestion): boolean {
  return !s.skipped && s.suggested !== s.original && s.safety.atomsPreserved && s.safety.formulaClean;
}

const diffBox: React.CSSProperties = {
  margin: '4px 0 0',
  padding: 6,
  background: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 3,
  fontFamily: 'monospace',
  fontSize: 11,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 120,
  overflow: 'auto',
};

export function CompressPanel() {
  const { state, dispatch } = useStudio();
  const candidates = state.sources.filter((s) => s.status === 'converted' && s.markdown.trim());
  const [sourceId, setSourceId] = useState(candidates[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<BlockSuggestion[]>([]);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [summary, setSummary] = useState<AiCompressSummary | null>(null);
  /** 提交精简时那份 markdown 的快照——range 偏移相对它算，回写也拼回它 */
  const [snapshot, setSnapshot] = useState('');

  const run = async () => {
    const source = state.sources.find((s) => s.id === sourceId);
    if (!source) return;
    const provider = byokProvider();
    if (!provider) {
      setError('AI 精简走你自己的 key——先在「AI 设置」里填 API Key');
      return;
    }
    setBusy(true);
    setError(null);
    setSuggestions([]);
    setSummary(null);
    const snap = source.markdown;
    setSnapshot(snap);
    try {
      const resp = await apiFetch('/api/ai/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: snap, provider }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const res = data as AiCompressResponse;
      setSuggestions(res.suggestions);
      setSummary(res.summary);
      const acc: Record<string, boolean> = {};
      res.suggestions.forEach((s) => {
        acc[s.blockId] = s.safety.ok;
      });
      setAccepted(acc);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 勾选的建议按 range 降序拼回快照（降序保证靠前偏移不被挪动），写回该 source */
  const apply = () => {
    let out = snapshot;
    const toApply = suggestions
      .filter((s) => accepted[s.blockId] && isApplicable(s))
      .sort((a, b) => b.range.start - a.range.start);
    for (const s of toApply) {
      out = out.slice(0, s.range.start) + s.suggested + '\n\n' + out.slice(s.range.end);
    }
    dispatch({ type: 'update_source', id: sourceId, patch: { markdown: out } });
    setSuggestions([]);
    setAccepted({});
    setSummary(null);
  };

  const acceptedCount = suggestions.filter((s) => accepted[s.blockId] && isApplicable(s)).length;

  return (
    <div style={{ fontSize: 13 }}>
      <b>✨ AI 精简</b>
      <div style={{ color: 'var(--color-text-secondary)', margin: '4px 0 8px' }}>
        把一份材料的叙述性文字改写成要点式——只出建议，勾选后「应用」才写回。公式/代码/表格/图片不会被动。
      </div>
      {candidates.length === 0 ? (
        <div className="hh-empty">没有已转换的材料——先在对话流里「转换生料」（或对材料「跳过 AI」）。</div>
      ) : (
        <>
          <select
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            style={{ maxWidth: '100%', marginBottom: 6 }}
          >
            {candidates.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
          <div>
            <button type="button" className="hh-btn-primary" onClick={() => void run()} disabled={busy || !sourceId}>
              {busy ? 'AI 精简中…' : '开始精简'}
            </button>
          </div>
        </>
      )}
      {error && <div className="hh-msg-err" style={{ marginTop: 6 }}>{error}</div>}
      {summary && (
        <div style={{ color: '#555', margin: '8px 0 4px' }}>
          共 {summary.total} 块 · 可精简 {summary.compressed} 块 · 全接受口径 {summary.charsBefore}→
          {summary.charsAfter} 字
          <div style={{ marginTop: 4 }}>
            <button type="button" className="hh-btn-primary" onClick={apply} disabled={acceptedCount === 0}>
              应用选中（{acceptedCount} 块）
            </button>
          </div>
        </div>
      )}
      {suggestions.map((s) => {
        const applicable = isApplicable(s);
        return (
          <div key={s.blockId} style={{ borderTop: '1px solid #eee', padding: '6px 0' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <input
                type="checkbox"
                disabled={!applicable}
                checked={!!accepted[s.blockId]}
                onChange={(e) => setAccepted((a) => ({ ...a, [s.blockId]: e.target.checked }))}
              />
              <b>{s.blockTitle || s.blockId}</b>
              {!s.skipped && (
                <span style={{ color: '#555' }}>
                  {s.charsBefore}→{s.charsAfter} 字
                </span>
              )}
              {s.safety.ok ? (
                <span className="hh-msg-ok">✅</span>
              ) : (
                <span style={{ color: s.skipped ? '#64748b' : '#b45309' }}>
                  {s.skipped ? '—' : '⚠️'} {s.safety.reason}
                </span>
              )}
            </label>
            {applicable && (
              <>
                <pre style={diffBox}>{s.original}</pre>
                <pre style={{ ...diffBox, background: '#f0fdf4' }}>{s.suggested}</pre>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function DiagnosticsPanel() {
  const { state } = useStudio();
  const r = state.lastResult;
  if (!r) {
    return <div className="hh-empty">还没有生成记录——先「生成 PDF」，这里会展示引擎诊断。</div>;
  }
  const d = r.diagnostics;
  return (
    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
      <b>🔍 最近一次生成</b>
      <div>
        正文≈{r.stats.charCount}字 · 公式{r.stats.displayFormulaCount + r.stats.inlineFormulaCount} · 表格
        {r.stats.tableCount} · 代码块{r.stats.codeBlockCount} · 共{r.stats.blockCount}块
      </div>
      <div>
        场景 <b>{r.usedSceneName}</b> · {r.fontSize}pt · {r.pages} 页 ·{' '}
        {r.withinTargetPages ? '达标 ✓' : '未达标'}
      </div>
      {(r.trace ?? []).map((e, i) => (
        <div key={i} style={{ color: e.kind === 'adjudication' ? '#7c3aed' : '#555' }}>
          {e.kind === 'hard' ? '🔒' : e.kind === 'adjudication' ? '⚖️' : '·'} [{e.rule}] {e.detail}
        </div>
      ))}
      {d && (
        <>
          <div style={{ margin: '6px 0 2px' }}>
            总填充 <b>{d.overallFill}%</b> · 耗时 {(d.elapsedMs / 1000).toFixed(1)}s
          </div>
          {d.pageFill.map((f, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 40 }}>第{i + 1}页</span>
              <div style={{ flex: 1, height: 8, background: '#e2e8f0', borderRadius: 2 }}>
                <div
                  style={{
                    width: `${Math.min(f, 100)}%`,
                    height: '100%',
                    borderRadius: 2,
                    background: f > 100 ? '#dc2626' : f < 60 ? '#94a3b8' : '#3b82f6',
                  }}
                />
              </div>
              <span>{f}%</span>
            </div>
          ))}
          <div style={{ maxHeight: 240, overflow: 'auto', marginTop: 6 }}>
            <table className="hh-mini-table">
              <thead>
                <tr>
                  {['块', '宽', '页', '缩放', '提示'].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.blocks.map((b) => (
                  <tr
                    key={b.id}
                    style={{ background: b.oversized ? '#fee2e2' : b.belowMinScale ? '#fef3c7' : undefined }}
                  >
                    <td title={b.id}>{b.title}</td>
                    <td>{b.span}</td>
                    <td>{b.page ?? '—'}</td>
                    <td>{b.scale < 1 ? `×${b.scale}` : '—'}</td>
                    <td>
                      {b.oversized ? '⛔' : b.belowMinScale ? '⚠️' : ''}
                      {b.stretchedPt ? `↗${b.stretchedPt}pt` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function HistoryPanel() {
  const { state } = useStudio();
  if (state.runs.length === 0) {
    return <div className="hh-empty">本次会话还没有生成记录。改一个参数再生成，即可逐行对照。</div>;
  }
  return (
    <div style={{ fontSize: 12 }}>
      <b>🕘 会话历史（{state.runs.length} 次）</b>
      <div style={{ maxHeight: 400, overflow: 'auto', marginTop: 6 }}>
        <table className="hh-mini-table">
          <thead>
            <tr>
              {['#', '配置', '字号', '页', '达标', '填充'].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.runs.map((r, i) => {
              const prev = i > 0 ? state.runs[i - 1] : null;
              const delta = prev ? Math.round((r.fontSize - prev.fontSize) * 10) / 10 : 0;
              return (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{r.config}</td>
                  <td>
                    <b>{r.fontSize}pt</b>
                    {prev && delta !== 0 && (
                      <span style={{ color: delta > 0 ? '#15803d' : '#b91c1c', marginLeft: 3 }}>
                        {delta > 0 ? `▲+${delta}` : `▼${delta}`}
                      </span>
                    )}
                  </td>
                  <td>{r.pages}</td>
                  <td>{r.ok ? '✓' : '✗'}</td>
                  <td>{r.fill !== null ? `${r.fill}%` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AiSettingsPanel() {
  // localStorage key 与旧界面共享——两边填一次就都能用；key 只存本地浏览器
  const [endpoint, setEndpoint] = useState(() => lsGet(AI_KEYS.endpoint, AI_DEFAULTS.endpoint));
  const [model, setModel] = useState(() => lsGet(AI_KEYS.model, AI_DEFAULTS.model));
  const [key, setKey] = useState(() => lsGet(AI_KEYS.key));

  const field: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: 5, marginTop: 2 };
  return (
    <div style={{ fontSize: 13 }}>
      <b>⚙️ AI 设置（BYOK）</b>
      <div style={{ color: 'var(--color-text-secondary)', margin: '4px 0 8px' }}>
        不填 = 用服务器统一配置的 AI（部署者提供）。填了就用你自己的 key——存本地浏览器，请求时才过后端内存，不落服务器。
      </div>
      <label>
        端点（OpenAI 兼容 /chat/completions）
        <input type="text" value={endpoint} style={field} placeholder={AI_DEFAULTS.endpoint}
          onChange={(e) => { setEndpoint(e.target.value); lsSet(AI_KEYS.endpoint, e.target.value); }} />
      </label>
      <label style={{ display: 'block', marginTop: 8 }}>
        模型
        <input type="text" value={model} style={field} placeholder={AI_DEFAULTS.model}
          onChange={(e) => { setModel(e.target.value); lsSet(AI_KEYS.model, e.target.value); }} />
      </label>
      <label style={{ display: 'block', marginTop: 8 }}>
        API Key
        <input type="password" value={key} style={field} placeholder="sk-..."
          onChange={(e) => { setKey(e.target.value); lsSet(AI_KEYS.key, e.target.value); }} />
      </label>
    </div>
  );
}

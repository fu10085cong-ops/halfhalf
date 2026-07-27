/**
 * 居中弹窗的面板内容（精简 / 诊断 / 历史 / AI 设置 / 重点规划）——由 StudioRail 的瓦片打开。
 * 精简作用域 = 单个已转换 source（spec 已拍;组合级 range 映射是坑,二期再说）。
 */
import { useEffect, useState } from 'react';
import { apiFetch } from '../../api';
import type { AiCompressResponse, AiCompressSummary, BlockSuggestion } from '../../types';
import type {
  FocusPriority,
  FocusSpec,
  MaterializeResult,
  RestructurePlan,
} from '../../types/restructure';
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
      <div className="text-muted" style={{ margin: '4px 0 8px' }}>
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
            <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={busy || !sourceId}>
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
            <button type="button" className="btn btn-primary" onClick={apply} disabled={acceptedCount === 0}>
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
      <div className="text-muted">本次会话共 {state.runs.length} 次生成;改一个参数再生成即可逐行对照</div>
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

interface ProviderPreset {
  id: string;
  name: string;
  endpoint: string;
  defaultModel: string;
  keyUrl: string;
}

export function AiSettingsPanel() {
  // localStorage key 与旧界面共享——两边填一次就都能用；key 只存本地浏览器
  const [endpoint, setEndpoint] = useState(() => lsGet(AI_KEYS.endpoint, AI_DEFAULTS.endpoint));
  const [model, setModel] = useState(() => lsGet(AI_KEYS.model, AI_DEFAULTS.model));
  const [key, setKey] = useState(() => lsGet(AI_KEYS.key));
  const [presets, setPresets] = useState<ProviderPreset[]>([]);

  // 服务商预设（GET /api/ai/providers,与服务端 BYOK 白名单同源）:选中即填端点+模型,key 自己填
  useEffect(() => {
    apiFetch('/api/ai/providers')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.providers) setPresets(d.providers as ProviderPreset[]);
      })
      .catch(() => {});
  }, []);

  const currentPreset = presets.find((p) => p.endpoint === endpoint);

  const applyPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    setEndpoint(preset.endpoint);
    setModel(preset.defaultModel);
    lsSet(AI_KEYS.endpoint, preset.endpoint);
    lsSet(AI_KEYS.model, preset.defaultModel);
  };

  return (
    <div style={{ fontSize: 13 }}>
      <div className="text-muted" style={{ margin: '4px 0 8px' }}>
        不填 = 用服务器统一配置的 AI（部署者提供）。填了就用你自己的 key——存本地浏览器，请求时才过后端内存，不落服务器。
      </div>
      {presets.length > 0 && (
        <div className="field">
          <label>服务商（选中自动填端点和默认模型）</label>
          <select
            className="input"
            value={currentPreset?.id ?? ''}
            onChange={(e) => applyPreset(e.target.value)}
          >
            <option value="">自定义端点…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {currentPreset && (
            <div className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>
              还没有 key？
              <a href={currentPreset.keyUrl} target="_blank" rel="noreferrer">
                去 {currentPreset.name} 申请 →
              </a>
            </div>
          )}
        </div>
      )}
      <div className="field">
        <label>端点（OpenAI 兼容 /chat/completions）</label>
        <input type="text" className="input" value={endpoint} placeholder={AI_DEFAULTS.endpoint}
          onChange={(e) => { setEndpoint(e.target.value); lsSet(AI_KEYS.endpoint, e.target.value); }} />
      </div>
      <div className="field">
        <label>模型</label>
        <input type="text" className="input" value={model} placeholder={AI_DEFAULTS.model}
          onChange={(e) => { setModel(e.target.value); lsSet(AI_KEYS.model, e.target.value); }} />
      </div>
      <div className="field">
        <label>API Key</label>
        <input type="password" className="input" value={key} placeholder="sk-..."
          onChange={(e) => { setKey(e.target.value); lsSet(AI_KEYS.key, e.target.value); }} />
      </div>
    </div>
  );
}

// ---------- 重点规划（重构计划 → 确认后应用 → 可撤销） ----------

function splitTopics(value: string): string[] {
  return value
    .split(/[,;\n，；]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

const PRIORITY_LABEL: Record<FocusPriority, string> = {
  must: '必留',
  key: '重点',
  supporting: '辅助',
  omit: '忽略',
};

/**
 * 只对带 KnowledgeIR 的材料可用（目前 = PDF 导入）。
 * 先出可审计计划、由用户确认后才应用，应用后保留撤销——不自动改用户的材料。
 */
export function FocusPanel() {
  const { state, dispatch } = useStudio();
  const planned = state.sources.find((s) => s.knowledge && s.enabled) ?? null;

  const [goal, setGoal] = useState('');
  const [keyTopics, setKeyTopics] = useState('');
  const [omitTopics, setOmitTopics] = useState('');
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<RestructurePlan | null>(null);
  const [before, setBefore] = useState<string | null>(null);

  if (!planned?.knowledge) {
    return (
      <div className="hh-empty">
        还没有带来源锚点的材料。导入一份 PDF 后，这里可以按「必须保留 / 希望忽略」生成
        可核对的重构计划。粘贴文本和网页抓取暂不产出知识节点。
      </div>
    );
  }

  const document = planned.knowledge;
  const sourceMarkdown = planned.markdown || planned.raw;

  const generatePlan = async () => {
    const mustQueries = splitTopics(keyTopics);
    const omitQueries = splitTopics(omitTopics);
    if (!goal.trim() && mustQueries.length === 0) {
      setError('请先写明使用目的，或至少一个重点。');
      return;
    }
    setBusy(true);
    setError(null);
    setBefore(null);
    try {
      const focus: FocusSpec = {
        goal: goal.trim(),
        targetPages: state.genConfig.targetPages,
        minFontPt: 8,
        defaultExplanationDepth: 'brief',
        topics: [
          ...mustQueries.map((query) => ({
            query,
            priority: 'must' as const,
            explanationDepth: 'deep' as const,
          })),
          ...omitQueries.map((query) => ({
            query,
            priority: 'omit' as const,
            explanationDepth: 'none' as const,
          })),
        ],
      };
      const resp = await apiFetch('/api/restructure/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document, focus }),
      });
      const data = (await resp.json()) as RestructurePlan | { error?: string };
      if (!resp.ok || !('decisions' in data)) {
        throw new Error(('error' in data && data.error) || `HTTP ${resp.status}`);
      }
      setPlan(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyPlan = async () => {
    if (!plan) return;
    setApplying(true);
    setError(null);
    try {
      const snapshot = sourceMarkdown;
      const resp = await apiFetch('/api/restructure/materialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document, plan, sourceMarkdown: snapshot }),
      });
      const data = (await resp.json()) as MaterializeResult | { error?: string };
      if (!resp.ok || !('markdown' in data)) {
        throw new Error(('error' in data && data.error) || `HTTP ${resp.status}`);
      }
      setBefore(snapshot);
      dispatch({ type: 'update_source', id: planned.id, patch: { markdown: data.markdown, status: 'converted' } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const undo = () => {
    if (before === null) return;
    dispatch({ type: 'update_source', id: planned.id, patch: { markdown: before } });
    setBefore(null);
  };

  const preview = plan?.decisions.filter((d) => d.priority !== 'supporting').slice(0, 40) ?? [];

  return (
    <div className="hh-focus">
      <div className="text-muted hh-focus-stat">
        {planned.title} · {document.nodes.length} 个知识节点 / {document.pageCount ?? 0} 页
        {document.quality?.hybridPageCount
          ? ` · ${document.quality.hybridPageCount} 页需混合公式识别`
          : ''}
      </div>

      <label className="hh-focus-field">
        <span>你想怎么使用这份资料？</span>
        <textarea
          rows={2}
          value={goal}
          placeholder="例：考前复习，重点说明边界条件的物理意义，例题只留方法"
          onChange={(e) => setGoal(e.target.value)}
        />
      </label>
      <label className="hh-focus-field">
        <span>必须保留 / 重点说明</span>
        <input
          value={keyTopics}
          placeholder="例：麦克斯韦方程，边界条件"
          onChange={(e) => setKeyTopics(e.target.value)}
        />
      </label>
      <label className="hh-focus-field">
        <span>希望忽略</span>
        <input
          value={omitTopics}
          placeholder="例：教师信息，重复推导"
          onChange={(e) => setOmitTopics(e.target.value)}
        />
      </label>

      <div className="hh-focus-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void generatePlan()}>
          {busy ? '正在分析重点…' : '生成重构计划'}
        </button>
        {plan && (
          <button type="button" className="btn" disabled={applying} onClick={() => void applyPlan()}>
            {applying ? '正在应用…' : '应用这份计划'}
          </button>
        )}
        {before !== null && (
          <button type="button" className="btn" onClick={undo}>
            撤销本次重构
          </button>
        )}
      </div>

      {error && <div className="hh-msg-err">{error}</div>}

      {plan && (
        <>
          <div className="hh-focus-summary">
            {(['must', 'key', 'supporting', 'omit'] as FocusPriority[]).map((p) => (
              <span key={p}>
                {PRIORITY_LABEL[p]}
                <b>
                  {p === 'must'
                    ? plan.summary.mustKeep
                    : p === 'key'
                      ? plan.summary.key
                      : p === 'supporting'
                        ? plan.summary.supporting
                        : plan.summary.omitted}
                </b>
              </span>
            ))}
            <span>
              原图兜底<b>{plan.summary.visualFallbacks}</b>
            </span>
          </div>
          {plan.warnings.length > 0 && (
            <div className="text-muted hh-focus-warnings">
              {plan.warnings.map((w, i) => (
                <div key={i}>· {w}</div>
              ))}
            </div>
          )}
          <div className="hh-focus-preview">
            {preview.map((d) => (
              <div key={d.nodeId} className={`hh-focus-row is-${d.priority}`}>
                <span className="hh-focus-tag">{PRIORITY_LABEL[d.priority]}</span>
                <span className="hh-focus-reason" title={d.reason}>
                  {d.reason}
                </span>
                <span className="text-muted hh-focus-anchor">
                  {d.sourceAnchors[0]?.page ? `第 ${d.sourceAnchors[0].page} 页` : '—'}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

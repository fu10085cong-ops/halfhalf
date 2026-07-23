/**
 * 场景排版面板（网格引擎）：无装饰、全功能。
 * - Markdown 纯 textarea；截图直接 Ctrl/Cmd+V 粘贴或点按钮上传，自动转 data URI 插入光标处
 * - 场景默认"自动推荐"，结果里显示推荐理由，用户可改选后重排
 * - 结果：内容统计 / 推荐场景 / 字号页数 / 各类警告 / PDF 内嵌预览 + 下载
 */
import { useRef, useState } from 'react';
import type { SceneId, SceneResult, BlockSuggestion, AiCompressResponse, AiCompressSummary } from '../../types';

/** BYOK 配置存本地浏览器（localStorage），不上传服务器；key 也只在本机 */
const AI_KEYS = { endpoint: 'hh.ai.endpoint', model: 'hh.ai.model', key: 'hh.ai.key' } as const;
const lsGet = (k: string, fallback: string) => {
  try {
    return localStorage.getItem(k) ?? fallback;
  } catch {
    return fallback;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 隐私模式等禁用 localStorage：静默降级为本会话内存 */
  }
};

/** 能否勾选应用：非跳过、改写与原文不同、且原子/公式安全网都过（"没变短"仍可由用户自行接受） */
function isApplicable(s: BlockSuggestion): boolean {
  return !s.skipped && s.suggested !== s.original && s.safety.atomsPreserved && s.safety.formulaClean;
}

/** 原文/建议两栏对照的通用样式（等宽、自动换行、各占一半、可纵向滚动） */
const diffCol: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  margin: 0,
  padding: 6,
  background: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 3,
  fontFamily: 'monospace',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 160,
  overflow: 'auto',
};

const SCENE_OPTIONS: { value: SceneId | 'auto'; label: string }[] = [
  { value: 'auto', label: '自动推荐' },
  { value: 'text-cram', label: '极限文本（背诵型大文本，samples 风格）' },
  { value: 'formula', label: '理科公式（公式不缩小，允许留白）' },
  { value: 'code', label: '代码密集（编程课，代码不折行）' },
  { value: 'visual', label: '图文混排（截图多的课）' },
  { value: 'balanced', label: '均衡默认' },
];

/** 与服务端 SUBJECT_RULES 的键一致；空串 = 不声明学科（只走力学层兜底） */
const SUBJECT_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '不指定' },
  { value: 'calculus', label: '微积分/高数' },
  { value: 'os', label: '操作系统' },
  { value: 'semiconductor', label: '半导体/电路' },
  { value: 'politics', label: '政治/毛概/马原' },
];

const DEFAULT_MD = `# 示例 —— 换成你的复习材料

## 一、基本概念

**进程**是资源分配的基本单位，**线程**是 CPU 调度的基本单位。

## 二、一个公式

有效访问时间 $EAT = (t_{TLB} + t_{mem}) \\times h + (t_{TLB} + 2t_{mem}) \\times (1-h)$。

$$
P(S): S \\leftarrow S-1;\\ \\text{if } S<0 \\text{ then block}
$$

## 三、图片

截图后直接在文本框里 Ctrl/Cmd+V 粘贴，或点「插入图片」按钮。
`;

function insertAtCursor(el: HTMLTextAreaElement, text: string): string {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  return el.value.slice(0, start) + text + el.value.slice(end);
}

function fileToMarkdownImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(`\n![截图](${reader.result as string})\n`);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function ScenePanel() {
  const [markdown, setMarkdown] = useState(DEFAULT_MD);
  const [targetPages, setTargetPages] = useState(1);
  const [scene, setScene] = useState<SceneId | 'auto'>('auto');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [debug, setDebug] = useState(false);
  const [allowReorder, setAllowReorder] = useState(false);
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SceneResult | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // —— AI 语义精简（BYOK）——
  const [showAi, setShowAi] = useState(false);
  const [aiEndpoint, setAiEndpoint] = useState(() =>
    lsGet(AI_KEYS.endpoint, 'https://api.openai.com/v1/chat/completions')
  );
  const [aiModel, setAiModel] = useState(() => lsGet(AI_KEYS.model, 'gpt-4o-mini'));
  const [aiKey, setAiKey] = useState(() => lsGet(AI_KEYS.key, ''));
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<BlockSuggestion[]>([]);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [aiSummary, setAiSummary] = useState<AiCompressSummary | null>(null);
  /** 提交精简时那份 markdown 的快照——range 偏移是相对它算的，回写也拼回它 */
  const [compressSource, setCompressSource] = useState('');

  const insertImageFile = async (file: File) => {
    const snippet = await fileToMarkdownImage(file);
    const el = textareaRef.current;
    setMarkdown(el ? insertAtCursor(el, snippet) : markdown + snippet);
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
    if (!item) return; // 普通文本粘贴走默认行为
    e.preventDefault();
    const file = item.getAsFile();
    if (file) await insertImageFile(file);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const resp = await fetch('/api/scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markdown,
          targetPages,
          scene,
          orientation,
          debug,
          allowReorder,
          subject: subject || undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      setResult(data as SceneResult);

      const pdfResp = await fetch(`/api/download/${(data as SceneResult).jobId}/pdf`);
      if (!pdfResp.ok) throw new Error('PDF 下载失败');
      const blob = await pdfResp.blob();
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      setPdfUrl(URL.createObjectURL(blob));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runCompress = async () => {
    if (!aiKey.trim()) {
      setAiError('请先填写 API Key（存本地浏览器，不上传服务器）');
      setShowAi(true);
      return;
    }
    setAiBusy(true);
    setAiError(null);
    setSuggestions([]);
    setAiSummary(null);
    const snapshot = markdown;
    setCompressSource(snapshot);
    try {
      const resp = await fetch('/api/ai/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markdown: snapshot,
          provider: {
            endpoint: aiEndpoint,
            model: aiModel,
            headers: { Authorization: `Bearer ${aiKey}` },
          },
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const res = data as AiCompressResponse;
      setSuggestions(res.suggestions);
      setAiSummary(res.summary);
      // 默认勾选安全网通过的块；其余（含"改写没变短"）留给用户自己判断
      const acc: Record<string, boolean> = {};
      res.suggestions.forEach((s) => {
        acc[s.blockId] = s.safety.ok;
      });
      setAccepted(acc);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(false);
    }
  };

  /** 把勾选的建议按 range 降序拼回快照（降序保证靠前的偏移不被前面的替换挪动） */
  const applyAccepted = () => {
    let out = compressSource;
    const toApply = suggestions
      .filter((s) => accepted[s.blockId] && isApplicable(s))
      .sort((a, b) => b.range.start - a.range.start);
    for (const s of toApply) {
      out = out.slice(0, s.range.start) + s.suggested + '\n\n' + out.slice(s.range.end);
    }
    setMarkdown(out);
    setSuggestions([]);
    setAccepted({});
    setAiSummary(null);
  };

  const acceptedCount = suggestions.filter((s) => accepted[s.blockId] && isApplicable(s)).length;

  const warn = result
    ? [
        // 多类刚性原子冲突时的取舍（如"图+公式"材料优先保了公式）——过去是静默失败
        ...(result.recommended.warning ? [result.recommended.warning] : []),
        ...result.warnings.formulaIssues.map(
          (i) => `公式错误 @「${i.blockTitle || i.blockId}」: ${i.message}`
        ),
        ...(result.warnings.oversized.length
          ? [`超高块（会被截断）: ${result.warnings.oversized.join(', ')}`]
          : []),
        ...(result.warnings.cramped.length
          ? [`宽内容缩到可读下限以下: ${result.warnings.cramped.join(', ')}`]
          : []),
        ...(!result.withinTargetPages
          ? ['最小字号仍超出目标页数，当前是尽力结果：请增加页数或精简内容']
          : []),
      ]
    : [];

  return (
    <div style={{ display: 'flex', gap: 12, height: '100%', padding: 12, boxSizing: 'border-box' }}>
      {/* 左：输入 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label>
            目标页数
            <input
              type="number"
              min={1}
              max={50}
              value={targetPages}
              onChange={(e) =>
                // 清空/非法输入兜底到 1，并钳在服务端校验的 1~50 区间内
                setTargetPages(Math.min(50, Math.max(1, parseInt(e.target.value) || 1)))
              }
              style={{ width: 56, marginLeft: 4 }}
            />
          </label>
          <label>
            场景
            <select
              value={scene}
              onChange={(e) => setScene(e.target.value as SceneId | 'auto')}
              style={{ marginLeft: 4, maxWidth: 260 }}
            >
              {SCENE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label title="声明这是什么课：政治类会自动允许乱序换密度，操作系统类会保护对比表不被缩小。识别建议只是提示，选了才生效">
            学科
            <select
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              style={{ marginLeft: 4 }}
            >
              {SUBJECT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            方向
            <select
              value={orientation}
              onChange={(e) => setOrientation(e.target.value as 'portrait' | 'landscape')}
              style={{ marginLeft: 4 }}
            >
              <option value="portrait">竖版</option>
              <option value="landscape">横版</option>
            </select>
          </label>
          <label title="在 PDF 上叠加 24 列网格线、每个块的方框和标签；不改变排版本身">
            <input
              type="checkbox"
              checked={debug}
              onChange={(e) => setDebug(e.target.checked)}
            />
            显示网格
          </label>
          <label title="要点式材料（如政治「一问几面」）顺序打乱几乎无代价，勾选后允许后面的内容填进前面页的空隙，更省纸。推导/教程类材料（数学、代码）不建议勾选">
            <input
              type="checkbox"
              checked={allowReorder}
              onChange={(e) => setAllowReorder(e.target.checked)}
            />
            允许乱序换密度
          </label>
          <button onClick={() => fileInputRef.current?.click()}>插入图片</button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await insertImageFile(f);
              e.target.value = '';
            }}
          />
          <button onClick={run} disabled={busy} style={{ fontWeight: 'bold' }}>
            {busy ? '排版中…' : '生成 PDF'}
          </button>
          <button
            onClick={runCompress}
            disabled={aiBusy}
            title="用你自己的 AI key 把叙述性文字改写成要点式，只出建议不自动改；公式/代码/表格/图片不会被动"
          >
            {aiBusy ? 'AI 精简中…' : '✨ AI 精简'}
          </button>
          <button onClick={() => setShowAi((v) => !v)} title="配置 AI 服务商端点 / 模型 / API Key（存本地浏览器）">
            AI 设置 {showAi ? '▴' : '▾'}
          </button>
        </div>

        {showAi && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
              padding: 8,
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: 4,
              fontSize: 13,
            }}
          >
            <label>
              端点
              <input
                type="text"
                value={aiEndpoint}
                onChange={(e) => {
                  setAiEndpoint(e.target.value);
                  lsSet(AI_KEYS.endpoint, e.target.value);
                }}
                style={{ marginLeft: 4, width: 320 }}
                placeholder="https://api.openai.com/v1/chat/completions"
              />
            </label>
            <label>
              模型
              <input
                type="text"
                value={aiModel}
                onChange={(e) => {
                  setAiModel(e.target.value);
                  lsSet(AI_KEYS.model, e.target.value);
                }}
                style={{ marginLeft: 4, width: 140 }}
                placeholder="gpt-4o-mini"
              />
            </label>
            <label>
              API Key
              <input
                type="password"
                value={aiKey}
                onChange={(e) => {
                  setAiKey(e.target.value);
                  lsSet(AI_KEYS.key, e.target.value);
                }}
                style={{ marginLeft: 4, width: 220 }}
                placeholder="sk-..."
              />
            </label>
            <span style={{ color: '#64748b' }}>
              仅 OpenAI 兼容格式；key 存本地浏览器，只在请求内存里过后端，不落服务器
            </span>
          </div>
        )}

        {aiError && <div style={{ color: '#b91c1c' }}>AI 出错：{aiError}</div>}

        {suggestions.length > 0 && (
          <div
            style={{
              border: '1px solid #cbd5e1',
              borderRadius: 4,
              padding: 8,
              maxHeight: '45%',
              overflow: 'auto',
              fontSize: 13,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 6,
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <b>AI 精简建议（只是建议，勾选后「应用」才写回文本框）</b>
              <span>
                <button onClick={applyAccepted} disabled={acceptedCount === 0} style={{ fontWeight: 'bold' }}>
                  应用选中（{acceptedCount} 块）
                </button>
                <button onClick={() => { setSuggestions([]); setAccepted({}); setAiSummary(null); }} style={{ marginLeft: 6 }}>
                  放弃
                </button>
              </span>
            </div>
            {aiSummary && (
              <div style={{ color: '#555', marginBottom: 6 }}>
                共 {aiSummary.total} 块 · 可精简 {aiSummary.compressed} 块 · 正文（全接受口径）
                {aiSummary.charsBefore}→{aiSummary.charsAfter} 字
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
                      <span style={{ color: '#15803d' }}>✅ 可精简</span>
                    ) : (
                      <span style={{ color: s.skipped ? '#64748b' : '#b45309' }}>
                        {s.skipped ? '—' : '⚠️'} {s.safety.reason}
                      </span>
                    )}
                  </label>
                  {applicable && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                      <pre style={diffCol}>{s.original}</pre>
                      <pre style={diffCol}>{s.suggested}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          onPaste={handlePaste}
          spellCheck={false}
          placeholder="粘贴 Markdown；截图可直接 Ctrl/Cmd+V"
          style={{
            flex: 1,
            fontFamily: 'monospace',
            fontSize: 13,
            padding: 8,
            resize: 'none',
            minHeight: 0,
          }}
        />

        {error && <div style={{ color: '#b91c1c' }}>出错：{error}</div>}

        {result && (
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <div>
              内容统计：正文≈{result.stats.charCount}字 · 独立公式{result.stats.displayFormulaCount} ·
              行内公式{result.stats.inlineFormulaCount} · 图片块{result.stats.imageBlockCount} · 表格
              {result.stats.tableCount} · 代码块{result.stats.codeBlockCount} · 共
              {result.stats.blockCount}块
            </div>
            <div>
              推荐场景：<b>{result.recommended.name}</b>
              {result.usedScene !== result.recommended.scene && (
                <>
                  ；实际使用：<b>{result.usedSceneName}</b>
                </>
              )}
            </div>
            {/* 学科识别建议 ≠ 声明：用户在下拉里选了才生效 */}
            {result.subjectSuggestion && result.subject !== result.subjectSuggestion.id && (
              <div style={{ color: '#1d4ed8' }}>
                💡 检测到可能是「{result.subjectSuggestion.name}」（命中：
                {result.subjectSuggestion.matchedAliases.slice(0, 3).join('、')}）——在学科下拉里选中后重新生成可启用对应规则
              </div>
            )}
            {/* rule trace：自动模式下参数就是这些规则算出来的（用户强制预设时仅供参考） */}
            {(result.trace ?? []).map((e, i) => (
              <div key={i} style={{ color: '#555' }}>
                {e.kind === 'hard' ? '🔒' : '·'} [{e.rule}] {e.detail}
              </div>
            ))}
            <div>
              结果：<b>{result.fontSize}pt</b> · {result.pages} 页 ·{' '}
              {result.withinTargetPages ? '达标 ✓' : '未达标'} · 搜索{' '}
              {result.history.map((h) => `${h.fontSize}pt→${h.pages}页`).join('，')}
            </div>
            {warn.map((w, i) => (
              <div key={i} style={{ color: '#b45309' }}>
                ⚠️ {w}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 右：PDF 预览 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        {pdfUrl ? (
          <>
            <div>
              <a href={pdfUrl} download={result?.fileName ?? 'halfhalf.pdf'}>
                下载 PDF{result ? `（${result.fileName}）` : ''}
              </a>
            </div>
            <iframe title="PDF 预览" src={pdfUrl} style={{ flex: 1, border: '1px solid #ccc' }} />
          </>
        ) : (
          <div
            style={{
              flex: 1,
              border: '1px dashed #ccc',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#888',
            }}
          >
            生成后在这里预览 PDF
          </div>
        )}
      </div>
    </div>
  );
}

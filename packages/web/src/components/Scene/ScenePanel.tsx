/**
 * 场景排版面板（网格引擎）：无装饰、全功能。
 * - Markdown 纯 textarea；截图直接 Ctrl/Cmd+V 粘贴或点按钮上传，自动转 data URI 插入光标处
 * - 场景默认"自动推荐"，结果里显示推荐理由，用户可改选后重排
 * - 结果：内容统计 / 推荐场景 / 字号页数 / 各类警告 / PDF 内嵌预览 + 下载
 */
import { useRef, useState } from 'react';
import type { SceneId, SceneResult } from '../../types';

const SCENE_OPTIONS: { value: SceneId | 'auto'; label: string }[] = [
  { value: 'auto', label: '自动推荐' },
  { value: 'text-cram', label: '极限文本（背诵型大文本，samples 风格）' },
  { value: 'formula', label: '理科公式（公式不缩小，允许留白）' },
  { value: 'code', label: '代码密集（编程课，代码不折行）' },
  { value: 'visual', label: '图文混排（截图多的课）' },
  { value: 'balanced', label: '均衡默认' },
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SceneResult | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        body: JSON.stringify({ markdown, targetPages, scene, orientation, debug, allowReorder }),
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
        </div>

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
              推荐场景：<b>{result.recommended.name}</b>（{result.recommended.reason}）
              {result.usedScene !== result.recommended.scene && (
                <>
                  ；实际使用：<b>{result.usedSceneName}</b>
                </>
              )}
            </div>
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

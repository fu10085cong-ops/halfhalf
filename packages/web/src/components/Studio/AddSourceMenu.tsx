/**
 * 「+ 添加材料」三入口：粘贴文本（内联区）/ 上传文件（异步 /api/import/jobs）/
 * 网页 URL（/api/import/url,正文抽取后落成生料卡）。
 * 拖文件进页面任意位置由外层 DocumentDropSurface 接住,不经此处。
 */
import { useRef, useState } from 'react';
import { apiFetch } from '../../api';
import { importDocument, unsupportedFileReason } from '../../lib/documentImport';
import { makeSource, useStudio } from './useStudioStore';

interface UploadingFile {
  name: string;
  progress: number;
  message: string;
  abort: () => void;
}

/** 与旧界面 attachmentSummary 同口径的一行文件概述（存进 source.meta.importSummary） */
function summarize(kind: 'docx' | 'pdf', s: {
  pageCount?: number;
  textPageCount?: number;
  characterCount: number;
  headingCount: number;
  paragraphCount: number;
  tableCount: number;
}): string {
  if (kind === 'pdf') {
    return ['PDF', `${s.pageCount ?? 0} 页`, `${s.characterCount.toLocaleString()} 字`].join(' · ');
  }
  return [
    'Word',
    `${s.headingCount} 个标题`,
    `${s.paragraphCount} 段`,
    s.tableCount ? `${s.tableCount} 个表格` : null,
    `${s.characterCount.toLocaleString()} 字`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function AddSourceMenu() {
  const { dispatch } = useStudio();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'paste' | 'url' | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [urlText, setUrlText] = useState('');
  const [fetching, setFetching] = useState(false);
  // 异步导入：进度 + 取消（大 PDF 的原页保真要十几秒，不能只显示「导入中…」）
  const [uploading, setUploading] = useState<UploadingFile[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const closeAll = () => {
    setOpen(false);
    setMode(null);
  };

  const addPaste = () => {
    if (!pasteText.trim()) return;
    dispatch({ type: 'add_source', source: makeSource({ kind: 'paste', raw: pasteText }) });
    setPasteText('');
    closeAll();
  };

  /** 网页 URL → /api/import/url（SSRF/大小/超时闸在服务端）→ 生料卡（可再走 AI 转换） */
  const addUrl = async () => {
    const url = urlText.trim();
    if (!url || fetching) return;
    setFetching(true);
    try {
      const resp = await apiFetch('/api/import/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        markdown?: string;
        summary?: { originalName: string; characterCount: number; sourceUrl?: string };
        error?: string;
      };
      if (!resp.ok || !data.markdown || !data.summary) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      dispatch({
        type: 'add_source',
        source: makeSource({
          kind: 'url',
          raw: data.markdown,
          title: data.summary.originalName,
          importSummary: [
            '网页',
            `${data.summary.characterCount.toLocaleString()} 字`,
            data.summary.sourceUrl ? new URL(data.summary.sourceUrl).hostname : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }),
      });
      setUrlText('');
      closeAll();
    } catch (e) {
      setErrors((cur) => [...cur, `网页抓取失败：${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setFetching(false);
    }
  };

  const handleFiles = async (files: File[]) => {
    closeAll();
    for (const file of files) {
      // 图片：转 data URI 直接就是合法 Markdown，免 AI（与旧界面「图片直接插入」同口径）
      if (file.type.startsWith('image/')) {
        try {
          const uri = await fileToDataUri(file);
          const md = `![${file.name}](${uri})`;
          dispatch({
            type: 'add_source',
            source: makeSource({
              kind: 'file',
              raw: md,
              markdown: md,
              status: 'converted',
              title: file.name,
              importSummary: `图片 · ${Math.round(file.size / 1024)} KB`,
            }),
          });
        } catch {
          setErrors((cur) => [...cur, `${file.name}：图片读取失败`]);
        }
        continue;
      }
      const unsupported = unsupportedFileReason(file.name);
      if (unsupported) {
        setErrors((cur) => [...cur, `${file.name}：${unsupported}`]);
        continue;
      }
      const controller = new AbortController();
      setUploading((cur) => [
        ...cur,
        { name: file.name, progress: 0, message: '已进入解析队列', abort: () => controller.abort() },
      ]);
      const outcome = await importDocument(file, {
        signal: controller.signal,
        onProgress: (progress) =>
          setUploading((cur) =>
            cur.map((item) =>
              item.name === file.name
                ? { ...item, progress: progress.progress, message: progress.message }
                : item
            )
          ),
      });
      setUploading((cur) => cur.filter((item) => item.name !== file.name));
      if (!outcome.ok) {
        // 用户自己按的取消不算错误，不往错误区堆红字
        if (!outcome.cancelled) setErrors((cur) => [...cur, `${file.name}：${outcome.error}`]);
        continue;
      }
      dispatch({
        type: 'add_source',
        source: makeSource({
          kind: 'file',
          raw: outcome.markdown,
          title: outcome.summary.originalName.replace(/\.(docx|pdf)$/i, ''),
          importSummary: summarize(outcome.summary.kind as 'docx' | 'pdf', outcome.summary),
        }),
      });
    }
  };

  return (
    <div className="hh-add-menu">
      <button type="button" className="btn btn-primary hh-add-trigger" onClick={() => setOpen((v) => !v)}>
        ＋ 添加材料
      </button>
      {open && mode === null && (
        <div className="hh-add-options">
          <button type="button" onClick={() => setMode('paste')}>
            📋 粘贴文本 <small>（课件/聊天记录/任意生料）</small>
          </button>
          <button type="button" onClick={() => inputRef.current?.click()}>
            📄 上传文件 <small>（.docx / 文字型 PDF / 图片）</small>
          </button>
          <button type="button" onClick={() => setMode('url')}>
            🔗 网页 URL <small>（抓取正文,动态渲染页可能抓不到）</small>
          </button>
        </div>
      )}
      {mode === 'paste' && (
        <div className="hh-paste-modal" style={{ marginTop: 8 }}>
          <textarea
            autoFocus
            rows={6}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="把原始材料粘到这里——不需要是 Markdown"
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button type="button" className="btn btn-primary" onClick={addPaste} disabled={!pasteText.trim()}>
              添加为材料
            </button>
            <button type="button" className="btn btn-secondary" onClick={closeAll}>
              取消
            </button>
          </div>
        </div>
      )}
      {mode === 'url' && (
        <div style={{ marginTop: 8 }}>
          <input
            autoFocus
            type="url"
            className="hh-url-input"
            value={urlText}
            onChange={(e) => setUrlText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addUrl();
            }}
            placeholder="https://…（公开网页;需登录/纯脚本渲染的页面请直接复制文字粘贴）"
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button type="button" className="btn btn-primary" onClick={() => void addUrl()} disabled={fetching || !urlText.trim()}>
              {fetching ? '抓取中…' : '抓取网页'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={closeAll} disabled={fetching}>
              取消
            </button>
          </div>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".docx,.pdf,image/*"
        hidden
        onChange={(e) => {
          void handleFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      {uploading.map((item) => (
        <div key={item.name} className="hh-upload-progress">
          <div className="hh-upload-line">
            <span className="text-muted" title={item.name}>
              {item.name} · {item.message}
            </span>
            <button type="button" className="text-muted" onClick={() => item.abort()}>
              取消
            </button>
          </div>
          <span
            className="hh-upload-bar"
            role="progressbar"
            aria-valuenow={item.progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <i style={{ width: `${item.progress}%` }} />
          </span>
        </div>
      ))}
      {errors.map((msg, i) => (
        <div key={i} className="hh-msg-err" style={{ fontSize: 12, marginTop: 6 }}>
          {msg}{' '}
          <button
            type="button"
            style={{ border: 'none', background: 'none', cursor: 'pointer' }}
            className="text-muted"
            onClick={() => setErrors((cur) => cur.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

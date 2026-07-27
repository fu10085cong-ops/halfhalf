/**
 * 「+ 添加材料」三入口：粘贴文本（内联弹层）/ 上传文件（走 /api/import/document）/
 * 网页 URL（二期，置灰）。拖文件进页面任意位置由外层 DocumentDropSurface 接住,不经此处。
 */
import { useRef, useState } from 'react';
import { importDocument, unsupportedFileReason } from '../../lib/documentImport';
import { makeSource, useStudio } from './useStudioStore';

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
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [uploading, setUploading] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const addPaste = () => {
    if (!pasteText.trim()) return;
    dispatch({ type: 'add_source', source: makeSource({ kind: 'paste', raw: pasteText }) });
    setPasteText('');
    setPasting(false);
    setOpen(false);
  };

  const handleFiles = async (files: File[]) => {
    setOpen(false);
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
      setUploading((cur) => [...cur, file.name]);
      const outcome = await importDocument(file);
      setUploading((cur) => cur.filter((n) => n !== file.name));
      if (!outcome.ok) {
        setErrors((cur) => [...cur, `${file.name}：${outcome.error}`]);
        continue;
      }
      dispatch({
        type: 'add_source',
        source: makeSource({
          kind: 'file',
          raw: outcome.markdown,
          title: outcome.summary.originalName.replace(/\.(docx|pdf)$/i, ''),
          importSummary: summarize(outcome.summary.kind, outcome.summary),
        }),
      });
    }
  };

  return (
    <div className="hh-add-menu">
      <button type="button" className="hh-add-trigger" onClick={() => setOpen((v) => !v)}>
        ＋ 添加材料
      </button>
      {open && !pasting && (
        <div className="hh-add-options">
          <button type="button" onClick={() => setPasting(true)}>
            📋 粘贴文本 <small>（课件/聊天记录/任意生料）</small>
          </button>
          <button type="button" onClick={() => inputRef.current?.click()}>
            📄 上传文件 <small>（.docx / 文字型 PDF / 图片）</small>
          </button>
          <button type="button" disabled title="即将支持">
            🔗 网页 URL <small>（即将支持）</small>
          </button>
        </div>
      )}
      {pasting && (
        <div className="hh-paste-modal" style={{ marginTop: 6 }}>
          <textarea
            autoFocus
            rows={6}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="把原始材料粘到这里——不需要是 Markdown"
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button type="button" className="hh-btn-primary" onClick={addPaste} disabled={!pasteText.trim()}>
              添加为材料
            </button>
            <button
              type="button"
              className="hh-btn-secondary"
              onClick={() => {
                setPasting(false);
                setOpen(false);
              }}
            >
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
      {uploading.map((name) => (
        <div key={name} style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
          ⏳ {name} 导入中…
        </div>
      ))}
      {errors.map((msg, i) => (
        <div key={i} style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>
          {msg}{' '}
          <button
            type="button"
            style={{ border: 'none', background: 'none', color: '#64748b' }}
            onClick={() => setErrors((cur) => cur.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

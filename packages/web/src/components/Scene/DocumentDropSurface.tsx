import { useRef, useState, type ReactNode } from 'react';
import { apiFetch } from '../../api';
import './DocumentDropSurface.css';

interface DocumentImportSummary {
  kind: 'docx' | 'pdf';
  originalName: string;
  sizeBytes: number;
  characterCount: number;
  paragraphCount: number;
  headingCount: number;
  tableCount: number;
  imageCount: number;
  pageCount?: number;
  textPageCount?: number;
  warnings: string[];
}

interface ImportResponse {
  markdown: string;
  summary: DocumentImportSummary;
}

interface ErrorResponse {
  code?: string;
  error?: string;
  details?: {
    pageCount?: number;
    textPageCount?: number;
    characterCount?: number;
  };
}

type AttachmentStatus = 'processing' | 'ready' | 'error';

interface Attachment {
  id: string;
  name: string;
  sizeBytes: number;
  status: AttachmentStatus;
  summary?: DocumentImportSummary;
  error?: string;
  errorCode?: string;
  pageCount?: number;
}

interface DocumentDropSurfaceProps {
  children: (uploadPanel: ReactNode) => ReactNode;
  onMarkdownImport: (markdown: string) => void;
  onImageImport: (file: File) => Promise<void>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentSummary(attachment: Attachment): string {
  if (attachment.status === 'processing') return '正在读取并分析内容…';
  if (attachment.status === 'error') {
    if (attachment.errorCode === 'OCR_REQUIRED') {
      return `扫描版 PDF${attachment.pageCount ? ` · ${attachment.pageCount} 页` : ''} · 需要 OCR`;
    }
    return '未导入';
  }

  const summary = attachment.summary;
  if (!summary) return `图片 · ${formatBytes(attachment.sizeBytes)} · 已插入原图`;
  if (summary.kind === 'pdf') {
    return [
      'PDF',
      `${summary.pageCount ?? 0} 页`,
      `${summary.textPageCount ?? 0} 页有文字`,
      `${summary.characterCount.toLocaleString()} 字`,
    ].join(' · ');
  }
  return [
    'Word',
    `${summary.headingCount} 个标题`,
    `${summary.paragraphCount} 段`,
    summary.tableCount ? `${summary.tableCount} 个表格` : null,
    summary.imageCount ? `${summary.imageCount} 张图片` : null,
    `${summary.characterCount.toLocaleString()} 字`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function newAttachmentId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function DocumentDropSurface({
  children,
  onMarkdownImport,
  onImageImport,
}: DocumentDropSurfaceProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const updateAttachment = (id: string, patch: Partial<Attachment>) => {
    setAttachments((current) =>
      current.map((attachment) =>
        attachment.id === id ? { ...attachment, ...patch } : attachment
      )
    );
  };

  const processFiles = async (files: File[]) => {
    for (const file of files) {
      const id = newAttachmentId();
      const attachment: Attachment = { id, name: file.name, sizeBytes: file.size, status: 'processing' };
      setAttachments((current) =>
        [attachment, ...current].slice(0, 8)
      );

      try {
        if (file.type.startsWith('image/')) {
          await onImageImport(file);
          updateAttachment(id, { status: 'ready' });
          continue;
        }

        if (!/\.(?:docx|pdf)$/i.test(file.name)) {
          throw new Error(
            /\.doc$/i.test(file.name)
              ? '旧版 .doc 请先在 Word 中“另存为 .docx”。'
              : '当前支持 .docx、可复制文字的 PDF 和常见图片。'
          );
        }

        const form = new FormData();
        form.append('file', file);
        // apiFetch：部署环境的访问口令头（x-access-code）；FormData 不能手动设 Content-Type
        const response = await apiFetch('/api/import/document', {
          method: 'POST',
          body: form,
        });
        const data = (await response.json()) as ImportResponse | ErrorResponse;
        if (!response.ok || !('markdown' in data)) {
          const failure = data as ErrorResponse;
          updateAttachment(id, {
            status: 'error',
            error: failure.error || `导入失败（HTTP ${response.status}）`,
            errorCode: failure.code,
            pageCount: failure.details?.pageCount,
          });
          continue;
        }

        onMarkdownImport(data.markdown);
        updateAttachment(id, {
          status: 'ready',
          name: data.summary.originalName,
          summary: data.summary,
        });
      } catch (error) {
        updateAttachment(id, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const uploadPanel = (
    <>
      <div className="hh-drop-guide">
        <span className="hh-drop-icon" aria-hidden="true">＋</span>
        <span>
          <b>把 Word、PDF 或图片拖到页面任意位置</b>
          <small>文档提取后进入上方「材料转换」，AI 整理成标准 Markdown 再排版；图片直接插入。文件仅在本机服务内存中处理</small>
        </span>
        <button type="button" onClick={() => inputRef.current?.click()}>
          选择文件
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".docx,.pdf,image/*"
          hidden
          onChange={(event) => {
            void processFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </div>

      {attachments.length > 0 && (
        <div className="hh-attachments" aria-live="polite">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className={`hh-attachment is-${attachment.status}`}
            >
              <span className="hh-file-type" aria-hidden="true">
                {attachment.status === 'processing'
                  ? '…'
                  : attachment.status === 'error'
                    ? '!'
                    : attachment.summary?.kind === 'pdf'
                      ? 'PDF'
                      : attachment.summary?.kind === 'docx'
                        ? 'W'
                        : 'IMG'}
              </span>
              <span className="hh-file-copy">
                <b title={attachment.name}>{attachment.name}</b>
                <small>{attachmentSummary(attachment)}</small>
                {attachment.error && <em>{attachment.error}</em>}
                {attachment.summary?.warnings[0] && (
                  <em className="hh-file-warning">提示：{attachment.summary.warnings[0]}</em>
                )}
              </span>
              <button
                type="button"
                className="hh-dismiss-file"
                title="隐藏这条概述（不会删除已导入的正文）"
                onClick={() =>
                  setAttachments((current) =>
                    current.filter((item) => item.id !== attachment.id)
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

    </>
  );

  return (
    <div
      className={`hh-drop-surface${dragging ? ' is-dragging' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void processFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="hh-drop-content">{children(uploadPanel)}</div>

      {dragging && (
        <div className="hh-drop-overlay">
          <b>松开即可导入</b>
          <span>Word / 文字型 PDF / 图片</span>
        </div>
      )}
    </div>
  );
}

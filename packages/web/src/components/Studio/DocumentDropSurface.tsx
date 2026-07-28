import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  fetchImportResult,
  importDocument,
  listRecentImports,
  unsupportedFileReason,
  type DocumentImportSummary,
  type ImportJobListEntry,
  type ImportProgress,
} from '../../lib/documentImport';
import './DocumentDropSurface.css';

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
  /** 异步解析的实时进度；ready/error 后不再更新 */
  progress?: ImportProgress;
  /** 取消这条正在跑的解析 */
  abort?: () => void;
}

interface DocumentDropSurfaceProps {
  children: (uploadPanel: ReactNode) => ReactNode;
  /** summary：Studio 用它取文件名/统计建材料卡；旧界面忽略即可 */
  onMarkdownImport: (markdown: string, summary?: DocumentImportSummary) => void;
  onImageImport: (file: File) => Promise<void>;
  /** 拖放引导的说明文案；缺省 = 旧界面「进入材料转换」口径，Studio 覆盖为「落成材料卡」 */
  guideHint?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentSummary(attachment: Attachment): string {
  if (attachment.status === 'processing') {
    return attachment.progress?.message || '正在读取并分析内容…';
  }
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
  guideHint,
}: DocumentDropSurfaceProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [recent, setRecent] = useState<ImportJobListEntry[]>([]);
  const [restoringJobId, setRestoringJobId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const updateAttachment = (id: string, patch: Partial<Attachment>) => {
    setAttachments((current) =>
      current.map((attachment) =>
        attachment.id === id ? { ...attachment, ...patch } : attachment
      )
    );
  };

  // 已完成的历史任务：刷新页面后还能把导入过的材料捞回来（列表不含页面图）
  const refreshRecent = useCallback(async () => {
    const jobs = await listRecentImports(5).catch(() => []);
    setRecent(jobs.filter((job) => job.status === 'completed'));
  }, []);

  useEffect(() => {
    void refreshRecent();
  }, [refreshRecent]);

  const processFiles = async (files: File[]) => {
    for (const file of files) {
      const id = newAttachmentId();
      const controller = new AbortController();
      const attachment: Attachment = {
        id,
        name: file.name,
        sizeBytes: file.size,
        status: 'processing',
        abort: () => controller.abort(),
      };
      setAttachments((current) =>
        [attachment, ...current].slice(0, 8)
      );

      try {
        if (file.type.startsWith('image/')) {
          await onImageImport(file);
          updateAttachment(id, { status: 'ready', abort: undefined });
          continue;
        }

        const unsupported = unsupportedFileReason(file.name);
        if (unsupported) throw new Error(unsupported);

        const outcome = await importDocument(file, {
          signal: controller.signal,
          onProgress: (progress) => updateAttachment(id, { progress }),
        });
        if (!outcome.ok) {
          updateAttachment(id, {
            status: 'error',
            error: outcome.error,
            errorCode: outcome.errorCode,
            pageCount: outcome.pageCount,
            abort: undefined,
          });
          continue;
        }

        onMarkdownImport(outcome.markdown, outcome.summary);
        updateAttachment(id, {
          status: 'ready',
          name: outcome.summary.originalName,
          summary: outcome.summary,
          abort: undefined,
        });
        void refreshRecent();
      } catch (error) {
        updateAttachment(id, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          abort: undefined,
        });
      }
    }
  };

  const restoreJob = async (job: ImportJobListEntry) => {
    setRestoringJobId(job.jobId);
    try {
      const outcome = await fetchImportResult(job.jobId);
      if (!outcome.ok) {
        setAttachments((current) =>
          [
            {
              id: newAttachmentId(),
              name: job.fileName,
              sizeBytes: job.sizeBytes,
              status: 'error' as AttachmentStatus,
              error: outcome.error,
              errorCode: outcome.errorCode,
            },
            ...current,
          ].slice(0, 8)
        );
        void refreshRecent();
        return;
      }
      onMarkdownImport(outcome.markdown, outcome.summary);
      setAttachments((current) =>
        [
          {
            id: newAttachmentId(),
            name: outcome.summary.originalName,
            sizeBytes: outcome.summary.sizeBytes,
            status: 'ready' as AttachmentStatus,
            summary: outcome.summary,
          },
          ...current,
        ].slice(0, 8)
      );
    } finally {
      setRestoringJobId(null);
    }
  };

  const uploadPanel = (
    <>
      <div className="hh-drop-guide">
        <span className="hh-drop-icon" aria-hidden="true">＋</span>
        <span>
          <b>把 Word、PDF 或图片拖到页面任意位置</b>
          <small>
            {guideHint ??
              '文档提取后进入上方「材料转换」，AI 整理成标准 Markdown 再排版；图片直接插入。文件仅在本机服务内存中处理'}
          </small>
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
                {attachment.status === 'processing' && (
                  <span
                    className="hh-file-progress"
                    role="progressbar"
                    aria-valuenow={attachment.progress?.progress ?? 0}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <i style={{ width: `${attachment.progress?.progress ?? 0}%` }} />
                  </span>
                )}
                {attachment.error && <em>{attachment.error}</em>}
                {attachment.summary?.warnings[0] && (
                  <em className="hh-file-warning">提示：{attachment.summary.warnings[0]}</em>
                )}
              </span>
              {attachment.status === 'processing' && attachment.abort ? (
                <button
                  type="button"
                  className="hh-dismiss-file"
                  title="取消这次解析"
                  onClick={() => attachment.abort?.()}
                >
                  取消
                </button>
              ) : (
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
              )}
            </div>
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <div className="hh-recent-imports">
          <small>最近导入（服务器保留期内可恢复）</small>
          <div className="hh-recent-list">
            {recent.map((job) => (
              <button
                key={job.jobId}
                type="button"
                title={`${job.fileName} · ${formatBytes(job.sizeBytes)}`}
                disabled={restoringJobId !== null}
                onClick={() => void restoreJob(job)}
              >
                {restoringJobId === job.jobId ? '恢复中…' : job.fileName}
              </button>
            ))}
          </div>
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

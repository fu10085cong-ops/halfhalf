/**
 * 文档导入（Word/PDF → Markdown 提取物）的共用请求层。
 * DocumentDropSurface（旧界面拖放）与 Studio 的添加材料共用；原始文件不落盘。
 *
 * 走异步任务：POST /api/import/jobs 立刻拿任务号，再轮询进度。
 * 大 PDF 的原页保真渲染动辄十几秒，同步端点会把 HTTP 连接挂死，
 * 也吃不到取消和「刷新页面后恢复」。同步端点仍在，但只留给外部脚本。
 */
import { apiFetch } from '../api';
// 质量报告的形状与 KnowledgeIR 共用一份定义,别再抄一遍(此前重复定义过两份)
import type { DocumentQualityReport } from '../types/restructure';

/** 联网检索采纳的来源，供前端展示与用户回查。 */
export interface ResearchSource {
  url: string;
  domain: string;
  title: string;
}

export interface DocumentImportSummary {
  kind: 'docx' | 'pdf' | 'url' | 'research';
  originalName: string;
  sizeBytes: number;
  characterCount: number;
  paragraphCount: number;
  headingCount: number;
  tableCount: number;
  imageCount: number;
  pageCount?: number;
  textPageCount?: number;
  sourceUrl?: string;
  quality?: DocumentQualityReport;
  /** 仅 kind === 'research' 时产出 */
  sources?: ResearchSource[];
  warnings: string[];
}

/** 服务端 KnowledgeIR 的结构在 packages/server/src/types/index.ts；这里只当不透明载荷透传。 */
export interface KnowledgeDocumentPayload {
  schemaVersion: number;
  fileHash: string;
  sourceOrder: 'strict' | 'soft';
  pageCount?: number;
  nodes: unknown[];
  quality?: DocumentQualityReport;
}

interface ImportedDocumentBody {
  markdown: string;
  summary: DocumentImportSummary;
  knowledge?: KnowledgeDocumentPayload;
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

export type ImportStage = 'queued' | 'extracting' | 'rendering' | 'finalizing' | 'completed';
export type ImportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ImportProgress {
  progress: number;
  stage: ImportStage;
  message: string;
}

export type ImportOutcome =
  | {
      ok: true;
      markdown: string;
      summary: DocumentImportSummary;
      knowledge?: KnowledgeDocumentPayload;
    }
  | { ok: false; error: string; errorCode?: string; pageCount?: number; cancelled?: boolean };

/** 最近任务列表用的轻量条目——刻意不含 result，页面图不进列表。 */
export interface ImportJobListEntry {
  jobId: string;
  status: ImportStatus;
  stage: ImportStage;
  progress: number;
  message: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  error?: { code: string; message: string };
}

interface JobSnapshot extends ImportJobListEntry {
  result?: ImportedDocumentBody;
}

export interface ImportOptions {
  onProgress?: (progress: ImportProgress) => void;
  /** 中断则 DELETE 任务，服务端停掉解析并释放并发额度 */
  signal?: AbortSignal;
}

/**
 * 保真页文档:含 HH_SOURCE_PAGE 页图(扫描/混合 PDF 的整页渲染兜底)。
 * 这类内容本体是图,与图片材料同一豁免口径(统一输入闸,FORMAT.md §7)——
 * 不经文本 AI 转换:巨型 base64 进提示词是 token 灾难,且 AI 会毁掉页图与严格序。
 */
export function hasSourcePages(markdown: string): boolean {
  return markdown.includes('![HH_SOURCE_PAGE_');
}

/** 上传前的本地闸：只认 .docx/.pdf（图片走各界面自己的通道） */
export function unsupportedFileReason(name: string): string | null {
  if (/\.(?:docx|pdf)$/i.test(name)) return null;
  return /\.doc$/i.test(name)
    ? '旧版 .doc 请先在 Word 中“另存为 .docx”。'
    : '当前支持 .docx、可复制文字的 PDF 和常见图片。';
}

function failureFrom(data: ErrorResponse, status: number): ImportOutcome {
  return {
    ok: false,
    error: data.error || `导入失败（HTTP ${status}）`,
    errorCode: data.code,
    pageCount: data.details?.pageCount,
  };
}

function outcomeFromSnapshot(snapshot: JobSnapshot): ImportOutcome {
  if (snapshot.status === 'completed' && snapshot.result) {
    return {
      ok: true,
      markdown: snapshot.result.markdown,
      summary: snapshot.result.summary,
      knowledge: snapshot.result.knowledge,
    };
  }
  if (snapshot.status === 'cancelled') {
    return { ok: false, error: snapshot.message || '已取消', cancelled: true };
  }
  return {
    ok: false,
    error: snapshot.error?.message || snapshot.message || '文档解析失败。',
    errorCode: snapshot.error?.code,
  };
}

/** 轮询间隔：前几秒问得勤（小文件秒回），之后退到 1.5s，避免长任务刷爆请求。 */
function pollDelay(elapsedMs: number): number {
  if (elapsedMs < 2_000) return 300;
  if (elapsedMs < 10_000) return 700;
  return 1_500;
}

const POLL_TIMEOUT_MS = 5 * 60 * 1000;

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

export async function importDocument(
  file: File,
  options: ImportOptions = {}
): Promise<ImportOutcome> {
  const form = new FormData();
  form.append('file', file);
  // apiFetch 带上访问口令与匿名客户端 ID；FormData 不能手动设 Content-Type
  const submitted = await apiFetch('/api/import/jobs', { method: 'POST', body: form });
  const created = await readJson<JobSnapshot & ErrorResponse>(submitted);
  if (!submitted.ok || !created.jobId) return failureFrom(created, submitted.status);
  return pollJob(created, options);
}

/**
 * 提交之后的公共部分：报首帧进度、挂取消、轮询到终态。
 * 上传文件与联网补洞共用——服务端本来就是同一条队列、同一组查询端点。
 */
async function pollJob(created: JobSnapshot, options: ImportOptions): Promise<ImportOutcome> {
  options.onProgress?.({
    progress: created.progress ?? 0,
    stage: created.stage ?? 'queued',
    message: created.message || '已进入解析队列',
  });

  const cancel = () => {
    void apiFetch(`/api/import/jobs/${created.jobId}`, { method: 'DELETE' }).catch(
      () => undefined
    );
  };
  if (options.signal?.aborted) {
    cancel();
    return { ok: false, error: '已取消', cancelled: true };
  }
  options.signal?.addEventListener('abort', cancel, { once: true });

  const startedAt = Date.now();
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, pollDelay(Date.now() - startedAt)));
      if (options.signal?.aborted) return { ok: false, error: '已取消', cancelled: true };

      const polled = await apiFetch(`/api/import/jobs/${created.jobId}`);
      if (!polled.ok) {
        const failure = await readJson<ErrorResponse>(polled);
        return failureFrom(failure, polled.status);
      }

      const snapshot = await readJson<JobSnapshot>(polled);
      options.onProgress?.({
        progress: snapshot.progress,
        stage: snapshot.stage,
        message: snapshot.message,
      });
      if (snapshot.status !== 'queued' && snapshot.status !== 'running') {
        return outcomeFromSnapshot(snapshot);
      }

      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        cancel();
        return {
          ok: false,
          error: '解析超过 5 分钟仍未完成，已取消。请拆分文件后重试。',
          errorCode: 'IMPORT_TIMEOUT',
        };
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}

/** 最近任务：用于刷新页面后把之前导入过的材料找回来。 */
export async function listRecentImports(limit = 5): Promise<ImportJobListEntry[]> {
  const response = await apiFetch(`/api/import/jobs?limit=${limit}`);
  if (!response.ok) return [];
  const data = await readJson<{ jobs?: ImportJobListEntry[] }>(response);
  return data.jobs ?? [];
}

/**
 * 提交一个不带文件的任务（联网补洞用），之后共用同一套轮询。
 * 研究任务与导入任务在服务端是同一条队列，所以查询端点也是同一个。
 */
export async function submitJsonJob(
  endpoint: string,
  body: unknown,
  options: ImportOptions = {}
): Promise<ImportOutcome> {
  const submitted = await apiFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const created = await readJson<JobSnapshot & ErrorResponse>(submitted);
  if (!submitted.ok || !created.jobId) return failureFrom(created, submitted.status);
  return pollJob(created, options);
}

/** 打开某条历史时才取完整结果（列表里没有 result，页面图不会预先下载）。 */
export async function fetchImportResult(jobId: string): Promise<ImportOutcome> {
  const response = await apiFetch(`/api/import/jobs/${jobId}`);
  if (!response.ok) {
    return failureFrom(await readJson<ErrorResponse>(response), response.status);
  }
  return outcomeFromSnapshot(await readJson<JobSnapshot>(response));
}

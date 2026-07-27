/**
 * 文档导入（Word/PDF → /api/import/document → Markdown 提取物）的共用请求层。
 * DocumentDropSurface（旧界面拖放）与 Studio 的添加材料共用；文件仅在服务内存中处理。
 */
import { apiFetch } from '../api';

export interface DocumentImportSummary {
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

interface ErrorResponse {
  code?: string;
  error?: string;
  details?: {
    pageCount?: number;
    textPageCount?: number;
    characterCount?: number;
  };
}

export type ImportOutcome =
  | { ok: true; markdown: string; summary: DocumentImportSummary }
  | { ok: false; error: string; errorCode?: string; pageCount?: number };

/** 上传前的本地闸：只认 .docx/.pdf（图片走各界面自己的通道） */
export function unsupportedFileReason(name: string): string | null {
  if (/\.(?:docx|pdf)$/i.test(name)) return null;
  return /\.doc$/i.test(name)
    ? '旧版 .doc 请先在 Word 中“另存为 .docx”。'
    : '当前支持 .docx、可复制文字的 PDF 和常见图片。';
}

export async function importDocument(file: File): Promise<ImportOutcome> {
  const form = new FormData();
  form.append('file', file);
  // apiFetch：部署环境的访问口令头（x-access-code）；FormData 不能手动设 Content-Type
  const response = await apiFetch('/api/import/document', {
    method: 'POST',
    body: form,
  });
  const data = (await response.json().catch(() => ({}))) as
    | { markdown: string; summary: DocumentImportSummary }
    | ErrorResponse;
  if (!response.ok || !('markdown' in data)) {
    const failure = data as ErrorResponse;
    return {
      ok: false,
      error: failure.error || `导入失败（HTTP ${response.status}）`,
      errorCode: failure.code,
      pageCount: failure.details?.pageCount,
    };
  }
  return { ok: true, markdown: data.markdown, summary: data.summary };
}

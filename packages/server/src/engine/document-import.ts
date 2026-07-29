import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createHash } from 'node:crypto';
import type { ImportedDocument } from '../types/index.js';
import {
  buildKnowledgeDocument,
  coalesceNativeBlocks,
  sanitizeExtractedText,
  type NativeSourceBlock,
} from './knowledge-ir.js';
import { renderPdfVisualAssets } from './pdf-visual-renderer.js';

export class DocumentImportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DocumentImportError';
  }
}

/** 异步导入任务的阶段进度；同步端点不传 onProgress 时全部为空操作。 */
export interface DocumentImportProgress {
  progress: number;
  stage: 'extracting' | 'rendering' | 'finalizing';
  message: string;
}

export interface DocumentImportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DocumentImportProgress) => void;
}

function throwIfImportAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Import cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function countCharacters(text: string): number {
  return text.replace(/\s/g, '').length;
}

export function countDocumentCharacters(markdown: string): number {
  return countCharacters(
    markdown.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+/g, '')
  );
}

export function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

/** HTML\u2192Markdown \u7684\u7edf\u4e00 turndown \u914d\u7f6e\uff08docx \u5bfc\u5165\u4e0e URL \u6293\u53d6\u5171\u7528\uff09 */
export function createTurndown(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  });
  turndown.use(gfm);
  turndown.addRule('removeEmptyLinks', {
    filter: (node) =>
      node.nodeName === 'A' &&
      !node.textContent?.trim() &&
      !(node as HTMLAnchorElement).querySelector('img'),
    replacement: () => '',
  });
  return turndown;
}

function promoteFirstTableRows(html: string): string {
  // Mammoth emits every Word table cell as <td>. GFM needs the first row to be
  // semantic headers, so promote that row before converting to Markdown.
  const promoted = html.replace(
    /(<table\b[^>]*>[\s\S]*?<tr\b[^>]*>)([\s\S]*?)(<\/tr>)/gi,
    (_match, open: string, cells: string, close: string) =>
      `${open}${cells.replace(/<(\/?)td\b/gi, '<$1th')}${close}`
  );
  return promoted.replace(
    /<(t[hd])([^>]*)>([\s\S]*?)<\/\1>/gi,
    (_match, tag: string, attrs: string, content: string) =>
      `<${tag}${attrs}>${content.replace(/<\/p>\s*<p>/gi, '<br>').replace(/<\/?p>/gi, '').trim()}</${tag}>`
  );
}

export async function importDocx(
  buffer: Buffer,
  originalName: string,
  sizeBytes: number,
  options: DocumentImportOptions = {}
): Promise<ImportedDocument> {
  if (buffer.length < 4 || buffer.subarray(0, 2).toString('ascii') !== 'PK') {
    throw new DocumentImportError(
      'INVALID_DOCX',
      '这个文件不是有效的 .docx。旧版 .doc 请先在 Word 中“另存为 .docx”。',
      400
    );
  }

  throwIfImportAborted(options.signal);
  options.onProgress?.({ progress: 20, stage: 'extracting', message: '正在读取 Word 结构…' });
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.dataUri,
      styleMap: [
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Subtitle'] => h2:fresh",
      ],
      includeDefaultStyleMap: true,
    }
  );

  throwIfImportAborted(options.signal);
  options.onProgress?.({ progress: 90, stage: 'finalizing', message: '正在生成可编辑文档…' });
  const turndown = createTurndown();
  const semanticHtml = promoteFirstTableRows(result.value);
  const markdown = normalizeMarkdown(turndown.turndown(semanticHtml));
  const imageCount = countMatches(result.value, /<img(?:\s|>)/gi);
  const characterCount = countDocumentCharacters(markdown);
  if (!markdown || (characterCount < 2 && imageCount === 0)) {
    throw new DocumentImportError(
      'EMPTY_DOCUMENT',
      'Word 文件中没有提取到正文。它可能只包含扫描图片、绘图对象或受保护内容。',
      422
    );
  }

  const messages = result.messages
    .filter((message) => message.type === 'warning')
    .map((message) => message.message)
    .slice(0, 3);
  const tableCount = countMatches(result.value, /<table(?:\s|>)/gi);
  const warnings = [
    ...messages,
    ...(tableCount > 0 ? ['复杂合并单元格会转成普通 Markdown 表格，请导入后核对。'] : []),
    ...(imageCount > 0 ? ['图片已随正文导入；浮动位置会改为按正文顺序排列。'] : []),
    'Word 的字体、页眉页脚和精确页位置不会照搬，HalfHalf 会按目标页数重新排版。',
  ];

  return {
    markdown,
    summary: {
      kind: 'docx',
      originalName,
      sizeBytes,
      characterCount,
      paragraphCount: countMatches(result.value, /<(?:p|li)(?:\s|>)/gi),
      headingCount: countMatches(result.value, /<h[1-6](?:\s|>)/gi),
      tableCount,
      imageCount,
      warnings,
    },
  };
}

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

function isPdfTextItem(item: unknown): item is PdfTextItem {
  if (!item || typeof item !== 'object') return false;
  const candidate = item as Partial<PdfTextItem>;
  return (
    typeof candidate.str === 'string' &&
    Array.isArray(candidate.transform) &&
    candidate.transform.length >= 6
  );
}

/**
 * 按行聚合 PDF 文本项，并记录归一化 bbox——KnowledgeIR 的页锚点靠它，
 * 页面视觉保真也靠它判断哪些区域该回退成原图。
 */
function extractPdfBlocks(
  items: PdfTextItem[],
  page: number,
  pageWidth: number,
  pageHeight: number
): NativeSourceBlock[] {
  const blocks: NativeSourceBlock[] = [];
  let line = '';
  let previousY: number | null = null;
  let previousEndX: number | null = null;
  let previousHeight = 10;
  let forceNewLine = false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const flush = () => {
    const clean = line.replace(/[ \t]+/g, ' ').trim();
    if (clean && Number.isFinite(minX) && Number.isFinite(minY)) {
      blocks.push({
        id: `p${page}-b${blocks.length + 1}`,
        page,
        text: clean,
        bbox: [
          minX / pageWidth,
          (pageHeight - maxY) / pageHeight,
          maxX / pageWidth,
          (pageHeight - minY) / pageHeight,
        ],
        fontHeight: previousHeight,
      });
    }
    line = '';
    previousEndX = null;
    minX = Infinity;
    minY = Infinity;
    maxX = -Infinity;
    maxY = -Infinity;
  };

  for (const item of items) {
    if (!item.str.trim()) {
      if (item.hasEOL) forceNewLine = true;
      continue;
    }

    const x = Number(item.transform[4]) || 0;
    const y = Number(item.transform[5]) || 0;
    const height = Math.abs(item.height || item.transform[3] || 10);
    const width = Math.max(0, item.width || 0);
    const changedLine =
      previousY !== null &&
      (forceNewLine ||
        Math.abs(y - previousY) > Math.max(2, Math.min(height, previousHeight) * 0.45));

    if (changedLine) flush();

    if (line && previousEndX !== null) {
      const gap = x - previousEndX;
      if (gap > Math.max(1.5, height * 0.18) && !/\s$/.test(line) && !/^\s/.test(item.str)) {
        line += ' ';
      }
    }

    line += item.str;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
    previousY = y;
    previousHeight = height;
    previousEndX = x + width;
    forceNewLine = item.hasEOL;
  }
  flush();
  return blocks;
}

function escapePdfMarkdown(line: string): string {
  if (/^\s*(?:#{1,6}|>|`{3})\s?/.test(line)) return `\\${line}`;
  return line;
}

/** 同一栏内：先上后下，同高再左右。0.004 是容差，避免同一行的微小基线差把顺序抖乱。 */
function sortTopThenLeft(a: NativeSourceBlock, b: NativeSourceBlock): number {
  const dy = a.bbox[1] - b.bbox[1];
  return Math.abs(dy) > 0.004 ? dy : a.bbox[0] - b.bbox[0];
}

/**
 * 只在几何毫无歧义时才认双栏：左右各至少 2 块、且这一段里每块都明确属于某一栏。
 * 居中的公式、图注、窄的单栏正文都不满足，照常按上下顺序读——
 * 宁可不改顺序，也不能把单栏文档打乱。
 */
function orderColumnSegment(blocks: NativeSourceBlock[]): NativeSourceBlock[] {
  const center = (b: NativeSourceBlock) => (b.bbox[0] + b.bbox[2]) / 2;
  const left = blocks.filter((b) => center(b) < 0.47);
  const right = blocks.filter((b) => center(b) > 0.53);
  if (left.length >= 2 && right.length >= 2 && left.length + right.length === blocks.length) {
    return [...left.sort(sortTopThenLeft), ...right.sort(sortTopThenLeft)];
  }
  return [...blocks].sort(sortTopThenLeft);
}

/**
 * 还原双栏讲义 PDF 的阅读顺序。pdf.js 按绘制顺序吐文字项，双栏排版下抽出来常是
 * 左一段右一段交错——直接拼成 Markdown 就是串行的乱码句子。
 *
 * 做法：宽度 ≥ 62% 页宽的块（通栏标题、跨栏图表）当分隔符，把页面切成若干段，
 * 每段内部单独判断是不是双栏。这样"通栏标题 → 双栏正文 → 通栏图 → 双栏正文"
 * 这种常见结构能逐段还原，而通栏元素本身留在原位。
 * （2026-07-29 从 feat/document-intelligence-complete 分支捞回）
 */
export function orderPdfBlocksForReading(blocks: NativeSourceBlock[]): NativeSourceBlock[] {
  const result: NativeSourceBlock[] = [];
  let segment: NativeSourceBlock[] = [];
  const flush = () => {
    if (segment.length > 0) result.push(...orderColumnSegment(segment));
    segment = [];
  };
  for (const block of [...blocks].sort(sortTopThenLeft)) {
    if (block.bbox[2] - block.bbox[0] >= 0.62) {
      flush();
      result.push(block);
    } else {
      segment.push(block);
    }
  }
  flush();
  return result;
}

/**
 * 通用质量策略：异常页稀疏时只对那几页做原图保真，其余保持可编辑；
 * 异常页密集时整篇切视觉模式，避免巨大原生文字和幻灯片图混排。
 * 这是按可测页面质量决策，不看文件名、学科或页数。
 */
export function selectPdfVisualPages(
  pages: Array<{ page: number; route: 'native' | 'hybrid' | 'ocr' }>,
  pageCount: number
): number[] {
  const fallback = pages
    .filter((page) => page.route !== 'native')
    .map((page) => page.page);
  if (fallback.length === 0) return [];

  const denseVisualDocument = fallback.length >= 3 && fallback.length / pageCount >= 0.4;
  return denseVisualDocument
    ? Array.from({ length: pageCount }, (_, index) => index + 1)
    : fallback;
}

type LoadedPdfDocument = Awaited<ReturnType<typeof getDocument>['promise']>;

async function importPdfDocumentWithVisuals(
  document: LoadedPdfDocument,
  buffer: Buffer,
  originalName: string,
  sizeBytes: number,
  options: DocumentImportOptions
): Promise<ImportedDocument> {
  const sourceBlocks: NativeSourceBlock[] = [];
  const blocksByPage = new Map<number, NativeSourceBlock[]>();
  let textPageCount = 0;

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    throwIfImportAborted(options.signal);
    const content = await page.getTextContent();
    const textItems = content.items.reduce<PdfTextItem[]>((items, item) => {
      if (isPdfTextItem(item)) items.push(item);
      return items;
    }, []);
    const viewport = page.getViewport({ scale: 1 });
    const pageBlocks = orderPdfBlocksForReading(
      coalesceNativeBlocks(extractPdfBlocks(textItems, pageNumber, viewport.width, viewport.height))
    );
    blocksByPage.set(pageNumber, pageBlocks);
    sourceBlocks.push(...pageBlocks);
    if (pageBlocks.some((block) => countCharacters(block.text) > 0)) textPageCount += 1;
    page.cleanup();
    options.onProgress?.({
      progress: 10 + Math.round((pageNumber / document.numPages) * 50),
      stage: 'extracting',
      message: `正在分析第 ${pageNumber}/${document.numPages} 页…`,
    });
  }

  const fileHash = createHash('sha256').update(buffer).digest('hex');
  const knowledge = buildKnowledgeDocument({
    fileHash,
    pageCount: document.numPages,
    blocks: sourceBlocks,
  });
  const nativeCharacterCount = sourceBlocks.reduce(
    (sum, block) => sum + countCharacters(block.text),
    0
  );
  const minimumUsefulText = Math.max(20, document.numPages * 6);
  if (textPageCount === 0 || nativeCharacterCount < minimumUsefulText) {
    throw new DocumentImportError(
      'OCR_REQUIRED',
      '这份 PDF 几乎没有可复制文字，判断为扫描件或图片型 PDF，需要 OCR 才能变成可编辑内容。',
      422,
      {
        pageCount: document.numPages,
        textPageCount,
        characterCount: nativeCharacterCount,
      }
    );
  }

  const qualityPages = knowledge.quality?.pages ?? [];
  const fallbackPageNumbers = qualityPages
    .filter((page) => page.route !== 'native')
    .map((page) => page.page);
  const visualPageNumbers = selectPdfVisualPages(qualityPages, document.numPages);
  const denseVisualMode =
    visualPageNumbers.length === document.numPages &&
    fallbackPageNumbers.length < document.numPages;
  options.onProgress?.({
    progress: 65,
    stage: 'rendering',
    message: '正在保真渲染公式和图表…',
  });
  throwIfImportAborted(options.signal);
  let visualAssets: Awaited<ReturnType<typeof renderPdfVisualAssets>> = [];
  try {
    visualAssets = await renderPdfVisualAssets(
      buffer,
      visualPageNumbers.map((page) => ({ id: `source-page-${page}`, page })),
      { scale: 1.35, quality: 72, signal: options.signal }
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DocumentImportError(
      'PDF_VISUAL_RENDER_FAILED',
      '检测到公式字体损坏，但原页图像保真 Worker 未能完成。已停止生成不完整 PDF。',
      503,
      { detail, visualPageNumbers, fallbackPageNumbers }
    );
  }

  const visualByPage = new Map(visualAssets.map((asset) => [asset.page, asset]));
  throwIfImportAborted(options.signal);
  options.onProgress?.({
    progress: 90,
    stage: 'finalizing',
    message: '正在组装可追溯内容…',
  });
  const pages: string[] = ['<!-- halfhalf:source-order=strict -->'];
  let paragraphCount = 0;
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const pageBlocks = blocksByPage.get(pageNumber) ?? [];
    const visual = visualByPage.get(pageNumber);
    if (visual) {
      pages.push(`## 第 ${pageNumber} 页\n\n![HH_SOURCE_PAGE_${pageNumber}](${visual.dataUri})`);
      paragraphCount += 1;
      continue;
    }

    const pageText = pageBlocks
      .map((block) => sanitizeExtractedText(block.text))
      .filter(Boolean)
      .map(escapePdfMarkdown)
      .join('\n');
    if (!pageText) continue;
    pages.push(`## 第 ${pageNumber} 页\n\n${pageText}`);
    paragraphCount += pageText.split(/\n{2,}/).filter((part) => part.trim()).length;
  }

  const markdown = normalizeMarkdown(pages.join('\n\n'));
  const characterCount = sourceBlocks.reduce(
    (sum, block) => sum + countCharacters(block.text.replace(/[\uE000-\uF8FF\uFFFD\u25A1]/gu, '')),
    0
  );
  const blankPages = document.numPages - textPageCount;
  const warnings = [
    ...(blankPages > 0 ? [`${blankPages} 页没有提取到文字，已保留原页图像。`] : []),
    ...(knowledge.quality?.hybridPageCount
      ? [
          `${knowledge.quality.hybridPageCount} 页含旧式公式/符号字体，已改用原页图像保真，不再输出重复占位符。`,
        ]
      : []),
    ...(knowledge.quality?.ocrPageCount
      ? [`${knowledge.quality.ocrPageCount} 页已保留原图，后续可在 OCR 完成后替换为可编辑节点。`]
      : []),
    denseVisualMode
      ? '异常页占比较高，版面层统一按原页保真；可编辑文字仍保留在知识节点层。'
      : '只对异常页使用原图保真；其余可信文字保持可编辑。',
    '每页已加入页码标题，方便发现漏页并追溯原文件。',
  ];

  return {
    markdown,
    summary: {
      kind: 'pdf',
      originalName,
      sizeBytes,
      characterCount,
      paragraphCount,
      headingCount: document.numPages,
      tableCount: 0,
      imageCount: visualAssets.length,
      pageCount: document.numPages,
      textPageCount,
      quality: knowledge.quality,
      warnings,
    },
    knowledge,
  };
}

export async function importTextPdf(
  buffer: Buffer,
  originalName: string,
  sizeBytes: number,
  options: DocumentImportOptions = {}
): Promise<ImportedDocument> {
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new DocumentImportError('INVALID_PDF', '这个文件不是有效的 PDF。', 400);
  }

  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  });

  try {
    const document = await loadingTask.promise;
    if (document.numPages > 300) {
      throw new DocumentImportError(
        'TOO_MANY_PAGES',
        `PDF 有 ${document.numPages} 页，超过单次导入上限 300 页。请先拆分文件。`,
        413,
        { pageCount: document.numPages }
      );
    }

    return await importPdfDocumentWithVisuals(document, buffer, originalName, sizeBytes, options);
  } catch (error) {
    if (error instanceof DocumentImportError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) {
      throw new DocumentImportError(
        'PASSWORD_PROTECTED',
        'PDF 有密码保护，请先解除密码后再导入。',
        422
      );
    }
    throw new DocumentImportError('PDF_PARSE_FAILED', `PDF 解析失败：${message}`, 422);
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ImportedDocument } from '../types/index.js';

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
  sizeBytes: number
): Promise<ImportedDocument> {
  if (buffer.length < 4 || buffer.subarray(0, 2).toString('ascii') !== 'PK') {
    throw new DocumentImportError(
      'INVALID_DOCX',
      '这个文件不是有效的 .docx。旧版 .doc 请先在 Word 中“另存为 .docx”。',
      400
    );
  }

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

function joinPdfTextItems(items: PdfTextItem[]): string {
  const lines: string[] = [];
  let line = '';
  let previousY: number | null = null;
  let previousEndX: number | null = null;
  let previousHeight = 10;
  let forceNewLine = false;

  const flush = () => {
    const clean = line.replace(/[ \t]+/g, ' ').trim();
    if (clean) lines.push(clean);
    line = '';
    previousEndX = null;
  };

  for (const item of items) {
    if (!item.str) {
      if (item.hasEOL) forceNewLine = true;
      continue;
    }

    const x = Number(item.transform[4]) || 0;
    const y = Number(item.transform[5]) || 0;
    const height = Math.abs(item.height || item.transform[3] || 10);
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
    previousY = y;
    previousHeight = height;
    previousEndX = x + Math.max(0, item.width || 0);
    forceNewLine = item.hasEOL;
  }
  flush();
  return lines.join('\n');
}

function escapePdfMarkdown(line: string): string {
  if (/^\s*(?:#{1,6}|>|`{3})\s?/.test(line)) return `\\${line}`;
  return line;
}

export async function importTextPdf(
  buffer: Buffer,
  originalName: string,
  sizeBytes: number
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

    const pages: string[] = [];
    let textPageCount = 0;
    let paragraphCount = 0;

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const textItems = content.items.reduce<PdfTextItem[]>((items, item) => {
        if (isPdfTextItem(item)) items.push(item);
        return items;
      }, []);
      const pageText = joinPdfTextItems(textItems);
      page.cleanup();

      if (countCharacters(pageText) > 0) {
        textPageCount += 1;
        paragraphCount += pageText.split(/\n{2,}/).filter((part) => part.trim()).length;
        pages.push(
          `## 第 ${pageNumber} 页\n\n${pageText
            .split('\n')
            .map(escapePdfMarkdown)
            .join('\n')}`
        );
      }
    }

    const markdown = normalizeMarkdown(pages.join('\n\n'));
    const characterCount = countCharacters(markdown.replace(/^## 第 \d+ 页$/gm, ''));
    const minimumUsefulText = Math.max(20, document.numPages * 6);

    if (characterCount < minimumUsefulText) {
      throw new DocumentImportError(
        'OCR_REQUIRED',
        '这份 PDF 几乎没有可复制文字，判断为扫描件或图片型 PDF，需要 OCR 才能变成可编辑内容。',
        422,
        {
          pageCount: document.numPages,
          textPageCount,
          characterCount,
        }
      );
    }

    const blankPages = document.numPages - textPageCount;
    const warnings = [
      ...(blankPages > 0
        ? [`${blankPages} 页没有提取到文字，可能是封面、空白页或扫描图片。`]
        : []),
      'PDF 只提取可复制文字；复杂表格、分栏、公式和图片的位置可能需要导入后核对。',
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
        imageCount: 0,
        pageCount: document.numPages,
        textPageCount,
        warnings,
      },
    };
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

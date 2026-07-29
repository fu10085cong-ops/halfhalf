import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  DocumentImportError,
  countDocumentCharacters,
  importDocx,
  importTextPdf,
  orderPdfBlocksForReading,
  selectPdfVisualPages,
} from '../../src/engine/document-import.js';

test('text PDF imports page text and reports page coverage', async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage();
  first.drawText('HalfHalf keeps source text editable.', { x: 50, y: 700, font });
  const second = pdf.addPage();
  second.drawText('Second page content is traceable.', { x: 50, y: 700, font });
  const bytes = Buffer.from(await pdf.save());

  const result = await importTextPdf(bytes, 'notes.pdf', bytes.length);

  assert.match(result.markdown, /## 第 1 页/);
  assert.match(result.markdown, /HalfHalf keeps source text editable/);
  assert.match(result.markdown, /## 第 2 页/);
  assert.equal(result.summary.pageCount, 2);
  assert.equal(result.summary.textPageCount, 2);
  assert.ok(result.summary.characterCount > 20);
});

test('image-only PDF returns OCR_REQUIRED instead of empty success', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bytes = Buffer.from(await pdf.save());

  await assert.rejects(
    () => importTextPdf(bytes, 'scan.pdf', bytes.length),
    (error: unknown) =>
      error instanceof DocumentImportError &&
      error.code === 'OCR_REQUIRED' &&
      error.details?.pageCount === 1
  );
});

test('invalid docx reports a useful format error', async () => {
  const bytes = Buffer.from('not a docx');

  await assert.rejects(
    () => importDocx(bytes, 'old.docx', bytes.length),
    (error: unknown) =>
      error instanceof DocumentImportError && error.code === 'INVALID_DOCX'
  );
});

test('Word character count excludes embedded image base64', () => {
  const markdown = '# Notes\n\n正文内容\n\n![](data:image/png;base64,QUFBQUFBQUFB)';

  assert.equal(countDocumentCharacters(markdown), countDocumentCharacters('# Notes\n\n正文内容\n\n![]()'));
});

test('visual fallback policy stays local for sparse defects', () => {
  const pages = Array.from({ length: 20 }, (_, index) => ({
    page: index + 1,
    route: index === 4 ? ('hybrid' as const) : ('native' as const),
  }));

  assert.deepEqual(selectPdfVisualPages(pages, 20), [5]);
});

test('visual fallback policy uses a coherent mode for dense defects', () => {
  const pages = Array.from({ length: 10 }, (_, index) => ({
    page: index + 1,
    route: index < 4 ? ('hybrid' as const) : ('native' as const),
  }));

  assert.deepEqual(
    selectPdfVisualPages(pages, 10),
    Array.from({ length: 10 }, (_, index) => index + 1)
  );
});

test('small mixed documents do not overreact to one or two visual pages', () => {
  const pages = [
    { page: 1, route: 'native' as const },
    { page: 2, route: 'hybrid' as const },
    { page: 3, route: 'ocr' as const },
  ];
  assert.deepEqual(selectPdfVisualPages(pages, 3), [2, 3]);
});

/**
 * 双栏阅读顺序（2026-07-29 从 feat/document-intelligence-complete 捞回）。
 * 两侧都要锁：双栏要还原，**单栏更要不被打乱**——这个机制的风险全在误判上。
 */
const blk = (id: string, x: number, y: number, w = 0.25) => ({
  id,
  page: 1,
  text: id,
  bbox: [x, y, x + w, y + 0.04] as [number, number, number, number],
  fontHeight: 10,
});

test('双栏讲义：左栏读完再读右栏', () => {
  const ordered = orderPdfBlocksForReading([
    blk('右上', 0.62, 0.2),
    blk('左下', 0.1, 0.5),
    blk('右下', 0.62, 0.5),
    blk('左上', 0.1, 0.2),
  ]);
  assert.deepEqual(ordered.map((b) => b.id), ['左上', '左下', '右上', '右下']);
});

test('单栏文档顺序原样保持——几何有歧义时绝不重排', () => {
  const ordered = orderPdfBlocksForReading([
    blk('三', 0.1, 0.6),
    blk('一', 0.1, 0.2),
    blk('二', 0.1, 0.4),
  ]);
  assert.deepEqual(ordered.map((b) => b.id), ['一', '二', '三']);
});

test('居中公式不够两栏，按上下读', () => {
  const ordered = orderPdfBlocksForReading([
    blk('正文左', 0.1, 0.2),
    blk('居中公式', 0.38, 0.35),
    blk('正文右', 0.62, 0.2),
  ]);
  assert.deepEqual(ordered.map((b) => b.id), ['正文左', '正文右', '居中公式']);
});

test('通栏标题当分隔符，前后两段各自判栏', () => {
  const ordered = orderPdfBlocksForReading([
    blk('段一左上', 0.1, 0.1),
    blk('段一右上', 0.62, 0.1),
    blk('段一左下', 0.1, 0.2),
    blk('段一右下', 0.62, 0.2),
    blk('通栏标题', 0.08, 0.4, 0.84),
    blk('段二左', 0.1, 0.5),
    blk('段二右', 0.62, 0.5),
  ]);
  assert.deepEqual(
    ordered.map((b) => b.id),
    ['段一左上', '段一左下', '段一右上', '段一右下', '通栏标题', '段二左', '段二右']
  );
});

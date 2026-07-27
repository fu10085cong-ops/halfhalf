import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  DocumentImportError,
  countDocumentCharacters,
  importDocx,
  importTextPdf,
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

import type {
  Columns,
  Density,
  IterationRecord,
  Margins,
  Orientation,
  PaperSize,
  ResolvedOrientation,
} from '../types/index.js';
import { SEARCH_CONFIG } from '../types/index.js';
import { markdownToHtml } from './md-to-html.js';
import {
  applyColumns,
  applyTypography,
  closeRenderContext,
  createRenderContext,
  renderPdfAndCountPages,
  type RenderContext,
} from './render-pdf.js';

export interface SearchParams {
  markdown: string;
  targetPages: number;
  paperSize: PaperSize;
  margins: Margins;
  density: Density;
  precision: number;
  /** 'auto' 会并行跑竖版和横版两轮完整搜索，取字号更大的结果 */
  orientation: Orientation;
  /** 'auto' 会在 1~maxAutoColumns 之间逐个试栏数，取字号更大的结果 */
  columns: Columns;
}

export interface SearchOutcome {
  optimalFontSize: number;
  actualPages: number;
  iterations: number;
  history: IterationRecord[];
  pdfBuffer: Buffer;
  orientation: ResolvedOrientation;
  columns: number;
}

/** 择优标准：字号大者优先；字号相同取页数少的；再相同取栏数少的（更简单/易读）；再相同取竖版 */
interface Ranked {
  fontSize: number;
  pages: number;
  columns: number;
  orientation: ResolvedOrientation;
}
function firstIsBetter(a: Ranked, b: Ranked): boolean {
  if (a.fontSize !== b.fontSize) return a.fontSize > b.fontSize;
  if (a.pages !== b.pages) return a.pages < b.pages;
  if (a.columns !== b.columns) return a.columns < b.columns;
  return a.orientation === 'portrait';
}

/**
 * 在给定纸张方向 + 栏数下，二分搜索满足「页数 <= targetPages」的最大字号。
 * 复用外部传入的渲染上下文（不重开浏览器、不重跑 Mermaid），只调整字号 CSS 变量后重新打印。
 */
async function binarySearchFontSize(
  ctx: RenderContext,
  params: SearchParams,
  orientation: ResolvedOrientation,
  columns: number,
  onProgress?: (record: IterationRecord) => void
): Promise<{ fontSize: number; pages: number; pdfBuffer: Buffer; iterations: number; history: IterationRecord[] }> {
  const renderParams = {
    paperSize: params.paperSize,
    margins: params.margins,
    density: params.density,
    orientation,
    columns,
  };

  const history: IterationRecord[] = [];
  let iterations = 0;
  let lo = SEARCH_CONFIG.minFontSize;
  let hi = SEARCH_CONFIG.maxFontSize;

  const probe = async (fontSize: number) => {
    await applyTypography(ctx, fontSize, params.density);
    const { pdfBuffer, pageCount } = await renderPdfAndCountPages(ctx, renderParams);
    iterations++;
    const record: IterationRecord = {
      fontSize,
      pages: pageCount,
      withinLimit: pageCount <= params.targetPages,
      timestamp: Date.now(),
      orientation,
      columns,
    };
    history.push(record);
    onProgress?.(record);
    return { pdfBuffer, pageCount };
  };

  // 先探测下限：如果最小字号仍然超页，说明内容过多，直接返回该最佳努力结果
  const lowProbe = await probe(lo);
  let best = { fontSize: lo, pages: lowProbe.pageCount, pdfBuffer: lowProbe.pdfBuffer };

  if (lowProbe.pageCount <= params.targetPages) {
    while (hi - lo > params.precision && iterations < SEARCH_CONFIG.maxIterations) {
      const mid = Math.round(((lo + hi) / 2) * 2) / 2; // 对齐到 0.5pt 网格
      const p = await probe(mid);
      if (p.pageCount <= params.targetPages) {
        best = { fontSize: mid, pages: p.pageCount, pdfBuffer: p.pdfBuffer };
        lo = mid;
      } else {
        hi = mid;
      }
    }
  }

  return { ...best, iterations, history };
}

/** 把 columns 请求参数解析成要实际尝试的栏数列表 */
function resolveColumnCandidates(columns: Columns): number[] {
  if (columns === 'auto') {
    return Array.from({ length: SEARCH_CONFIG.maxAutoColumns }, (_, i) => i + 1);
  }
  return [Math.max(1, Math.floor(columns))];
}

/**
 * 单一纸张方向下的搜索：建立一个渲染上下文，在其中逐个尝试候选栏数
 * （每个栏数只改一个 CSS 变量，不重开浏览器、不重跑 Mermaid），取字号最大的栏数为结果。
 */
async function searchForOrientation(
  params: SearchParams,
  orientation: ResolvedOrientation,
  onProgress?: (record: IterationRecord) => void
): Promise<SearchOutcome> {
  const { html } = await markdownToHtml(params.markdown);
  const columnCandidates = resolveColumnCandidates(params.columns);
  const ctx = await createRenderContext(html, {
    paperSize: params.paperSize,
    margins: params.margins,
    density: params.density,
    orientation,
    columns: columnCandidates[0],
  });

  const allHistory: IterationRecord[] = [];
  let totalIterations = 0;
  let best: { fontSize: number; pages: number; pdfBuffer: Buffer; columns: number } | null = null;

  try {
    for (const cols of columnCandidates) {
      await applyColumns(ctx, cols);
      const r = await binarySearchFontSize(ctx, params, orientation, cols, onProgress);
      totalIterations += r.iterations;
      allHistory.push(...r.history);

      const candidate = { fontSize: r.fontSize, pages: r.pages, pdfBuffer: r.pdfBuffer, columns: cols };
      if (
        best === null ||
        firstIsBetter(
          { ...candidate, orientation },
          { fontSize: best.fontSize, pages: best.pages, columns: best.columns, orientation }
        )
      ) {
        best = candidate;
      }
    }

    // columnCandidates 至少有一个元素，循环后 best 一定非空
    const chosen = best!;
    return {
      optimalFontSize: chosen.fontSize,
      actualPages: chosen.pages,
      iterations: totalIterations,
      history: allHistory,
      pdfBuffer: chosen.pdfBuffer,
      orientation,
      columns: chosen.columns,
    };
  } finally {
    await closeRenderContext(ctx);
  }
}

/**
 * 对外入口。方向和栏数都可以是固定值或 'auto'：
 * - orientation 固定 + columns 固定 → 一个渲染上下文，一轮二分搜索
 * - columns='auto' → 同一上下文内逐个试栏数（切栏数只改 CSS，不重开浏览器）
 * - orientation='auto' → 并行开两个上下文（竖/横），各自内部再按 columns 处理，最后择优
 * 择优标准：字号大者优先，其次页数少、栏数少、竖版。
 */
export async function searchOptimalFontSize(
  params: SearchParams,
  onProgress?: (record: IterationRecord) => void
): Promise<SearchOutcome> {
  if (params.orientation !== 'auto') {
    return searchForOrientation(params, params.orientation, onProgress);
  }

  const [portraitResult, landscapeResult] = await Promise.all([
    searchForOrientation(params, 'portrait', onProgress),
    searchForOrientation(params, 'landscape', onProgress),
  ]);

  return firstIsBetter(
    {
      fontSize: portraitResult.optimalFontSize,
      pages: portraitResult.actualPages,
      columns: portraitResult.columns,
      orientation: 'portrait',
    },
    {
      fontSize: landscapeResult.optimalFontSize,
      pages: landscapeResult.actualPages,
      columns: landscapeResult.columns,
      orientation: 'landscape',
    }
  )
    ? portraitResult
    : landscapeResult;
}

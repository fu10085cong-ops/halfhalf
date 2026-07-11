import type {
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
  applyTypography,
  closeRenderContext,
  createRenderContext,
  renderPdfAndCountPages,
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
}

export interface SearchOutcome {
  optimalFontSize: number;
  actualPages: number;
  iterations: number;
  history: IterationRecord[];
  pdfBuffer: Buffer;
  orientation: ResolvedOrientation;
}

/**
 * 单一纸张方向下，在 [minFontSize, maxFontSize] 区间二分搜索满足「页数 <= targetPages」的最大字号。
 * Mermaid 图表只在渲染上下文建立时预渲染一次，后续每轮迭代只调整 CSS 变量并重新打印，
 * 不重新加载页面、不重跑图表渲染。
 */
async function searchForOrientation(
  params: SearchParams & { orientation: ResolvedOrientation },
  onProgress?: (record: IterationRecord) => void
): Promise<SearchOutcome> {
  const { html } = await markdownToHtml(params.markdown);
  const ctx = await createRenderContext(html, {
    paperSize: params.paperSize,
    margins: params.margins,
    density: params.density,
    orientation: params.orientation,
  });

  const history: IterationRecord[] = [];
  let iterations = 0;

  try {
    let lo = SEARCH_CONFIG.minFontSize;
    let hi = SEARCH_CONFIG.maxFontSize;

    // 先探测下限：如果最小字号仍然超页，说明内容过多，直接返回该最佳努力结果
    await applyTypography(ctx, lo, params.density);
    const lowProbe = await renderPdfAndCountPages(ctx, params);
    iterations++;

    const lowRecord: IterationRecord = {
      fontSize: lo,
      pages: lowProbe.pageCount,
      withinLimit: lowProbe.pageCount <= params.targetPages,
      timestamp: Date.now(),
      orientation: params.orientation,
    };
    history.push(lowRecord);
    onProgress?.(lowRecord);

    let best = { fontSize: lo, pages: lowProbe.pageCount, pdfBuffer: lowProbe.pdfBuffer };

    if (lowProbe.pageCount <= params.targetPages) {
      while (hi - lo > params.precision && iterations < SEARCH_CONFIG.maxIterations) {
        const mid = Math.round(((lo + hi) / 2) * 2) / 2; // 对齐到 0.5pt 网格

        await applyTypography(ctx, mid, params.density);
        const probe = await renderPdfAndCountPages(ctx, params);
        iterations++;

        const withinLimit = probe.pageCount <= params.targetPages;
        const record: IterationRecord = {
          fontSize: mid,
          pages: probe.pageCount,
          withinLimit,
          timestamp: Date.now(),
          orientation: params.orientation,
        };
        history.push(record);
        onProgress?.(record);

        if (withinLimit) {
          best = { fontSize: mid, pages: probe.pageCount, pdfBuffer: probe.pdfBuffer };
          lo = mid;
        } else {
          hi = mid;
        }
      }
    }

    return {
      optimalFontSize: best.fontSize,
      actualPages: best.pages,
      iterations,
      history,
      pdfBuffer: best.pdfBuffer,
      orientation: params.orientation,
    };
  } finally {
    await closeRenderContext(ctx);
  }
}

/**
 * 对外入口。orientation 为 'portrait'/'landscape' 时只跑一轮单方向搜索（跟历史行为一致，
 * 不额外增加耗时）；为 'auto' 时并行跑两轮（竖版 + 横版），总耗时接近单轮，但会同时占用两个
 * Chromium 实例的内存/CPU。取 optimalFontSize 更大的结果——字号相同时优先选页数更少的，
 * 再相同则优先竖版（约定俗成的默认阅读方向）。
 */
export async function searchOptimalFontSize(
  params: SearchParams,
  onProgress?: (record: IterationRecord) => void
): Promise<SearchOutcome> {
  if (params.orientation !== 'auto') {
    return searchForOrientation({ ...params, orientation: params.orientation }, onProgress);
  }

  const [portraitResult, landscapeResult] = await Promise.all([
    searchForOrientation({ ...params, orientation: 'portrait' }, onProgress),
    searchForOrientation({ ...params, orientation: 'landscape' }, onProgress),
  ]);

  if (portraitResult.optimalFontSize !== landscapeResult.optimalFontSize) {
    return portraitResult.optimalFontSize > landscapeResult.optimalFontSize
      ? portraitResult
      : landscapeResult;
  }
  if (portraitResult.actualPages !== landscapeResult.actualPages) {
    return portraitResult.actualPages < landscapeResult.actualPages
      ? portraitResult
      : landscapeResult;
  }
  return portraitResult;
}

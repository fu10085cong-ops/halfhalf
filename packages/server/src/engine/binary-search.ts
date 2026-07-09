import type { Density, IterationRecord, Margins, PaperSize } from '../types/index.js';
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
}

export interface SearchOutcome {
  optimalFontSize: number;
  actualPages: number;
  iterations: number;
  history: IterationRecord[];
  pdfBuffer: Buffer;
}

/**
 * 在 [minFontSize, maxFontSize] 区间二分搜索满足「页数 <= targetPages」的最大字号。
 * Mermaid 图表只在渲染上下文建立时预渲染一次，后续每轮迭代只调整 CSS 变量并重新打印，
 * 不重新加载页面、不重跑图表渲染。
 */
export async function searchOptimalFontSize(
  params: SearchParams,
  onProgress?: (record: IterationRecord) => void
): Promise<SearchOutcome> {
  const { html } = await markdownToHtml(params.markdown);
  const ctx = await createRenderContext(html, {
    paperSize: params.paperSize,
    margins: params.margins,
    density: params.density,
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
    };
  } finally {
    await closeRenderContext(ctx);
  }
}

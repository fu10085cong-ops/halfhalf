/**
 * layout 引擎的优化循环：给定目标页数，二分搜索能塞进该页数的最大字号。
 * 这是卡片流版的"自动找最大字号"——和 binary-search.ts 之于连续多栏流是同一个角色，
 * 只是每次试探的代价是"测量所有块 + 贪心拼装"而非"整页渲染量页数"。
 *
 * 栏宽/内容区尺寸只由纸张/边距/栏数决定，与字号无关，循环外算一次即可；
 * 只有块高度随字号变，所以每轮必须重新 measure（测量是这里的主要开销）。
 */
import type {
  Density,
  Margins,
  PaperSize,
  ResolvedOrientation,
} from '../types/index.js';
import { PAPER_SIZES, SEARCH_CONFIG } from '../types/index.js';
import { chunkMarkdown, type ContentBlock } from './chunk-markdown.js';
import { markdownToHtml } from './md-to-html.js';
import { measureBlocks, PX_PER_MM, type BlockMeasurement } from './measure-blocks.js';
import { packBlocks, type PackStrategy, type Placement } from './pack-blocks.js';

export interface LayoutSearchParams {
  markdown: string;
  targetPages: number;
  paperSize: PaperSize;
  orientation: ResolvedOrientation;
  margins: Margins;
  columnsPerPage: number;
  columnGapMm: number;
  /** 块与块之间的纵向间距 mm */
  blockGapMm: number;
  density: Density;
  strategy: PackStrategy;
  /** 宽内容原子缩放的可读下限 */
  minScale: number;
  /** 字号搜索精度 pt，默认取 SEARCH_CONFIG.defaultPrecision */
  precision?: number;
  /** 本地图片解析基准目录，透传做 base64 内嵌 */
  imageBaseDir?: string;
}

export interface LayoutTrial {
  fontSize: number;
  pages: number;
  placements: Placement[];
  measurements: BlockMeasurement[];
  /** 高度超过单栏、会被纵向截断的块 */
  oversized: string[];
  /** 跨满整页仍需缩到可读下限以下的块 */
  cramped: string[];
}

export interface LayoutSearchOutcome {
  blocks: ContentBlock[];
  colWidthMm: number;
  best: LayoutTrial;
  /** 是否成功压进目标页数；false 表示最小字号仍超页，返回的是最佳努力结果 */
  withinTargetPages: boolean;
  history: { fontSize: number; pages: number }[];
}

export async function searchLayoutFontSize(
  params: LayoutSearchParams,
  onProgress?: (t: { fontSize: number; pages: number }) => void
): Promise<LayoutSearchOutcome> {
  const blocks = chunkMarkdown(params.markdown);

  // 与字号无关的几何：内容区高度、单栏宽度，循环外算一次
  const paper = PAPER_SIZES[params.paperSize];
  const dims =
    params.orientation === 'landscape'
      ? { width: paper.height, height: paper.width }
      : { width: paper.width, height: paper.height };
  const contentH = dims.height - params.margins.top - params.margins.bottom;
  const contentW = dims.width - params.margins.left - params.margins.right;
  const colWidthMm =
    (contentW - (params.columnsPerPage - 1) * params.columnGapMm) / params.columnsPerPage;

  const geo = {
    columnHeightMm: contentH,
    columnsPerPage: params.columnsPerPage,
    gapMm: params.blockGapMm,
  };

  // 块的 HTML 与字号无关（字号是 CSS 变量），循环外转一次，免得每轮试探重跑 KaTeX/Shiki
  const htmlById = new Map<string, string>();
  for (const b of blocks) {
    const { html } = await markdownToHtml(b.markdown, { imageBaseDir: params.imageBaseDir });
    htmlById.set(b.id, html);
  }

  const trial = async (fontSize: number): Promise<LayoutTrial> => {
    const measurements = await measureBlocks(blocks, {
      columnWidthPx: colWidthMm * PX_PER_MM,
      columnGapPx: params.columnGapMm * PX_PER_MM,
      maxSpan: params.columnsPerPage,
      fontSize,
      density: params.density,
      minScale: params.minScale,
      htmlById,
    });
    const packResult = packBlocks(
      measurements.map((m) => ({ id: m.id, heightMm: m.heightPx / PX_PER_MM, span: m.span })),
      geo,
      params.strategy
    );
    return {
      fontSize,
      pages: packResult.pages,
      placements: packResult.placements,
      measurements,
      oversized: packResult.oversized,
      cramped: measurements.filter((m) => m.belowMinScale).map((m) => m.id),
    };
  };

  // 精度钳到 0.5pt 网格步长：mid 吸附在 0.5 网格上，precision 比网格细时区间收缩到
  // 0.5 后 mid 会四舍五入成 hi——hi 侧探测失败时区间不再收缩，循环永不终止
  const precision = Math.max(params.precision ?? SEARCH_CONFIG.defaultPrecision, 0.5);
  const history: { fontSize: number; pages: number }[] = [];
  const record = (t: LayoutTrial) => {
    history.push({ fontSize: t.fontSize, pages: t.pages });
    onProgress?.({ fontSize: t.fontSize, pages: t.pages });
  };

  // 显式标 number：SEARCH_CONFIG 是 as const，直接赋值会把 lo/hi 锁成字面量类型
  let lo: number = SEARCH_CONFIG.minFontSize;
  let hi: number = SEARCH_CONFIG.maxFontSize;

  // 先探下限：最小字号仍超页 → 内容太多，返回最佳努力结果
  const lowTrial = await trial(lo);
  record(lowTrial);
  let best = lowTrial;

  if (lowTrial.pages <= params.targetPages) {
    // 先探上界：mid 吸附在网格上永远取不到 hi 本身，内容很少时 24pt 直接命中就不用再搜
    const highTrial = await trial(hi);
    record(highTrial);
    if (highTrial.pages <= params.targetPages) {
      best = highTrial;
    } else {
      // maxIterations 是防御性兜底（精度钳制后区间每轮至少缩 0.5pt，正常几轮就收敛）
      while (hi - lo > precision && history.length < SEARCH_CONFIG.maxIterations) {
        const mid = Math.round(((lo + hi) / 2) * 2) / 2; // 对齐 0.5pt
        const t = await trial(mid);
        record(t);
        if (t.pages <= params.targetPages) {
          best = t; // 页数达标，记录并尝试更大字号
          lo = mid;
        } else {
          hi = mid;
        }
      }
    }
  }

  return {
    blocks,
    colWidthMm,
    best,
    withinTargetPages: best.pages <= params.targetPages,
    history,
  };
}

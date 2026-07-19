/**
 * 网格版面模型（自动排版侧）：把内容区分割成 unitsX 列的细单位格，
 * 块宽吸附到标准宽度档位（默认 24 格制的 8/12/16/24 格 = 1/3、1/2、2/3、整页宽），
 * 块高向上取整到整数格，块与块之间的留白（gutter）烘进每个块的盒子里——
 * 每块内容盒四周各内缩 gutter/2，相邻块之间自然形成恒定 gutter，永不贴边排满。
 *
 * 与列模式（search-layout）的关系：同一套 分块→测量→skyline 拼装→渲染 流水线，
 * 只是几何从"3~4 根粗栏"细化成"24 根单位列"，宽度档位比栏数更多、对齐粒度更细，
 * 也是将来编辑器拖拽/缩放吸附的坐标系。skyline 的 span 直接复用为"跨几格"。
 *
 * 标准块尺寸（STANDARD_CARDS）在自动模式只用宽度档位 + 高度取整格；
 * 固定宽×高的卡片尺寸是编辑器的预设档 + AI 生成内容的长度目标，不在这里强套
 * ——把任意长度的内容硬塞进固定高度的卡片只会产生大量留白或溢出。
 */
import type { Density, Margins, PaperSize, ResolvedOrientation } from '../types/index.js';
import { PAPER_SIZES, SEARCH_CONFIG } from '../types/index.js';
import { chunkMarkdown, type ContentBlock } from './chunk-markdown.js';
import { markdownToHtml } from './md-to-html.js';
import {
  measureBlocks,
  PX_PER_MM,
  type BlockMeasurement,
  type SpanCandidate,
} from './measure-blocks.js';
import { packBlocks, type PackStrategy, type Placement } from './pack-blocks.js';
import { renderRectsPdf, type BlockRect, type RectRenderOptions } from './render-layout.js';

export interface GridSpec {
  /** 横向格数 */
  unitsX: number;
  /** 纵向格数（floor(内容区高/格边长)，仅供展示/编辑器；拼装按 mm 精确判断） */
  unitsY: number;
  /** 格边长 mm（= 内容区宽 / unitsX） */
  unitMm: number;
  /** 块与块之间的强制留白 mm（每块盒子四周各内缩一半）；默认 = 1 格宽 */
  gutterMm: number;
  /** 标准宽度档位（格数，升序） */
  widthTiers: number[];
}

export const GRID_DEFAULTS = {
  unitsX: 24,
  widthTiers: [6, 8, 12, 16, 24],
  /**
   * 文字块最大高宽比（高 / 内容盒宽）。没有它所有文字块都会吸到最窄档，
   * 输出千篇一律的等宽栏；有了它，"竹竿块"自动升宽档，小块留窄档，
   * 不同体量的章节呈现不同宽度的卡片。
   */
  maxAspect: 2,
} as const;

/**
 * 标准块尺寸预设（宽×高，单位：格）。编辑器的新建/吸附档位，
 * 也是 AI 压缩模块的内容长度目标（"一段内容约一张中卡"）。
 * 宽度取自 widthTiers（6/8/12/16/24 = 1/4、1/3、1/2、2/3、整页宽）。
 */
export const STANDARD_CARDS = [
  { name: '迷你卡', w: 6, h: 6 },
  { name: '窄长卡', w: 6, h: 12 },
  { name: '小卡', w: 8, h: 6 },
  { name: '高卡', w: 8, h: 16 },
  { name: '中卡', w: 12, h: 10 },
  { name: '大卡', w: 12, h: 16 },
  { name: '宽卡', w: 16, h: 10 },
  { name: '通栏', w: 24, h: 6 },
] as const;

export interface GridSearchParams {
  markdown: string;
  targetPages: number;
  paperSize: PaperSize;
  orientation: ResolvedOrientation;
  margins: Margins;
  density: Density;
  strategy: PackStrategy;
  /** 宽内容原子缩放的可读下限 */
  minScale: number;
  /** 横向格数，默认 24 */
  unitsX?: number;
  /** 强制留白 mm，默认 = 1 格宽（约 7.9mm）。默认版疏朗优先——这不是最终结果，
   *  后面还有"放大"（保持留白重搜字号）或编辑器人为微调；想更密显式传小值 */
  gutterMm?: number;
  /** 标准宽度档位（格数），默认 [6, 8, 12, 16, 24] */
  widthTiers?: number[];
  /** 文字块最大高宽比，默认 2；调大则更多块挤最窄档（趋向等宽栏），调小则更多块升宽档 */
  maxAspect?: number;
  /** 页内换位：块卡住时整页重排再试，默认 true（见 pack-blocks 头注释） */
  repack?: boolean;
  /** 跨页回填：牺牲跨页阅读顺序换密度，默认 false——顺序刚性弱（S2）才该开 */
  backfill?: boolean;
  /** 字号搜索精度 pt，默认取 SEARCH_CONFIG.defaultPrecision */
  precision?: number;
  /** 本地图片解析基准目录，透传做 base64 内嵌 */
  imageBaseDir?: string;
}

export interface GridTrial {
  fontSize: number;
  pages: number;
  /** column/span 的单位是"格"，yMm 已含 gutter（盒子坐标） */
  placements: Placement[];
  measurements: BlockMeasurement[];
  /** 盒子（含 gutter、取整格后）比整页还高、会被纵向截断的块 */
  oversized: string[];
  /** 跨满最大档位仍需缩到可读下限以下的块 */
  cramped: string[];
}

export interface GridSearchOutcome {
  blocks: ContentBlock[];
  grid: GridSpec;
  best: GridTrial;
  /** 是否成功压进目标页数；false 表示最小字号仍超页，返回的是最佳努力结果 */
  withinTargetPages: boolean;
  history: { fontSize: number; pages: number }[];
}

/** 由纸张/边距/参数算出网格几何（与字号无关，循环外算一次） */
export function resolveGrid(params: {
  paperSize: PaperSize;
  orientation: ResolvedOrientation;
  margins: Margins;
  unitsX?: number;
  gutterMm?: number;
  widthTiers?: number[];
}): { grid: GridSpec; contentHMm: number } {
  const paper = PAPER_SIZES[params.paperSize];
  const dims =
    params.orientation === 'landscape'
      ? { width: paper.height, height: paper.width }
      : { width: paper.width, height: paper.height };
  const contentW = dims.width - params.margins.left - params.margins.right;
  const contentH = dims.height - params.margins.top - params.margins.bottom;

  const unitsX = params.unitsX ?? GRID_DEFAULTS.unitsX;
  const unitMm = contentW / unitsX;
  const widthTiers = [...new Set(params.widthTiers ?? GRID_DEFAULTS.widthTiers)]
    .filter((t) => t >= 1 && t <= unitsX)
    .sort((a, b) => a - b);
  if (widthTiers.length === 0) throw new Error('resolveGrid: 没有可用的宽度档位');

  return {
    grid: {
      unitsX,
      unitsY: Math.floor(contentH / unitMm),
      unitMm,
      // 默认留白 = 1 格宽：留白本身也落在网格制上，前端看起来干净规整
      gutterMm: params.gutterMm ?? unitMm,
      widthTiers,
    },
    contentHMm: contentH,
  };
}

/** 盒子坐标（格/含 gutter） → 内容盒矩形（内缩 gutter/2），供渲染 */
export function gridPlacementsToRects(placements: Placement[], grid: GridSpec): BlockRect[] {
  return placements.map((pl) => ({
    id: pl.id,
    page: pl.page,
    xMm: pl.column * grid.unitMm + grid.gutterMm / 2,
    yMm: pl.yMm + grid.gutterMm / 2,
    wMm: pl.span * grid.unitMm - grid.gutterMm,
  }));
}

export async function renderGridPdf(
  blocks: ContentBlock[],
  placements: Placement[],
  grid: GridSpec,
  /** debug: 画出网格线 + 块方框 + 标签（叠加层不参与布局，排版与正式版一致） */
  opts: RectRenderOptions & { debug?: boolean }
): Promise<{ pdfBuffer: Buffer; pageCount: number }> {
  return renderRectsPdf(blocks, gridPlacementsToRects(placements, grid), {
    ...opts,
    overlay: opts.debug
      ? { unitMm: grid.unitMm, unitsX: grid.unitsX, gutterMm: grid.gutterMm }
      : undefined,
  });
}

export async function searchGridFontSize(
  params: GridSearchParams,
  onProgress?: (t: { fontSize: number; pages: number }) => void
): Promise<GridSearchOutcome> {
  const blocks = chunkMarkdown(params.markdown);
  const { grid, contentHMm } = resolveGrid(params);

  // 每个宽度档位的内容盒宽（盒子 = 档位格数 × 格宽，内容盒再减去 gutter）
  const candidates: SpanCandidate[] = grid.widthTiers.map((tier) => ({
    span: tier,
    widthPx: (tier * grid.unitMm - grid.gutterMm) * PX_PER_MM,
  }));

  const geo = { columnHeightMm: contentHMm, columnsPerPage: grid.unitsX, gapMm: 0 };

  // 块的 HTML 与字号无关（字号是 CSS 变量），循环外转一次，免得每轮试探重跑 KaTeX/Shiki
  const htmlById = new Map<string, string>();
  for (const b of blocks) {
    const { html } = await markdownToHtml(b.markdown, { imageBaseDir: params.imageBaseDir });
    htmlById.set(b.id, html);
  }

  const trial = async (fontSize: number): Promise<GridTrial> => {
    const measurements = await measureBlocks(blocks, {
      candidates,
      fontSize,
      density: params.density,
      minScale: params.minScale,
      maxAspect: params.maxAspect ?? GRID_DEFAULTS.maxAspect,
      htmlById,
    });
    // 盒高 = 内容高 + gutter，不再向上取整到格线：取整曾让每块最多白扔一格（约 8mm），
    // 实测 19 块的材料因此膨胀 16%、硬生生多出一页。取整只买到"块顶边落在格线上"的
    // 视觉对齐，而编辑器的拖拽吸附是拖拽时现算的、不依赖自动版预先取整——用页数换对齐
    // 不划算。横向仍吸标准宽度档（那里的对齐才有视觉价值）。
    const packResult = packBlocks(
      measurements.map((m) => ({
        id: m.id,
        heightMm: m.heightPx / PX_PER_MM + grid.gutterMm,
        span: m.span,
      })),
      geo,
      params.strategy,
      { repack: params.repack, backfill: params.backfill }
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
  const record = (t: GridTrial) => {
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
    grid,
    best,
    withinTargetPages: best.pages <= params.targetPages,
    history,
  };
}

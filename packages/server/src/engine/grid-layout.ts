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
 * 自动模式只用宽度档位 + 高度自然生长；固定宽×高的"标准卡"是编辑器的预设概念
 * （见 DESIGN.md ③ 层），不在这里强套——任意长度内容硬塞固定高度只会留白或溢出。
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
  /** Strict source documents never jump back into an earlier visual column hole. */
  monotonicOrder?: boolean;
  /** 本地图片解析基准目录，透传做 base64 内嵌 */
  imageBaseDir?: string;
  /**
   * 满版伸展（默认开）：搜索定稿后，把每块的字号向上多试几步（0.5pt 一步），
   * 让它"向下长"填掉正下方的空隙——柱底/块间的锯齿空白换成更大的字。
   * 不改变页数与搜索结果，只是块级的收尾放大；关掉即回老行为。
   */
  stretchFill?: boolean;
  /** 满版伸展的字号上限增量 pt，默认 2（太大则相邻块字号差异扎眼） */
  stretchCapPt?: number;
  /**
   * **末页**块的伸展上限增量 pt，默认 4。末页天然半空（内容量对不齐整页的量化余数），
   * 且下方多为页底空白而非邻块——字号差异的顾虑小、可回收的空隙大，给它更高的顶。
   */
  stretchLastCapPt?: number;
  /**
   * 硬疙瘩联合选档（默认开）：拼装时给"高过内容区 45% 的高大块"试更宽的档
   * （变矮好塞），页数严格变少才采用。治"大表格把 2 页顶成 3 页"的悬崖。
   * 关掉即回"每块先选档、拼装不商量"的老行为。
   */
  jointSpan?: boolean;
  /**
   * 洞驱动降档（默认开）：块按原档装不下当前页、页内换位也救不回时，试更窄的档
   * （可读性 scale ≥ minScale 的档才算数）塞进本页剩余缺口，而不是开新页留死洞。
   * 联合选档的对偶（那个升档救页数，这个降档填洞）。关掉即回老行为。
   */
  holeFill?: boolean;
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
  /** 满版伸展的结果：块 id → 放大后的字号与新高度（只含被放大的块） */
  stretched?: Record<string, StretchedBlock>;
}

export interface StretchedBlock {
  fontSize: number;
  heightPx: number;
}

/**
 * 每块"正下方的可伸展空隙"mm：块是顶端定位、向下生长，紧挨其下的块（同页且
 * 列区间重叠、顶边不高于本块底边）的顶边——或页底——就是它的伸展极限。
 * 空隙只属于上方的块（下方块不会上移），所以逐块独立伸展互不冲突。
 */
export function computeStretchGaps(
  placements: Placement[],
  boxHeightMm: Map<string, number>,
  contentHMm: number
): Map<string, number> {
  const gaps = new Map<string, number>();
  for (const p of placements) {
    const h = boxHeightMm.get(p.id);
    if (h === undefined) continue;
    const bottom = p.yMm + h;
    let limit = contentHMm;
    for (const q of placements) {
      if (q.id === p.id || q.page !== p.page) continue;
      const overlaps = q.column < p.column + p.span && p.column < q.column + q.span;
      if (overlaps && q.yMm >= bottom - 0.01 && q.yMm < limit) limit = q.yMm;
    }
    const gap = limit - bottom;
    if (gap > 0.5) gaps.set(p.id, gap);
  }
  return gaps;
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

  const unitsX = GRID_DEFAULTS.unitsX;
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
  /** debug: 画出网格线 + 块方框 + 标签（叠加层不参与布局，排版与正式版一致）
   *  stretched: 满版伸展的块级字号覆盖（搜索定稿后的收尾放大，见 searchGridFontSize） */
  opts: RectRenderOptions & { debug?: boolean; stretched?: Record<string, StretchedBlock> }
): Promise<{ pdfBuffer: Buffer; pageCount: number }> {
  const rects = gridPlacementsToRects(placements, grid).map((r) => {
    const s = opts.stretched?.[r.id];
    return s ? { ...r, fontSizePt: s.fontSize } : r;
  });
  return renderRectsPdf(blocks, rects, {
    ...opts,
    overlay: opts.debug
      ? { unitMm: grid.unitMm, unitsX: grid.unitsX, gutterMm: grid.gutterMm }
      : undefined,
  });
}

/**
 * 一个试探能否当"达标"候选：页数进目标只是必要条件，**内容完整**才算数——
 * 有超高截断块 = 有内容被页底裁掉，页数再漂亮也是假密度（真实判例：数据分析材料
 * 横版 12.5pt，工具对比表超页高、Tableau 一整行被裁，搜索却因"2 页达标"选了它）。
 * gateOversized=false 表示最小字号下就存在超高块（巨图等，字号救不了）——
 * 此时不再用超高一票否决，退回"尽力交付 + oversized 警告"的老行为。
 */
export function isAcceptableTrial(
  t: Pick<GridTrial, 'pages' | 'oversized'>,
  effectiveTarget: number,
  gateOversized: boolean
): boolean {
  return t.pages <= effectiveTarget && (!gateOversized || t.oversized.length === 0);
}

/**
 * 硬疙瘩联合选档：先按每块自选的档拼一次；若有"盒高超过内容区 45%"的高大文字块，
 * 逐个用测量白送的 bySpan 数据换更宽的档（变矮）重拼，**页数严格更少**才采用
 * （平页数不换——避免无谓地改变既有判例的版面）。变体必须 scale ≥ minScale，
 * 不许靠把内容缩到不可读来换宽档。零额外浏览器开销（逐档高度测量时本来就量过）。
 *
 * 真实判例（2026-07-26 数据分析材料，2 页目标）：13pt 时 257mm 的工具对比表
 * 把 2 页顶成 3 页；换 16 格（105mm）后 2 页/84%——字号悬崖从 12.5 推高到 13pt。
 */
export function packWithNuggetVariants(
  items: { id: string; heightMm: number; span: number }[],
  measurements: BlockMeasurement[],
  opts: {
    geo: { columnHeightMm: number; columnsPerPage: number; gapMm: number };
    gutterMm: number;
    strategy: PackStrategy;
    pack: { repack?: boolean; backfill?: boolean };
    minScale: number;
  }
): {
  result: ReturnType<typeof packBlocks>;
  overrides: { id: string; span: number; heightPx: number; scale: number; formulaScale: number }[];
} {
  const base = packBlocks(items, opts.geo, opts.strategy, opts.pack);
  const byId = new Map(measurements.map((m) => [m.id, m]));
  // 高大块按高度降序，最多试 6 个。不能只取前 2：真实判例里 190/187mm 的高散文块
  // 比 148mm 的表格更高、却换宽档救不了页数——真凶往往不是最高的那个。
  // 变体重拼是纯计算（微秒级），多试几个候选没有成本；上限 6 只是防御性护栏。
  const nuggets = items
    .filter((i) => i.heightMm > opts.geo.columnHeightMm * 0.45 && byId.get(i.id)?.bySpan)
    .sort((a, z) => z.heightMm - a.heightMm)
    .slice(0, 6);

  let best = base;
  let curItems = items;
  const overrides: ReturnType<typeof packWithNuggetVariants>['overrides'] = [];
  for (const nug of nuggets) {
    const bySpan = byId.get(nug.id)!.bySpan!;
    for (const [spanStr, v] of Object.entries(bySpan)) {
      const span = Number(spanStr);
      if (span <= nug.span || v.scale < opts.minScale) continue;
      const hMm = v.heightPx / PX_PER_MM + opts.gutterMm;
      const variant = items.map((i) => (i.id === nug.id ? { ...i, span, heightMm: hMm } : i));
      const res = packBlocks(variant, opts.geo, opts.strategy, opts.pack);
      if (res.pages < best.pages) {
        best = res;
        curItems = variant;
        overrides.length = 0;
        overrides.push({ id: nug.id, span, heightPx: v.heightPx, scale: v.scale, formulaScale: v.formulaScale });
      }
    }
  }

  // 深压缩救援（2026-07-26 站⑤⑥）：缩放跌破 0.75 舒适线的原子块（0.75 与 H3/H4
  // 可读下限同源），若存在"高度不增、缩放更清晰"的更宽档，试着换上——**页数不变差
  // 才采用**。判例：network-tables 端口表 span6=68mm 缩 0.55，而 span12=58mm 缩
  // 0.98，页面还空着 25%——"够得着预设可读线就取最窄"两头输。密排材料（poli-econ）
  // 升档会因面积膨胀顶出新页 → 这里自动被拒，密度取舍不受伤（曾在测量层做过同样的
  // 救援，上下文盲，poli-econ/data-analysis 字号各掉 0.5~1pt，已回滚）。逐块贪心
  // 链式采用，多个受害块（network-tables 有俩）都能救。
  const rescueTargets = curItems
    .map((i) => ({ item: i, m: byId.get(i.id) }))
    .filter(({ item, m }) => {
      const cur = m?.bySpan?.[item.span];
      return cur !== undefined && cur.scale < 0.75;
    });
  for (const { item, m } of rescueTargets) {
    const bySpan = m!.bySpan!;
    const cur = bySpan[item.span];
    // 支配性候选按 span 升序：宽度代价最小的先试（越宽越难塞回马赛克），
    // 采纳第一个"页数不变差"的——0.98 和 1.00 的清晰度肉眼无差，塞得回去才是硬道理
    const rescues = Object.entries(bySpan)
      .map(([s, v]) => ({ span: Number(s), v }))
      .filter(
        ({ span, v }) =>
          span > item.span && v.heightPx <= cur.heightPx + PX_PER_MM && v.scale > cur.scale + 0.02
      )
      .sort((a, z) => a.span - z.span);
    for (const { span, v } of rescues) {
      const hMm = v.heightPx / PX_PER_MM + opts.gutterMm;
      const variant = curItems.map((i) => (i.id === item.id ? { ...i, span, heightMm: hMm } : i));
      const res = packBlocks(variant, opts.geo, opts.strategy, opts.pack);
      if (res.pages <= best.pages) {
        best = res;
        curItems = variant;
        overrides.push({ id: item.id, span, heightPx: v.heightPx, scale: v.scale, formulaScale: v.formulaScale });
        break;
      }
    }
  }

  return { result: best, overrides };
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
    const items = measurements.map((m) => ({
      id: m.id,
      heightMm: m.heightPx / PX_PER_MM + grid.gutterMm,
      span: m.span,
      // 洞驱动降档的备选窄档：可读性达标（scale ≥ minScale）且不超页高的更窄档位，
      // span 降序（优先降得最少）。数据是测量白送的 bySpan，零额外开销。
      altSpans: params.holeFill !== false && m.bySpan
        ? Object.entries(m.bySpan)
            .map(([s, v]) => ({
              span: Number(s),
              heightMm: v.heightPx / PX_PER_MM + grid.gutterMm,
              scale: v.scale,
            }))
            .filter((a) => a.span < m.span && a.scale >= params.minScale && a.heightMm <= contentHMm)
            .sort((a, z) => z.span - a.span)
            .map(({ span, heightMm }) => ({ span, heightMm }))
        : undefined,
    }));
    const packOpts = { repack: params.repack, backfill: params.backfill, monotonicOrder: params.monotonicOrder };
    let packResult: ReturnType<typeof packBlocks>;
    let effMeasurements = measurements;
    if (params.jointSpan !== false) {
      const { result, overrides } = packWithNuggetVariants(items, measurements, {
        geo,
        gutterMm: grid.gutterMm,
        strategy: params.strategy,
        pack: packOpts,
        minScale: params.minScale,
      });
      packResult = result;
      if (overrides.length > 0) {
        // 换档/救援生效：下游（渲染宽度/伸展/诊断）必须看到换档后的真实档位与高度
        const ovById = new Map(overrides.map((o) => [o.id, o]));
        effMeasurements = measurements.map((m) => {
          const o = ovById.get(m.id);
          return o
            ? { ...m, span: o.span, heightPx: o.heightPx, scale: o.scale, formulaScale: o.formulaScale }
            : m;
        });
      }
    } else {
      packResult = packBlocks(items, geo, params.strategy, packOpts);
    }
    // 洞驱动降档生效：落位档与测量选档不同的块，把测量数据同步成实际档位
    // （渲染宽度/伸展/诊断都要看到降档后的真实高度与缩放）
    if (packResult.retiered.length > 0) {
      const retierBySpan = new Map(packResult.retiered.map((r) => [r.id, r.span]));
      effMeasurements = effMeasurements.map((m) => {
        const span = retierBySpan.get(m.id);
        const v = span !== undefined ? m.bySpan?.[span] : undefined;
        return v
          ? { ...m, span: span!, heightPx: v.heightPx, scale: v.scale, formulaScale: v.formulaScale }
          : m;
      });
    }
    return {
      fontSize,
      pages: packResult.pages,
      placements: packResult.placements,
      measurements: effMeasurements,
      oversized: packResult.oversized,
      cramped: effMeasurements.filter((m) => m.belowMinScale).map((m) => m.id),
    };
  };

  // 精度钳到 0.5pt 网格步长：mid 吸附在 0.5 网格上，precision 比网格细时区间收缩到
  // 0.5 后 mid 会四舍五入成 hi——hi 侧探测失败时区间不再收缩，循环永不终止
  const precision = Math.max(SEARCH_CONFIG.defaultPrecision, 0.5);
  const history: { fontSize: number; pages: number }[] = [];
  const record = (t: GridTrial) => {
    history.push({ fontSize: t.fontSize, pages: t.pages });
    onProgress?.({ fontSize: t.fontSize, pages: t.pages });
  };

  // 显式标 number：SEARCH_CONFIG 是 as const，直接赋值会把 lo/hi 锁成字面量类型
  let lo: number = SEARCH_CONFIG.minFontSize;
  let hi: number = SEARCH_CONFIG.maxFontSize;

  // 先探下限。最小字号仍超页 → 目标页数物理上达不到，但不能就地返回 6pt 的最差版本
  // （字最小、尾页还只剩一点内容堆成竹竿）——把目标改成"实际能做到的最少页数"，
  // 继续同一套二分，交出"最少页数下的最大字号"。真实判例：6572 字填目标 1 页，
  // 老行为返回 6pt/2 页（尾页 5/6 空），新行为返回 8pt/2 页（两页全满）。
  const lowTrial = await trial(lo);
  record(lowTrial);
  let best = lowTrial;
  const effectiveTarget = Math.max(params.targetPages, lowTrial.pages);
  // 块高随字号单调增长：最小字号都超高的块任何字号都救不了（gate 关掉、带警告尽力交付）；
  // 否则超高截断一律不许当达标结果——字号加大加出来的截断必须被二分收缩修掉
  const gateOversized = lowTrial.oversized.length === 0;

  {
    // 先探上界：mid 吸附在网格上永远取不到 hi 本身，内容很少时 24pt 直接命中就不用再搜
    const highTrial = await trial(hi);
    record(highTrial);
    if (isAcceptableTrial(highTrial, effectiveTarget, gateOversized)) {
      best = highTrial;
    } else {
      // maxIterations 是防御性兜底（精度钳制后区间每轮至少缩 0.5pt，正常几轮就收敛）
      while (hi - lo > precision && history.length < SEARCH_CONFIG.maxIterations) {
        const mid = Math.round(((lo + hi) / 2) * 2) / 2; // 对齐 0.5pt
        const t = await trial(mid);
        record(t);
        if (isAcceptableTrial(t, effectiveTarget, gateOversized)) {
          best = t; // 达标（页数 + 内容完整），记录并尝试更大字号
          lo = mid;
        } else {
          hi = mid;
        }
      }
    }
  }

  // —— 末页拉宽重排：末页是量化余数的倾倒场，16/12 混档常留整列死柱（真实判例：
  // cs 材料末页 五@16+六@12，右侧 8 格从头空到底，填充率 35%）。末页明显半空时，
  // 把末页文字块统一升到通栏档（bySpan 白送的数据，scale 须达标），按阅读序纵向
  // 堆叠，剩余高度均摊成块间呼吸位——每块正下方都有了自己的空隙，随后的满版伸展
  // 能逐块把它换成更大的字。只动末页、多页结果才动（单页结果 = 全文，不该整版重写）。
  if (params.stretchFill !== false && best.pages > 1) {
    const lastPage = best.pages - 1;
    const lastPls = best.placements.filter((p) => p.page === lastPage);
    const mById = new Map(best.measurements.map((m) => [m.id, m]));
    const pageAreaMm2 = grid.unitsX * grid.unitMm * contentHMm;
    const fillMm2 = lastPls.reduce((acc, p) => {
      const m = mById.get(p.id);
      return acc + (m ? p.span * grid.unitMm * (m.heightPx / PX_PER_MM + grid.gutterMm) : 0);
    }, 0);
    if (lastPls.length > 0 && fillMm2 / pageAreaMm2 < 0.6) {
      const orderIdx = new Map(blocks.map((b, i) => [b.id, i]));
      const stack = [...lastPls].sort((a, b) => (orderIdx.get(a.id) ?? 0) - (orderIdx.get(b.id) ?? 0));
      const widened: { id: string; hMm: number; m: BlockMeasurement }[] = [];
      let totalH = 0;
      let ok = true;
      for (const pl of stack) {
        const m = mById.get(pl.id);
        const v =
          m?.span === grid.unitsX ? m : m?.bySpan?.[grid.unitsX];
        if (!m || !v || v.scale < params.minScale) {
          ok = false; // 图片块（无 bySpan）或通栏下不可读：整页放弃，保持原版面
          break;
        }
        const hMm = v.heightPx / PX_PER_MM + grid.gutterMm;
        widened.push({ id: pl.id, hMm, m });
        totalH += hMm;
      }
      if (ok && totalH <= contentHMm) {
        const spacing = (contentHMm - totalH) / widened.length;
        let y = 0;
        const newPls = new Map<string, Placement>();
        for (const w of widened) {
          newPls.set(w.id, { id: w.id, page: lastPage, column: 0, span: grid.unitsX, yMm: y });
          y += w.hMm + spacing;
        }
        best = {
          ...best,
          placements: best.placements.map((p) => newPls.get(p.id) ?? p),
          measurements: best.measurements.map((m) => {
            const w = newPls.has(m.id) ? m.bySpan?.[grid.unitsX] : undefined;
            return w && m.span !== grid.unitsX
              ? { ...m, span: grid.unitsX, heightPx: w.heightPx, scale: w.scale, formulaScale: w.formulaScale }
              : m;
          }),
        };
      }
    }
  }

  // —— 满版伸展：定稿后逐块把字号向上多试几步，填掉各自正下方的空隙。
  // 只在最终结果上跑一次（每步一轮测量），不进二分循环；页数/搜索结果不受影响。
  if (params.stretchFill !== false) {
    const stretched: Record<string, StretchedBlock> = {};
    const boxH = new Map(
      best.measurements.map((m) => [m.id, m.heightPx / PX_PER_MM + grid.gutterMm])
    );
    const gaps = computeStretchGaps(best.placements, boxH, contentHMm);
    if (gaps.size > 0) {
      const capPt = params.stretchCapPt ?? 2;
      // 末页专属更高的顶：末页是量化余数的倾倒场（内容 1.6 页 → 第 2 页天然只有六成），
      // 块下方多是页底空白而非邻块，字号差异不扎眼、空隙又大，值得多爬几步
      const lastCapPt = Math.max(capPt, params.stretchLastCapPt ?? 4);
      const lastPage = best.pages - 1;
      const imageIds = new Set(blocks.filter((b) => b.kind === 'image').map((b) => b.id));
      const placeById = new Map(best.placements.map((p) => [p.id, p]));
      for (let step = 0.5; step <= lastCapPt + 1e-9; step += 0.5) {
        const ms = await measureBlocks(blocks, {
          candidates,
          fontSize: best.fontSize + step,
          density: params.density,
          minScale: params.minScale,
          maxAspect: params.maxAspect ?? GRID_DEFAULTS.maxAspect,
          htmlById,
        });
        for (const m of ms) {
          if (imageIds.has(m.id)) continue; // 图片高度与字号无关，放大无意义
          const gap = gaps.get(m.id);
          if (gap === undefined) continue;
          const pl = placeById.get(m.id);
          if (!pl) continue;
          if (step > (pl.page === lastPage ? lastCapPt : capPt) + 1e-9) continue;
          // 高度必须取"落位档"下的：大字号下选档可能漂走，但降档/换档/拉宽过的块
          // 落位档是定死的——bySpan 里有该档在这个字号下的高度（可读性也要复查：
          // 字号越大代码/表格在同宽下缩得越狠，scale 掉出下限就到顶了）
          const v = m.span === pl.span ? m : m.bySpan?.[pl.span];
          if (!v || v.scale < (params.minScale ?? 0)) continue;
          const newBox = v.heightPx / PX_PER_MM + grid.gutterMm;
          if (newBox <= (boxH.get(m.id) ?? 0) + gap) {
            stretched[m.id] = { fontSize: best.fontSize + step, heightPx: v.heightPx };
          }
        }
      }
    }
    if (Object.keys(stretched).length > 0) best = { ...best, stretched };
  }

  return {
    blocks,
    grid,
    best,
    // 达标与否仍按用户的原始目标判定，兜底搜索不改变"未达标"的事实
    withinTargetPages: best.pages <= params.targetPages,
    history,
  };
}

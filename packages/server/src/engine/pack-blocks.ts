/**
 * 贪心拼装（skyline 模型）：把已测量的内容块摆进"页 × 栏"的版面。
 * 纯算法，不碰浏览器——输入每块的 (高度, 跨栏数)，输出每块的 (页, 起始栏, y 偏移)。
 *
 * skyline：每页维护一条"每栏当前已用高度"的天际线。放一个跨 s 栏的块时，
 * 取它覆盖的 s 个相邻栏中最高的那条线作为落点 y，放下后把这 s 栏的线都推到 y+高度。
 * 跨栏块下方两侧留下的缝隙就是贪心的代价——留给用户在编辑器里手调（见 DESIGN.md）。
 *
 * 两种策略（对应模板的 packing 字段）：
 * - column-flow：按阅读顺序放，锚点从左往右推进，页放不下开新页。顺序完整。
 * - size-desc：按高度从大到小放，每块挑"落点最低"的位置（更密，顺序让位于密度）。
 */

export interface PackInput {
  id: string;
  heightMm: number;
  /** 跨栏数（来自测量：不横向溢出的最小栏数） */
  span: number;
}

export interface Placement {
  id: string;
  /** 0-based 页码 */
  page: number;
  /** 0-based 起始栏号 */
  column: number;
  /** 跨栏数 */
  span: number;
  /** 距内容区顶部的纵向偏移 mm */
  yMm: number;
}

export interface PackGeometry {
  /** 每栏可用高度 mm（= 纸张内容区高度） */
  columnHeightMm: number;
  /** 每页栏数 */
  columnsPerPage: number;
  /** 块与块之间的纵向间距 mm */
  gapMm: number;
}

export type PackStrategy = 'column-flow' | 'size-desc';

export interface PackResult {
  placements: Placement[];
  pages: number;
  /** 高度超过单栏可用高度、必然纵向截断的块 id（上层应提示或换更小字号重排） */
  oversized: string[];
  /** 每栏天际线高度 mm：usage[page][column]，用于诊断留白率 */
  usage: number[][];
}

/** 一页的天际线 */
type Sky = number[];

/** 跨 [anchor, anchor+span) 的落点：窗口内最高线（非零线要加块间距） */
function windowTop(sky: Sky, anchor: number, span: number, gapMm: number): number {
  let top = 0;
  for (let i = anchor; i < anchor + span; i++) {
    const t = sky[i] === 0 ? 0 : sky[i] + gapMm;
    if (t > top) top = t;
  }
  return top;
}

function settle(sky: Sky, anchor: number, span: number, y: number, h: number): void {
  for (let i = anchor; i < anchor + span; i++) sky[i] = y + h;
}

export function packBlocks(
  blocks: PackInput[],
  geo: PackGeometry,
  strategy: PackStrategy = 'column-flow'
): PackResult {
  const placements: Placement[] = [];
  const oversized: string[] = [];
  const pages: Sky[] = [];

  const newPage = (): Sky => {
    const sky = new Array(geo.columnsPerPage).fill(0);
    pages.push(sky);
    return sky;
  };

  const clampSpan = (s: number) => Math.max(1, Math.min(s, geo.columnsPerPage));

  if (strategy === 'column-flow') {
    let sky = newPage();

    for (const raw of blocks) {
      const span = clampSpan(raw.span);
      const maxAnchor = geo.columnsPerPage - span;

      if (raw.heightMm > geo.columnHeightMm) {
        // 超高块：新页顶部单独放，显式上报（纵向溢出被页容器裁掉，但不悄悄丢）
        oversized.push(raw.id);
        sky = newPage();
        placements.push({ id: raw.id, page: pages.length - 1, column: 0, span, yMm: 0 });
        settle(sky, 0, span, 0, raw.heightMm);
        continue;
      }

      // 每块都从最左栏开始找第一个装得下的锚点（leftmost-first-fit）：
      // 优先回填左侧栏的剩余空间，避免"右边放了一个块之后左边下半页永远空着"。
      // 阅读顺序由块的先后决定（先放的块整体靠左靠上），瀑布流布局下可接受。
      let placed = false;
      while (!placed) {
        for (let anchor = 0; anchor <= maxAnchor; anchor++) {
          const y = windowTop(sky, anchor, span, geo.gapMm);
          if (y + raw.heightMm <= geo.columnHeightMm) {
            placements.push({ id: raw.id, page: pages.length - 1, column: anchor, span, yMm: y });
            settle(sky, anchor, span, y, raw.heightMm);
            placed = true;
            break;
          }
        }
        if (!placed) sky = newPage();
      }
    }
  } else {
    // size-desc：从大到小放（高度×跨栏近似面积），每块在所有已有页里挑落点最低的位置
    const ordered = [...blocks].sort(
      (a, b) => b.heightMm * clampSpan(b.span) - a.heightMm * clampSpan(a.span)
    );

    for (const raw of ordered) {
      const span = clampSpan(raw.span);
      const maxAnchor = geo.columnsPerPage - span;

      if (raw.heightMm > geo.columnHeightMm) {
        oversized.push(raw.id);
        const sky = newPage();
        placements.push({ id: raw.id, page: pages.length - 1, column: 0, span, yMm: 0 });
        settle(sky, 0, span, 0, raw.heightMm);
        continue;
      }

      let best: { page: number; anchor: number; y: number } | null = null;
      for (let p = 0; p < pages.length; p++) {
        for (let anchor = 0; anchor <= maxAnchor; anchor++) {
          const y = windowTop(pages[p], anchor, span, geo.gapMm);
          if (y + raw.heightMm <= geo.columnHeightMm) {
            if (best === null || y < best.y) best = { page: p, anchor, y };
          }
        }
        if (best !== null) break; // 优先填满靠前的页
      }

      if (best === null) {
        const sky = newPage();
        placements.push({ id: raw.id, page: pages.length - 1, column: 0, span, yMm: 0 });
        settle(sky, 0, span, 0, raw.heightMm);
      } else {
        placements.push({ id: raw.id, page: best.page, column: best.anchor, span, yMm: best.y });
        settle(pages[best.page], best.anchor, span, best.y, raw.heightMm);
      }
    }
  }

  const usage = pages.map((sky) => sky.map((v) => Math.round(v * 10) / 10));
  return { placements, pages: pages.length, oversized, usage };
}

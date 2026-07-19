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
 *
 * column-flow 的两个补丁（治"宽块卡住→弃页→下一页空 2/3"）：
 * - repack 页内换位（默认开）：块放不下时把「本页已放的块 + 它」按高度/面积重排一遍，
 *   全装得下才接受。只在卡住时触发；"第 N 页装的是阅读顺序前缀"这一性质不变，
 *   变的只是页内位置——skyline 本就是马赛克，页内从不保证严格线性顺序。
 * - backfill 跨页回填（默认关）：开新页后，后续块仍先试旧页缺口。会让后面的块出现在
 *   前面的页上，牺牲跨页阅读顺序换密度——对应 RULES.md S2，顺序刚性弱才允许开。
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

export interface PackOptions {
  /** 页内换位（见文件头注释）。默认 true */
  repack?: boolean;
  /** 跨页回填（见文件头注释）。默认 false——顺序刚性弱（S2）才该开 */
  backfill?: boolean;
}

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
  strategy: PackStrategy = 'column-flow',
  opts: PackOptions = {}
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
    const repack = opts.repack ?? true;
    const backfill = opts.backfill ?? false;
    /** 每页已放的块（含钳过的 span），repack 重排时要整页重来 */
    const pageMembers: { id: string; heightMm: number; span: number }[][] = [];
    const byId = new Map<string, Placement>();
    let cur = -1;

    const openPage = (): number => {
      newPage();
      pageMembers.push([]);
      return (cur = pages.length - 1);
    };
    openPage();

    // 每块都从最左栏开始找第一个装得下的锚点（leftmost-first-fit）：
    // 优先回填左侧栏的剩余空间，避免"右边放了一个块之后左边下半页永远空着"。
    // 阅读顺序由块的先后决定（先放的块整体靠左靠上），瀑布流布局下可接受。
    const tryPlace = (m: { id: string; heightMm: number; span: number }, p: number): boolean => {
      const maxAnchor = geo.columnsPerPage - m.span;
      for (let anchor = 0; anchor <= maxAnchor; anchor++) {
        const y = windowTop(pages[p], anchor, m.span, geo.gapMm);
        if (y + m.heightMm <= geo.columnHeightMm) {
          const pl = { id: m.id, page: p, column: anchor, span: m.span, yMm: y };
          placements.push(pl);
          byId.set(m.id, pl);
          settle(pages[p], anchor, m.span, y, m.heightMm);
          pageMembers[p].push(m);
          return true;
        }
      }
      return false;
    };

    // 页内换位：本页成员 + 卡住块，按高度序/面积序各试一轮 first-fit，
    // 全装得下才接受（老成员只挪位置不换页，卡住块新增落位）
    const repackPage = (p: number, extra: { id: string; heightMm: number; span: number }): boolean => {
      const members = [...pageMembers[p], extra];
      const orderings = [
        [...members].sort((a, b) => b.heightMm - a.heightMm),
        [...members].sort((a, b) => b.heightMm * b.span - a.heightMm * a.span),
      ];
      for (const order of orderings) {
        const sky: Sky = new Array(geo.columnsPerPage).fill(0);
        const trial: { id: string; anchor: number; y: number }[] = [];
        let allFit = true;
        for (const m of order) {
          const maxAnchor = geo.columnsPerPage - m.span;
          let put = false;
          for (let anchor = 0; anchor <= maxAnchor; anchor++) {
            const y = windowTop(sky, anchor, m.span, geo.gapMm);
            if (y + m.heightMm <= geo.columnHeightMm) {
              settle(sky, anchor, m.span, y, m.heightMm);
              trial.push({ id: m.id, anchor, y });
              put = true;
              break;
            }
          }
          if (!put) {
            allFit = false;
            break;
          }
        }
        if (!allFit) continue;
        pages[p] = sky;
        for (const t of trial) {
          const existing = byId.get(t.id);
          if (existing) {
            existing.column = t.anchor;
            existing.yMm = t.y;
          } else {
            const pl = { id: extra.id, page: p, column: t.anchor, span: extra.span, yMm: t.y };
            placements.push(pl);
            byId.set(extra.id, pl);
          }
        }
        pageMembers[p].push(extra);
        return true;
      }
      return false;
    };

    for (const raw of blocks) {
      const span = clampSpan(raw.span);
      const m = { id: raw.id, heightMm: raw.heightMm, span };

      if (raw.heightMm > geo.columnHeightMm) {
        // 超高块：新页顶部单独放，显式上报（纵向溢出被页容器裁掉，但不悄悄丢）
        oversized.push(raw.id);
        const p = openPage();
        const pl = { id: raw.id, page: p, column: 0, span, yMm: 0 };
        placements.push(pl);
        byId.set(raw.id, pl);
        settle(pages[p], 0, span, 0, raw.heightMm);
        pageMembers[p].push(m);
        continue;
      }

      let placed = false;
      if (backfill) {
        for (let p = 0; p < pages.length && !placed; p++) placed = tryPlace(m, p);
      } else {
        placed = tryPlace(m, cur);
      }
      if (!placed && repack) placed = repackPage(cur, m);
      if (!placed) {
        openPage();
        tryPlace(m, cur); // 非超高块在空页必然放得下
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

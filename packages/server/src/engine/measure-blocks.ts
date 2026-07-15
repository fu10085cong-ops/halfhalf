/**
 * 测量：把每个内容块在若干候选宽度（1 栏、2 栏、…）下渲染，量出高度并检测横向溢出。
 * 输出每块"不溢出的最小跨栏数"及该宽度下的高度——这是贪心拼装的输入。
 *
 * 为什么要多宽度测量：表格/宽公式这类原子内容有内容决定的最小宽度，塞不进窄栏时
 * 会横向溢出淌进邻栏（绝对定位盒子不会自动通栏）。解法是给宽内容更宽的盒子（跨栏），
 * "该跨几栏"只能实测——渲染出来看在哪个宽度下不再溢出。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Density } from '../types/index.js';
import { DENSITY_CONFIG } from '../types/index.js';
import { withPage } from './browser-pool.js';
import { markdownToHtml } from './md-to-html.js';
import {
  KATEX_CSS_INLINED,
  PRINT_CSS,
  applyAtomScaling,
  renderMermaidDiagrams,
  uniquifyMermaidIds,
} from './render-assets.js';
import type { ContentBlock } from './chunk-markdown.js';

/** 浏览器默认 96 CSS px / 英寸，1 英寸 = 25.4mm */
export const PX_PER_MM = 96 / 25.4;

export interface BlockMeasurement {
  id: string;
  /** 选定的跨栏数（宽内容优先缩小塞窄栏，缩过头才升级跨栏；上限 maxSpan） */
  span: number;
  /** 在该跨栏宽度下（含原子缩放后）的渲染高度 px */
  heightPx: number;
  /**
   * 文字块：块内被缩放的原子中最小的缩放系数（1 = 无需缩放）。
   * 图片块：实际显示宽度 / 图片自然宽度（1 = 原尺寸显示，<1 = 被 max-width 压缩）。
   */
  scale: number;
  /** true = 即使跨满 maxSpan，内容仍需缩到 minScale 以下才能塞下（可读性存疑，上层应提示） */
  belowMinScale: boolean;
}

/** 一个候选宽度档位：span 是拼装坐标系里的跨度（栏数/格数），widthPx 是该档位的内容盒宽 */
export interface SpanCandidate {
  span: number;
  widthPx: number;
}

export interface MeasureOptions {
  /** 单栏宽度 px（列模式；给了 candidates 时忽略） */
  columnWidthPx?: number;
  /** 栏间距 px（列模式：span 栏宽 = span*colW + (span-1)*gap；给了 candidates 时忽略） */
  columnGapPx?: number;
  /** 最大候选跨栏数（列模式，一般 = 每页栏数；给了 candidates 时忽略） */
  maxSpan?: number;
  /**
   * 显式候选宽度列表（网格模式：标准宽度档位，如 24 格制的 8/12/16/24 格）。
   * 给了它就逐档测量并从中选档，否则按列模式由 columnWidthPx/columnGapPx/maxSpan 生成 1..maxSpan 档。
   */
  candidates?: SpanCandidate[];
  fontSize: number; // pt
  density: Density;
  /**
   * 原子缩放的可读下限（默认 0.5，密度优先）。选 span 的规则：优先"缩放不低于此值"的最小跨栏；
   * 都低于则取缩放系数最大的候选并打 belowMinScale 标。
   * 这是"密度 vs 可读性"的调节钮——想更密就调低，想公式更大就调高。
   */
  minScale?: number;
  /**
   * 文字块的最大高宽比（高 / 内容盒宽）。不给则不启用（列模式默认行为：永远取最窄）。
   * 给了之后，又高又瘦的"竹竿块"会升到更宽的档位，让不同体量的内容呈现不同宽度的卡片，
   * 而不是全部挤在最窄档里输出千篇一律的等宽栏。图片块不受此限制。
   */
  maxAspect?: number;
  /** 本地图片解析基准目录，透传给 markdownToHtml 做 base64 内嵌 */
  imageBaseDir?: string;
}

/**
 * 一次浏览器会话完成全部测量：每块 × 每个候选跨栏宽度渲染一个容器，统一读回
 * 高度和溢出标记，再在 Node 侧为每块挑最小可用跨栏。
 */
export async function measureBlocks(
  blocks: ContentBlock[],
  options: MeasureOptions
): Promise<BlockMeasurement[]> {
  const config = DENSITY_CONFIG[options.density];
  // 候选宽度档位：显式给了就用（网格模式），否则按列模式生成 1..maxSpan 档
  const candidates: SpanCandidate[] =
    options.candidates ??
    Array.from({ length: options.maxSpan ?? 0 }, (_, i) => ({
      span: i + 1,
      widthPx: (i + 1) * (options.columnWidthPx ?? 0) + i * (options.columnGapPx ?? 0),
    }));
  if (candidates.length === 0 || candidates.some((c) => !(c.widthPx > 0))) {
    throw new Error('measureBlocks: 需要 candidates，或 columnWidthPx/columnGapPx/maxSpan 组合');
  }
  const widthBySpan = new Map(candidates.map((c) => [c.span, c.widthPx]));
  const spanWidth = (span: number) => widthBySpan.get(span) ?? 0;

  // 每块渲染每个候选档位一个容器；mermaid 占位 id 按 (块, span) 唯一化避免撞车
  const containers: string[] = [];
  for (const b of blocks) {
    const { html } = await markdownToHtml(b.markdown, { imageBaseDir: options.imageBaseDir });
    for (const c of candidates) {
      const uniqueHtml = uniquifyMermaidIds(html, `${b.id}-s${c.span}`);
      containers.push(
        `<div class="hh-page measure-block" data-id="${b.id}" data-span="${c.span}" style="width:${c.widthPx}px">${uniqueHtml}</div>`
      );
    }
  }

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  ${KATEX_CSS_INLINED}
  :root {
    --content-width: ${candidates[0].widthPx}px;
    --content-height: 100000px;
    --font-size: ${options.fontSize}pt;
    --line-height: ${config.lineHeight};
    --paragraph-spacing: ${config.paragraphSpacing}em;
    --columns: 1;
    --column-gap: ${options.columnGapPx ?? 0}px;
  }
  body { margin: 0; }
  .measure-block { margin: 0 0 20px 0; }
  ${PRINT_CSS}
</style>
</head>
<body data-density="${options.density}">
${containers.join('\n')}
</body>
</html>`;

  const tempFilePath = path.join(os.tmpdir(), `halfhalf-measure-${randomUUID()}.html`);
  await fs.writeFile(tempFilePath, fullHtml, 'utf-8');

  try {
    return await withPage(async (page) => {
      await page.goto(`file://${tempFilePath}`, { waitUntil: 'domcontentloaded' });
      await renderMermaidDiagrams(page);
      // 图片解码完成后才有正确的布局高度/naturalWidth（base64 图通常同步就绪，这里兜底）
      await page.evaluate(() =>
        Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {})))
      );
      // 超宽原子（表格/公式）等比缩小到各自容器宽度，缩放系数记在 data-hh-scale 上
      await applyAtomScaling(page);

      const raw = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll<HTMLElement>('.measure-block'));
        return els.map((el) => {
          // 该容器内原子的最小缩放系数（没有被缩放的原子 = 1）
          let minScale = 1;
          for (const atom of el.querySelectorAll<HTMLElement>('[data-hh-scale]')) {
            const s = Number(atom.dataset.hhScale);
            if (s < minScale) minScale = s;
          }
          // 容器内图片的最大自然宽度（CSS px），图片块按它吸附宽度档位
          let imgNaturalW = 0;
          for (const img of el.querySelectorAll<HTMLImageElement>('img')) {
            if (img.naturalWidth > imgNaturalW) imgNaturalW = img.naturalWidth;
          }
          return {
            id: el.dataset.id || '',
            span: Number(el.dataset.span || 1),
            heightPx: el.getBoundingClientRect().height,
            scale: minScale,
            imgNaturalW,
          };
        });
      });

      // 每块挑"缩放不低于 minScale"的最小 span；都不达标则取缩放最温和（最大 scale）的候选
      const minScale = options.minScale ?? 0.5;
      const results: BlockMeasurement[] = [];
      for (const b of blocks) {
        const cands = raw.filter((r) => r.id === b.id).sort((a, z) => a.span - z.span);

        if (b.kind === 'image') {
          // 图片块：吸附到能按原尺寸放下的最小宽度档位；全都放不下则取最大档，
          // 由 CSS max-width:100% 等比缩小。允许 5% 的缩小容差——差几个百分点就
          // 跳到下一个大档只会让盒子两侧留大片空白，肉眼却看不出 5% 的缩小。
          // 截图常是 2x Retina（自然宽度虚高一倍），缩小通常仍可读，所以不打 belowMinScale。
          const naturalW = cands[0].imgNaturalW;
          const chosen =
            cands.find((c) => spanWidth(c.span) >= naturalW * 0.95) ?? cands[cands.length - 1];
          results.push({
            id: b.id,
            span: chosen.span,
            heightPx: chosen.heightPx,
            scale: Math.min(1, spanWidth(chosen.span) / Math.max(naturalW, 1)),
            belowMinScale: false,
          });
          continue;
        }

        // 可读性达标的候选（按 span 升序）；再按最大高宽比筛掉"竹竿块"
        const fits = cands.filter((c) => c.scale >= minScale);
        const shapely =
          options.maxAspect === undefined
            ? fits[0]
            : fits.find((c) => c.heightPx <= options.maxAspect! * spanWidth(c.span)) ??
              fits[fits.length - 1];
        const chosen =
          shapely ?? cands.reduce((best, c) => (c.scale > best.scale ? c : best), cands[0]);
        results.push({
          id: b.id,
          span: chosen.span,
          heightPx: chosen.heightPx,
          scale: chosen.scale,
          belowMinScale: fits.length === 0,
        });
      }
      return results;
    });
  } finally {
    await fs.unlink(tempFilePath).catch(() => {});
  }
}

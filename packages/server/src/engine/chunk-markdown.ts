/**
 * 分块：把一份 Markdown 按标题切成若干"内容块"，作为 layout 引擎（测量 → 贪心拼装）的输入。
 *
 * 规则（v1，按标题切）：
 * - 遇到层级 <= splitLevel 的标题（默认 2，即 # 和 ##）就开一个新块；
 *   更深的标题（###+）留在当前块内，以保留主题分组。
 * - 第一个分块标题之前的内容（通常是文档大标题 + 引言）单独成一个"前言块"。
 * - 围栏代码块（``` 包裹）内部的 # 行不算标题，避免把代码注释误判为章节。
 * - 独立成段的图片（一行只有 ![alt](src)）拆成自己的图片块——产品模型里截图就是
 *   独立内容块，拆出来才能按图片的自然宽度单独选跨栏、在编辑器里单独拖动。
 *   图片后面的剩余文字接一个"续块"（不带标题行）。
 */

export interface ContentBlock {
  id: string;
  /** 内容类型：正文块 or 独立图片块（一行只有一张图的段落） */
  kind: 'text' | 'image';
  /** 该块起始标题的层级；前言块/图片块/续块没有标题行，记为 0 */
  level: number;
  /** 该块起始标题的纯文本；图片块用 alt 文本；前言块为空串 */
  title: string;
  /** 该块的原始 Markdown 片段（含起始标题行） */
  markdown: string;
}

const ATX_HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
/** 一行只有一张图：![alt](src) 或带 title 的 ![alt](src "t")，允许首尾空白 */
const STANDALONE_IMAGE = /^\s*!\[([^\]]*)\]\(\S+(?:\s+"[^"]*")?\)\s*$/;

export interface ChunkOptions {
  /** 层级 <= 此值的标题会开启新块，默认 2 */
  splitLevel?: number;
}

export function chunkMarkdown(markdown: string, options?: ChunkOptions): ContentBlock[] {
  const splitLevel = options?.splitLevel ?? 2;
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  const blocks: ContentBlock[] = [];
  let current: { level: number; title: string; lines: string[] } | null = null;
  let inFence = false;

  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    // 跳过完全空白的块（前言为空、或图片块后没有剩余文字的续块）
    if (text === '') return;
    blocks.push({
      id: `block-${blocks.length}`,
      kind: 'text',
      level: current.level,
      title: current.title,
      markdown: text,
    });
  };

  for (const line of lines) {
    // 先处理围栏开关：围栏行本身不参与标题/图片判断
    if (FENCE.test(line)) {
      inFence = !inFence;
      if (current === null) current = { level: 0, title: '', lines: [] };
      current.lines.push(line);
      continue;
    }

    if (!inFence) {
      const m = line.match(ATX_HEADING);
      if (m && m[1].length <= splitLevel) {
        // 遇到分块级标题：结束上一块，开启新块
        flush();
        current = { level: m[1].length, title: m[2].trim(), lines: [line] };
        continue;
      }

      const img = line.match(STANDALONE_IMAGE);
      if (img) {
        // 独立图片：结束当前块，图片自成一块，其后文字进"续块"（不带标题行）
        // 显式标 string：下面对 current 的赋值又引用了 parentTitle，不标会循环推断成 any
        const parentTitle: string = current?.title ?? '';
        flush();
        blocks.push({
          id: `block-${blocks.length}`,
          kind: 'image',
          level: 0,
          title: img[1].trim() || parentTitle,
          markdown: line.trim(),
        });
        current = { level: 0, title: parentTitle ? `${parentTitle}（续）` : '', lines: [] };
        continue;
      }
    }

    // 普通行（或前言）：没有当前块时先建一个前言块
    if (current === null) current = { level: 0, title: '', lines: [] };
    current.lines.push(line);
  }

  flush();
  return blocks;
}

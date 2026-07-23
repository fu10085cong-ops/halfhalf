/**
 * 原子遮罩：把一段 Markdown 里所有"不能交给 AI 改写"的刚性内容替换成哨兵占位符，
 * 只把剩下的纯散文送去精简，改写完再逐字回填。这是"AI 精简不毁内容"的核心保障——
 * 公式/代码/表格/图片/标题从头到尾都不进 AI 的输入，也就无从被改错。
 *
 * 遮罩顺序（从"最不透明"到"最透明"，先摘掉的会吞掉后面模式会误扫的 $/|/![ 等符号）：
 *   ① 围栏代码块 → ② 行内代码 `..` → ③ 独立公式 $$..$$ → ④ 表格 → ⑤ 图片
 *   → ⑥ 行内公式 $..$ → ⑦ 标题行
 *
 * 哨兵用全角龟甲括号 〔HH数字〕：学习笔记里几乎不会出现，且对 markdown-it/KaTeX/Shiki
 * 都是普通文本；能过 JSON 往返，配合 prompt 也能被 LLM 逐字保留。万一模型弄丢/改乱，
 * 由 checkSentinels 的计数校验兜住——降级成"这块建议作废"，绝不会变成"公式被改错"。
 *
 * 原子正则与 scene-presets.ts 的 analyzeContent 同源；表格判定复用其 isTableDivider
 * （那条判定修过"把 --- 水平线误判成表格"的 bug，不在这里重写以免漂移）。
 */
import { isTableDivider } from './scene-presets.js';

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const DISPLAY_MATH_RE = /\$\$[\s\S]*?\$\$/g;
const INLINE_MATH_RE = /\$[^$\n]+\$/g;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const HEADING_RE = /^#{1,6}[ \t].*$/gm;

/** 哨兵匹配：捕获组是原子序号 */
export const SENTINEL_RE = /〔HH(\d+)〕/g;

export interface MaskResult {
  /** 遮罩后的文本：刚性原子都变成了 〔HH数字〕，只剩散文 */
  masked: string;
  /** 按序号索引的原子原文，unmaskAtoms 回填时用 */
  atoms: string[];
}

/**
 * 表格遮罩：GFM 表格没有可靠的单条正则，按行扫描——"含 | 的行 + 紧跟一条分隔行"
 * 视为表头，往下吃连续的含 | 非空行，整段作为一个原子。分隔行判定复用 isTableDivider。
 */
function maskTables(md: string, hold: (s: string) => string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') j++;
      out.push(hold(lines.slice(i, j).join('\n')));
      i = j - 1;
    } else {
      out.push(lines[i]);
    }
  }
  return out.join('\n');
}

/**
 * 遮罩一段 Markdown，返回散文 + 原子表。同一次调用里原子序号全局递增，
 * 后遮的模式看到的已是前面替换出的哨兵（不含 $/`/| 等），不会二次误扫。
 */
export function maskAtoms(md: string): MaskResult {
  const atoms: string[] = [];
  const hold = (s: string) => `〔HH${atoms.push(s) - 1}〕`;
  let out = md;
  out = out.replace(FENCE_RE, hold); // ① 围栏代码块（先摘，保护内部的 $ | ![ ` 不被后续误扫）
  out = out.replace(INLINE_CODE_RE, hold); // ② 行内代码：技术标识符不该被 AI 改词
  out = out.replace(DISPLAY_MATH_RE, hold); // ③ 独立公式
  out = maskTables(out, hold); // ④ 表格
  out = out.replace(IMAGE_RE, hold); // ⑤ 图片（行内 + 独立）
  out = out.replace(INLINE_MATH_RE, hold); // ⑥ 行内公式：保护其 LaTeX 不被 AI 改动
  out = out.replace(HEADING_RE, hold); // ⑦ 标题行：结构承重且短，防止 AI 改写标题措辞
  return { masked: out, atoms };
}

/** 把哨兵按序号逐字回填成原子原文；越界序号（模型杜撰）回填为空串，交由安全网判失败 */
export function unmaskAtoms(masked: string, atoms: string[]): string {
  return masked.replace(SENTINEL_RE, (_m, i: string) => atoms[Number(i)] ?? '');
}

/** 遮罩后只剩哨兵和空白 → 这块全是刚性原子（纯公式/代码/表格/图片/标题），没有可精简的正文 */
export function isPureAtom(masked: string): boolean {
  return masked.replace(SENTINEL_RE, '').trim() === '';
}

/**
 * 哨兵完整性校验：改写后的文本里，0..atomCount-1 每个序号必须恰好出现一次，
 * 不能丢失、不能重复、不能出现越界（杜撰）序号。这是"原子没被 AI 动过"的判据。
 */
export function checkSentinels(text: string, atomCount: number): boolean {
  const seen = new Map<number, number>();
  for (const m of text.matchAll(SENTINEL_RE)) {
    const idx = Number(m[1]);
    seen.set(idx, (seen.get(idx) ?? 0) + 1);
  }
  if (seen.size !== atomCount) return false; // 有丢失或有越界序号
  for (let i = 0; i < atomCount; i++) {
    if (seen.get(i) !== 1) return false; // 缺失或重复
  }
  return true;
}

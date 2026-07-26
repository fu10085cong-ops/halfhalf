/**
 * 长注释行拆分：代码块里真正卡宽度的大多不是代码，是长中文注释——
 * `// 快排:分区+递归,不稳定,平均O(nlogn),最坏O(n^2)` 一行 60+ 显示列，
 * 逼得整块要么升宽档要么全体缩小（真实判例：cs 材料 五、排序要点）。
 *
 * 注释是散文：把超预算的整行注释拆成多行注释（续行保留 `//`/`#` 前缀，
 * 语义零损伤）；行尾长注释挪到代码行上方再拆。**代码行一个字符不动**——
 * 长代码行交给 applyAtomScaling 的逐行缩放。
 *
 * 只在渲染路径生效（md-to-html 围栏处理），用户的 Markdown 源文本不变；
 * 测量与渲染共用同一转换，高度口径天然一致。语言不认识（无行注释语法表项）
 * 则原样返回——错拆代码的风险大于收益。
 */

/** 语言 → 行注释起始符（fence 的 info 字符串，小写匹配） */
const LINE_COMMENT: Record<string, string> = {
  c: '//',
  cpp: '//',
  'c++': '//',
  java: '//',
  js: '//',
  javascript: '//',
  jsx: '//',
  ts: '//',
  typescript: '//',
  tsx: '//',
  go: '//',
  rust: '//',
  rs: '//',
  cs: '//',
  csharp: '//',
  kotlin: '//',
  swift: '//',
  scala: '//',
  dart: '//',
  php: '//',
  python: '#',
  py: '#',
  bash: '#',
  sh: '#',
  shell: '#',
  zsh: '#',
  ruby: '#',
  rb: '#',
  yaml: '#',
  yml: '#',
  perl: '#',
  r: '#',
  makefile: '#',
  dockerfile: '#',
  toml: '#',
  sql: '--',
  lua: '--',
  haskell: '--',
  hs: '--',
};

/** CJK/全角等"宽字符"（显示列宽 2；其余按 1）——等宽字体下的近似 */
const WIDE_RE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

export function displayCols(s: string): number {
  let n = 0;
  for (const ch of s) n += WIDE_RE.test(ch) ? 2 : 1;
  return n;
}

/** 默认预算：40 显示列 ≈ 12 格 @13pt 下注释不再是块内最宽的行 */
export const COMMENT_BUDGET_COLS = 40;

/** 优先在这些字符**之后**断行（空格与中英文标点）；找不到就硬切 */
const BREAK_AFTER = /[ \t,;、，。：:；)）\]】/]/;

/** 把注释文本按显示列宽拆成多段，尽量在标点/空格后断 */
function wrapCols(text: string, maxCols: number): string[] {
  if (maxCols < 8) return [text]; // 前缀吃掉太多预算：不拆，避免碎成竖条
  const chunks: string[] = [];
  let cur = '';
  let curCols = 0;
  let lastBreak = -1; // cur 内最后一个可断点（含该字符）
  for (const ch of text) {
    cur += ch;
    curCols += WIDE_RE.test(ch) ? 2 : 1;
    if (BREAK_AFTER.test(ch)) lastBreak = cur.length;
    if (curCols > maxCols && cur.length > 1) {
      // 断点可以就是当前字符（逗号/顿号刚好把预算顶爆时，标点留在行尾而不是甩去下一行开头）
      const cut = lastBreak > 0 ? lastBreak : cur.length - 1;
      chunks.push(cur.slice(0, cut).trimEnd());
      cur = cur.slice(cut).trimStart();
      curCols = displayCols(cur);
      lastBreak = -1;
    }
  }
  if (cur.trim().length > 0) chunks.push(cur.trimEnd());
  return chunks.length > 0 ? chunks : [text];
}

/** 行尾注释起点：marker 前是空白、且之前的引号（' " `）配平——避免误拆字符串里的 // */
function trailingCommentIndex(line: string, marker: string): number {
  for (let i = line.indexOf(marker); i >= 0; i = line.indexOf(marker, i + 1)) {
    if (i === 0) return -1; // 整行注释由上层处理，这里只找行尾注释
    if (!/\s/.test(line[i - 1])) continue;
    const before = line.slice(0, i);
    const balanced = ["'", '"', '`'].every(
      (q) => (before.split(q).length - 1) % 2 === 0
    );
    if (balanced) return i;
  }
  return -1;
}

/**
 * 拆分超预算的注释行。返回处理后的代码文本（无注释语法表项的语言原样返回）。
 */
export function splitLongCodeComments(
  code: string,
  lang: string,
  budgetCols: number = COMMENT_BUDGET_COLS
): string {
  const marker = LINE_COMMENT[lang.toLowerCase()];
  if (!marker) return code;

  const out: string[] = [];
  for (const line of code.split('\n')) {
    if (displayCols(line) <= budgetCols) {
      out.push(line);
      continue;
    }

    // 整行注释：indent + marker + 文本 → 拆成多行同前缀注释
    const full = line.match(new RegExp(`^(\\s*)${marker.replace(/[/\\]/g, '\\$&')} ?(.*)$`));
    if (full) {
      const prefix = `${full[1]}${marker} `;
      for (const chunk of wrapCols(full[2], budgetCols - displayCols(prefix))) {
        out.push(prefix + chunk);
      }
      continue;
    }

    // 行尾注释：代码部分本身不超预算才动——注释挪到代码行上方再拆；
    // 代码部分本身就超预算的长行不碰（交给逐行缩放）
    const ti = trailingCommentIndex(line, marker);
    if (ti > 0) {
      const codePart = line.slice(0, ti).trimEnd();
      const text = line.slice(ti + marker.length).replace(/^ /, '');
      if (displayCols(codePart) <= budgetCols && text.trim().length > 0) {
        const indent = line.match(/^\s*/)![0];
        const prefix = `${indent}${marker} `;
        for (const chunk of wrapCols(text, budgetCols - displayCols(prefix))) {
          out.push(prefix + chunk);
        }
        out.push(codePart);
        continue;
      }
    }

    out.push(line); // 长代码行：一个字符不动
  }
  return out.join('\n');
}

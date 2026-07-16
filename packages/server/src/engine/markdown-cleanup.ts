import type { BundledLanguage } from 'shiki';

/**
 * AI 生成的 Markdown 常见的格式问题，用确定性规则清理，不涉及语义改动、不需要调用 AI。
 * 默认不自动执行，由调用方显式开启（见 optimize.ts 里的 cleanup 参数）。
 */

const LANG_ALIASES: Record<string, BundledLanguage> = {
  py: 'python',
  py3: 'python',
  python3: 'python',
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  'c++': 'cpp',
  cplusplus: 'cpp',
  golang: 'go',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  htm: 'html',
};

/** 围栏代码块（与 pdf-name.ts / scene-presets.ts 同一模式）。清理前整体摘出：
 *  空行、行尾空白、`* ` 开头的行（JSDoc 注释）在代码里都是内容本身，不能清理 */
const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;

/** 把多余的空行折叠成最多一行空行，减少无意义的垂直空间浪费 */
function collapseBlankLines(markdown: string): string {
  return markdown.replace(/\n{3,}/g, '\n\n');
}

/** 去掉行尾多余空格（换行符统一在 cleanupMarkdown 里做，围栏内外都安全） */
function stripTrailingWhitespace(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
}

/**
 * 统一代码块语言标注的大小写和常见别名，避免 Shiki 因为匹配不上语言 ID
 * 而把整段代码降级成无高亮的纯文本。只处理 ```lang 这一行，不碰代码内容本身。
 */
function normalizeCodeFenceLang(markdown: string): string {
  return markdown.replace(/^([ \t]*```)([^\n`]*)$/gm, (match, fence: string, info: string) => {
    const trimmed = info.trim();
    if (!trimmed) return match;

    const [rawLang, ...rest] = trimmed.split(/\s+/);
    const normalized = rawLang.toLowerCase();
    const lang = LANG_ALIASES[normalized] || normalized;
    return `${fence}${[lang, ...rest].join(' ')}`;
  });
}

/** 把 `*`/`+` 无序列表符号统一成 `-`，只匹配行首缩进后紧跟一个空格的列表标记，不误伤加粗/斜体语法 */
function normalizeListMarkers(markdown: string): string {
  return markdown.replace(/^([ \t]*)[*+]( )/gm, '$1-$2');
}

export interface CleanupOptions {
  collapseBlankLines?: boolean;
  normalizeWhitespace?: boolean;
  normalizeCodeFenceLang?: boolean;
  normalizeListMarkers?: boolean;
}

const DEFAULT_OPTIONS: Required<CleanupOptions> = {
  collapseBlankLines: true,
  normalizeWhitespace: true,
  normalizeCodeFenceLang: true,
  normalizeListMarkers: true,
};

export function cleanupMarkdown(markdown: string, options?: CleanupOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // 换行符统一对围栏内外都是无损的，放在摘围栏之前做
  let result = opts.normalizeWhitespace ? markdown.replace(/\r\n/g, '\n') : markdown;

  // 围栏摘出换占位符（NUL 定界：用户文本里不会出现，也不会被行尾空白清理误伤），
  // 清理只作用于正文，最后原样回填
  const fences: string[] = [];
  result = result.replace(FENCE_RE, (block) => {
    fences.push(block);
    return `\u0000hh-fence-${fences.length - 1}\u0000`;
  });

  if (opts.normalizeWhitespace) result = stripTrailingWhitespace(result);
  if (opts.normalizeListMarkers) result = normalizeListMarkers(result);
  if (opts.collapseBlankLines) result = collapseBlankLines(result);

  result = result.replace(/\u0000hh-fence-(\d+)\u0000/g, (_m, i: string) => fences[Number(i)]);
  // 语言标注归一化只碰 ```lang 围栏行自己，不碰围栏内容，回填后做
  if (opts.normalizeCodeFenceLang) result = normalizeCodeFenceLang(result);

  return result;
}

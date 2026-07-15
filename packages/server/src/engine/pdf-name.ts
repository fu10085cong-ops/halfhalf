/**
 * 自动命名 PDF：从 Markdown 内容取第一个标题当文件名（"操作系统 —— 期末考点全集.pdf"），
 * 比 halfhalf-<uuid>.pdf 好找得多——学生一门课会导出很多版。
 * 没有标题就退到第一行非空文字，再不行用兜底名。
 */

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const ATX_HEADING_RE = /^#{1,6}\s+(.+)$/m;
/** 文件系统非法字符（跨 macOS/Windows 取并集） */
const ILLEGAL_RE = /[\\\/:*?"<>|]/g;

/** 去掉行内 Markdown 标记，只留可读文字 */
function stripInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片整个去掉
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接留文字
    .replace(/\$[^$\n]*\$/g, '') // 行内公式去掉（LaTeX 当文件名没意义）
    .replace(/[*_`~#>]/g, '')
    .trim();
}

export function derivePdfName(markdown: string): string {
  // 围栏先摘掉，避免把代码注释里的 # 行当标题
  const text = markdown.replace(FENCE_RE, '');

  let raw = text.match(ATX_HEADING_RE)?.[1] ?? '';
  if (!raw) {
    raw = text.split('\n').find((line) => stripInline(line) !== '') ?? '';
  }

  const cleaned = stripInline(raw)
    .replace(ILLEGAL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();

  return `${cleaned || 'HalfHalf'}.pdf`;
}

/**
 * chat 回复卡的 Markdown → 安全 HTML(spec: docs/superpowers/specs/2026-07-28-chat-column-design.md)。
 * 只给对话回复用;转换卡的 <pre> 预览是刻意展示"源码",不走这里。
 * 流式期间每帧都会整段重渲——回复量级是几 KB 文本,marked 同步解析毫秒级,不值得增量化。
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }));
}

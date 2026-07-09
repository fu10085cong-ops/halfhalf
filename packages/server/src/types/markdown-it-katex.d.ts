declare module 'markdown-it-katex' {
  import type MarkdownIt from 'markdown-it';

  interface MarkdownItKatexOptions {
    throwOnError?: boolean;
    macros?: Record<string, string>;
    [key: string]: unknown;
  }

  const plugin: (md: MarkdownIt, options?: MarkdownItKatexOptions) => void;
  export default plugin;
}

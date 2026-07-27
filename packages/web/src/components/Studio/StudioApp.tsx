/**
 * Studio 三栏前端（NotebookLM 骨架）：左 Sources / 中 操作流对话 / 右 功能模块。
 * spec: docs/superpowers/specs/2026-07-27-studio-ui-design.md。
 * `?ui=studio` 进入,与旧界面并存;后端零改动。
 * 整个应用包在 DocumentDropSurface 里——拖文件到页面任意位置落成新材料卡。
 */
import { useEffect, useRef } from 'react';
import DocumentDropSurface from '../Scene/DocumentDropSurface';
import { IconLogo } from './icons';
import ChatStream from './ChatStream';
import PdfOverlay from './PdfOverlay';
import SourceEditor from './SourceEditor';
import SourcesRail from './SourcesRail';
import StudioRail from './StudioRail';
import { makeSource, newId, StudioProvider, useStudio } from './useStudioStore';
import './Studio.css';

function StudioShell() {
  const { state, dispatch } = useStudio();
  const editing = state.editingSourceId
    ? state.sources.find((s) => s.id === state.editingSourceId) ?? null
    : null;

  // 生料自动引导（产品特色）：本次会话新落卡且 status=raw 的 source → 对话流出引导卡。
  // ref 以挂载时的 sources 初始化——刷新恢复的旧材料不刷屏,只有新增才引导。
  const knownIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (knownIds.current === null) {
      knownIds.current = new Set(state.sources.map((s) => s.id));
      return;
    }
    for (const s of state.sources) {
      if (knownIds.current.has(s.id)) continue;
      knownIds.current.add(s.id);
      if (s.status === 'raw' && s.raw.trim()) {
        dispatch({
          type: 'add_message',
          message: {
            id: newId(),
            role: 'system',
            kind: 'guide',
            sourceId: s.id,
            sourceTitle: s.title,
          },
        });
      }
    }
  }, [state.sources, dispatch]);

  return (
    <DocumentDropSurface
      guideHint="文档提取后落成左栏材料卡，转换成标准 Markdown 后参与排版；图片直接可用。文件仅在本机服务内存中处理"
      onMarkdownImport={(markdown, summary) => {
        dispatch({
          type: 'add_source',
          source: makeSource({
            kind: 'file',
            raw: markdown,
            title: summary?.originalName.replace(/\.(docx|pdf)$/i, ''),
            importSummary: summary
              ? [
                  summary.kind === 'pdf' ? 'PDF' : 'Word',
                  summary.pageCount ? `${summary.pageCount} 页` : null,
                  `${summary.characterCount.toLocaleString()} 字`,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : undefined,
          }),
        });
      }}
      onImageImport={async (file) => {
        const uri = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        const md = `![${file.name}](${uri})`;
        dispatch({
          type: 'add_source',
          source: makeSource({
            kind: 'file',
            raw: md,
            markdown: md,
            status: 'converted',
            title: file.name,
            importSummary: `图片 · ${Math.round(file.size / 1024)} KB`,
          }),
        });
      }}
    >
      {(uploadPanel) => (
        <div className="studio-root">
          <header className="studio-header">
            <span className="studio-badge" aria-hidden="true">
              <IconLogo />
            </span>
            <h1>HalfHalf</h1>
            <span className="studio-tagline">半开卷小抄工作台 —— 从材料到可打印 PDF</span>
            <a className="studio-back" href={window.location.pathname}>
              返回旧版 ↩
            </a>
          </header>
          <div className="studio-body">
            <SourcesRail uploadPanel={uploadPanel} />
            {editing ? <SourceEditor source={editing} /> : <ChatStream />}
            <StudioRail />
          </div>
          <PdfOverlay />
        </div>
      )}
    </DocumentDropSurface>
  );
}

export default function StudioApp() {
  return (
    <StudioProvider>
      <StudioShell />
    </StudioProvider>
  );
}

/**
 * 左栏材料卡：启停勾选 + 图标 + 标题 + 字数/来源 + 状态徽章 + 删除。
 * 点卡片本体 → 中栏切换为该 source 的编辑视图。
 * 图标一律走 icons.tsx 的线稿（logo 设计语言，不用 emoji）。
 */
import { IconAlert, IconCheck, IconClipboard, IconDoc, IconLink, IconTrash } from './icons';
import { useStudio, type Source } from './useStudioStore';

/** 文件类材料保留两字母标签（PDF/W/IMG）——标签比图标更快认出格式 */
function SourceMark({ source }: { source: Source }) {
  if (source.kind === 'paste') return <IconClipboard size={15} />;
  if (source.kind === 'url') return <IconLink size={15} />;

  const summary = source.meta.importSummary ?? '';
  if (summary.startsWith('PDF')) return <em>PDF</em>;
  if (summary.startsWith('Word')) return <em>W</em>;
  if (source.markdown.startsWith('![')) return <em>IMG</em>;
  return <IconDoc size={15} />;
}

export default function SourceCard({ source }: { source: Source }) {
  const { dispatch } = useStudio();
  return (
    <div
      className={`hh-source-card${source.enabled ? '' : ' is-disabled'}`}
      onClick={() => dispatch({ type: 'edit_source', id: source.id })}
      title="点击编辑这份材料"
    >
      <input
        type="checkbox"
        checked={source.enabled}
        title="是否参与排版"
        onClick={(e) => e.stopPropagation()}
        onChange={() => dispatch({ type: 'toggle_source', id: source.id })}
      />
      <span className="hh-source-icon" aria-hidden="true">
        <SourceMark source={source} />
      </span>
      <span className="hh-source-copy">
        <b title={source.title}>{source.title}</b>
        <small>
          {source.meta.importSummary ?? `${source.meta.charCount.toLocaleString()} 字`}
        </small>
        <br />
        {source.status === 'raw' ? (
          <span className="tag tag-accent">
            <IconAlert /> 生料待转换
          </span>
        ) : (
          <span className="tag tag-accent-2">
            <IconCheck size={12} /> 已转换
          </span>
        )}
      </span>
      <button
        type="button"
        className="hh-source-delete"
        title={`删除《${source.title}》`}
        aria-label={`删除材料 ${source.title}`}
        onClick={(e) => {
          // 卡片本体点击会进编辑页，删除按钮必须自己截住事件
          e.stopPropagation();
          if (window.confirm(`删除材料《${source.title}》？`)) {
            dispatch({ type: 'remove_source', id: source.id });
          }
        }}
      >
        <IconTrash />
      </button>
    </div>
  );
}

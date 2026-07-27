/**
 * 左栏材料卡：启停勾选 + 图标 + 标题 + 字数/来源 + 状态徽章。
 * 点卡片本体 → 中栏切换为该 source 的编辑视图。
 */
import { useStudio, type Source } from './useStudioStore';

function sourceIcon(source: Source): string {
  if (source.kind === 'paste') return '📋';
  const summary = source.meta.importSummary ?? '';
  if (summary.startsWith('PDF')) return 'PDF';
  if (summary.startsWith('Word')) return 'W';
  if (source.markdown.startsWith('![')) return 'IMG';
  return '📄';
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
        {sourceIcon(source)}
      </span>
      <span className="hh-source-copy">
        <b title={source.title}>{source.title}</b>
        <small>
          {source.meta.importSummary ?? `${source.meta.charCount.toLocaleString()} 字`}
        </small>
        <br />
        {source.status === 'raw' ? (
          <span className="hh-source-badge is-raw">⚠ 生料待转换</span>
        ) : (
          <span className="hh-source-badge is-converted">✓ 已转换</span>
        )}
      </span>
    </div>
  );
}

/**
 * 中栏 source 编辑视图（点材料卡进入）：改标题/内容、AI 转换这份、跳过 AI、删除。
 * 编辑的是"当前生效文本"——已转换的编辑 markdown（原文 raw 保留可另看），生料编辑 raw。
 */
import { useStudio, type Source } from './useStudioStore';
import { useStudioActions } from './useStudioActions';

export default function SourceEditor({ source }: { source: Source }) {
  const { state, dispatch } = useStudio();
  const { convertSingle, skipAi } = useStudioActions();
  const editingConverted = source.status === 'converted';
  const text = editingConverted ? source.markdown : source.raw;

  const onEdit = (value: string) => {
    dispatch({
      type: 'update_source',
      id: source.id,
      patch: editingConverted
        ? { markdown: value }
        : { raw: value, meta: { ...source.meta, charCount: value.length } },
    });
  };

  return (
    <div className="studio-col is-mid">
      <div className="studio-col-head">
        <button
          type="button"
          className="hh-breadcrumb"
          onClick={() => dispatch({ type: 'edit_source', id: null })}
        >
          ← 返回对话流
        </button>
      </div>
      <div className="hh-editor">
        <input
          type="text"
          value={source.title}
          onChange={(e) =>
            dispatch({ type: 'update_source', id: source.id, patch: { title: e.target.value } })
          }
          
        />
        <div className="text-muted" style={{ fontSize: 12 }}>
          {source.meta.importSummary ?? `${source.meta.charCount.toLocaleString()} 字`}
          {' · '}
          {editingConverted
            ? '已转换——正在编辑转换后的标准 Markdown'
            : '生料——正在编辑原文，转换后进入排版'}
        </div>
        <textarea
          className="hh-editor-text"
          value={text}
          onChange={(e) => onEdit(e.target.value)}
          spellCheck={false}
          placeholder="材料内容"
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={state.converting || !source.raw.trim()}
            title="用 AI 把这份材料的原文整理成标准 Markdown（过程在对话流里）"
            onClick={() => {
              dispatch({ type: 'edit_source', id: null });
              void convertSingle(source);
            }}
          >
            {editingConverted ? '🪄 重新转换（从原文）' : '🪄 AI 转换这份'}
          </button>
          {!editingConverted && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!source.raw.trim()}
              title="不经 AI，原样当成品参与排版（没配 AI key 时的直通路径）"
              onClick={() => skipAi(source)}
            >
              跳过 AI，原样采用
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginLeft: 'auto', color: '#b91c1c' }}
            onClick={() => {
              if (window.confirm(`删除材料《${source.title}》？`)) {
                dispatch({ type: 'remove_source', id: source.id });
              }
            }}
          >
            删除材料
          </button>
        </div>
      </div>
    </div>
  );
}

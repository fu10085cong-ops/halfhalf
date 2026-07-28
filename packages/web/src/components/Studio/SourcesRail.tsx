/**
 * 左栏 Sources：添加入口 + 材料卡列表。
 * uploadPanel 是外层 DocumentDropSurface 的拖放引导/附件状态区，渲染在列表下方
 * （拖放错误、OCR 提示都在那里显示）。
 */
import type { ReactNode } from 'react';
import { IconAlert } from './icons';
import AddSourceMenu from './AddSourceMenu';
import SourceCard from './SourceCard';
import { IconFile } from './icons';
import { useStudio } from './useStudioStore';

export default function SourcesRail({ uploadPanel }: { uploadPanel: ReactNode }) {
  const { state, storageDegraded } = useStudio();
  return (
    <div className="studio-col is-left">
      <div className="studio-col-head">
        来源
        <small>{state.sources.length > 0 && `${state.sources.length} 份`}</small>
      </div>
      <div className="studio-col-body">
        <AddSourceMenu />
        {storageDegraded && (
          <div className="hh-msg-warn" style={{ fontSize: 12, marginBottom: 8 }}>
            <IconAlert /> 浏览器存储不可用/已满：材料只保留在本次会话，刷新会丢
          </div>
        )}
        {state.sources.length === 0 ? (
          <div className="hh-empty">
            <span className="hh-empty-icon" aria-hidden="true"><IconFile size={26} /></span>
            <b>还没有材料</b>
            <br />
            把 Word / PDF 拖到页面任意位置，或点上方「＋ 添加材料」。
            <br />
            勾选的材料会按顺序拼成一份小抄。
          </div>
        ) : (
          state.sources.map((s) => <SourceCard key={s.id} source={s} />)
        )}
        {uploadPanel}
      </div>
    </div>
  );
}

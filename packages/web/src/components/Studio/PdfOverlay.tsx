/**
 * 全屏 PDF 预览覆盖层（结果卡「打开预览」）——中栏平时不放 iframe。Esc / × / 点暗处关闭。
 */
import { useEffect } from 'react';
import { useStudio } from './useStudioStore';

export default function PdfOverlay() {
  const { state, dispatch } = useStudio();
  const overlay = state.pdfOverlay;

  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'set_overlay', overlay: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, dispatch]);

  if (!overlay) return null;

  return (
    <div className="hh-pdf-overlay" onClick={() => dispatch({ type: 'set_overlay', overlay: null })}>
      <div className="hh-pdf-overlay-head" onClick={(e) => e.stopPropagation()}>
        <b>{overlay.fileName}</b>
        <a href={overlay.url} download={overlay.fileName}>
          下载
        </a>
        <button type="button" title="关闭（Esc）" onClick={() => dispatch({ type: 'set_overlay', overlay: null })}>
          ×
        </button>
      </div>
      <iframe title="PDF 预览" src={overlay.url} />
    </div>
  );
}

/**
 * PDF 大预览（结果卡「打开预览」）——Organic 居中大弹窗,iframe 逐页查看 + 下载。
 * 中栏平时不放 iframe。
 */
import Modal from './Modal';
import { useStudio } from './useStudioStore';

export default function PdfOverlay() {
  const { state, dispatch } = useStudio();
  const overlay = state.pdfOverlay;
  if (!overlay) return null;

  return (
    <Modal
      title={overlay.fileName}
      width={860}
      onClose={() => dispatch({ type: 'set_overlay', overlay: null })}
    >
      <div style={{ marginBottom: 8 }}>
        <a className="btn btn-secondary" href={overlay.url} download={overlay.fileName} style={{ textDecoration: 'none' }}>
          下载 PDF
        </a>
      </div>
      <iframe className="hh-pdf-frame" title="PDF 预览" src={overlay.url} />
    </Modal>
  );
}

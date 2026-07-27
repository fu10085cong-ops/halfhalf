/**
 * 居中弹窗（Organic 弹窗语言,设计说明 §5「弹窗统一规格」）：
 * 遮罩点击/Esc/× 关闭、打开时锁 body 滚动、aria-modal、超长内容窗内滚动。
 * 二级界面不再挤压一级内容——原地展开的 <details> 在 Studio 里全部走它。
 */
import { useEffect, type ReactNode } from 'react';

interface ModalProps {
  title: string;
  /** 弹窗宽度上限 px（设计稿:设置 560 / 详情 700-760 / 精简·诊断 860-880） */
  width?: number;
  onClose: () => void;
  children: ReactNode;
}

export default function Modal({ title, width = 560, onClose, children }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div className="dialog-backdrop hh-modal-backdrop" onClick={onClose}>
      <div
        className="dialog elev-lg hh-modal"
        style={{ width: `min(${width}px, 100%)` }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hh-modal-head">
          <span className="dialog-title">{title}</span>
          <button type="button" className="btn btn-secondary btn-icon" title="关闭（Esc）" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="hh-modal-body">{children}</div>
      </div>
    </div>
  );
}

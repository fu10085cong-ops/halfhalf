import { useState, useEffect } from 'react';
import type { PaperSize, Density } from '../../types';

interface ParameterPanelProps {
  targetPages: number;
  onTargetPagesChange: (v: number) => void;
  paperSize: PaperSize;
  onPaperSizeChange: (v: PaperSize) => void;
  density: Density;
  onDensityChange: (v: Density) => void;
  cleanup: boolean;
  onCleanupChange: (v: boolean) => void;
  margins: { top: number; bottom: number; left: number; right: number };
  onMarginsChange: (v: { top: number; bottom: number; left: number; right: number }) => void;
  precision: number;
  onPrecisionChange: (v: number) => void;
  onOptimize: () => void;
  isOptimizing: boolean;
}

const panelStyle: React.CSSProperties = {
  background: 'var(--color-surface)',
  borderRadius: 'var(--radius)',
  boxShadow: 'var(--shadow)',
  padding: '16px',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  marginBottom: 4,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 14,
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  outline: 'none',
  background: '#fafafa',
  color: 'var(--color-text)',
};

const primaryBtnStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 16px',
  fontSize: 15,
  fontWeight: 600,
  color: '#fff',
  background: 'var(--color-primary)',
  border: 'none',
  borderRadius: 8,
  transition: 'background 0.2s',
};

export default function ParameterPanel({
  targetPages,
  onTargetPagesChange,
  paperSize,
  onPaperSizeChange,
  density,
  onDensityChange,
  cleanup,
  onCleanupChange,
  margins,
  onMarginsChange,
  precision,
  onPrecisionChange,
  onOptimize,
  isOptimizing,
}: ParameterPanelProps) {
  const [inputValue, setInputValue] = useState(String(targetPages));
  const [precisionValue, setPrecisionValue] = useState(String(precision));
  const [marginValues, setMarginValues] = useState({
    top: String(margins.top),
    bottom: String(margins.bottom),
    left: String(margins.left),
    right: String(margins.right),
  });

  useEffect(() => {
    setInputValue(String(targetPages));
  }, [targetPages]);

  useEffect(() => {
    setPrecisionValue(String(precision));
  }, [precision]);

  useEffect(() => {
    setMarginValues({
      top: String(margins.top),
      bottom: String(margins.bottom),
      left: String(margins.left),
      right: String(margins.right),
    });
  }, [margins]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setInputValue(raw);
    if (raw !== '') {
      const num = parseInt(raw, 10);
      if (!isNaN(num)) {
        onTargetPagesChange(Math.max(1, Math.min(100, num)));
      }
    }
  };

  const handleBlur = () => {
    const num = parseInt(inputValue, 10);
    if (inputValue === '' || isNaN(num) || num < 1) {
      setInputValue('1');
      onTargetPagesChange(1);
    }
  };

  const handlePrecisionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setPrecisionValue(raw);
    if (raw !== '') {
      const num = parseFloat(raw);
      if (!isNaN(num)) {
        onPrecisionChange(Math.max(0.1, Math.min(5, num)));
      }
    }
  };

  const handlePrecisionBlur = () => {
    const num = parseFloat(precisionValue);
    if (precisionValue === '' || isNaN(num) || num < 0.1) {
      setPrecisionValue('0.5');
      onPrecisionChange(0.5);
    }
  };

  const handleMarginChange = (field: 'top' | 'bottom' | 'left' | 'right') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setMarginValues((prev) => ({ ...prev, [field]: raw }));
    if (raw !== '') {
      const num = parseFloat(raw);
      if (!isNaN(num)) {
        onMarginsChange({ ...margins, [field]: Math.max(0, Math.min(50, num)) });
      }
    }
  };

  const handleMarginBlur = (field: 'top' | 'bottom' | 'left' | 'right') => () => {
    const raw = marginValues[field];
    const num = parseFloat(raw);
    if (raw === '' || isNaN(num) || num < 0) {
      const next = { ...marginValues, [field]: '10' };
      setMarginValues(next);
      onMarginsChange({ ...margins, [field]: 10 });
    }
  };

  return (
    <>
      {/* 参数设置 */}
      <div style={panelStyle}>
        <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: 'var(--color-text)' }}>
          ⚙️ 排版参数
        </h3>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>目标页数</label>
          <input
            type="number"
            min={1}
            max={100}
            value={inputValue}
            onChange={handleChange}
            onBlur={handleBlur}
            style={fieldStyle}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>纸张尺寸</label>
          <select
            value={paperSize}
            onChange={(e) => onPaperSizeChange(e.target.value as PaperSize)}
            style={fieldStyle}
          >
            <option value="A4">A4 (210×297mm)</option>
            <option value="A5">A5 (148×210mm)</option>
            <option value="Letter">Letter (215.9×279.4mm)</option>
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>排版密度</label>
          <select
            value={density}
            onChange={(e) => onDensityChange(e.target.value as Density)}
            style={fieldStyle}
          >
            <option value="compact">紧凑 (行高 1.05)</option>
            <option value="normal">正常 (行高 1.15)</option>
            <option value="loose">宽松 (行高 1.3)</option>
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>页边距 (mm)</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {(['top', 'bottom', 'left', 'right'] as const).map((field) => (
              <div key={field}>
                <label style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginBottom: 2, display: 'block', textTransform: 'capitalize' }}>{field}</label>
                <input
                  type="number"
                  min={0}
                  max={50}
                  step={1}
                  value={marginValues[field]}
                  onChange={handleMarginChange(field)}
                  onBlur={handleMarginBlur(field)}
                  style={{ ...fieldStyle, padding: '6px 8px', fontSize: 13 }}
                />
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>搜索精度 (pt)</label>
          <input
            type="number"
            min={0.1}
            max={5}
            step={0.1}
            value={precisionValue}
            onChange={handlePrecisionChange}
            onBlur={handlePrecisionBlur}
            style={fieldStyle}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={cleanup}
              onChange={(e) => onCleanupChange(e.target.checked)}
              style={{ margin: 0 }}
            />
            格式清理（统一代码语言标注、折叠多余空行等）
          </label>
        </div>
      </div>

      {/* 操作按钮 */}
      <button
        onClick={onOptimize}
        disabled={isOptimizing}
        style={{
          ...primaryBtnStyle,
          opacity: isOptimizing ? 0.7 : 1,
          cursor: isOptimizing ? 'wait' : 'pointer',
        }}
      >
        {isOptimizing ? '🔄 正在搜索最佳字号...' : '🚀 开始优化'}
      </button>

      {/* 快捷提示 */}
      <div style={{
        padding: '12px',
        background: '#fefce8',
        border: '1px solid #fde68a',
        borderRadius: 6,
        fontSize: 11,
        color: '#854d0e',
        lineHeight: 1.5,
      }}>
        💡 <strong>使用技巧：</strong>粘贴 Markdown 内容，设置目标页数后点击「开始优化」。
        系统将通过二分搜索自动找到最大可用字号。
      </div>
    </>
  );
}
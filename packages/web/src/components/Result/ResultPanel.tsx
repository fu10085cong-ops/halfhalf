import type { OptimizeResult, IterationRecord } from '../../types';

interface ResultPanelProps {
  result: OptimizeResult | null;
  history: IterationRecord[];
  isOptimizing: boolean;
  error: string | null;
}

const containerStyle: React.CSSProperties = {
  background: 'var(--color-surface)',
  borderRadius: 'var(--radius)',
  boxShadow: 'var(--shadow)',
  padding: '16px',
  minHeight: 120,
};

export default function ResultPanel({
  result,
  history,
  isOptimizing,
  error,
}: ResultPanelProps) {
  if (error) {
    return (
      <div style={{
        ...containerStyle,
        border: '2px solid var(--color-danger)',
        background: '#fef2f2',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 20 }}>❌</span>
          <strong style={{ color: 'var(--color-danger)' }}>优化失败</strong>
        </div>
        <p style={{ fontSize: 13, color: '#991b1b' }}>{error}</p>
      </div>
    );
  }

  if (!result && !isOptimizing && history.length === 0) {
    return (
      <div style={{
        ...containerStyle,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--color-text-secondary)',
        fontSize: 14,
      }}>
        👆 设置参数后点击「开始优化」开始自动排版
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      {/* 结果概览 */}
      {result && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '12px 16px',
          background: 'linear-gradient(135deg, #ecfdf5, #d1fae5)',
          borderRadius: 8,
          marginBottom: history.length > 0 ? 12 : 0,
        }}>
          <span style={{ fontSize: 28 }}>✅</span>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#065f46' }}>
              最佳字号：<span style={{ fontSize: 24 }}>{result.optimalFontSize}pt</span>
            </div>
            <div style={{ fontSize: 13, color: '#047857', marginTop: 2 }}>
              实际页数：{result.actualPages} 页 · 搜索 {result.iterations} 次
            </div>
          </div>
        </div>
      )}

      {/* 搜索过程历史 */}
      {history.length > 0 && (
        <div>
          <div style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--color-text-secondary)',
            marginBottom: 8,
            textTransform: 'uppercase',
          }}>
            📊 搜索过程
          </div>
          <div style={{
            maxHeight: 200,
            overflowY: 'auto',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
          }}>
            {history.map((record, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  borderBottom: i < history.length - 1 ? '1px solid var(--color-border)' : 'none',
                  fontSize: 13,
                  fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
                }}
              >
                <span style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                  background: record.withinLimit ? '#d1fae5' : '#fee2e2',
                  color: record.withinLimit ? '#065f46' : '#991b1b',
                }}>
                  {record.withinLimit ? '✓' : '✗'}
                </span>
                <span style={{ flex: 1 }}>
                  <strong>{record.fontSize}pt</strong> → {record.pages} 页
                  {!record.withinLimit && (
                    <span style={{ color: 'var(--color-danger)', marginLeft: 6 }}>超出</span>
                  )}
                </span>
                {record.message && (
                  <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                    {record.message}
                  </span>
                )}
              </div>
            ))}
            {isOptimizing && (
              <div style={{
                padding: '6px 12px',
                fontSize: 13,
                color: 'var(--color-primary)',
                animation: 'pulse 1.5s ease-in-out infinite',
              }}>
                🔍 正在尝试下一个字号...
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
import { useState } from 'react';
import AppLayout from './components/Layout/AppLayout';
import MarkdownEditor from './components/Editor/MarkdownEditor';
import ParameterPanel from './components/Config/ParameterPanel';
import ResultPanel from './components/Result/ResultPanel';
import ScenePanel from './components/Scene/ScenePanel';
import type { Density, OptimizeResult, IterationRecord } from './types';

function App() {
  // 'scene' = 场景排版（网格引擎，新，默认）；'flow' = 连续多栏流（旧）
  const [tab, setTab] = useState<'scene' | 'flow'>('scene');
  const [markdown, setMarkdown] = useState(`# 你好，HalfHalf！

这是一个 **Markdown 自动分页排版系统** 的演示。

## 功能特性

- 自动寻找最大字号
- 二分搜索算法
- 支持数学公式 $E=mc^2$

### 代码示例

\`\`\`typescript
function hello() {
  console.log("Hello, HalfHalf!");
}
\`\`\`

> 紧凑排版，保持阅读体验。

| 特性 | 状态 |
|------|------|
| 标题 | ✅ |
| 表格 | ✅ |
| 公式 | ✅ |
`);

  const [targetPages, setTargetPages] = useState(5);
  const [paperSize, setPaperSize] = useState<'A4' | 'A5' | 'Letter'>('A4');
  const [density, setDensity] = useState<Density>('normal');
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [history, setHistory] = useState<IterationRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleOptimize = async () => {
    setIsOptimizing(true);
    setError(null);
    setHistory([]);
    setResult(null);

    try {
      const response = await fetch('/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markdown,
          targetPages,
          paperSize,
          density,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('无法读取响应流');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            if (eventType === 'progress') {
              setHistory(prev => [...prev, data]);
            } else if (eventType === 'result') {
              setResult(data);
            } else if (eventType === 'error') {
              setError(data.error);
            }
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '优化请求失败');
    } finally {
      setIsOptimizing(false);
    }
  };

  const tabButton = (key: 'scene' | 'flow', label: string) => (
    <button
      onClick={() => setTab(key)}
      style={{
        padding: '4px 12px',
        fontWeight: tab === key ? 'bold' : 'normal',
        textDecoration: tab === key ? 'underline' : 'none',
      }}
    >
      {label}
    </button>
  );

  return (
    <AppLayout>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 16px 0', display: 'flex', gap: 8 }}>
          {tabButton('scene', '场景排版（网格引擎）')}
          {tabButton('flow', '连续多栏流（旧版）')}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {tab === 'scene' ? <ScenePanel /> : renderFlowTab()}
        </div>
      </div>
    </AppLayout>
  );

  function renderFlowTab() {
    return (
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 320px',
        gridTemplateRows: '1fr auto',
        gap: '16px',
        height: '100%',
        padding: '16px',
      }}>
        {/* 左上：编辑器 */}
        <div style={{ gridRow: '1', gridColumn: '1' }}>
          <MarkdownEditor value={markdown} onChange={setMarkdown} />
        </div>

        {/* 右上：参数设置 */}
        <div style={{ gridRow: '1', gridColumn: '2', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <ParameterPanel
            targetPages={targetPages}
            onTargetPagesChange={setTargetPages}
            paperSize={paperSize}
            onPaperSizeChange={setPaperSize}
            density={density}
            onDensityChange={setDensity}
            onOptimize={handleOptimize}
            isOptimizing={isOptimizing}
          />
        </div>

        {/* 下方：结果展示 */}
        <div style={{ gridRow: '2', gridColumn: '1 / span 2' }}>
          <ResultPanel
            result={result}
            history={history}
            isOptimizing={isOptimizing}
            error={error}
          />
        </div>
      </div>
    );
  }
}

export default App;
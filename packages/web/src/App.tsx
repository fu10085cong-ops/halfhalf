import AppLayout from './components/Layout/AppLayout';
import ScenePanel from './components/Scene/ScenePanel';
import StudioApp from './components/Studio/StudioApp';

/**
 * 两个界面并存（spec: docs/superpowers/specs/2026-07-27-studio-ui-design.md）：
 * - 默认 = 旧版 ScenePanel（全功能单页）
 * - `?ui=studio` = Studio 三栏（NotebookLM 骨架）,成熟后切默认
 * 旧「连续多栏流」tab 已从 UI 隐藏（无 PDF 下载出口的死路;后端 /api/optimize 保留）。
 */
function App() {
  const useStudioUi = new URLSearchParams(window.location.search).get('ui') === 'studio';
  if (useStudioUi) return <StudioApp />;
  return (
    <AppLayout>
      <ScenePanel />
    </AppLayout>
  );
}

export default App;

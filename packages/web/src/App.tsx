import AppLayout from './components/Layout/AppLayout';
import ScenePanel from './components/Scene/ScenePanel';

/**
 * 单页应用 = 场景排版（网格引擎）。
 * 旧「连续多栏流」tab 已从 UI 隐藏：它没有 PDF 下载出口、只能竖版单栏，是条死路；
 * 后端 /api/optimize 保留（DESIGN.md：连续流仍是长文快速通道，将来需要时再挂回入口，
 * 旧组件仍在 components/Editor|Config|Result 下）。
 */
function App() {
  return (
    <AppLayout>
      <ScenePanel />
    </AppLayout>
  );
}

export default App;

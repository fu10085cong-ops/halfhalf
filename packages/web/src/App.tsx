import StudioApp from './components/Studio/StudioApp';

/**
 * Studio 三栏是唯一界面。旧版 ScenePanel/AppLayout 已于 2026-07-28 退役删除
 * (它绕过统一输入闸,且功能已被 Studio 全覆盖)——需要考古时从 git 历史找。
 */
function App() {
  return <StudioApp />;
}

export default App;

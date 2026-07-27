import { lazy, Suspense } from 'react';
import AppLayout from './components/Layout/AppLayout';
import ScenePanel from './components/Scene/ScenePanel';

/**
 * 两个界面并存（spec: docs/superpowers/specs/2026-07-27-studio-ui-design.md）：
 * - 默认 = 旧版 ScenePanel（全功能单页）
 * - `?ui=studio` = Studio 三栏（Organic 皮 + Studio 骨）,成熟后切默认
 * StudioApp 懒加载：organic.css 的 :root token 只在 Studio 路由才进页面,
 * 不污染旧界面的旧 token（合体计划的隔离钉子）。
 */
const StudioApp = lazy(() => import('./components/Studio/StudioApp'));

function App() {
  const useStudioUi = new URLSearchParams(window.location.search).get('ui') === 'studio';
  if (useStudioUi) {
    return (
      <Suspense fallback={null}>
        <StudioApp />
      </Suspense>
    );
  }
  return (
    <AppLayout>
      <ScenePanel />
    </AppLayout>
  );
}

export default App;

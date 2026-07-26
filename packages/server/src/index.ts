import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportRouter } from './routes/export.js';
import { aiRouter } from './routes/ai.js';
import { sceneRouter } from './routes/scene.js';
import { fixturesRouter } from './routes/fixtures.js';
import { closeSharedBrowser } from './engine/browser-pool.js';
import { accessCodeGuard } from './middleware/access-code.js';

const app: express.Express = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors());
// 25mb：web 场景截图以 base64 data URI 内嵌在 Markdown 里，几张 Retina 截图就能到 MB 级
app.use(express.json({ limit: '25mb' }));

// 访问口令（设了 HALFHALF_ACCESS_CODE 才启用）：挡在所有 /api 路由之前，/api/health 放行
const ACCESS_CODE = process.env.HALFHALF_ACCESS_CODE || '';
if (ACCESS_CODE) {
  app.use('/api', accessCodeGuard(ACCESS_CODE));
  console.log('[halfhalf] 访问口令已启用（x-access-code）');
}

// Routes
app.use('/api', exportRouter);
app.use('/api', aiRouter);
app.use('/api', sceneRouter);
app.use('/api', fixturesRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 生产环境托管前端构建产物（同源，免 CORS）：dev 用 Vite proxy，不走这里。
// 默认相对 dist 定位（dist/index.js → ../../web/dist）；Docker 里用 HALFHALF_WEB_DIST 指到固定路径。
const webDist = process.env.HALFHALF_WEB_DIST || path.resolve(__dirname, '../../web/dist');
app.use(express.static(webDist));
// SPA 兜底：非 /api 的 GET 一律回 index.html（交给 React 前端路由）。
// 负向前瞻排除 /api，避免把接口的 404 也吞成 HTML。
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(webDist, 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`[halfhalf] Server running at http://localhost:${PORT}`);
});

// 优雅关停：容器 stop / Ctrl-C 时关掉共享 Chromium，否则子进程会拖住 Node 不退、
// 甚至在宿主残留僵尸浏览器（browser-pool 头注释的告警）。
let shuttingDown = false;
const shutdown = async (sig: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[halfhalf] ${sig} 收到，开始收尾`);
  server.close();
  await closeSharedBrowser().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export { app };
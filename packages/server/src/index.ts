import express from 'express';
import cors from 'cors';
import { optimizeRouter } from './routes/optimize.js';
import { exportRouter } from './routes/export.js';
import { aiRouter } from './routes/ai.js';
import { sceneRouter } from './routes/scene.js';

const app: express.Express = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// 25mb：web 场景截图以 base64 data URI 内嵌在 Markdown 里，几张 Retina 截图就能到 MB 级
app.use(express.json({ limit: '25mb' }));

// Routes
app.use('/api', optimizeRouter);
app.use('/api', exportRouter);
app.use('/api', aiRouter);
app.use('/api', sceneRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[halfhalf] Server running at http://localhost:${PORT}`);
});

export { app };
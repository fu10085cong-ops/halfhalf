import express from 'express';
import cors from 'cors';
import { optimizeRouter } from './routes/optimize.js';
import { exportRouter } from './routes/export.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Routes
app.use('/api', optimizeRouter);
app.use('/api', exportRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[halfhalf] Server running at http://localhost:${PORT}`);
});

export { app };
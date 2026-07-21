import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 起服务后自动打开浏览器；端口被占用直接报错而不是偷偷换端口
    // （换了端口前端反代还指着 3000，容易出现"能开但 API 全 404"的迷惑现象）
    open: true,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
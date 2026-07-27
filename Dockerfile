# HalfHalf 单容器部署：Express 同源服务 /api + 前端静态资源。
# 运行时基于官方 Playwright 镜像（Chromium + 系统库 + 基础字体已预装），额外补 CJK 字体。
#
# ⚠️ 基础镜像 tag 必须与 pnpm-lock 里解析到的 playwright 版本一致（当前 1.61.1），
#    否则容器内浏览器版本与 npm 包不匹配，启动报 "browser not found"。
#    升级 playwright 后同步改这里的 v1.61.1 和下面 builder 无关（builder 不装浏览器）。
#
# 1G 内存机器不要在本机 build（vite build + 依赖会顶爆内存）：
#   在开发机/CI  docker build → docker push，服务器只 docker pull + run。

# ---- builder：装依赖 + 构建 server(dist) 和 web(dist) ----
FROM node:20-bookworm-slim AS builder
RUN npm install -g pnpm@9
WORKDIR /app

# 先拷清单装依赖，最大化利用 Docker 层缓存（源码变动不必重装依赖）
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build   # server: tsc + 拷 templates → dist；web: tsc -b && vite build → packages/web/dist

# ---- runtime：官方 Playwright 镜像 ----
FROM mcr.microsoft.com/playwright:v1.61.1-jammy
# 补中文字体，否则中文 PDF 全是方块（基础镜像只有拉丁字体）；
# python3 给 PDF 原页保真 Worker 用（坏字体页回退成原页图像时才会拉起）。
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-noto-cjk fonts-noto-color-emoji python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/packages/server/src/workers/requirements.txt /tmp/parser-requirements.txt
RUN python3 -m pip install --no-cache-dir -r /tmp/parser-requirements.txt \
    && rm /tmp/parser-requirements.txt

WORKDIR /app
ENV NODE_ENV=production \
    HALFHALF_MAX_PAGES=1 \
    HALFHALF_CHROMIUM_NO_SANDBOX=1 \
    HALFHALF_WEB_DIST=/app/web/dist \
    HALFHALF_PYTHON=/usr/bin/python3 \
    HALFHALF_IMPORT_CONCURRENCY=1 \
    HALFHALF_IMPORT_OWNER_LIMIT=3 \
    HALFHALF_DATA_DIR=/app/data \
    PORT=3000

# 保持 monorepo 布局照搬 node_modules（pnpm 的符号链接依赖 /app 路径一致才解析得开）。
# 依赖全是纯 JS（playwright-core 走 CDP 无原生 addon），跨发行版照搬安全。
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/web/dist ./web/dist

EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]

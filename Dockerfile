# HalfHalf 单容器部署：Express 同源服务 /api + 前端静态资源。
# 运行时基于 node:20-bookworm-slim，浏览器由 playwright npm 包自己安装（只装 Chromium）。
# 曾用官方 Playwright 镜像：省事但捎带 Firefox/WebKit 共 ~2GB 死重，且镜像 tag 必须
# 人肉对齐 npm 包版本（对不齐报 "browser not found"）。现在版本天然一致，无需对齐。
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

# ---- runtime：slim 基底 + 按需装 Chromium ----
FROM node:20-bookworm-slim
# 中文字体必装，否则中文 PDF 全是方块；fonts-liberation 是拉丁兜底（slim 基底几乎无字体）。
# python3 给 PDF 原页保真 Worker 用（坏字体页回退成原页图像时才会拉起）。
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-noto-cjk fonts-noto-color-emoji fonts-liberation python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/packages/server/src/workers/requirements.txt /tmp/parser-requirements.txt
# bookworm 的 pip 有 PEP 668 保护（拒绝装进系统环境）；容器整个就是隔离环境，直接放行。
RUN python3 -m pip install --no-cache-dir --break-system-packages -r /tmp/parser-requirements.txt \
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
# 依赖全是纯 JS（playwright 走 CDP 无原生 addon），跨发行版照搬安全。
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/server/node_modules ./packages/server/node_modules

# 用项目自己的 playwright CLI 装浏览器：版本永远和 pnpm-lock 一致，不存在"tag 没对齐"。
# --with-deps 顺带装 Chromium 的系统库；只装 chromium，不带 Firefox/WebKit（省 ~2GB）。
# --only-shell 只装 headless shell（334MB），不装完整版（624MB）——browser-pool 固定
# headless:true，Playwright 无头默认走 shell；实测删掉完整版渲染照常（RULES.md §4.18）。
# 放在 dist 拷贝之前：源码改动重打镜像时，浏览器层走缓存不重下。
RUN apt-get update \
    && ./packages/server/node_modules/.bin/playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/web/dist ./web/dist

EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]

# HalfHalf 部署手册

单容器形态：Express 同源托管 `/api` + 前端静态资源，`node:20-bookworm-slim` 打底、
Chromium(headless shell)由 playwright npm 包在构建时自装——版本天然与 lockfile 一致。
适用目标：一台 1~2G 内存的云服务器，供同学们通过网址直接使用（应急十分钟路径的前提）。

## 0. 服务器要求

- 1 核 / **≥1G 内存**（务必配 2G swap 吸收渲染尖峰；2G 内存更稳）
- Docker + docker compose
- 一个域名（要开 HTTPS / 远程 AI 就必须有）

## 1. 隐私红线（部署前自查，一条都不能跳）

| 项 | 状态 |
|---|---|
| `samples/`（含真实姓名学号的照片）不进镜像 | ✅ `.dockerignore` 已排除；**运行时镜像只拷 dist+node_modules，构建上下文里也没有它** |
| `test/fixtures/` 真实复习材料不进运行时镜像 | ✅ 只进 builder 层，runtime 阶段不拷贝；`/api/fixtures` 在 `NODE_ENV=production` 下一律 404 |
| git 历史里的 samples 照片 | ⚠️ 仅当你把仓库 **git clone 到服务器 / 推公开远程** 时需要先洗历史（BFG）；走"本机 build → push 镜像"流程可绕过 |
| 访问口令 | 公网必设 `HALFHALF_ACCESS_CODE`（API 无鉴权裸奔等于公共渲染农场） |
| HTTPS | 用户要在页面里填 BYOK key / 粘贴复习材料——明文 HTTP 会被中间人看光，公网必须挂 HTTPS |
| 任务历史落盘 | ⚠️ 设了 `HALFHALF_DATA_DIR`（compose 默认设了）就会把**用户导入的文档内容**写进卷：任务快照 + 已完成结果（含原页图像）。所有者只记 SHA-256 键，不存客户端 ID/IP，**原始上传文件不落盘**。默认 7 天后连结果文件一起清掉。不想留任何用户内容就删掉这个环境变量和卷 |
| 匿名客户端 ID | ⚠️ `x-halfhalf-client` 是浏览器自己生成的，服务端照单全收。它只用于任务隔离和配额，**不是登录认证**——拿到别人的 ID 就能读对方的任务结果。别把它当权限边界 |

## 2. 构建与推送（在开发机做，1G 服务器别本机 build）

```bash
docker build -t <registry>/halfhalf:latest .
docker push <registry>/halfhalf:latest
```

升级 playwright 版本不需要改 Dockerfile：浏览器由镜像内的 playwright CLI 安装，
版本永远跟着 pnpm-lock 走（旧方案要人肉对齐基础镜像 tag，对不齐报 "browser not found"）。

## 3. 服务器上运行

```bash
mkdir halfhalf && cd halfhalf
# 拷 docker-compose.yml 和 .env.example 过来（rsync/scp，不需要整个仓库）
cp .env.example .env && vim .env     # 至少设 HALFHALF_ACCESS_CODE；想开「材料转换」再设 HALFHALF_AI_*
# compose 里把 image 换成你推送的镜像名、删掉 build: . 行
docker compose up -d
curl http://localhost/api/health     # {"status":"ok",...} 才算起来了
```

关键环境变量（完整说明见 `.env.example`）：

| 变量 | 作用 |
|---|---|
| `HALFHALF_ACCESS_CODE` | 访问口令；设了才启用闸门，前端首次 401 会弹窗要口令 |
| `HALFHALF_AI_ENDPOINT/MODEL/KEY` | ⓪ 材料转换的服务器统一 key（建议 deepseek 控成本）；不设则用户必须自带 key |
| `HALFHALF_AI_RATE_LIMIT` | 材料转换每 IP 每小时次数（默认 10）——控你的 key 费用 |
| `HALFHALF_MAX_PAGES` | 并发渲染页上限；1G 内存必须 1 |

## 4. HTTPS（Caddy 反代，自动证书）

```bash
# 宿主装 Caddy 后，/etc/caddy/Caddyfile：
your.domain.com {
    reverse_proxy localhost:80
}
# compose 的端口映射相应改成 "127.0.0.1:80:3000"（只给本机 Caddy 访问）
sudo systemctl reload caddy
```

没有 HTTPS 之前：不要让用户在页面里填 BYOK key，也别宣传公网地址——口令和材料都是明文。

## 5. 升级 / 排障

```bash
# 升级
docker compose pull && docker compose up -d

# 日志（第一句应看到 "Server running"；设了口令还有 "访问口令已启用"）
docker compose logs -f --tail 100

# 常见病
# - 中文 PDF 全方块：镜像没装 fonts-noto-cjk（用本仓库 Dockerfile 不会发生）
# - "browser has been closed"/内存爆:HALFHALF_MAX_PAGES 调回 1,确认 swap 存在
# - "browser not found":镜像大概率是旧方案(Playwright 官方镜像打底)构建的,tag 与
#   playwright npm 版本没对齐;用当前 Dockerfile 重打即可(浏览器改由 npm 包自装)
# - 改了代码行为没变:先确认打的是新镜像,再怀疑代码(僵尸容器同理:docker ps 看创建时间)
# - PDF_VISUAL_RENDER_FAILED:原页保真 Worker 起不来。进容器 `python3 -c "import fitz"`
#   验证 PyMuPDF 装上了,再看 HALFHALF_PYTHON 是否指对
# - 429 IMPORT_BUSY:导入并发已满(默认 1)。这是刻意的背压,不是故障;
#   内存够就调高 HALFHALF_IMPORT_CONCURRENCY
# - 重启后任务显示 IMPORT_INTERRUPTED:符合预期。本版不自动续跑中断的解析,
#   请用户重新提交文件(绝不伪造成功)
```

## 6. 任务数据的保留与清理

`HALFHALF_DATA_DIR` 下每个任务两个文件：`<jobId>.json`（几百字节的快照）和
`<jobId>.result.json`（完成结果，含原页图像，可达数 MB）。启动只读快照，
用户真正打开某个任务时才读结果——历史再多也不会在启动时撑爆内存。

清理是自动的：超过 `HALFHALF_IMPORT_JOB_TTL_MS`（compose 默认 7 天）或超出
每客户端 `HALFHALF_IMPORT_HISTORY_LIMIT` 条（默认 20）的终态任务，快照和结果一起删。

要立刻清空所有用户内容：`docker compose down && docker volume rm <项目名>_halfhalf-data`。

## 7. 发布前验收

1. `pnpm test` 全绿(开发机);
2. 带口令 curl `/api/scene` 通、无口令 401、`/api/fixtures` 404;
3. 导入一份真实 PDF,`docker compose restart` 后仍能在最近任务里打开并恢复内容;
4. 按 EXPERIMENT.md 的「十分钟北极星演练」用一份真实无结构材料全流程计时,超时段记进演练日志。


## 构建平台（2026-07-30 记）

本机若是 Apple Silicon，`docker build` 出来的是 **arm64 镜像，跑不了 x86 服务器**。
部署前必须显式指定平台：

```bash
docker build --platform linux/amd64 -t halfhalf:latest .
```

**arm64 与 amd64 双平台均已验证**（2026-07-30，详见 RULES.md §4.18）：构建成功、
PyMuPDF 1.26.3 可导入、30 个 Noto CJK 字体在位、`/api/health` 2 秒内 200、
容器内真排出中文 PDF 并目检确认中文/表格/代码高亮/KaTeX 公式全部正常。

镜像 4.04GB，其中 1.93GB 是 Playwright 基础镜像自带的三个浏览器（本项目只用 Chromium）。
瘦身方案已挂账，见 RULES.md §4.18——换基础镜像是部署关键改动，须单独验证。

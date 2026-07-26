# HalfHalf 部署手册

单容器形态：Express 同源托管 `/api` + 前端静态资源，Playwright 官方镜像打底。
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

## 2. 构建与推送（在开发机做，1G 服务器别本机 build）

```bash
docker build -t <registry>/halfhalf:latest .
docker push <registry>/halfhalf:latest
```

⚠️ Dockerfile 头部注释：基础镜像 tag（当前 `v1.61.1`）必须与 pnpm-lock 的 playwright 版本一致，
升级 playwright 后要同步改，否则容器报 "browser not found"。

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
# - "browser not found":镜像 tag 与 playwright npm 版本不一致(见第 2 节)
# - 改了代码行为没变:先确认打的是新镜像,再怀疑代码(僵尸容器同理:docker ps 看创建时间)
```

## 6. 发布前验收

1. `pnpm test` 全绿(开发机);
2. 带口令 curl `/api/scene` 通、无口令 401、`/api/fixtures` 404;
3. 按 EXPERIMENT.md 的「十分钟北极星演练」用一份真实无结构材料全流程计时,超时段记进演练日志。

---
name: zombie-processes
description: 当出现"改了代码但行为没变"、新加的接口返回 404/Cannot POST、前端收到 DOCTYPE 开头的 HTML 而不是 JSON、报 browser has been closed、起服务报 EADDRINUSE、或 kill 过的进程好像还活着时使用——先排查是否在跟旧进程(僵尸/孤儿)说话,再调试代码。
---

# 僵尸进程排查

## 核心原则

**"代码明明改了却没生效"的第一嫌疑人不是代码,是进程。** 先证明"应答者跑的是新代码",再开始调试——顺序反了会在旧进程上白调几小时(本仓库真实翻车 4 次)。

## 三步排查

```bash
# ① 查端口占用者的出生时间(把 3000 换成实际端口)
lsof -ti :3000 | xargs ps -o pid,ppid,lstart,command -p

# ② 判定:出生时间早于你最近一次改代码 = 僵尸,在应答旧代码
#    PPID = 1(launchd/init)= 孤儿,它的 watch 外壳已死,永远不会热重载

# ③ 按端口杀干净,重启,并验证启动日志
lsof -ti :3000 | xargs kill -9
# 重启后必须 grep 到 "Server running" 才算起来了——不能只看命令没报错
```

## 已知陷阱(每条都真实翻过车)

| 陷阱 | 事实 |
|---|---|
| "tsx watch 会自动重载,不用管" | 只对**活着的 watch** 成立;孤儿进程永远跑旧代码 |
| `kill %1` / `kill $!` 杀后台任务 | 杀的是 pnpm/nohup 包装进程,node 子进程**孤儿化继续占端口**——必须按端口杀 |
| `pkill -f "tsx watch"` 按名字杀 | 孤儿的命令行是 `node …loader.mjs src/index.ts`,**不含 "tsx watch",漏杀真凶**;名字模式还可能误杀别的项目——按端口杀才是准的 |
| "kill 完了就干净了" | 必须复查 `lsof -ti :PORT`;端口还被占就是没杀对 |
| "服务起了"(命令没报错) | EADDRINUSE 崩溃后旧进程仍在应答,看起来一切正常——**必须验证启动日志** |
| 连续几个端口都"有服务" | 多半是历次实验留下的僵尸群,逐个查出生时间 |

## 红旗——见到就先走三步排查,别调代码

- 新功能 404 / `Cannot POST`,但代码里明明有
- 响应是 `<!DOCTYPE` 开头的 HTML,期望是 JSON
- `browser has been closed` 这类"陈旧状态"错误
- 修复提交了,用户说"还是老样子"

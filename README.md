# 📄 HalfHalf — Markdown 自动分页排版系统

> **Half the size, Half the time.** 输入 Markdown 和目标页数，自动寻找最大正文字号，生成完美排版 PDF。
> 典型场景：把 AI 生成的复习笔记压成半开卷考试允许携带的一张 A4 小抄。

[![Stack](https://img.shields.io/badge/stack-Node.js_%7C_React_%7C_Playwright_%7C_TypeScript-blue)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()

---

## ✨ 核心特性

- **自动字号搜索**：二分搜索算法，在 6pt~24pt 范围内找到满足页数限制的最大字号
- **多格式支持**：标题、列表、表格、代码块（Shiki 高亮）、图片、数学/物理公式（KaTeX）、Mermaid 图表
- **原子块保护**：代码块/公式/图表/表格不会被硬切断到两页之间
- **实时预览**：SSE 流式返回搜索过程，可视化每次迭代结果
- **多种纸张**：A4 / A5 / Letter
- **排版密度**：紧凑 / 正常 / 宽松 三种预设
- **格式清理（可选）**：折叠多余空行、归一化代码块语言标注等，用户主动开启，不默认改动原文
- **AI 接口预留**：BYOK（自带 API key）的通用转发接口，不绑定具体 AI 服务商

---

## 🚀 快速开始

### 环境要求

- **Node.js** >= 18
- **pnpm** >= 9
- **Playwright** 依赖的 Chromium（首次运行需要手动安装一次）

### 安装与运行

```bash
# 1. 克隆仓库
git clone https://github.com/fu10085cong-ops/halfhalf.git
cd halfhalf

# 2. 安装依赖
pnpm install

# 3. 安装 Playwright Chromium（首次需要）
cd packages/server && npx playwright install chromium && cd ../..

# 4. 启动开发模式
pnpm dev
```

- 前端：http://localhost:5173
- 后端 API：http://localhost:3000

### 不启动前端，单独验证排版引擎

```bash
cd packages/server
pnpm test:fixture 5   # 数字是目标页数，默认 2
```

会跑 `test/fixtures/sample.md`（覆盖代码高亮、数学/物理公式、Mermaid 图表、长表格等场景），
终端打印每轮二分搜索的字号/页数，并把最终 PDF 写到 `test/fixtures/sample.output.pdf`。

---

## 🏗️ 项目结构

```
halfhalf/
├── pnpm-workspace.yaml          # pnpm monorepo 配置
├── tsconfig.base.json           # 共享 TypeScript 配置
├── package.json                 # 根 package.json（脚本入口 + pnpm.overrides）
│
├── packages/
│   ├── server/                  # 后端服务
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── test/
│   │   │   ├── run-fixture.ts   # 绕开 HTTP，直接跑引擎的验证脚本
│   │   │   └── fixtures/
│   │   │       └── sample.md    # 覆盖各类排版场景的测试文档
│   │   └── src/
│   │       ├── index.ts         # Express 入口
│   │       ├── types/
│   │       │   ├── index.ts     # 共享类型定义 & 常量
│   │       │   └── markdown-it-katex.d.ts  # 第三方包的类型声明补丁
│   │       ├── routes/
│   │       │   ├── optimize.ts  # 优化 API（SSE 流式）
│   │       │   ├── export.ts    # PDF 下载 API
│   │       │   └── ai.ts        # 通用 BYOK AI 转发接口
│   │       ├── engine/          # 排版引擎
│   │       │   ├── md-to-html.ts       # Markdown → HTML（Shiki + KaTeX + Mermaid 占位 + 图片缩放）
│   │       │   ├── render-pdf.ts       # Chromium 渲染 + Mermaid 预渲染 + pdf-lib 读页数
│   │       │   ├── binary-search.ts    # 字号二分搜索主循环
│   │       │   ├── markdown-cleanup.ts # 确定性格式清理（用户可选开启）
│   │       │   └── job-store.ts        # PDF 任务内存存储（供下载端点使用）
│   │       └── templates/
│   │           └── print.css    # 打印样式表（分页/原子块保护规则）
│   │
│   └── web/                     # 前端界面
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── index.html
│       └── src/
│           ├── main.tsx         # React 入口
│           ├── App.tsx          # 主布局 & 状态管理
│           ├── types/
│           │   └── index.ts     # 前端类型定义
│           ├── styles/
│           │   └── global.css   # 全局样式 & CSS 变量
│           └── components/
│               ├── Layout/
│               │   └── AppLayout.tsx
│               ├── Editor/
│               │   └── MarkdownEditor.tsx  # Monaco 编辑器
│               ├── Config/
│               │   └── ParameterPanel.tsx  # 参数设置面板
│               └── Result/
│                   └── ResultPanel.tsx     # 搜索结果展示
```

---

## 🔧 API 接口

### `POST /api/optimize`（SSE 流式）

请求：

```json
{
  "markdown": "# Hello\n\nWorld",
  "targetPages": 5,
  "paperSize": "A4",
  "density": "normal",
  "margins": { "top": 10, "bottom": 10, "left": 10, "right": 10 },
  "precision": 0.5,
  "cleanup": false
}
```

`cleanup` 为 `true` 时会在排版前跑一遍确定性格式清理（见下方「格式清理」），默认 `false`，不改动原文。

SSE 事件流：

```
event: progress
data: {"fontSize":12,"pages":7,"withinLimit":false,"timestamp":1234567890}

event: progress
data: {"fontSize":9,"pages":4,"withinLimit":true,"timestamp":1234567891}

event: result
data: {
  "optimalFontSize": 10.5,
  "actualPages": 5,
  "iterations": 8,
  "history": [...],
  "withinTargetPages": true,
  "jobId": "b3f1..."
}
```

`withinTargetPages` 为 `false` 时表示内容过多，最小字号（6pt）下仍超过目标页数——此时返回的是最小字号下的最佳努力结果，而不是报错。

### `POST /api/render`

使用指定字号渲染单次 PDF 预览（不参与搜索）。**尚未实现**（占位端点）。

### `GET /api/download/:jobId/pdf`

下载最终 PDF 文件，`jobId` 来自 `/api/optimize` 返回结果。任务在内存中保留 30 分钟，过期或服务重启后失效。

### `GET /api/download/:jobId/docx`

DOCX 导出。**尚未实现**（占位端点，预留给 Pandoc 集成）。

### `POST /api/ai/proxy`

BYOK 通用 AI 转发接口，不绑定具体任务（审核/精简/排版建议等由调用方自行决定 prompt 内容），
后端只做域名白名单校验（`api.openai.com` / `api.anthropic.com` / `generativelanguage.googleapis.com`）和原样转发，
不记录、不存储传入的 key。

```json
{
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "headers": { "Authorization": "Bearer sk-xxx" },
  "body": { "model": "gpt-4o-mini", "messages": [] }
}
```

---

## 🧹 格式清理（`markdown-cleanup.ts`）

针对 AI 生成 Markdown 常见的格式问题，纯规则处理，不涉及语义改动，用户通过 `cleanup: true` 主动开启：

- 折叠多余空行、去掉行尾空格、统一换行符
- 归一化代码块语言标注（如 `Python`/`py` → `python`），避免因大小写或别名不匹配导致 Shiki 高亮降级成纯文本
- 统一无序列表符号（`*`/`+` → `-`）

更深层的语义级精简（改写叙述性文字为要点式表达等）计划通过 `/api/ai/proxy` 由用户自己的 AI key 完成，
输出仅作为建议，不自动应用到最终文档——排版内容的准确性不能因为省空间而打折扣。

---

## 📐 排版参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 纸张 | A4 | A4/A5/Letter |
| 页边距 | 10mm | 上下左右 |
| 字号范围 | 6pt–24pt | 二分搜索范围 |
| 搜索精度 | 0.5pt | 可配置 |
| 行高（紧凑） | 1.05 | density=compact |
| 行高（正常） | 1.15 | density=normal |
| 行高（宽松） | 1.3 | density=loose |

---

## 🧠 核心算法

```
function findOptimalFontSize(markdown, targetPages):
  lo = 6pt, hi = 24pt

  # 先探测下限：最小字号仍超页 → 内容过多，直接返回最佳努力结果
  if renderPDF(markdown, fontSize=lo).pages > targetPages:
    return lo, withinTargetPages=false

  best = lo
  while hi - lo > precision:
    mid = (lo + hi) / 2
    pages = renderPDF(markdown, fontSize=mid)

    if pages <= targetPages:
      best = mid      # 记录可行解
      lo = mid        # 尝试更大字号
    else:
      hi = mid         # 减小字号

  return best, withinTargetPages=true
```

代码块/公式/Mermaid 图表/表格行通过 `break-inside: avoid` 尽量保持整体不被硬切，
若单个原子块本身比一整页还长，会在无法避免时允许它跨页，而不是被裁切丢失内容。

Mermaid 图表只在二分搜索开始前预渲染一次（图表内部布局不随正文字号变化），
后续每轮迭代只调整字号/行高等 CSS 变量重新打印，不重复渲染图表。

---

## 🗺️ 开发计划

### 已完成

- [x] Monorepo 项目骨架搭建
- [x] 前端界面（编辑器 + 参数面板 + 结果展示）
- [x] 排版引擎核心实现（Markdown → HTML → PDF，含代码高亮/公式/图表/图片）
- [x] 二分搜索算法与 SSE 集成
- [x] PDF 下载端点（内存任务存储）
- [x] 确定性格式清理（用户可选开启）
- [x] AI 通用 BYOK 转发接口（占位，未接具体业务逻辑）

### 进行中 / 下一步

- [ ] 多栏排版（2/3 栏），提升信息密度，是当前优先级最高的功能
- [ ] Chromium 浏览器实例池 + 并发控制（多人共用前必须做，否则并发请求会耗尽内存）
- [ ] AI 语义级精简建议（依赖上面的 BYOK 接口，输出建议 diff，人工确认后才应用）
- [ ] 图片/表格跨页的进一步验证（当前实现已具备，未做充分的真实场景测试）

### 后续版本

- [ ] DOCX 导出（Pandoc 集成）
- [ ] LaTeX 高级排版模式
- [ ] 模板系统（简历/论文/书籍）
- [ ] Docker 部署（共享工具形态的前置条件）
- [ ] 批量处理

---

## 📄 License

MIT © 2024

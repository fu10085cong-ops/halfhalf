# 📄 HalfHalf — Markdown 自动分页排版系统

> **Half the size, Half the time.** 输入 Markdown 和目标页数，自动寻找最大正文字号，生成完美排版 PDF。

[![Stack](https://img.shields.io/badge/stack-Node.js_%7C_React_%7C_Playwright_%7C_TypeScript-blue)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()

---

## ✨ 核心特性

- **自动字号搜索**：二分搜索算法，在 6pt~24pt 范围内找到满足页数限制的最大字号
- **多格式支持**：标题、列表、表格、代码块、图片、数学公式（KaTeX）
- **特殊排版优化**：标题不孤行、表格自适应、代码块自动换行
- **实时预览**：SSE 流式返回搜索过程，可视化每次迭代结果
- **多种纸张**：A4 / A5 / Letter
- **排版密度**：紧凑 / 正常 / 宽松 三种预设

---

## 🚀 快速开始

### 环境要求

- **Node.js** >= 18
- **pnpm** >= 8（推荐）或 npm/yarn
- **Playwright** 依赖的 Chromium（首次运行自动安装）

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

---

## 🏗️ 项目结构

```
halfhalf/
├── pnpm-workspace.yaml          # pnpm monorepo 配置
├── tsconfig.base.json            # 共享 TypeScript 配置
├── package.json                  # 根 package.json（脚本入口）
│
├── packages/
│   ├── server/                   # 后端服务
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts          # Express 入口
│   │       ├── types/
│   │       │   └── index.ts      # 共享类型定义 & 常量
│   │       ├── routes/
│   │       │   ├── optimize.ts   # 优化 API（SSE 流式）
│   │       │   └── export.ts     # 下载 API（PDF/DOCX 预留）
│   │       ├── engine/           # 排版引擎（待实现）
│   │       │   ├── md-to-html.ts # Markdown → HTML 渲染
│   │       │   ├── render-pdf.ts # Chromium PDF 渲染
│   │       │   └── binary-search.ts # 二分搜索算法
│   │       └── templates/        # HTML 排版模板
│   │           └── print.css     # 打印样式表
│   │
│   └── web/                      # 前端界面
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── index.html
│       └── src/
│           ├── main.tsx          # React 入口
│           ├── App.tsx           # 主布局 & 状态管理
│           ├── types/
│           │   └── index.ts      # 前端类型定义
│           ├── styles/
│           │   └── global.css    # 全局样式 & CSS 变量
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
  "precision": 0.5
}
```

SSE 事件流：

```
event: progress
data: {"fontSize":12,"pages":7,"withinLimit":false}

event: progress
data: {"fontSize":9,"pages":4,"withinLimit":true}

event: result
data: {"optimalFontSize":10.5,"actualPages":5,"iterations":8,"history":[...]}
```

### `POST /api/render`

使用指定字号渲染单次 PDF 预览（不参与搜索）。

### `GET /api/download/:jobId/pdf`

下载最终 PDF 文件。

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
  best = 6pt

  while hi - lo > precision:
    mid = (lo + hi) / 2
    pages = renderPDF(markdown, fontSize=mid)

    if pages <= targetPages:
      best = mid      // 记录可行解
      lo = mid        // 尝试更大字号
    else:
      hi = mid        // 减小字号

  return best
```

---

## 🗺️ 开发计划

### MVP（当前阶段）

- [x] Monorepo 项目骨架搭建
- [x] 前端界面（编辑器 + 参数面板 + 结果展示）
- [x] 后端 API 路由骨架（SSE 流式端点）
- [x] 共享类型定义与常量
- [ ] 排版引擎核心实现（Markdown→HTML→PDF）
- [ ] 二分搜索算法与 SSE 集成
- [ ] PDF 下载端点

### 后续版本

- [ ] DOCX 导出（Pandoc 集成）
- [ ] LaTeX 高级排版模式
- [ ] 模板系统（简历/论文/书籍）
- [ ] 页边距可视化自定义
- [ ] 批量处理
- [ ] Docker 部署

---

## 📄 License

MIT © 2024
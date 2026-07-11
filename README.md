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
- **横竖版可选**：竖版 / 横版 / 自动（并行试两个方向，取字号更大的）
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

完整的接口契约（请求/响应字段、校验规则、错误形状、SSE 事件、示例）见
[`packages/server/API.md`](./packages/server/API.md)——那份文档是给前端集成用的权威参考，这里只列一个速查表：

| 接口 | 说明 |
|------|------|
| `POST /api/optimize` | 核心接口，SSE 流式返回二分搜索过程和最终结果（含下载用的 `jobId`） |
| `POST /api/render` | 单次渲染预览（指定字号，不搜索），直接返回 PDF 二进制流，用于切换方向/字号后先看效果 |
| `GET /api/download/:jobId/pdf` | 下载最终 PDF，任务内存保留 30 分钟 |
| `GET /api/download/:jobId/docx` | 尚未实现，占位返回 501，预留给 Pandoc |
| `POST /api/ai/proxy` | 通用 BYOK AI 转发接口，域名白名单校验后原样转发 |

所有接口的错误响应统一是 `{ "error": string }` 形状，包括 SSE 里的 `error` 事件。

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
| 方向 | portrait（竖版） | portrait/landscape/auto |
| 页边距 | 10mm | 上下左右，横版时不跟着旋转，仍按物理边 |
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

## 🧭 产品定位与增长策略

> 这一节是非技术的产品/商业判断记录，不影响代码运行，留着是为了不让决策的理由随时间流失。

### 跟"格式工厂"类通用转换工具的区分点

格式工厂是**无损格式转换**（A 转 B，不理解内容语义）；HalfHalf 做的是**约束求解**（给定内容和页数上限，自动求出能让内容合法塞进去的排版参数）。通用转换工具不会、也没有商业动机去理解 Markdown 语义、保护代码块/公式完整性、自动找最大字号——这不是它们没做，是它们的产品逻辑（广度优先、走量）决定了不会做。所以不是同一类竞品，不需要在功能列表上正面竞争。

### 护城河

二分搜索算法和 Playwright 渲染方案本身不构成壁垒，任何工程师都能照抄。真正难复制的是：

1. **渲染保真度的工程债**——KaTeX 版本冲突、Mermaid 内联样式覆盖、字体跨目录加载失败……这类边界 bug 只能靠踩坑攒经验，抄代码抄不走踩坑记录。
2. **AI 压缩质量的经验积累**——什么样的精简会破坏可读性、图表该不该转成更紧凑的图表语法，这些判断标准是用真实反馈喂出来的，是持续复利的资产。
3. **学生群体内部的口碑/信任**——这类工具天然靠同学之间安利传播，一旦建立"从来没出过错"的口碑，新进入者要撬动的是信任而不是功能对比。反过来，一次"AI 把公式改错"级别的翻车会直接透支这个资产。

投入优先级：先把保真度磨扎实，再把 AI 压缩的判断标准喂扎实，最后靠零差错口碑滚雪球。

### 学生内容社区（想法阶段，尚未开发）

**设想**：允许用户分享整理好的学科知识点总结，订阅制解锁他人分享的内容，创作者分成。

**现状判断**：需求信号是真实的（小红书上已经有大量同类"知识点总结"帖子在自然传播，创作者靠署名/流量变现，不是靠直接收费），但直接开发付费市场级功能风险和成本都过高，暂不排期：

- **学术诚信边界**必须卡死在"自己整理的知识点总结"，明确排除"历年真题/答案/未公开课件原文"——前者风险接近教辅资料，后者是实际的红线，一旦出现会反噬上面说的口碑护城河，且有平台/校方层面的封禁风险。
- **工程规模**跟现有系统完全不是一个量级——现在没有账号体系、没有持久化用户内容存储、没有支付基础设施，做这套东西的工程量可能超过整个排版引擎，且是完全不同的技能栈（支付合规、内容审核、社区运营）。

**低成本验证路径（进行中）**：

1. 不做账号/支付/审核系统，先做一个极简的"导出署名水印"选项，复用现有排版引擎——验证创作者是否认可 HalfHalf 的排版质量，愿不愿意用它处理本来就要发布的内容。
2. 内容冷启动不找陌生创作者，通过朋友网络覆盖不同专业，在小红书自然发布 + 软性带上产品链接，同时完成内容启动和产品推广。开始前对齐一句话的内容准则（"总结自己的理解，不要照抄课件/真题"），避免边界问题。
3. 朋友产出内容不是长期供给策略，只是启动种子；小红书对硬广限流敏感，避免统一模板/矩阵号观感，保持各自的个人风格。
4. 验证通过（创作者认可排版质量、内容能自然传播）之后，再考虑要不要往正式的订阅/分成方向投入工程。

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
- [x] 横竖版排版（portrait/landscape/auto，auto 并行跑两个方向取更优）
- [x] 单次渲染预览接口（`/api/render`，指定字号直接出 PDF，不参与二分搜索）

### 进行中 / 下一步

- [ ] 多栏排版（2/3 栏），提升信息密度，是当前优先级最高的功能
- [ ] Chromium 浏览器实例池 + 并发控制（多人共用前必须做，否则并发请求会耗尽内存；也是把 orientation='auto' 设为默认值的前提）
- [ ] AI 语义级精简建议（依赖上面的 BYOK 接口，输出建议 diff，人工确认后才应用）
- [ ] 图片/表格跨页的进一步验证（当前实现已具备，未做充分的真实场景测试）

### 后续版本

- [ ] DOCX 导出（Pandoc 集成）
- [ ] LaTeX 高级排版模式
- [ ] 模板系统（简历/论文/书籍）
- [ ] Docker 部署（共享工具形态的前置条件）
- [ ] 批量处理
- [ ] 内容社区低成本验证：导出署名水印选项 + 小红书内容冷启动，详见「产品定位与增长策略」

---

## 📄 License

MIT © 2024

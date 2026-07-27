# Studio 三栏前端(NotebookLM 风格)设计

2026-07-27 · 已与用户对齐并获批。四个前置决定:**并存开发成熟后切换 / 中栏为操作流对话 / URL 抓取二期 / 亮色为主、取 NotebookLM 布局骨架**。

## 背景与目标

现有前端是单个 869 行的 ScenePanel:材料转换、工具条、测试台、导入、编辑框、AI 精简、诊断、历史挤在一页,主页面杂乱。目标:按 NotebookLM 的三栏信息架构重组——左 Sources、中 AI 对话流、右功能模块;用多种二级界面收纳细节,主页面只留主干。**后端零改动**,现有 API(scene/structurize/compress/import/download)全部够用。

非目标(明确二期以后):URL 网页抓取、真多轮自由对话、组合级 AI 精简、暗色主题实现(只留变量位)、多 notebook 与服务端持久化。

## 信息模型:Source

把"一个大文本框"升级为"一列材料卡片"。每份材料一条记录:

```ts
interface Source {
  id: string;
  title: string;            // 自动取首行/文件名,可改
  kind: 'paste' | 'file';   // 二期加 'url'
  raw: string;              // 原始生料(粘贴原文/文档提取物)
  markdown: string;         // 标准 Markdown(转换产物;「跳过AI」时 = raw)
  status: 'raw' | 'converted';
  enabled: boolean;         // 是否参与排版
  meta: { charCount: number; importSummary?: string; createdAt: number };
}
```

**排版输入 = enabled 的 sources 按序拼接**(source 间空行分隔)。状态存 React(context + reducer 的 `useStudioStore`),localStorage 兜底(刷新不丢)。

## 三栏布局

- **左栏 Sources(~280px)**:「+ 添加」三入口——粘贴文本(小弹层)、上传文件(走现有 /api/import/document 链路)、网页 URL(置灰,"即将支持")。下方材料卡列表:图标(W/PDF/📋)、标题、字数、启停勾选、状态徽章(⚠️生料/✅已转换)。拖文件进页面任意位置仍全局接住,落成新卡(复用 DocumentDropSurface 机制)。
- **中栏 对话流**:操作流对话。每个动作一来一回:用户消息("转换《数据库》")→ 系统响应卡(流式转换文本 + 体检结论 / PDF 结果卡:字号·页数·填充 + 打开预览/下载)。底部为**动作条**(「转换生料」「生成 PDF」两主按钮),非自由聊天框。「转换生料」= 对所有 enabled 且 status=raw 的 source **按序逐个**转换(队列执行,每份一张对话卡);单独转某一份走 source 编辑视图里的按钮。消息结构按未来可升级多轮对话设计(role/kind/payload)。
- **右栏 Studio(~300px)**:功能卡——**生成 PDF**(主卡,常驻目标页数;高级选项折叠:场景/学科/乱序/边距/满版伸展)、AI 精简、诊断报告、会话历史、AI 设置(endpoint/model/key);dev 环境多一张「测试材料」(fixtures)。

## 二级界面(三种形态)

1. **右栏栈式面板**:点功能卡 → 右栏滑入该模块详情(顶部←返回)。精简 diff、诊断表、历史、AI 设置全部收进面板。
2. **中栏 source 编辑视图**:点材料卡 → 中栏切换为该 source 大编辑器(改标题/内容/转换这份/跳过 AI/删除),面包屑返回对话流。
3. **全屏 PDF 预览层**:结果卡「打开预览」→ 覆盖层大预览 + 下载/打印,Esc/× 关闭。中栏平时不放 iframe。

## 已拍取舍

- **AI 精简作用域 = 单个 source**(右栏面板里选一份,建议写回该份)。组合级精简的 range 偏移映射是坑,二期再说。
- **编辑器占中栏**而非弹窗:编辑是沉浸动作值得大空间;编辑时看不到对话流,可接受。

## 数据流 → API 映射(后端零改动)

| 动作 | API | 结果去向 |
|---|---|---|
| 上传/拖入文档 | POST /api/import/document | 新 source(status=raw) |
| 转换某 source | POST /api/ai/structurize (SSE) | 流式进对话卡;成品写回 source.markdown,status=converted |
| 跳过 AI | — | markdown=raw,status=converted |
| 生成 PDF | POST /api/scene(拼接 enabled sources) | PDF 结果卡(诊断数据同时喂诊断面板/历史) |
| AI 精简(单 source) | POST /api/ai/compress | 精简面板 diff,采纳写回该 source |
| 预览/下载 | GET /api/download/:jobId/pdf | 覆盖层 iframe / 下载 |

## 组件与工程形态

新增(约 10 个,全部在 `packages/web/src/components/Studio/`):`StudioApp`(三栏骨架)、`SourcesRail`、`SourceCard`、`AddSourceMenu`、`ChatStream`、`MessageCard`、`SourceEditor`、`StudioRail` + 各 Panel(Generate/Compress/Diagnostics/History/AiSettings)、`PdfOverlay`、`useStudioStore`(context+reducer+localStorage)。

- **并存**:App.tsx 按 `?ui=studio`(或顶栏「体验新版」开关)切换 StudioApp / 旧 ScenePanel;旧界面一行不动。
- **零新依赖**:React + Vite + 手写 CSS;亮色 CSS 变量打底,暗色变量位预留不实现。
- 复用:apiFetch、DocumentDropSurface(接 onMarkdownImport → 新建 source)、ChatIntake 的 SSE 解析逻辑(抽成共享工具)。

## v1 验收标准

拖一个 docx + 粘一段文本 → 左栏两张卡 → 对话流转换生料(体检结论可见)→ 勾选组合 → 生成 PDF → 结果卡打开预览/下载——全程主页面无滚动杂讯;旧界面照常可用;双端 tsc 绿;Playwright 走通上述全流程。

## 风险与对策

- **功能对齐缺口**:旧 ScenePanel 的每个能力(乱序/学科/边距/debug 网格/fixtures)在切默认前列清单核对——并存期即安全网。
- **拼接口径**:多 source 拼接后 H1 标题多个——切块器已按"仅首块 H1 豁免"处理,其余 H1 空章头并入,行为已有回归锁。
- **localStorage 尺寸**:文档提取物可达数百 KB,超限时降级为"本次会话内存态"并提示。

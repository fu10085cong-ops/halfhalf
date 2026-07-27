# Studio 三栏前端实施计划

2026-07-27 · spec: [2026-07-27-studio-ui-design.md](../specs/2026-07-27-studio-ui-design.md)(已获批)。
原则:**后端零改动;旧界面除两处最小改动外不动**;`?ui=studio` 并存;每步双端 tsc + pnpm test 绿,布局改动必须 Playwright 截图目检。

## 任务分解(按提交切)

### 1. 共享工具抽取(唯一动旧代码的一步,行为不变)

- 新建 `packages/web/src/lib/sse.ts`:把 ChatIntake 里的 `consumeSse` 原样搬出并导出;ChatIntake 改为 import。
- 新建 `packages/web/src/lib/documentImport.ts`:把 DocumentDropSurface 里 `/api/import/document` 的 fetch+错误解析抽成 `importDocument(file): Promise<ImportOutcome>`(带 `DocumentImportSummary` 等类型导出);DocumentDropSurface 改用它,`onMarkdownImport` 签名扩为 `(markdown, summary?)`(可选参数,ScenePanel 不用改)。
- 验证:web tsc 绿;旧界面 Playwright 冒烟(拖 docx 流程不回归)。

### 2. useStudioStore(context + reducer + localStorage)

`packages/web/src/components/Studio/useStudioStore.tsx`:

- `Source` 按 spec;`StudioMessage { id; role: 'user'|'system'; kind: 'text'|'convert'|'pdf'|'error'; ... }`(convert 卡带流式缓冲/体检结论/attempt,pdf 卡带 SceneResult 摘要+jobId+objectUrl)。
- view 状态:`railPanel: 'cards'|'compress'|'diagnostics'|'history'|'settings'`、`editingSourceId`、`pdfOverlay`。
- 只持久化 sources(key `hh.studio.sources`,QuotaExceeded 降级会话内存并提示);消息/结果为会话态。AI 配置沿用旧 localStorage key(`hh.ai.*`),两界面共享。

### 3. StudioApp 三栏骨架 + 切换

- `StudioApp.tsx` 自带顶栏(标题 + 「返回旧版」链接);三栏 grid(280px / 1fr / 300px),内部滚动区全部 `minHeight:0`(高度链教训)。
- `Studio.css`:亮色,用现有 CSS 变量。
- `App.tsx`:`?ui=studio` → StudioApp,否则旧 AppLayout+ScenePanel;AppLayout 头部加一条「体验新版」链接(旧界面第二处最小改动)。
- 验证:Playwright 双 URL 截图——旧界面无回归、新界面三栏满高。

### 4. 左栏 Sources

- `SourcesRail` + `SourceCard`(图标/标题/字数/启停勾选/状态徽章)+ `AddSourceMenu`(粘贴文本弹层、上传文件=hidden input→importDocument、URL 置灰)。
- 整个 StudioApp 包进 DocumentDropSurface:拖文件任意位置 → `onMarkdownImport(md, summary)` → 新建 source(title=文件名);uploadPanel 渲染在左栏底部(错误/OCR 提示有处可看);图片拖入 → data-URI markdown source。

### 5. 中栏 对话流 + 编辑视图

- `ChatStream`(消息列表自动滚底)+ `MessageCard`(text/convert/pdf/error 四形态)+ 底部动作条(「转换生料」「生成 PDF」)。
- 转换:对 enabled 且 raw 的 source 逐个排队走 `/api/ai/structurize` SSE,流式进 convert 卡,产物写回 source(status=converted),体检结论上卡;失败上 error 卡不断队。
- 生成:enabled sources 按序拼 `markdown || raw`(空行分隔)→ `/api/scene` → 取 PDF blob → pdf 卡(字号/页数/达标/填充 + 打开预览/下载);结果同时喂诊断面板与历史。
- `SourceEditor`:点材料卡 → 中栏切换(标题/内容编辑、转换这份、跳过 AI、删除、面包屑返回)。

### 6. 右栏 Studio

- `StudioRail`:生成主卡常驻(目标页数 + 高级折叠:场景/学科/方向/边距/乱序/满版伸展/网格)+ 模块卡(精简/诊断/历史/AI 设置,dev 加 fixtures);点卡片 → 栈式面板(← 返回)。
- v1 面板深度:AI 设置全功能(convert 依赖 BYOK);诊断=最近一次生成的警告+块诊断表;历史=会话生成记录表;精简=选一个 source 跑 `/api/ai/compress`、diff 勾选写回该 source(能力对齐旧界面,砍会话内多轮)。
- `PdfOverlay`:全屏覆盖层 iframe + 下载,Esc/× 关闭。

### 7. 验证收口

- 双端 `tsc --noEmit` 绿;`pnpm test` 全绿(94/94 不减)。
- Playwright 全流程:拖 docx + 粘贴文本 → 两张卡 → 转换生料(mock 或跳过 AI)→ 生成 PDF → 结果卡 → 预览覆盖层;新旧两界面各留截图目检。
- 旧界面功能清单核对不回归(并存期安全网)。

## 风险钉子

- 高度链:三栏与每个滚动区显式 `minHeight:0`;截图验证强制。
- localStorage 超限:写入 try/catch,降级会话内存 + 左栏提示。
- 拼接口径:多 source 多 H1——切块器"仅全文首块 H1 豁免"已有回归锁,无需前端特判。

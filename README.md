# HalfHalf — 半开卷小抄生成器

> **Half the size, Half the time.**
>
> **你说一页,就是一页 —— 而且是这份内容能用的最大字号。**
>
> 输入 Markdown 和目标页数,自动求解排版参数,生成可直接打印的 PDF。

> **当前状态**:本地可跑,**尚未部署**,无外部用户。部署配置(Dockerfile / 访问口令 / DEPLOY.md)
> 已就绪但未上线。

[![Stack](https://img.shields.io/badge/stack-Node.js_%7C_React_%7C_Playwright_%7C_TypeScript-blue)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()

---

## 这是什么

半开卷考试允许带一张纸。要把一学期的知识塞进去,人得干两件事:**决定留什么**(脑力活),
和**把它们在纸上摆密**(体力活)。第二件事在 Word 里做是场噩梦——调字号、分栏、打印预览、
发现多出半页、回去删内容,循环往复。

HalfHalf 接管第二件事。给它内容和"我要几页",它用真实浏览器渲染反复测量,搜出**能塞进这个页数的
最大字号**,再把内容切成块在网格上密堆,最后出一份可以直接打印的 PDF。

一个实测的例子(6572 字的政经笔记,A4):

| 做法 | 结果 |
|---|---|
| 粘进 Word 直接打印 | 11 页 |
| 手动死磕,字号砍到 6pt 下限 | **5 页——仍然塞不进 2 页** |
| HalfHalf | **2 页,8pt** |

注意第二行:这份材料靠手调**根本压不到 2 页**,不是慢,是走不通。

### 那我为什么不直接让 AI 生成一页的内容?

因为把内容塞进 N 页有两个办法——**删内容**和**调排版**——而 AI 只有前一个。同一张 A4,
12pt 单栏装 ≈600 字,8pt 四栏装 ≈3286 字。让 AI 直接给"一页的量",代价是砍掉约 90% 的内容;
走排版这条路,同样这份材料两页装下全文,删了 0%。

**排版是免费的容量,删内容是要付代价的容量。** 正确顺序是先把排版榨干,不够再让 AI 删——
这也正是产品的分层:AI 做压缩(第 ⓪① 层),引擎做页数命中(第 ② 层)。

完整论证、竞争定位与增长策略见 [`PRODUCT.md`](./PRODUCT.md)。

---

## 快速开始

### 环境要求

- **Node.js** >= 20
- **pnpm** >= 9
- **Playwright** 依赖的 Chromium(首次运行需要手动安装一次)

```bash
git clone https://github.com/fu10085cong-ops/halfhalf.git
cd halfhalf
pnpm install
cd packages/server && npx playwright install chromium && cd ../..
pnpm dev
```

- 前端:http://localhost:5173
- 后端 API:http://localhost:3000

前端唯一界面是 Studio 三栏工作台(左 材料 / 中 对话 / 右 功能模块)。

### 导入材料

把 `.docx`、文字型 PDF 或图片拖到左侧任意位置,或点「选择文件」;也支持粘贴网页链接。

- **`.docx`**:保留标题、列表、普通表格、图片和常见文字格式;不照搬字体和原来的分页,
  因为 HalfHalf 会重新寻找适合目标页数的版式。
- **文字型 PDF**:按页提取可复制文字并插入「第 N 页」标记,便于发现漏页和回原文核对。
- **扫描版 PDF**:识别为 `OCR_REQUIRED` 并显示页数,不会把空白内容当成导入成功。OCR 是后续优先级。
- **图片**:保持原图插入 Markdown。

文件走内存上传,**服务端不落盘保存原文件**。转换不是终点:文件概述留在编辑区上方,提取结果可以人工
修正,然后直接进学科/场景规则、可选 AI 精简、目标页数搜索和 PDF 预览。

### 不启动前端,单独验证排版引擎

```bash
cd packages/server

pnpm test                                    # 回归套件(不开浏览器,秒级)
npx tsx test/dump-features.ts                # 全部判例的内容特征 + 规则判定速查(毫秒级)
npx tsx test/run-scene.ts poli-econ.md 2     # 端到端:自动推荐场景 → 排版 → 出 PDF
npx tsx test/run-scene.ts poli-econ.md 2 text-cram   # 强制指定场景(模拟用户改选)
npx tsx test/run-ab.ts poli-econ.md 2        # 拼装变体 A/B:字号/页数/逐页填充率对照
npx tsx test/run-grid.ts os-large.md 2       # 网格引擎单跑
pnpm bench                                   # 性能基线对账(bench-baseline.json)
```

材料在 `test/fixtures/`(覆盖代码高亮、公式、Mermaid、长表格、图片等画像),
PDF 写到 `test/fixtures/<名字>.scene.pdf` 等。

**改引擎之前请先读 [`EXPERIMENT.md`](./EXPERIMENT.md)**——五步实验循环、归因纪律、真材料动线都在那里。
不按流程改,大概率是在给一个错误的归因写代码。

---

## 能力一览

**排版求解**

- **自动字号搜索**:6pt~24pt 二分搜索,找满足页数限制的最大字号;实测页数判定达标,不用估算
- **网格版面模型**:24 列单位格,块宽吸附标准档位,skyline 贪心拼装 + 页内重排(repack)
- **满版收尾**(`stretchFill`,默认开):末页拉宽重排 + 逐块字号微放大,把空隙换成更大的字
- **窄边距**(`marginMm`,3~25mm):6mm 比默认 10mm 多约 7.6% 版面
- **原子块保护**:代码块/公式/图表/表格不会被硬切断到两页之间;超宽原子整体缩放而非裁切

**内容适配**

- **场景预设(分类讨论)**:极限文本 / 理科公式 / 代码密集 / 图文混排 / 均衡默认,按内容特征自动推荐、
  用户可改——背诵型大文本才走极致压缩,公式课公式绝不缩小(宁可升宽档)
- **硬约束取交集**:多类刚性原子并存时保护同时生效,不再选边;公式密度落在模糊带时**双跑实测裁决**
- **排版密度**:紧凑 / 正常 / 宽松 / **极限(cram)**——cram 档照真实半开卷小抄校准
- **学科层**:用户声明学科后启用领域规则(表格是否核心、顺序刚性强弱);关键词只给**建议**,
  用户选中才生效

**格式支持**

标题、列表、表格、代码块(Shiki 高亮)、图片、数学/物理公式(KaTeX)、Mermaid 图表。

**AI(⓪①层)**

- **结构化入口**:任意粘贴内容 → 标准 .md,只重组不新增知识,产物过结构体检
- **语义级精简**:遮罩公式/代码/表格/图片/标题,**只把散文交给 AI**,过三道安全网,
  **只出建议不自动改**
- key 策略:服务器统一 key + 前端 BYOK 覆盖;key 只在单次请求内存中,不落日志不落盘

**导入与重构**

Word / 文字 PDF / 网页 / 图片导入;PDF 逐页质量路由(坏字体页回退原页图像保真);
带页锚点的知识节点 + 可审计、可撤销的重构计划。

**调试**

网格调试视图(勾「显示网格」叠加块边界/档位标签,与正式版排版逐像素一致)、公式预检、
块诊断与逐页填充率。

---

## 文档地图

| 文档 | 管什么 |
|---|---|
| [`DESIGN.md`](./DESIGN.md) | 分层架构(⓪结构化 → ①压缩 → ②自动排版 → ③手动微调)与设计意图 |
| [`RULES.md`](./RULES.md) | **排版决策规则**:力学层通用兜底 + 学科层护城河;判例表、证据等级、缺陷台账 |
| [`EXPERIMENT.md`](./EXPERIMENT.md) | **改引擎的实验流程**:五步循环、归因对照、真材料动线、十分钟北极星演练 |
| [`PRODUCT.md`](./PRODUCT.md) | 产品定位、竞争分析、护城河、增长策略 |
| [`CHANGELOG.md`](./CHANGELOG.md) | 已完成工作的完整经过(判例、数字、踩过的坑) |
| [`packages/server/API.md`](./packages/server/API.md) | **接口契约权威参考**(请求/响应字段、错误码、SSE 事件) |
| [`DEPLOY.md`](./DEPLOY.md) | 部署:服务器要求、HTTPS、环境变量 |

架构一句话:**机器做压缩、初排、渲染、导出;把 AI 做不了的"二维密堆拼图"留给用户手动完成,
同时始终提供一份能用的自动默认版兜底。**

---

## 项目结构

```
halfhalf/
├── packages/
│   ├── server/
│   │   ├── API.md                    # 接口契约(权威)
│   │   ├── src/
│   │   │   ├── index.ts              # Express 入口 + 访问口令中间件
│   │   │   ├── types/index.ts        # 共享类型 & 常量(类型的单一事实来源)
│   │   │   ├── routes/               # scene / ai / export / document-upload / url-import
│   │   │   │                         # / restructure / fixtures
│   │   │   ├── engine/
│   │   │   │   ├── chunk-markdown.ts     # ① 按标题分块,图片自成块,超长块递归细分
│   │   │   │   ├── measure-blocks.ts     # ② 逐块多档位宽度测量(bySpan 存全部候选)
│   │   │   │   ├── pack-blocks.ts        # ③ skyline 贪心拼装(纯算法,栏/格通用)
│   │   │   │   ├── render-layout.ts      # ④ 按矩形绝对定位渲染
│   │   │   │   ├── grid-layout.ts        # 网格版面模型 + 目标页数搜索
│   │   │   │   ├── rule-engine.ts        # 硬约束取交集 + rule trace(RULES.md §三)
│   │   │   │   ├── scene-presets.ts      # 场景预设 + 内容特征统计 + 推荐器
│   │   │   │   ├── subject-rules.ts      # 学科层规则(evidence 必填)
│   │   │   │   ├── adjudicate.ts         # B1 模糊带双跑裁决
│   │   │   │   ├── atom-mask.ts          # 刚性原子遮罩(AI 精简的安全前提)
│   │   │   │   ├── ai-structurize/compress/chat/provider.ts
│   │   │   │   ├── knowledge-ir.ts       # 带页锚点的知识节点
│   │   │   │   ├── restructure-plan/materializer.ts
│   │   │   │   ├── document-import.ts / pdf-visual-renderer.ts / url-import.ts
│   │   │   │   ├── browser-pool.ts       # 共享 Chromium(进程内一次冷启动)
│   │   │   │   └── precheck-formulas.ts  # 公式预检(不开浏览器扫 KaTeX 红字)
│   │   │   └── templates/print.css       # 打印样式(分页/原子块保护/密度档)
│   │   └── test/                     # 判例 fixtures + 实验脚本 + unit 回归锁
│   └── web/
│       └── src/components/
│           └── Studio/               # 三栏工作台(唯一界面)
├── Dockerfile / docker-compose.yml / .env.example
└── DESIGN.md / RULES.md / EXPERIMENT.md / PRODUCT.md / CHANGELOG.md / DEPLOY.md
```

---

## 排版参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 纸张 | A4 | `/api/scene` 固定 A4;引擎本身支持 A4/A5/Letter |
| 方向 | portrait | portrait / landscape |
| 目标页数 | 2 | 1~50;2 = 一张 A4 正反面 |
| 页边距 | 10mm | 四边统一,可传 3~25mm;横版不跟着旋转,仍按物理边 |
| 字号范围 | 6pt–24pt | 二分搜索范围 |
| 搜索精度 | 0.5pt | 可配置 |
| 满版收尾 | 开 | `stretchFill`:末页拉宽重排 + 逐块字号微放大 |
| 行高 | 紧凑 1.05 / 正常 1.15 / 宽松 1.3 / **极限 1.0** | 极限档另附标题行内化、列表缩进减半、表格内边距减半、发丝线分块 |
| 标题梯度 | h1 1.4em / h2 1.2em / h3 1.05em | 压缩版(浏览器默认 2/1.5/1.17em 对小抄太奢侈) |

网格几何(24 列、宽度档位、gutter)由场景与规则引擎决定,见 [`RULES.md`](./RULES.md)。

---

## 核心算法

字号搜索的骨架:

```
function findOptimalFontSize(markdown, targetPages):
  lo = 6pt, hi = 24pt

  # 先探底:最小字号仍超页 → 内容过多,返回"最少页数下的最大字号"作为尽力结果
  if render(lo).pages > targetPages:
    return bestEffort(), withinTargetPages=false

  best = lo
  while hi - lo > precision:
    mid = (lo + hi) / 2
    if render(mid).pages <= targetPages and 无超高截断块:
      best = mid; lo = mid      # 记录可行解,尝试更大
    else:
      hi = mid
  return best, withinTargetPages=true
```

三个容易被忽略的约束:

- **达标 = 页数进目标 且 内容完整**。存在超高截断块的试探不会被选为最优——页数好看但内容被切掉
  不叫成功(例外:最小字号下就超高的块,字号救不了它,退回尽力交付并报 `warnings.oversized`)。
- **Mermaid 只预渲染一次**(图表内部布局不随正文字号变化),后续迭代只改 CSS 变量重新打印。
- **共享 Chromium**:进程内一次冷启动,测量/渲染复用 page,大文本整轮搜索从几十秒降到 2 秒内。

---

## API

接口契约的权威参考是 [`packages/server/API.md`](./packages/server/API.md)。速查:

| 接口 | 说明 |
|---|---|
| `POST /api/scene` | **排版主接口**:统计 → 规则引擎 → 公式预检 → 字号搜索 → 渲染,返回 rule trace / 诊断 / `jobId` |
| `GET /api/download/:jobId/pdf` | 取 PDF,内存保留 30 分钟 |
| `POST /api/ai/structurize` | ⓪ 任意粘贴内容 → 标准 .md(SSE) |
| `POST /api/ai/chat` | 多轮材料对话(SSE,服务端无状态) |
| `POST /api/ai/compress` | ① 语义级精简建议(只出建议) |
| `POST /api/ai/proxy` | 通用 BYOK 转发(域名白名单) |
| `POST /api/import/document` `POST /api/import/jobs` `POST /api/import/url` | 同步导入 / 异步导入任务 / 网页导入 |
| `POST /api/restructure/plan` `…/materialize` | 先出可审计计划,确认后确定性应用 |

错误响应统一 `{ error, code?, details? }`,SSE 的 `error` 事件同形。

---

## 开发计划

### 下一步

- [ ] **部署上线**:配置已就绪(Dockerfile / `HALFHALF_ACCESS_CODE` / DEPLOY.md),
      待做镜像隐私核对(`samples/` 与真实材料不进镜像)与首轮十分钟北极星计时演练
- [ ] **无结构文本兜底切块**:无标题超长文本目前会被当成一个不可拆巨块
      (表现为"首页全白 + 大字 + 内容裁切"),需要按段落切块兜底——也是 AI 入口不可用时的降级
- [ ] **空白利用率**:已知 gutter 与拼装缝隙仍有可回收余量,先固化跨判例基线再动引擎
      (纪律见 EXPERIMENT.md,结论落 RULES.md 缺陷台账)
- [x] **Studio 界面收敛**:2026-07-28 Studio 转正为唯一界面,旧 ScenePanel 退役删除

### 后续版本

- [ ] 网格编辑器(前端):按 `GridSpec` 坐标系做块的拖拽/缩放吸附,自动版做底、人工微调收尾
- [ ] AI 适配器扩展(当前仅 OpenAI 兼容格式,Anthropic / Gemini 待接)
- [ ] 扫描件 OCR
- [ ] DOCX 导出、LaTeX 高级排版模式、模板系统、批量处理
- [ ] 内容社区低成本验证:导出署名水印选项 + 内容冷启动,详见 [`PRODUCT.md`](./PRODUCT.md)

已完成工作的完整经过见 [`CHANGELOG.md`](./CHANGELOG.md)。

---

## License

MIT

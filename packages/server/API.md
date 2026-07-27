# HalfHalf 后端接口参考

给前端集成用的完整接口契约。类型定义的唯一权威来源是 [`src/types/index.ts`](./src/types/index.ts)，
本文档只是把它翻译成带示例的说明——如果两者不一致，以代码为准。

- Base URL：本地开发默认 `http://localhost:3000`
- 所有请求/响应 body 都是 `application/json`，除了 `/api/import/document`（`multipart/form-data`）、SSE 接口（`/api/ai/structurize`、`/api/ai/compress`）和 PDF 下载（二进制流）
- 鉴权：设置了环境变量 `HALFHALF_ACCESS_CODE` 时，所有 `/api/*` 请求须带 `x-access-code` 头（`/api/health` 放行）；未设置则公开可访问
- 时间字段（`timestamp`）统一是 `Date.now()` 的毫秒时间戳

---

## 通用错误响应形状

所有接口的错误——不管是普通 HTTP 4xx/5xx 的 JSON body，还是 SSE 接口的 `error` 事件——
都用同一个形状，前端只需要认一种结构：

```ts
interface ApiErrorResponse {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}
```

---

## `GET /api/health`

健康检查，不在上面的错误形状规则内（不返回错误结构，只有成功一种情况）。

**响应** `200`：

```json
{ "status": "ok", "timestamp": "2026-07-10T08:00:00.000Z" }
```

---

## `POST /api/import/document`

把 Word 或 PDF 转成可编辑 Markdown。请求必须是 `multipart/form-data`，文件字段名为 `file`；只在内存中处理，不写入服务器磁盘。

- 支持 `.docx` 和文字型 `.pdf`，单文件最大 20 MB、PDF 最大 300 页。
- `.doc` 返回 `415 UNSUPPORTED_FILE`；扫描/图片型 PDF 返回 `422 OCR_REQUIRED`，不会返回空白成功。

### 响应 `200`

```ts
{
  markdown: string;
  summary: {
    kind: 'docx' | 'pdf';
    originalName: string;
    sizeBytes: number;
    characterCount: number;
    paragraphCount: number;
    headingCount: number;
    tableCount: number;
    imageCount: number;
    pageCount?: number;
    textPageCount?: number;
    warnings: string[];
  };
}
```

常见错误码：`FILE_TOO_LARGE`、`INVALID_DOCX`、`INVALID_PDF`、`PASSWORD_PROTECTED`、`TOO_MANY_PAGES`、`OCR_REQUIRED`。检测信息（例如扫描件页数）放在可选的 `details` 中。

---

## `POST /api/import/url`

网页链接 → 正文抽取（Readability，小页面退回剥壳 fallback）→ Markdown。响应与
`/api/import/document` 同形（`summary.kind = 'url'`，另带 `sourceUrl` 最终地址）。
网页内容只在本次请求内存中处理；网页图片不导入（仅文本）。

### 请求 body

```ts
{ url: string }   // http/https 链接
```

### 限制与安全

- **SSRF 防护**：目标域名先 DNS 解析，任一地址落在私网/环回/链路本地/CGNAT 段即
  `403 URL_BLOCKED`；重定向手动跟随（≤3 跳）且逐跳复查。`HALFHALF_URL_ALLOW_PRIVATE=1`
  仅供本地联调，生产绝不要开。
- 15s 超时（`504 FETCH_TIMEOUT`）、响应 ≤5MB（`413 PAGE_TOO_LARGE`）、
  content-type 必须是 HTML（`415 NOT_HTML`）。
- 限流：每 IP 每小时 `HALFHALF_URL_RATE_LIMIT` 次（默认 30，`429`）。

常见错误码：`URL_INVALID`、`URL_BLOCKED`、`FETCH_FAILED`、`FETCH_TIMEOUT`、`NOT_HTML`、
`PAGE_TOO_LARGE`、`EXTRACT_EMPTY`（动态渲染/登录墙页面——提示用户直接复制文字粘贴）。

---

## `POST /api/scene`

场景排版一站式接口（网格引擎，ScenePanel 用的就是它）：分块 → 内容统计 → 场景推荐（或用户指定）
→ 公式预检 → 网格字号搜索 → 渲染 PDF 存进 job-store。图片以 data: URI 直接内嵌在 Markdown 里
（前端粘贴/上传时转好），不走服务器文件路径。

### 请求 body

```ts
interface SceneRequest {
  markdown: string;      // 必填，非空
  targetPages?: number;  // 1~50 的整数，默认 1
  scene?: 'auto' | 'text-cram' | 'formula' | 'code' | 'visual' | 'balanced';  // 默认 'auto'（按内容特征推荐）
  orientation?: 'portrait' | 'landscape';  // 默认 'portrait'
  debug?: boolean;       // true = PDF 叠加网格线/块方框/标签（排版本身不变，文件名加「-网格」后缀）
  allowReorder?: boolean; // true = 用户声明「内容顺序可打乱」（RULES.md S2）：开启跨页回填，
                          // 后面的块可填进前面页的缺口换密度；默认 false（保守假定顺序刚性强）
  subject?: string;       // 用户声明的学科 id：'calculus' | 'os' | 'semiconductor' | 'politics'。
                          // 启用学科层规则（os 表=core → H3 表格保护；politics 顺序弱 → 自动回填）。
                          // 省略 = 只走力学层兜底；传未知 id 返回 400
}
```

请求 body 另支持：
- `marginMm?: number`——四边统一页边距毫米（3~25，省略 = 默认 10；6mm 比默认多约
  7.6% 版面，4mm 以下注意打印机物理边界）；
- `stretchFill?: boolean`——满版收尾（默认 true），包含两步：**末页拉宽重排**（多页结果
  且末页填充 <60% 时，末页文字块统一升到通栏、按阅读序堆叠、余量均摊成块间呼吸位）+
  **满版伸展**（逐块微放大字号：非末页 ≤+2pt，末页 ≤+4pt——末页下方多为页底空白，
  字号差异顾虑小、可回收空隙大）；被放大的块在 `diagnostics.blocks[].stretchedPt` 里可见。
  false = 关掉两步，全文严格等字号、版面按搜索原样输出。

搜索达标判据：页数进目标 **且内容完整**——存在超高截断块的试探不会被选为最优
（例外：最小字号下就超高的块，字号救不了，退回尽力交付 + `warnings.oversized`）。

### 响应 `200`

```ts
{
  fileName: string;           // 按文档首个标题自动命名的 PDF 文件名
  stats: ContentStats;        // charCount / displayFormulaCount / inlineFormulaCount /
                              // imageBlockCount / tableCount / codeBlockCount / blockCount
  recommended: {
    scene: SceneId; name: string; reason: string;  // reason 由 rule trace 派生
    warning?: string;         // 多类刚性原子并存的提示（保护已同时生效/取交集，但空间更紧）
  };
  trace: {                    // rule trace：实际触发的排版规则记账（RULES.md §三）
    rule: 'H1' | 'H2' | 'H3' | 'H4' | 'S1' | 'S2' | 'S3' | 'B1';  // H=硬约束，S=软偏好，B1=模糊带双跑裁决
    kind: 'hard' | 'soft' | 'adjudication';
    detail: string;           // 人话：触发条件 + 实际钳制
  }[];                        // 自动模式的参数由 trace 决定；强制预设时仍返回（仅供参考）
  subject: string | null;     // 生效的学科声明（null = 未声明）
  subjectSuggestion: {        // 关键词识别建议；建议 ≠ 声明，用户选了才生效
    id: string; name: string; matchedAliases: string[];
  } | null;
  usedScene: SceneId;         // 实际使用的场景（用户指定则以用户为准）
  usedSceneName: string;
  fontSize: number;           // 搜出的最优字号 pt
  pages: number;              // 实测 PDF 页数
  withinTargetPages: boolean; // 按实测页数判定是否达标
  history: { fontSize: number; pages: number }[];  // 二分搜索轨迹
  warnings: {
    oversized: string[];      // 比整页还高、会被截断的块 id
    cramped: string[];        // 跨满最大档仍需缩到可读下限以下的块 id
    formulaIssues: { blockId: string; blockTitle: string; message: string }[];  // KaTeX 预检错误
  };
  diagnostics: {              // 网页测试台诊断（前端「块诊断」折叠面板的数据源）
    grid: { unitsX: number; unitMm: number; gutterMm: number; widthTiers: number[] };
    blocks: {                 // 每块一行，按阅读顺序
      id: string; title: string; kind: 'text' | 'image';
      span: number;           // 选定宽度档位（格数）
      page: number | null;    // 落页（1-based；null = 未落位）
      heightMm: number | null;    // 盒高（含 gutter）
      scale: number;          // 块内原子最小缩放（含表格）；1 = 未缩
      formulaScale: number;   // 独立公式单独的最小缩放（B1 口径）
      belowMinScale: boolean; oversized: boolean;
    }[];
    pageFill: number[];       // 每页填充率 %（拼装几何估算；有超高块可能 >100）
    overallFill: number;
    elapsedMs: number;        // 本次请求全程耗时（分块→搜索→渲染）
  };
  jobId: string;              // 拿去 GET /api/download/:jobId/pdf
}
```

---

## `GET /api/fixtures` / `GET /api/fixtures/:name`（仅开发环境）

把 `packages/server/test/fixtures/*.md` 暴露给前端「测试材料」下拉，一键载入文本框，
免去手动翻文件夹复制粘贴。`NODE_ENV=production` 时两个接口一律 404（fixtures 里是
个人真实复习材料，且 API 尚无访问门槛）。

```ts
// GET /api/fixtures            → { fixtures: { name: string; sizeKb: number }[] }
// GET /api/fixtures/:name      → { name: string; markdown: string }
// :name 只接受 [\w.-]+\.md，路径穿越一律 400
```

---

## `GET /api/download/:jobId/pdf`

下载最终排版的 PDF。`jobId` 来自 `/api/scene` 响应的 `jobId` 字段。

- 成功：`200`，`Content-Type: application/pdf`，`Content-Disposition: attachment`
- 失败（任务不存在或已过期）：`404` + `ApiErrorResponse`

任务存储在服务进程内存里，**30 分钟后过期**，服务重启也会丢失，前端应该引导用户尽快下载，不要依赖长期可取。

---


## `POST /api/ai/structurize`（SSE 流式）

⓪ 结构化入口（DESIGN.md）：任意粘贴内容（Word 文本/课件/聊天记录）→ 标准 .md。
只重组不新增知识；产物过结构体检（切块健康度 + 巨块 + KaTeX 公式预检），
不合格自动带体检结论追问 AI 一轮（最多一轮）。

```ts
// 请求
{
  content: string;             // 任意文本;超过 HALFHALF_AI_MAX_INPUT(默认 6 万字)返回 413
  provider?: AiProviderConfig; // BYOK(走域名白名单);省略时用服务器统一 key
}
// key 解析顺序:BYOK > 服务器 env(HALFHALF_AI_ENDPOINT / HALFHALF_AI_MODEL / HALFHALF_AI_KEY)> 501
// 限流:每 IP 每小时 HALFHALF_AI_RATE_LIMIT 次(默认 10),超出 429
```

SSE 事件流：

```
event: delta    data: { text: string, attempt: 1 | 2 }   // 增量 md 文本;attempt 变化时前端应清空缓冲
event: retry    data: { problems: string[] }             // 首轮体检不过,即将追问修正
event: result   data: { markdown, check: { ok, problems, blockCount }, attempts }  // 最终结果(ok=false 也返回)
event: error    data: { error: string }
```

---

## `POST /api/ai/chat`（SSE 流式）

多轮材料对话（Studio 中栏）：围绕客户端带来的材料回答问题、按指示改写、给排版取舍建议。
学术诚信红线写死在 system prompt（不做题/不出题库答案/不新增材料外知识）。
服务端**无状态**：材料 + 历史每次全量带上，不落盘不留存。

```ts
// 请求
{
  messages: { role: 'user' | 'assistant'; content: string }[]; // 末条必须是 user
  context?: string;            // 参与对话的材料全文
  provider?: AiProviderConfig; // BYOK;省略时用服务器统一 key
}
// 材料 + 对话总字数超过 HALFHALF_AI_MAX_INPUT(默认 6 万)返回 413
// key 解析与限流与 /ai/structurize 完全同一套(限流窗口共享)
// 服务端只保留最近 12 条历史、单条截 8000 字(engine/ai-chat.ts)
```

SSE 事件流：

```
event: delta    data: { text: string }    // 增量回复文本
event: result   data: { reply: string }   // 完整回复(Markdown)
event: error    data: { error: string }
```

---

## `GET /api/ai/providers`

「AI 设置」下拉的服务商预设清单（静态常量，与 BYOK 域名白名单同源维护，有单测锁）。

```ts
// 响应 200
{ providers: { id, name, endpoint, defaultModel, keyUrl }[] }
// 现有预设:deepseek / qwen(通义·百炼) / zhipu(智谱) / minimax / openai
```

---

## `POST /api/ai/proxy`

通用 BYOK（用户自带 API key）AI 转发接口。后端不理解业务语义（审核/精简/图表重塑等都由调用方自己决定
prompt 内容），只做域名白名单校验后原样转发请求、原样返回上游响应。

### 请求 body

```ts
interface AiProxyRequest {
  endpoint: string;                  // 目标 AI 服务商完整 API 地址，必须 https，域名必须在白名单内
  headers?: Record<string, string>;  // 会与 Content-Type: application/json 合并后转发，用来放 Authorization 等认证头
  body: unknown;                     // 原样 JSON.stringify 后转发，具体形状由目标服务商决定
}
```

**当前白名单域名**：`api.openai.com`、`api.anthropic.com`、`generativelanguage.googleapis.com`、`api.deepseek.com`。
其他域名会被 `400` 拒绝——如果要接入新的服务商，需要改后端代码加白名单，前端传任意域名都不会生效。

### 响应

**透传上游响应**：HTTP 状态码、`Content-Type`、body 都和上游 AI 服务商的原始响应一致，
后端不做任何形状转换。请求校验失败（`endpoint` 缺失/非法/非白名单）时返回 `400` + `ApiErrorResponse`；
转发过程本身出错（网络错误等）返回 `502` + `ApiErrorResponse`。

### 请求示例（OpenAI 兼容格式）

```json
{
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "headers": { "Authorization": "Bearer sk-xxx" },
  "body": {
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "..." }]
  }
}
```

### 安全说明

- key 只存在于单次请求的内存中，服务端不记录日志、不落盘
- 前端**不应该**把用户的 key 打进自己的日志/埋点系统
- 这个接口是不理解业务的**通用转发层**。"AI 语义级精简"已经有了专门的业务接口
  [`POST /api/ai/compress`](#post-apiaicompress)（后端负责分块/遮罩/安全网），不走这个裸转发；
  裸转发留给"审核""图表重塑"等尚未实现的业务，或前端自定义的一次性调用。

---

## `POST /api/ai/compress`

AI 语义级精简（BYOK）：把叙述性文字改写成要点式以省纸，**只出建议、不自动改文档**。
后端负责安全关键的部分——分块、遮罩刚性原子、调用 AI、回填、三道安全网——前端只做
diff 展示与逐块接受/拒绝。**公式/代码/表格/图片/标题从头到尾不进 AI 的输入**（遮罩成
`〔HH数字〕` 哨兵），所以 AI 无从改错它们。v1 只支持 OpenAI 兼容的 `/chat/completions` 形状。

处理流程：`chunkMarkdown` 分块 → 逐块 `maskAtoms` 遮罩刚性原子、只留散文 → 拿用户 key 调 AI
改写 → `unmaskAtoms` 回填 → 三道安全网（①哨兵完整性 ②公式预检 `precheckFormulas` 不引入
新错误 ③剥后正文确实缩短）→ 批量返回逐块建议。任一安全网不过 → 作废该块、`suggested` 保留
原文、`safety.ok=false` 且给出中文原因。BYOK key 同 `/ai/proxy`：只在单次请求内存里，不落盘。

### 请求 body

```ts
interface AiCompressRequest {
  markdown: string;                    // 必填，非空（图片以 data: URI 内嵌，同 /api/scene）
  provider: {
    endpoint: string;                  // 必须 https 且域名在白名单内（同 /ai/proxy）
    model: string;                     // 如 'gpt-4o-mini'
    headers?: Record<string, string>;  // 认证头，BYOK key 放这里（Authorization: Bearer ...）
    temperature?: number;              // 默认 0.2（低温保真）
  };
  blockIds?: string[];                 // 只精简这些块（chunkMarkdown 的 block id）；省略 = 全部正文块
  options?: { minReductionChars?: number };  // 认为"确实精简"的最小缩减字数，默认 4
}
```

**校验规则**（不满足直接 `400 + ApiErrorResponse`）：`markdown` 非空字符串；`provider.endpoint`
合法 https 且域名在白名单内；`provider.model` 非空字符串；`temperature`（若传）>= 0；
`blockIds`（若传）是数组。

### 响应 `200`

```ts
interface BlockSuggestion {
  blockId: string;
  blockTitle: string;
  kind: 'text' | 'image';
  original: string;                    // 该块原始 Markdown
  suggested: string;                   // 改写后；被跳过/被安全网打回时 === original
  charsBefore: number;                 // 剥后正文字数（口径同 /api/scene 的 stats）
  charsAfter: number;
  range: { start: number; end: number };  // 该块在提交那份 markdown 里的字符区间，供前端按降序拼接回写
  skipped: boolean;                    // 纯原子块/图片块/正文过短/未选中 → 未调 AI
  safety: {
    ok: boolean;                       // 三道安全网都过；false 时前端默认不勾选，但仍展示原因
    atomsPreserved: boolean;           // 占位符逐一回来、无丢失/重复/杜撰
    formulaClean: boolean;             // 回填后未引入新 KaTeX 错误
    reason?: string;                   // ok=false 时的中文原因
  };
}
interface AiCompressResponse {
  suggestions: BlockSuggestion[];      // 按文档顺序，含被跳过的块（前端据此对齐/回写）
  summary: { total: number; compressed: number; charsBefore: number; charsAfter: number };
}
```

**回写约定**：前端把提交时那份 markdown 存为快照，用户勾选后按 `range.start` **降序**逐块
`slice` 替换（降序保证靠前偏移不被前面替换挪动），得到新 markdown，再走既有 `/api/scene`。

### 错误

- `400`：参数校验不通过。
- `504`：上游 AI 响应超时。
- `500`：其他失败（`AI 精简失败: <原因>`，如上游返回非 2xx、响应不是 OpenAI 形状等）。

> 单块的 AI 调用失败**不会**让整批失败——那一块记为 `safety.ok=false`、`reason` 含失败原因、
> `suggested` 保留原文，其余块照常返回。

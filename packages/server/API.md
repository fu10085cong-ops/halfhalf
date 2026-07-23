# HalfHalf 后端接口参考

给前端集成用的完整接口契约。类型定义的唯一权威来源是 [`src/types/index.ts`](./src/types/index.ts)，
本文档只是把它翻译成带示例的说明——如果两者不一致，以代码为准。

- Base URL：本地开发默认 `http://localhost:3000`
- 所有请求/响应 body 都是 `application/json`，除了 `/api/optimize`（SSE）和 PDF 下载（二进制流）
- 当前没有鉴权机制，所有接口公开可访问
- 时间字段（`timestamp`）统一是 `Date.now()` 的毫秒时间戳

---

## 通用错误响应形状

所有接口的错误——不管是普通 HTTP 4xx/5xx 的 JSON body，还是 `/api/optimize` 里 SSE 的 `error` 事件——
都用同一个形状，前端只需要认一种结构：

```ts
interface ApiErrorResponse {
  error: string;
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
    rule: 'H1' | 'H2' | 'H4' | 'S1' | 'S2' | 'S3';  // H=硬约束，S=软偏好
    kind: 'hard' | 'soft';
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
  jobId: string;              // 拿去 GET /api/download/:jobId/pdf
}
```

---

## `POST /api/optimize`（SSE 流式）

核心接口：提交 Markdown 和排版参数，服务端二分搜索最佳字号，用 SSE 流式返回搜索过程和最终结果。

### 请求 body

```ts
interface OptimizeRequest {
  markdown: string;           // 必填，非空
  targetPages: number;        // 必填，>= 1
  paperSize?: 'A4' | 'A5' | 'Letter';  // 默认 'A4'
  margins?: { top: number; bottom: number; left: number; right: number };  // 单位 mm，按字段合并默认值，不用传全部四个
  density?: 'compact' | 'normal' | 'loose';  // 默认 'normal'
  precision?: number;         // 字号搜索精度，单位 pt，默认 0.5，必须 > 0
  cleanup?: boolean;          // 是否在排版前跑确定性格式清理，默认 false（不改动原文）
  orientation?: 'portrait' | 'landscape' | 'auto';  // 纸张方向，默认 'portrait'
  columns?: number | 'auto';  // 分栏数，默认 1（单栏）
}
```

**校验规则**（不满足会直接返回 `400` + `ApiErrorResponse`，不会进入排版流程）：

| 字段 | 规则 |
|------|------|
| `markdown` | 必须是非空字符串 |
| `targetPages` | 必须是 >= 1 的数字 |
| `paperSize` | 传了就必须是 `A4`/`A5`/`Letter` 之一 |
| `density` | 传了就必须是 `compact`/`normal`/`loose` 之一 |
| `precision` | 传了就必须是 > 0 的数字 |
| `margins` | 传了的话，`top`/`bottom`/`left`/`right` 都必须是 >= 0 的数字 |
| `orientation` | 传了就必须是 `portrait`/`landscape`/`auto` 之一 |
| `columns` | 传了就必须是 `'auto'` 或 1~12 的整数 |

`orientation` 说明：
- `portrait`（默认）：竖版，跟历史行为一致，只跑一轮搜索
- `landscape`：横版，纸张宽高对调（页边距不跟着转，仍然按 top/bottom/left/right 挂在物理边上），只跑一轮搜索
- `auto`：并行跑竖版和横版两轮完整搜索，取 `optimalFontSize` 更大的结果返回。总耗时接近单轮（两轮并行），但会同时占用两个 Chromium 实例的内存/CPU——多人并发场景下慎用，等浏览器实例池做完之前不建议做成默认值

`columns` 说明：
- 具体数字（默认 `1`）：固定栏数。多栏时正文/代码/公式/图片会在栏内自然流动、跟文字穿插；宽表格会通栏（占满整行宽度）避免被挤进窄栏。
- `'auto'`：引擎在 1~4 栏之间逐个尝试，取能撑出最大字号的栏数。切换栏数只改一个 CSS 变量、复用同一个浏览器上下文，**不会**成倍增加浏览器实例；但渲染次数会随候选栏数增加，耗时相应变长。
- `orientation` 和 `columns` 可以同时为 `'auto'`——此时会在「方向 × 栏数」的组合里全局择优（字号最大者优先，其次页数少、栏数少、竖版）。

请求示例：

```json
{
  "markdown": "# Hello\n\nWorld $E=mc^2$",
  "targetPages": 2,
  "paperSize": "A4",
  "density": "compact",
  "margins": { "top": 8, "bottom": 8, "left": 8, "right": 8 },
  "precision": 0.5,
  "cleanup": true,
  "orientation": "auto",
  "columns": "auto"
}
```

### 响应：SSE 事件流

响应头是 `Content-Type: text/event-stream`，收到请求后立刻建立连接，随二分搜索的每一轮迭代推送事件，
最后以 `result` 或 `error` 事件之一结束并关闭连接。

#### `event: progress`（每轮迭代一次，0 到多次）

```ts
interface IterationRecord {
  fontSize: number;      // 本轮尝试的字号（pt）
  pages: number;         // 本轮渲染出的实际页数
  withinLimit: boolean;  // 本轮页数是否 <= targetPages
  timestamp: number;
  orientation: 'portrait' | 'landscape';  // 本轮测试的纸张方向；只有 orientation='auto' 时才会同时出现两种
  columns: number;                          // 本轮测试的分栏数；columns='auto' 时不同轮次会出现不同栏数
}
```

```
event: progress
data: {"fontSize":12,"pages":7,"withinLimit":false,"timestamp":1234567890,"orientation":"portrait","columns":2}
```

`orientation='auto'` 时，两个方向的搜索并行进行，`progress` 事件会交替出现 `portrait`/`landscape`，
前端如果要分开展示两条进度，用 `orientation` 字段分组即可。

#### `event: result`（成功时，最后一个事件）

```ts
interface OptimizeResult {
  optimalFontSize: number;
  actualPages: number;
  iterations: number;
  history: IterationRecord[];      // 完整的迭代记录，和收到的 progress 事件是同一份数据
  withinTargetPages: boolean;      // false 表示内容过多，最小字号仍超页，返回的是最佳努力结果
  jobId: string;                   // 用于 /api/download/:jobId/pdf 下载对应的 PDF
  orientation: 'portrait' | 'landscape';  // 最终采用的方向；orientation='auto' 时是搜索结果字号更大的那个
  columns: number;                          // 最终采用的分栏数；columns='auto' 时是搜索结果字号更大的那个栏数
}
```

```
event: result
data: {"optimalFontSize":10.5,"actualPages":2,"iterations":6,"history":[...],"withinTargetPages":true,"jobId":"b3f1c2...","orientation":"portrait"}
```

#### `event: error`（失败时，最后一个事件）

```
event: error
data: {"error":"具体错误信息"}
```

### 前端解析 SSE 的参考实现

```ts
const response = await fetch('/api/optimize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(requestBody),
});

const reader = response.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  let eventType = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      // eventType 是 'progress' | 'result' | 'error'
    }
  }
}
```

---

## `POST /api/render`

单次渲染 PDF 预览，**不参与二分搜索**——用户指定一个确定的字号（而不是目标页数），直接渲染一次。
典型用途：用户切换纸张方向（横版/竖版）或调整字号之后，想先看一眼效果，再决定要不要跑完整的
`/api/optimize`。

### 请求 body

```ts
interface RenderPreviewRequest {
  markdown: string;                      // 必填，非空
  fontSize: number;                      // 必填，必须落在 6~24（SEARCH_CONFIG 的范围）之间
  paperSize?: 'A4' | 'A5' | 'Letter';    // 默认 'A4'
  margins?: { top: number; bottom: number; left: number; right: number };
  density?: 'compact' | 'normal' | 'loose';  // 默认 'normal'
  orientation?: 'portrait' | 'landscape';    // 默认 'portrait'；**不支持 'auto'**（单次预览没有"取更优方向"这个概念，orientation 必须由用户自己选定）
  columns?: number;                      // 默认 1；**不支持 'auto'**（同 orientation，预览必须给定具体栏数）
  cleanup?: boolean;                     // 默认 false
}
```

**校验规则**：跟 `/api/optimize` 基本一致，区别是没有 `targetPages`/`precision`，多了必填的
`fontSize`（必须是 6~24 之间的数字）；`orientation` 和 `columns` 传 `'auto'` 都会被拒绝，返回 `400`。

### 响应

**成功**：`200`，直接返回 PDF 二进制流：

- `Content-Type: application/pdf`
- `Content-Disposition: inline`（不是 `attachment`，适合前端用 `<iframe>`/`<embed>` 直接内嵌预览，而不是触发下载）
- `X-Page-Count`：本次渲染的实际页数，放在响应头里，不需要解析 PDF 内容就能拿到

**失败**：`400`（参数校验不通过）或 `500`（渲染过程出错）+ `ApiErrorResponse`。

### 前端典型用法

```ts
const response = await fetch('/api/render', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ markdown, fontSize: 12, orientation: 'landscape' }),
});

const pageCount = response.headers.get('X-Page-Count');
const blob = await response.blob();
const url = URL.createObjectURL(blob);
// <iframe src={url} /> 或 <embed src={url} type="application/pdf" />
```

这个接口不会创建 `jobId`、不会写入 job-store——纯粹是"渲染一次给你看"，预览满意之后要走
`/api/optimize` 正式生成可下载的最终结果。

---

## `GET /api/download/:jobId/pdf`

下载 `/api/optimize` 产出的最终 PDF。`jobId` 来自 SSE `result` 事件里的 `jobId` 字段。

- 成功：`200`，`Content-Type: application/pdf`，`Content-Disposition: attachment`
- 失败（任务不存在或已过期）：`404` + `ApiErrorResponse`

任务存储在服务进程内存里，**30 分钟后过期**，服务重启也会丢失，前端应该引导用户尽快下载，不要依赖长期可取。

---

## `GET /api/download/:jobId/docx`

**尚未实现**，恒定返回 `501` + `ApiErrorResponse`，预留给后续 Pandoc 集成。

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

**当前白名单域名**：`api.openai.com`、`api.anthropic.com`、`generativelanguage.googleapis.com`。
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

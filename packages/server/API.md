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

请求示例：

```json
{
  "markdown": "# Hello\n\nWorld $E=mc^2$",
  "targetPages": 2,
  "paperSize": "A4",
  "density": "compact",
  "margins": { "top": 8, "bottom": 8, "left": 8, "right": 8 },
  "precision": 0.5,
  "cleanup": true
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
}
```

```
event: progress
data: {"fontSize":12,"pages":7,"withinLimit":false,"timestamp":1234567890}
```

#### `event: result`（成功时，最后一个事件）

```ts
interface OptimizeResult {
  optimalFontSize: number;
  actualPages: number;
  iterations: number;
  history: IterationRecord[];      // 完整的迭代记录，和收到的 progress 事件是同一份数据
  withinTargetPages: boolean;      // false 表示内容过多，最小字号仍超页，返回的是最佳努力结果
  jobId: string;                   // 用于 /api/download/:jobId/pdf 下载对应的 PDF
}
```

```
event: result
data: {"optimalFontSize":10.5,"actualPages":2,"iterations":6,"history":[...],"withinTargetPages":true,"jobId":"b3f1c2..."}
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

**尚未实现**，当前恒定返回：

```
HTTP 501
{ "error": "/api/render 尚未实现" }
```

设计意图是"用指定字号单次渲染 PDF 预览，不参与二分搜索"，接口形状还没最终定，先不要在前端接入。

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
- 这个接口目前只是占位转发层，没有接具体的"审核""精简""图表重塑"等业务逻辑，那些 prompt 设计
  和结果处理（diff 展示、人工确认流程等）都需要在前端/后续版本里实现

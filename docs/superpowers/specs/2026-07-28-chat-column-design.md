# 对话栏(中栏)功能设计 — 从咨询台到生产环节

日期:2026-07-28。设计对话中用户拍板:做第一层(体验补齐)+ 第二层(对话产物闭环),
写回确认用 `window.confirm`(与删除材料同一套模式);第三层挂货架。

## 定位

中栏是"工作台叙事流":每个动作留卡,自由对话是其中一种卡。本设计解决两个问题:

1. **体验短板**:回复不渲染 Markdown、流式期间强制滚底、单行输入、无停止、失败无重试。
2. **产物死胡同**:AI 改写得再好,用户只能手动复制。对话产物要能落回材料体系。

## 第一层:体验补齐

- **Markdown 渲染**:`ChatReplyCard` 的流式预览与完成态都经 `marked`(GFM)+ `DOMPurify`
  渲染(新增 `lib/markdown.ts`,两处唯一入口)。只用于 chat 回复卡;转换卡的 `<pre>`
  预览是刻意展示"源码",不动。
- **滚动跟随**:只有原本贴底(距底 < 40px)才自动滚底。用户上翻读旧卡时,流式 delta
  不再把视口拽回去。
- **多行输入**:`<input>` 换自适应高度 `<textarea>`(上限约 6 行)。Enter 发送、
  Shift+Enter 换行,保留 `isComposing` 中文输入法保护。
- **停止**:对话中"发送"按钮变"停止";转换卡 working 态加"停止"入口(中断当前份并
  停掉队列后续)。实现为 `AbortController` 透传 `apiFetch` → `consumeSse` 的
  `reader.read()` 抛 AbortError。对话停止时已流出的部分保留为完成态并标注
  "已手动停止";转换停止不写回半截产物,记为错误卡。
- **重试**:chat 错误卡带"重试"(assistant 卡记住 `prompt` + `scopeIds` 原样重发);
  convert 错误卡带"重试"(按 `sourceId` 重跑,材料已删则不显示)。

## 第二层:对话产物闭环

- **圈定材料**:composer 上方一排材料胶囊(仅列 enabled 且有内容的材料)。默认
  "全部";点某个胶囊 = 只问这份,可继续点选多份;取消最后一份回到"全部"。
  圈定同时解决 token 浪费(大 PDF 不再整本拼进每轮)与写回歧义。
  发送时以当时的圈定拼上下文;`scopeIds` 随消息存档。
- **存为新材料**:回复卡完成后出现。`makeSource(kind:'paste', status:'converted',
  raw = markdown = 回复文本, importSummary:'AI 对话产物')` 落左栏,标题取首个非空行。
  点击后按钮变"已存入左栏"防重复。
- **写回《X》**:仅当该轮圈定恰好一份且该材料仍存在时出现。`window.confirm` 后覆盖
  其 `markdown` 并置 `status:'converted'`。**原文 `raw` 不动**——"从原文重新转换"
  是天然后悔药,不再堆 diff 预览 UI。

## 数据模型增量(`StudioMessage`)

`scopeIds?: string[]`(user + assistant chat 卡)、`prompt?: string`(assistant 卡,
供重试)、`stopped?: boolean`(手动停止标记)。均为会话态,不持久化。

## 不做(货架)

- 对话里"联网补这个洞"快捷入口(复用 research 任务)。
- 自然语言调度排版(tool-calling agent 化)。
- 写回 diff 预览、对话历史持久化。

## 验证

- `tsc --noEmit` + 生产构建。
- 真机回环:本地双服务起着,发一轮真实对话(智谱 key),验证流式渲染、停止、
  存为新材料、写回、圈定材料后上下文确实只含该份(服务端日志或回复内容佐证)。

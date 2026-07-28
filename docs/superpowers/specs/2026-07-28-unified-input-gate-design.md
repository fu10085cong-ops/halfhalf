# 统一输入闸 — 任何材料必须经指定提示词的 AI 转成标准 Markdown 才能排版

日期:2026-07-28。用户明确要求:「任何输入都要经过指定提示词的 AI 以生成 md 文件,
达到统一输入的要求」。指定提示词 = `packages/server/src/engine/ai-structurize.ts`
的 `STRUCTURIZE_SYSTEM_PROMPT`(唯一 `#` 总标题、`##` 分节、LaTeX 公式、GFM 管道表、
保真红线),配 `checkStructure` 体检 + 一轮修正。

## 用户裁决(四问四答)

1. **没配 AI key / AI 挂了** → 明确报错阻断排版,删除所有「跳过 AI」路径;
   错误卡带「去 AI 设置」按钮引导填 BYOK。
2. **图片材料豁免**:data URI 图本身就是标准 Markdown 图语法,无文字可统一,维持直接可用。
3. **联网检索产物算达标**(它有自己的锁格式提示词且带溯源);**对话回复不算**——
   「存为新材料」「写回」时自动再过一遍 structurize。
4. **转换失败 → 中止整次排版**并点名失败材料,绝不 raw 兜底。

## 范围

仅新界面 Studio。旧界面(`components/Scene/`)待退役不动。测试 fixture(仅开发环境、
手工整理过的标准 md)与 localStorage 恢复的 `converted` 状态维持信任。
服务端 `/api/scene` 不加校验——它收纯 Markdown 字符串,无法验证 AI 出处,
闸做在前端漏斗层(`combineForLayout` 是最后一道硬保险)。

## 实现

**漏斗口 = `generate`**(`useStudioActions.ts`):任何入口(中栏「生成 PDF」、右栏招牌卡)
都先自动转换所有 enabled 生料;任一失败 → 中止 + 汇总错误卡(501 时快速失败不刷屏);
用户停止 → 排版取消,已转换的份保留。原 `convertAndGenerate` 并入,`skipAi` 删除。

**内核 `convertText(text, cardTitle, opts)`**:把任意文本经 structurize 转换,自带
完整叙事(用户消息 + convert 卡 + SSE 流式 + 体检),不写 source——写回语义归调用方:

- `convertOne(source)`:成功写回 `markdown` + `status:'converted'`。
- `writeBackChat(target, replyText)`:对话回复过闸后覆盖 `markdown`;**`raw` 永远不动**
  (「从原文重新转换」的后悔药)。失败 target 不变。
- 「存为新材料」:回复落成 **raw** 材料 + 立即自动 `convertSingle`——复用现有转换
  叙事与失败处理(失败即左栏亮「生料待转换」,被闸拦住,不会漏进排版)。

**拼接口径拆分**(`useStudioStore.tsx`):`combineForLayout` 只吃 converted(排版);
`combineForChat` 保留 raw 兜底(对话允许问生料,「先问问这份讲什么再决定转不转」是正当用法)。

**重点规划收口**(`panels.tsx` FocusPanel):materialize 是确定性算子,不能把生料漂白——
生料 PDF 显示"先转换"空态;产物只更新 `markdown` 不再赋 `converted` 身份。

**豁免路径确认**:图片(AddSourceMenu/StudioApp 落地即 converted)、fixture
(StudioRail)、联网检索(panels ResearchPanel,且默认 `enabled:false`)。

## 边界

- 全图片材料:无生料,直接排。图片+生料混合:生料任一失败,整体中止(图片也不排)。
- SourceEditor 对已转换材料的人工编辑不拦——那是用户润色整理稿,不是新输入。
- 501 检测在 `convertText` 的非 SSE 响应分支;`StudioMessage.configError` 驱动
  「去 AI 设置」按钮(convert 错误卡与汇总错误卡共用 `GoAiSettings`)。

## 验证

- 静态:`grep "skipAi|跳过 AI|原文兜底"` 在 Studio 目录零命中;web tsc + 生产构建。
- Playwright 真机:①无可用 AI(BYOK 填坏 key 指向无效端点)时点生成 → 出错误卡、
  `/api/scene` 零请求;②纯图片材料直排成功;③真 AI 下生料自动转换→排版全链路;
  ④「存为新材料」自动过闸、「写回」后 markdown 变而 raw 不变。

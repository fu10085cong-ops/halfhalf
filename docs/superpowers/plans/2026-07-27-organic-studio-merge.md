# 合体计划:Organic 皮 + Studio 骨

2026-07-27 · 用户拍板「合体」。骨 = Studio 方案 B(多材料卡/操作流对话/功能模块,spec b56defe);
皮 = Organic 设计系统(`Organic 三栏设计重构/_ds/.../styles.css` 为 token 唯一真相)+ 高保真稿的
面板语言(28px 圆角面板、neutral-100 内块 20px、pill 按钮、居中弹窗)。设计说明针对的是旧界面,
其「组件级映射」按 Studio 结构改译;旧界面本轮照旧不动(并存期安全网)。

## 改动面(全部在 packages/web)

1. **Token 层**:vendor `src/styles/organic.css`(去掉 Google Fonts @import——国内环境 CSS @import
   阻塞渲染是稳定性风险,Caprasimo/Figtree 回落 system-ui,中文本来就走 Noto Sans SC/PingFang)。
   `App.tsx` 把 StudioApp 改 `React.lazy`——organic.css 只在 `?ui=studio` 时加载,旧界面 token 零污染。
2. **弹窗语言**:新建通用 `Modal.tsx`(.dialog-backdrop/.dialog、Esc、遮罩点击、body 滚动锁、
   aria-modal);右栏栈式面板(精简/诊断/历史/AI 设置)全部改居中弹窗;PdfOverlay 改大尺寸 dialog。
   store:`railPanel` → `modal`。中栏 source 编辑视图保留(骨)。
3. **Studio.css 重写**:面板 28px 圆角 surface、头部 32px 圆徽标 + Caprasimo 品牌、材料卡/消息卡/
   瓦片用 .card/.tag/.btn DS 类、动作条改 composer 胶囊(radius 28、neutral-100)。
4. **接新后端**(三件套的前端落点):
   - 对话输入框进 composer:`POST /api/ai/chat` SSE,context=enabled sources 拼接,历史=kind:'chat'
     消息;新消息 kind 'chat'(role 加 'assistant')。
   - AddSourceMenu「网页 URL」点亮:输入框 → `POST /api/import/url` → 新 source(kind 'url',status raw)。
   - AI 设置弹窗加服务商下拉:`GET /api/ai/providers` 预设填 endpoint/model,附申请 key 链接。
5. **验证**:双端 tsc、Playwright 全流程(加 URL 入口与对话冒烟——对话可用假 501 路径验 UI 错误态)、
   新旧两界面截图目检。

## 风险钉子

- 高度链:面板 `height:calc(100vh-78px)` 改为继承现有 flex 链(minHeight:0 纪律不变),截图验证强制。
- 旧界面回归:organic.css 懒加载隔离;classic 截图对照。
- chat 历史口径:只取 kind:'chat' 的完成消息,动作卡(转换/生成)不进对话历史。

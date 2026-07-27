repo: fu10085cong-ops/halfhalf
branch: main
path: packages/web

## Last sync
date: 2026-07-27T09:20:00Z

### Updated in this project
- 按 Organic 设计系统重做前端外观，功能与后端接口不变
- 三栏工作台布局（材料 / 编辑 / 成果），借鉴 NotebookLM 的信息编排
- 原 `<details>` 二级面板全部改为屏幕居中弹窗（含 PDF 放大预览）
- 新增 `前端设计说明.md`：设计逻辑与落回 React 的实现规范

## Screen map
| 项目文件 | 来源仓库文件 |
| --- | --- |
| HalfHalf 工作台.dc.html | packages/web/src/App.tsx, src/components/Layout/AppLayout.tsx, src/components/Scene/ScenePanel.tsx, src/components/Scene/ChatIntake.tsx, src/styles/global.css, src/types/index.ts, src/api.ts |
| 前端设计说明.md | DESIGN.md, packages/web/src/components/Scene/ScenePanel.tsx, packages/web/src/types/index.ts |

---
name: experiment-loop
description: 当要改排版引擎(拼装/测量/搜索/规则)、调阈值参数、修排版 bug,或要验证一个引擎改动是否真的有收益时使用。
---

# 引擎实验循环

## 核心原则

按仓库根 **EXPERIMENT.md** 的五步循环执行,那是完整规范,本卡片只是入口和速查。

```
① 现象定位 → ② 离线验证方向 → ③ 单变量 A/B → ④ 目检 → ⑤ 固化
```

## 命令速查(均在 packages/server 下)

```bash
pnpm bench                                 # 固定基准跑分 vs 基线(改引擎必跑;--update 入库)
npx tsx test/dump-features.ts              # ① 全判例特征+判定速查(毫秒)
pnpm test                                  # ② 回归套件,不开浏览器(秒级)
npx tsx test/run-ab.ts <fixture> <页数>    # ③ 拼装变体 A/B:字号/页数/填充率
swift test/tools/pdf2png.swift <pdf> /tmp/x  # ④ 转 PNG 目检(macOS)
```

## 两条铁纪律

- **单变量**:一次只切一个开关;老行为必须留参数可复现,否则"提升"无对照。
- **先定量再修**:怀疑 ≠ 证据。先写诊断脚本把问题量化成数字,修完复跑同一脚本对账。

## 固化(⑤)不可省

结论进 `test/unit/`(修过的 bug 必须有回归锁)+ RULES.md(判例表 §1.6、证据等级、缺陷台账 §4)。留在对话记录里的结论等于没有。

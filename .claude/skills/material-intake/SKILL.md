---
name: material-intake
description: 当用户提供新的课程复习材料(真实/AI 整理的 Markdown)想入库、做判例或校准阈值时使用;也适用于用户给的是 PDF/照片等"熟"格式需要引导的情况。
---

# 真材料入库动线

## 核心原则

一份真材料 = 一次校准机会:阈值 ◐→● 的**唯一途径**是真材料(RULES.md §4.2)。每个环节的发现(判错场景、排版翻车)都是新判例,不是麻烦。

## 动线(顺序执行)

1. **拿"生"不拿"熟"**:引擎吃 Markdown 原文。用户给 PDF/照片 → 那是输出不是输入,PDF 可先目检,但校准必须要到 `.md` 原文。
2. **红线自查**(RULES.md §2.4):只收用户**自己整理**的总结(真题/答案/未公开课件原文不收);他人材料须明确同意入库;PII 扫描:
   ```bash
   grep -n "姓名\|学号\|班级\|电话\|微信" <file>   # 命中→删掉再入库
   ```
3. **规范化入库**:存 `packages/server/test/fixtures/<kebab-name>.md`,顶部加来源注释——真实/合成✳️/派生,日期,授权状态,画像预期。
4. **看特征与判定**(毫秒级,不开浏览器):
   ```bash
   cd packages/server && npx tsx test/dump-features.ts <file>.md
   ```
   判定与直觉不符 ≠ 错误,= 发现。对照 RULES.md §1.6 判例表分析。
5. **排版实测 + 目检**:
   ```bash
   npx tsx test/run-ab.ts <file>.md <目标页数>
   swift test/tools/pdf2png.swift test/fixtures/<file>.grid.pdf /tmp/x && open /tmp/x-p*.png
   ```
6. **发现分流**(守门问题,RULES.md §2.4③):"不知道这是什么课,这问题还能被发现吗?"——能 → 力学层(调统计/阈值);不能 → 学科层(orderRigidity/atomRoles)。
7. **固化**:RULES.md §1.6 判例表加行;能校准的阈值把证据等级升 ●(写明出处);确定性行为进 `test/unit/` 回归锁。

## 常见错误

| 错误 | 纠正 |
|---|---|
| 拿合成/派生判例校准阈值 | 合成只锁行为;阈值证据必须真材料(calc-monthly 低估公式数一半的教训) |
| 入库了但判例表/测试没更新 | 没固化 = 下次改引擎就丢;第 7 步不可省 |
| 直接改用户给的原文件 | fixtures 里存副本,Downloads 原件不动 |

---
name: hermes-evolution-inference
description: |
  进化推演增强方法论——把 hermess 左脑引擎的 E0–E4 推演链路、DSH Agent 异结构工具面、以及既有 hermes 技能群深度融合成一条可执行的「推演」流水线。
  核心能力：张力诊断（T1–T5）→ 真相源收敛（E0）→ 验证塔收敛（E1）→ 工程信号入适应度（E2）→ 三方漂移对账（E3）→ pre-mortem 强制闸（E4）→ 三类不外推交付。
  深度融合：hermes-evolution-team（五模式编排 M1–M5）× hermes-translation-loss-reduction（传话层降损 P1–P12）× 工程熵治理（E1–E5）× hermes-risk-assessment（预尸检）× DSH 16 异结构工具（git-snapshot / test-runner / config-diff / deploy-dry-run / perf-regression …）。
  用途：给任何「验证塔假绿 / 装机态漂移 / 左脑空转 / 记忆多份漂移 / 自我修改无闸」的进化闭环做推演治理。
  触发词：进化推演、推演、验证塔、真相源、漂移对账、pre-mortem、premortem、假绿、判别力、破坏夹具、锚点对账、适应度口径、进化闭环推演。
  组合：docs/evolution-inference-2026-10.md（E0–E4 + T1–T5）+ M 系四闸 + KB/09 三态诚实 + hermes 技能群深度融合 + hermess 引擎实测。
metadata:
  cn: "进化推演增强"
  version: "1.0.0"
  license: "MIT"
  geneType: null
  geneId: "hermes-evolution-inference-v1.0"
  parentGeneId: "docs-进化推演方案-E0-E4"
  branch: "fuse:hermess引擎×DSH工具面×hermes技能群"
  fitness: 92
  source: "docs/evolution-inference-2026-10.md 结晶 + hermes 技能群深度融合 + hermess 引擎实测"
  strategies: ["E0","E1","E2","E3","E4","M四闸","三态诚实","T1-T5","M1-M5","P1-P12"]
  triggers: [进化推演, 推演, 验证塔, 真相源, 漂移对账, pre-mortem, premortem, 假绿, 判别力, 破坏夹具, 锚点对账, 适应度口径, 进化闭环推演, 三方对账, 对不上]
  dependencies: ["hermes-evolution-team", "hermes-translation-loss-reduction", "hermes-risk-assessment", "hermes-solution-design", "hermes-debugging"]
  tags: ["进化推演","验证塔","真相源","漂移","pre-mortem","判别力","适应度","锚点","多Agent编排","传话层"]
---

# 🧬 进化推演增强（v1.0）

**第一性原理**：进化闭环最大的风险不是「改不对」，而是**「改完才发现改错了，且没有回滚点」**。三类根因：

1. **验证塔自证假绿** —— 验证者本身坏了也报绿，「验验证者」无限回归（实锤：0.8.6 整屏空白而台架全绿）。
2. **多真相源漂移** —— 文档 / 装机 / 测试三处口径不一，越走越远（实锤：handoff 0.6.0 vs 实际 0.8.8）。
3. **无闸的自我修改** —— mutation 前不预判失败模式，出事只能靠回滚点兜底。

**推演的最高杠杆 = 在动手前，把下一轮改动的失败模式列出来并留证**，而不是改完再补测试。
推演不是预测未来，而是**让「下一轮」在动手前就先被证伪一轮**。

---

## 与既有技能的深度融合矩阵

推演不是新造轮子，而是把已有技能**在一条链路上串起来**。每个环节明确「调哪个技能 + 用哪个 DSH 工具 + 出什么产物」：

| 推演环节 | 融合的 hermes 技能 | DSH 工具面 | 产物 |
|---|---|---|---|
| ① 张力诊断 | `hermes-debugging`（复现→定位）、`hermes-code-review` | `code-audit`、`log-rule-checker` | T1–T5 张力清单（按杀伤力排序） |
| ② 真相源收敛 | `hermes-architecture-design`（口径/分层） | `config-diff` | 单一真相源表 + 派生事实对账 |
| ③ 验证塔收敛 | `hermes-test-generation`（等价类/边界） | `test-runner`、`perf-regression` | 验证塔清单 + 破坏夹具 |
| ④ 信号入适应度 | `hermes-solution-design`（6 维评分） | `perf-regression` | fitness 科目（每笔带 provenance） |
| ⑤ 漂移对账 | `hermes-translation-loss-reduction`（符号态/产物判据） | `config-diff`、`deploy-dry-run` | drift-report 三态（match/differs/unknown） |
| ⑥ pre-mortem 闸 | `hermes-risk-assessment`（预尸检 + 概率×影响） | `git-snapshot`、`deploy-dry-run` | ≥3 失败模式 + 落实状态 + append-only ledger |
| ⑦ 编排执行 | `hermes-evolution-team`（M1 并行发散 / **M2 对抗互审** / M3 流水线 / M4 汇聚 / M5 融合 DAG） | `team`、`workflow`、`subagent` | 进化树谱系 + 互审结论 |
| ⑧ 交付复盘 | `hermes-retrospective`、`hermes-document-writing` | `git-snapshot` | 三类证据（static / unit / live）分报 |

> **融合要点**：推演链路本身**不复述**各技能的方法，只定「什么时候调谁、出什么证据」。
> 方法细节一律 `skill` 工具现载——避免把各技能本体复制成一份冗余文档（工程熵治理 E1：归纳去重）。

---

## 快速上手

| 症状 | 怎么说 | 我做什么 |
|---|---|---|
| 台架全绿但东西是坏的 | `验证塔假绿` | I2：验证塔清单 + 故意破坏夹具验判别力 |
| 装机态和源码对不上 | `做漂移对账` | I4：seed/profile/dist 三方双向 reconciliation |
| 文档数字和实测不一致 | `收敛真相源` | I1：定机器真相源 + 锚点机器对账闸 |
| 自进化老在原地转 | `左脑空转` | I3：工程信号入 fitness + plateau 判别器 |
| 要自我修改但怕出事 | `上 pre-mortem 闸` | I5：≥3 失败模式 + 未落实=不可装活 |
| 跨层评分口径打架 | `统一适应度口径` | I6：先校评分极性再比分数 |
| 想让多 Agent 接手推演 | `组队推演` | ⑦：载入 `hermes-evolution-team` 用 M2 对抗互审 |

---

## 推演模式库（结晶自 E0–E4，融合 hermes 技能群）

### I1 真相源收敛（E0 · 张力 T4 记忆漂移）
- **场景**：版本 / 台架数 / 模型名在 handoff、README、AI_STATE 三处各写一份，越走越远。
- **做法**：每类事实定**一个机器真相源**（版本 = `package.json.version`；台架数 = `run-all` 实测；活模型 = 运行时上下文，不硬编码），其余全是派生事实；派生处必须能被**机器复算对账**（锚点段漂移即红）。
- **融合**：口径设计用 `hermes-architecture-design`；层间 diff 用 `config-diff`。
- **经验**：文档里写死的数字是「声明」，跑出来的数字是「事实」；两者之间必须有一道机器闸，否则必然漂移。

### I2 验证塔收敛（E1 · 张力 T1 验证塔无限回归）
- **场景**：台架自身假绿——被测物整屏空白，台架却报全绿。
- **做法**：所有 verifier（`hermess/test`、`hermess/verify`、`scripts/bench-*`、`scripts/probe-*`）登入**验证塔清单**，每项标注 verify-product / verify-verifier；**验证层上限 3**（静态 → 执行级 → 渲染关），第 4 层判「成本 > 边际」；**判别力自证**升为一阶闸门——每 N 轮跑一次故意破坏的夹具，必须报红。
- **融合**：夹具生成用 `hermes-test-generation`（等价类 + 边界值）；执行用 `test-runner`；基线用 `perf-regression`。
- **经验**：测试绿 ≠ 被测物好，只等于「测试认为被测物好」。**破坏夹具是唯一能证明测试还有牙齿的手段。**

### I3 工程信号入适应度（E2 · 张力 T3 左脑空转）
- **场景**：自进化停滞 24 轮、`forceExplore` 单调循环、novelty≈0——它根本没吃工程侧真实信号。
- **做法**：bug 类别 / 台架回归 / 回滚点 / 装机漂移 → 结构化为 **fitness 输入科目**，每笔带 provenance；加 **plateau 判别器**区分「任务空间饱和」vs「信号太弱」。
- **融合**：6 维评分极性用 `hermes-solution-design`；量化基线用 `perf-regression`。
- **经验**：判 `saturated` 与判 `signal-weak` 是两个完全不同的修复方向，混为一谈会把资源投错地方。

### I4 三方漂移对账（E3 · 张力 T2 装机态三向漂移）
- **场景**：seed / profile / dist 三向漂移，装机线与工作区线**并行进化**——改 A ≠ B。
- **做法**：三方 reconciliation 一阶化，drift-report 三态（match / differs / unknown）逐条可复核；**双向**漂移显式报，不只报「源比新」。
- **融合**：传话层符号态用 `hermes-translation-loss-reduction`（别回传原始目录清单，回传三态符号）；发布前用 `deploy-dry-run`。
- **经验**：漂移不是「谁旧谁新」，而是**「两条改动线」**；单向对账会把双向分叉误判成单向陈旧。

### I5 pre-mortem 强制闸（E4 · 进化推演一阶化）
- **场景**：mutation 直接上，失败模式事后才想到，出事只能回滚。
- **做法**：每轮 mutation **前**强制结构化 pre-mortem：**≥3 条失败模式**，每条含 触发条件 + 对策 + **落实状态**；**未落实 = 不可装活**（hold/abort）；落 append-only ledger 可回放，与 lineage DAG 双向关联。
- **融合**：风险矩阵用 `hermes-risk-assessment`（概率 × 影响）；回滚点用 `git-snapshot`（**先留点再动手**）；干跑用 `deploy-dry-run`。
- **经验**：pre-mortem 的价值不在「写了」，在**「未落实的对策真的拦住了装活」**。

### I6 适应度口径统一（E5 · 张力 T5 三层口径不一）
- **场景**：左脑 / 右脑 / 多 Agent 技能三层的适应度极性与来源口径不一（实锤：solution-design 评分极性倒置 1/11 → 11/11）。
- **做法**：先定**评分极性 + 来源语义**的统一口径，再比分数；跨层比较前先做**极性校验**。
- **融合**：决策可解释性用 `hermes-decision-analysis`。
- **经验**：口径不一时，分数越高越危险——它给的是**错觉**。

---

## 通用执行协议（推演 SOP · 融合链路）

```
0. 载入技能   → skill-route 定位 + skill 现载方法（不复述）
1. 张力诊断   → hermes-debugging / code-review + code-audit          出 T1–T5 清单
2. 定边界标准 → hermes-architecture-design + config-diff             出真相源表
3. 留回滚点   → git-snapshot（机械快照 + 手工副本）                   出 pointId
4. 补破坏夹具 → hermes-test-generation + test-runner                 出「改前红」证据
5. 动手修改   → 按 M 系四闸推进（大改动走 M2 对抗互审）
6. 台架全绿   → test-runner + perf-regression + 破坏夹具复跑
7. 交付复盘   → 三类证据分报（static / unit / live），缺口如实写 UNVERIFIED
```

- **可逆优先**：任何删除/覆盖类操作先 `git-snapshot` 留点，或走软隔离（工程熵治理 E2）。
- **治根因不治现象**：数字漂移先补机器对账闸，别去逐个手改文档；重复脚本先抽公共层（E1）。
- **文档即世界模型**：现状与规划必须分开写，避免 AGI 据错误世界模型决策。

---

## 安全原则（M 系四闸 · 继承自进化引擎）

1. **先台架后装活** —— 改之前先让夹具在当前代码上**复现缺陷**，改之后再复跑。
2. **回滚点先留** —— 机械快照（`git-snapshot`）或手工副本，**先留点再动手**。
3. **不注水** —— 缺证据写 `UNVERIFIED` / 「未执行」，绝不写「通过」；缺基线时**报错**而非「0 回归」。
4. **双通道** —— 优先走可执行工具（JSON 面）；跨边界调用要**如实说明**哪一步走不通。
5. **三类不外推** —— **static**（文档/闭集）· **unit**（单测）· **live**（真实端点）**分报**，缺哪类写哪类未执行。

---

## 反模式（pitfall）

- **改完再补测试**：测试是给未来自己的闸，不是这次改动的补丁。
- **用「全绿」当结论**：没跑过破坏夹具，就无法断言测试还有判别力。
- **单向对账漂移**：把双向分叉当单向陈旧，修一边漏一边。
- **无闸的自我修改**：自我修改必须有 pre-mortem + 回滚点**双保险**，缺一不可装活。
- **口径未定先比分数**：跨层适应度比较前先校极性，否则高分即错觉。
- **把方法全文抄进推演文档**：各技能各有本体，推演链路只定「何时调谁」——复制即熵增（工程熵治理 E1）。

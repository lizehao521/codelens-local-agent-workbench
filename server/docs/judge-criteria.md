# 判据塔（Judge）判据说明

本文档描述判据塔的分层结构、L0 机械判据的通过条件与阈值、`unexec` 与 `pass` 的区别，以及覆盖率的口径。

依据源码：`src/services/judge/criteria.ts`、`src/services/judge/types.ts`。

---

## 1. L0–L3 分层

判据塔分四层，类型为 `JudgeLayer = 'L0' | 'L1' | 'L2' | 'L3'`。分层的基本原则是：

> 低层不能替高层签字，高层不能替低层免责。

| 层 | 关注点 | 说明 |
| --- | --- | --- |
| **L0** | 机械判据 | 只回答「格式 / 字段 / 阈值是否成立」，不判语义、不判对抗。每条判据都是纯函数：同样的证据必然得到同样的判决，因此可被单测与破坏夹具钉死。 |
| **L1** | 结构化 / 过程层 | 在 L0 之上对运行过程做结构化判定。 |
| **L2** | 语义层 | 判语义。对解释型目标，语义层可能给出「不适用」结论（见 `weightExcluded`）。 |
| **L3** | 对抗层 | 判对抗。 |

补充约定：

- 每条判据都必须能被破坏夹具打红，否则它不是判据，是装饰。
- 判决必须能指回它读过的证据 τ（`evidenceRef`），否则结论不可追溯。
- 每层有可用性声明 `LayerProfile`：`available` 说的是**本进程是否有能力产出非 unexec 判决**，是能力声明，不是本次结果；`required` 表示未执行时不得判 pass，required 层留空必须判 `inconclusive`。
- 层不可用时要记录原因 `LayerUnavailableReason`，三种原因分开记，以便区分「没接线」和「上游没跑」：
  - `assessor_not_wired`：评估器未接线（工程欠账）；
  - `depends_on_unavailable`：依赖的上游层不可用（运行时事实）；
  - `not_declared`：未声明。

---

## 2. L0 判据的通过条件与阈值

### 2.1 阈值来源与安全区间

L0 阈值来自 π 的 `thresholds` 面。为遵守「不得改判据的度量口径来迁就结果」，所有可调阈值都被 clamp 在安全区间内：**自我修改可以把闸拧紧，但不允许把它拧松到失效。**

| 阈值 | 默认值 | 安全区间 | 含义 |
| --- | --- | --- | --- |
| `minToolSuccessRate` | `0.6` | `[0.2, 1]` | 工具调用成功率**下限**。最高只允许提到 1.0；不得低于 0.2，否则「几乎不做成事」也算通过。 |
| `maxApprovalRejectionRate` | `0.5` | `[0, 0.8]` | 审批拒绝率**上限**。最低允许收到 0；不得高于 0.8，否则「大半被拒」也算健康。 |
| `maxBudgetUsageRate` | `0.9` | `[0.3, 1]` | token 预算使用率**上限**。 |

`resolveThresholds(raw)` 的收敛规则：

1. 候选值必须是有限数字，否则**回落到默认值**（而不是区间下界）。下界是留给「合法但极端」的自我修改的；拿它兜脏数据会把判据意外拧到最严（例如预算上限被压到 30%），制造假红。
2. 合法值再 `clamp` 进上表的安全区间。

### 2.2 工具成功率（`tool.success_rate`）

**通过条件**：成功率 ≥ `minToolSuccessRate`（默认 0.6）。

**分母口径**：只统计**终态**调用，即 `status ∈ {success, failed, timeout, rejected}`。`pending` / `running` 是「还没发生」，把它们计入分母会把「刚起手」误判为失败。

**分子口径（关键）**：**「工具状态 success」≠「做成了事」。**

- 命令执行的 `success` 只表示「命令跑完了」：`npm test` 返回 1、`git diff --exit-code` 返回 1、`tsc --noEmit` 报错，同样是 `success` 状态。若按 status 统计，「命令能跑」会被记成「代码正确」，判据塔就会凭这个数字给出错误结论。
- 因此：**凡是带真实 `exit_code` 的调用（`sys.exec` 等命令执行类工具）一律看 `exit_code === 0`**；`success + exit_code !== 0` 必须算失败。
- 没有 `exit_code` 的调用（其余内置工具，`exit_code` 为 `undefined`，表示该工具没有退出码这个概念）沿用 `status` 判定。

这条不看工具状态，看的是工具**报出来的执行结果**。

### 2.3 审批拒绝率

**通过条件**：拒绝率 ≤ `maxApprovalRejectionRate`（默认 0.5）。证据来自 `JudgeEvidence.approvals`（`status` / `decision`）。

### 2.4 预算使用率

**通过条件**：token 预算使用率 ≤ `maxBudgetUsageRate`（默认 0.9）。证据来自 `JudgeEvidence.usage`（`promptTokens` / `completionTokens`）与 `tokenBudget`。

### 2.5 运行期信号

`JudgeEvidence.circuitOpened` 记录本轮是否触发过熔断，作为 L0 判决的输入信号之一。

---

## 3. `unexec` 与 `pass` 的区别

判决状态是三态：`VerdictStatus = 'pass' | 'fail' | 'unexec'`。

- **`pass`**：判据**执行了**，且满足通过条件。这是绿灯。
- **`fail`**：判据执行了，且不满足通过条件。这是红灯。
- **`unexec`**：该判据**本次未能执行**。它是一等状态，不是「没填」。没有证据时诚实的判决是「未执行」，**既不是绿灯也不是红灯**（UNEXEC ≠ PASS）。

由此派生的规则：

- 未执行时**不得判 pass**；`required` 层留空必须判 `inconclusive`。
- 一次运行的总体结论 `RunVerdict = 'pass' | 'fail' | 'inconclusive'`，其中 `inconclusive` = 无失败但覆盖率不足，即「未验证」。
- 每条判决带 `detail`（人类可读的判定理由，写清「为什么是这个状态」）与 `score`（0–1 连续得分，仅在该判据本身是量化判据时有值）。
- `weightExcluded`：该判据「不适用」而不是「通过了」。它仍计入 coverage（确实产出了结论），但**不参与 `run.score` 的均值** —— 否则「语义层不对解释型目标判完成度」这种不适用结论会被算成 1.0，把解释型任务的分数抬高。

---

## 4. 覆盖率口径

覆盖率的分母**必须只算本进程真正有能力判定的层**（`available === true` 的层）。

- 旧口径把恒不执行的 L2/L3 也塞进分母，于是 `5/8 = 0.625` 就能过 `0.6` 的门槛 —— 「什么都没测到」被算成了「测得差不多了」。
- `available` 是**能力声明**，不是结果。因此不可用层不进入分母。
- `unexec` 的判据不产出结论，不计入通过也不计入失败；`weightExcluded` 的判据计入 coverage 但不参与分数均值。
- 覆盖率不足时，即使没有任何 `fail`，总体结论也只能是 `inconclusive`（未验证），不能是 `pass`。

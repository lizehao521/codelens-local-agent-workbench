# RSI 闭环（Recursive Self-Improvement Loop）

> 本文只描述 **L1 机械桥** 已落地的部分，以及 L2（Anchor）的设计意图。
> 事实来源：`src/services/rsi/manifest-builder.ts`、`src/services/rsi/rsi-bridge.service.ts`（各读前 80 行）。
> 凡标注「设计意图 / 未实现」的段落，均**不是**当前代码行为。

---

## 1. 链路总览

```
Improve(π) = π → Act → τ → Judge → r → Update → π'
```

| 阶段 | 符号 | 含义 | 当前实现位置 |
|---|---|---|---|
| 策略 | `π` | 上一代 Agent 策略（提示词 / 工具集 / 阈值） | 上一轮成功判决的 `AgentRunResult` |
| 执行 | `Act` | Agent 真跑一轮：工具调用、审批、预算消耗 | 运行期 |
| 轨迹 | `τ` | 本轮产生的轨迹与读数（tool_calls、审批事件、token 消耗、终止/熔断事件） | 运行期落库 |
| 判决 | `Judge` | 把 τ 压成 `CriterionVerdict[]`（三态 + 可选 score） | `JudgeService` |
| 回报 | `r` | 跨代对比结果：improved / not_improved / refused / undecidable | `krsi` CLI（`Judge(prev, next)`） |
| 更新 | `Update` | 依据 r 决定是否接受 π' | 旁路对账，**不阻断主流程** |
| 新策略 | `π'` | 下一代策略 | 下一轮 |

关键点：`Judge` 是**单代内**的判据塔（三态 verdict），`r` 是**跨代**的对比结论。
两者之间由 `manifest-builder` 做翻译：`CriterionVerdict[] → RsiManifest`。

```
AgentRunResult(prev) ──┐
                       ├─► buildManifest ─► prev Manifest ─┐
CriterionVerdict[](next)┘                                  ├─► krsi Judge(prev,next) ─► r
                       └─► buildManifest ─► next Manifest ─┘
```

---

## 2. Manifest 契约（L1 翻译层的硬约束）

`manifest-builder` 是**纯函数、无副作用、无 DB 依赖**，因此可以单测钉死。它把判据名映射成 RSI 指标名，
这张映射表是「判据名 → RSI 指标名」的**唯一真相源**：

| 判据名 | RSI metric | direction | basis | role |
|---|---|---|---|---|
| `tool.success_rate` | `tool_success_rate` | up | 1 (measured) | guard |
| `approval.friction` | `approval_friction` | down | 1 (measured) | guard |
| `task.terminal` | `task_terminal` | up | 1 (measured) | guard |
| `loop.health` | `loop_health` | up | 1 (measured) | guard |
| `tool.discipline.write_gate` | `tool_write_coverage` | up | 1 (measured) | guard |
| `semantic.task_completion` | `completion_score` | up | 1 (measured) | objective |
| `semantic.completion`（深判） | `semantic_completion` | up | 2 (relayed) | objective |

**role 的语义（这是 R5 可判的前提）：**

- `objective`（目标）：必须**严格变好**。它是「能力有没有真的提升」的唯一口径。
- `guard`（护栏）：只要求**不得变差**，持平可以。成功率 100%、覆盖率 100% 这类指标天生有天花板，
  到了顶就不可能再「严格变好」；把它们当目标会让 R5 永远否掉真实进步 —— 那是角色错配，不是没进步。

`budget.efficiency` **刻意不进** readings：成本是 L0 闸（用量 > 90% 预算即 fail），不是「越低越好」的目标。
把它当目标会与学习直接冲突 —— π 每多一条经验，prompt 就更长、成本必然上升，于是「越学越贵」会被判成「越学越差」。

为什么读数全部来自实测：`tool_success_rate` / `approval_friction` / `task_terminal` / `loop_health` 都来自
**真发生的事件**（真跑的 tool_calls、真发生的审批、真运行期的终止/熔断），不是转述、估算或模型自述。

`basis` 取值域固定为 1–5：

| basis | 名称 | 含义 |
|---|---|---|
| 1 | measured | 实测 |
| 2 | relayed | 转述（必须带 `source`） |
| 3 | estimated | 估算 |
| 4 | model_says | 模型自述 |
| 5 | absent | 量不到（必须带 `why_absent`） |

`tool_write_coverage` 特意做成**连续值 0–1** 而非二值 pass/fail：每补一个工具的写闸测试，它就严格上升一格，
跨代对比才看得出进步；若只有二值，补到 9/10 仍是 fail，RSI 完全失明。

---

## 3. krsi 四态 exit code

`krsi` 的退出码就是判决本身（语义来自 `krsi main.go`）：

| exit code | state | 含义 | 处置 |
|---|---|---|---|
| `0` | `improved` | 算数：读数支持改进 | 接受 π' |
| `1` | `not_improved` | 读数不支持改进 | 保留 π |
| `2` | `refused` | 拒收，并**点名**违反哪条 R 判据 | 修 manifest / 修判据，不重试 |
| `3` | `undecidable` | 量不到（数据不足，无法判定） | 补证据，或降级为 skipped |

**任何其他 exit code** → 视为 **bridge 自身故障**（krsi 找不到 / 构建挂了 / 超时），
映射为 `state='error'`，`exitCode` 保留原值供审计。

bridge 层还有两个**非 krsi** 状态：

- `skipped`：首次运行（无 prev Manifest），不 spawn krsi，直接写 `verdict=skipped`，`exitCode=null`。
- `error`：spawn 失败 / 超时（默认 10s）/ 报告解析失败，`exitCode=null` 或原始码。

失败**不阻断主流程**：所有异常被 catch，只 `console.warn`（与 `JudgeService.judgeDeep` 同口径）。

---

## 4. R1–R6 判据

`krsi` 在 `Judge(prev, next)` 里逐条校验。以下 R1、R5 由源码注释直接确认，其余为契约约束的归纳：

| 判据 | 内容 | 违反后果 |
|---|---|---|
| **R1** | Manifest 结构合法性：`direction ∈ {up, down}`、`basis ∈ 1..5`、`absent` 必带 `why_absent`、`relayed` 必带 `source`、比率型读数带正数 `denominator` | `refused`（exit 2） |
| **R2** | 指标可比较：两代同名 metric 的 `direction` 与 `basis` 必须一致，否则不可比 | `refused` |
| **R3** | 证据充分性：`basis=5 (absent)` 的指标不参与改进判定；关键指标全 absent → 不可判 | `undecidable`（exit 3） |
| **R4** | 单调性：至少一个 metric 严格变好，且**没有任何** metric 变坏 | 否则 `not_improved`（exit 1） |
| **R5** | 同名对比较：只比**同名** metric 对，跨代缺失的 metric 不参与（也不惩罚） | 缺失即跳过 |
| **R6** | 无回归闸：`direction=down` 的指标（如 `approval_friction`、`budget_efficiency`）不得上升 | `not_improved` 或 `refused` |

> 注：R2/R3/R4/R6 的具体编号归属以 `microkernel-rsi` 的 `risk` 包为准；本文按契约语义归纳，
> 若与上游实现冲突，以上游为准。

---

## 5. Anchor 哈希链（L2，设计意图）

**当前状态：L1 未实现 Anchor。** 账本 JSONL 只作为 artifact 落盘（`dbDir/rsi/` 下，每 session 独立账本），
`RsiBridgeResult.ledgerPath` 指向它，但**没有**链式锚定。

L2 目标：让「第 n 代判决」不可篡改、可离线复算。

```
anchor_0 = H(genesis)
anchor_n = H( anchor_{n-1} ‖ H(evidence_preimage_n) )
```

- `H` = SHA-256（与 `manifest-builder` / `rsi-bridge.service` 已引入的 `node:crypto` 同源）。
- 链式性质：改动任意一代的证据，`anchor_n` 及其后所有 anchor 全部失效 → 篡改可检测。
- 账本每行追加 `{ gen, anchor, prev_anchor, evidence_hash, verdict, exit_code }`，只追加不重写。

---

## 6. 证据原像（evidence preimage）

「原像」= 被哈希的**规范化字节串**。哈希只对原像负责，所以原像必须可确定性重建：

```
evidence_preimage_n = canonical_json({
  gen:            n,
  producer:       "codelens-agentkernel",
  prev_manifest:  <prev RsiManifest>,
  next_manifest:  <next RsiManifest>,
  verdict:        "improved" | "not_improved" | "refused" | "undecidable",
  exit_code:      0 | 1 | 2 | 3,
  reasons:        [ ... ],
  metrics:        [ { metric, before, after, better } ],
  report_raw:     "<krsi 原始报告>"
})
```

规范化规则（保证跨机器同字节）：

1. 对象键按字典序升序排列；
2. 无多余空白（compact），UTF-8 编码；
3. 数字用最短往返表示，禁止 `-0`、禁止科学计数法抖动；
4. 数组保持语义顺序（`metrics` 按 metric 名字典序，`reasons` 按产生顺序）；
5. 不含时间戳、不含随机数、不含绝对路径 —— 否则原像不可复算。

复算流程：从账本取 `prev_manifest` / `next_manifest` / `report_raw` → 重建原像 → 重算 `H` →
与账本 `evidence_hash` 比对 → 再沿 `prev_anchor` 回溯到 `anchor_0`，全链通过才算证据可信。

---

## 7. 一句话总结

`π` 真跑出 `τ`，`Judge` 把 `τ` 压成三态 verdict，`manifest-builder` 把 verdict 翻成 Manifest，
`krsi` 用 R1–R6 做跨代对比给出四态 exit code，`Update` 据此决定是否接受 `π'`；
L2 用 anchor 哈希链把每一代的证据原像钉死，使「改进」这件事可审计、可复算、不可事后美化。

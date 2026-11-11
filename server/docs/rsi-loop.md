# RSI 闭环（Recursive Self-Improvement Loop）

> 本文只描述 **L1 机械桥** 与 **L2（Anchor）** 已落地的部分。
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
| 回报 | `r` | 跨代对比结果：improved / not_improved / refused / undecidable（krsi 四态），另有 bridge 两态 skipped / error（共 6 态，见 §3） | `krsi` CLI（`Judge(prev, next)`） |
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
| 2 | relayed | 转述（无必带字段） |
| 3 | estimated | 估算 |
| 4 | model_says | 模型自述（必须带 `source`） |
| 5 | absent | 量不到（必须带 `why_absent`） |

必带字段口径以 `server/krsi/main.go:232-237` 为准：**仅 `basis=4 (model_says)` 必带 `source`、
`basis=5 (absent)` 必带 `why_absent`；`basis=2 (relayed)` 无必带字段**。`basis` 取值域由
`main.go:226-228` 校验，越界（不在 1–5）即 R1 拒收。旧版把「必须带 `source`」记在 `relayed(2)` 上是错的，
勘误登记见 `RSI-HANDOVER-2026-11-10-PM.md` §10。

`tool_write_coverage` 特意做成**连续值 0–1** 而非二值 pass/fail：每补一个工具的写闸测试，它就严格上升一格，
跨代对比才看得出进步；若只有二值，补到 9/10 仍是 fail，RSI 完全失明。

---

## 3. krsi 四态 + bridge 两态（exit code / verdict state）

`krsi` 的退出码就是判决本身（语义来自 `server/krsi/main.go:73-79,507-538`）。
`RsiVerdictState` 共 6 态（`rsi-bridge.service.ts:33`）：krsi 四态 + bridge 两态。
中文标签与 tone 与 `server/docs/rsi-rules-contract.md` 逐字一致：

| exit code | state | 中文标签 | tone | 含义 | 处置 |
|---|---|---|---|---|---|
| `0` | `improved` | 已改进 | success | 算数：读数支持改进 | 接受 π' |
| `1` | `not_improved` | 未改进 | warning | 读数不支持改进 | 保留 π；归因器写回 π' 供下一代 |
| `2` | `refused` | 拒收 | danger | 拒收，并**点名**违反哪条 R 判据 | 修 manifest / 修判据，不重试 |
| `3` | `undecidable` | 无法判定 | warning | 量不到（数据不足，无法判定） | 补证据，或降级为 skipped |
| `null` | `skipped` | 跳过 | muted | 首次运行（无 prev Manifest），不 spawn krsi | 直接写 `verdict=skipped`，下一代自然进入对账 |
| `null` | `error` | 桥接故障 | danger | bridge 自身故障：krsi 找不到 / 构建挂了 / 超时（默认 10s）/ 报告解析失败 | `exitCode` 保留原值供审计，不阻断主流程 |

**任何其他 exit code** → 视为 **bridge 自身故障**（krsi 找不到 / 构建挂了 / 超时），
映射为 `state='error'`，`exitCode` 保留原值供审计。

bridge 层两个**非 krsi** 状态的触发条件：

- `skipped`（跳过 / muted）：首次运行（无 prev Manifest），不 spawn krsi，直接写 `verdict=skipped`，`exitCode=null`。
- `error`（桥接故障 / danger）：spawn 失败 / 超时（默认 10s）/ 报告解析失败，`exitCode=null` 或原始码。

失败**不阻断主流程**：所有异常被 catch，只 `console.warn`（与 `JudgeService.judgeDeep` 同口径）。
「目标饱和」记 `undecidable / exit 3`（`main.go:524-530`），「目标没变好」记
`not_improved / exit 1`（`main.go:531-537`），是两条不同分支，都正确。

---

## 4. R1–R6 判据（以 `server/krsi/main.go` 为准）

本节按内核实现逐条重写。**真相源是 `server/krsi/main.go`**（本地锚点），不是归纳；
文档准绳见 `server/docs/rsi-capability-sedimentation.md` §5，人类可读的现行契约见
`server/docs/rsi-rules-contract.md`。旧版 §4 有两处外置表述（把编号归属指向仓库内并不存在的包、
并把冲突交由外部实现裁定），本轮一并删除：六条规则的编号、判断标准与执行顺序一律以 `main.go` 为准。

`main.go:78` 声明 `criteriaDeclared = "R1 R2 R3 R4 R5 R6"`（报告按编号打印，`main.go:574`），
但**编号顺序 ≠ 执行顺序**。实际固定执行顺序（`main.go:463-495`）为：

```
R1 → R2 → R3 → R4 → R6 → R5
```

`R6.order=5`、`R5.order=6`：R6 是前置拒收，在 R5 严格比较之前执行；`compare` 在
`main.go:495`，四态 `switch` 在 `main.go:507-538`。任一条拒收命中即整代拒收，不再执行后续拒收规则
（`if refuse == ""` 短路，`main.go:469-493`），但 `compare` 与账本写入仍会执行以留痕。

| 判据 | 名称 | 类别 | 适用条件 | 判断标准 | 违反后果 | 处置要求 | 结果状态 / 退出码 | 依据行号 |
|---|---|---|---|---|---|---|---|---|
| **R1** | schema 合法 | 拒收 | 对 `prev`、`next` 两份 Manifest 各执行一次 | `producer` 非空、`generation >= 0`；每条 reading 的 `metric` 非空、`basis ∈ 1..5`、`direction ∈ {up, down}`、`basis=4 (model_says)` 必带 `source`、`basis=5 (absent)` 必带 `why_absent`、`denominator` 若给出必须为正 | 整代 `refused`（exit 2），理由以 `R1:` 点名 | 修 manifest（补 `source` / `why_absent` / 正 `denominator`）；同一代不重跑，下一代以新 generation 进入；失败不阻断主流程 | `refused` / 2 | `main.go:214-243` |
| **R2** | 判据集锚定 | 拒收 | 两代 `criteria_sha256` 不一致时触发；一致则直接通过 | 指纹变了必须有非空 `criteria_diff`；每条 diff 的 `id` 非空、`change ∈ {tightened, loosened, added, removed}` | 整代 `refused`（exit 2），「拒绝静默改判据」 | 显式补 `criteria_diff` 声明或恢复判据集；不得静默改判据；同一代不重跑 | `refused` / 2 | `main.go:245-264` |
| **R3** | 防删指标 | 拒收 | 对比 `prev` / `next` 的 metric 集合 | 上一代出现的每个 metric 本代必须仍在；出现「上一代有、这一代消失的指标」即违反 | 整代 `refused`（exit 2），理由列出被删指标名 | 补回指标；量不到写 `basis=5 (absent)` + `why_absent`，不许整条删除；同一代不重跑 | `refused` / 2 | `main.go:266-283` |
| **R4** | 产物哈希 | 拒收 | 逐条检查 `next.artifacts`（文件存在则复核内容，不存在只校验格式） | `sha256` 为 64 位十六进制、`bytes >= 0`；文件存在时内容哈希与字节数须与声明一致 | 整代 `refused`（exit 2），理由点名产物 path | 提供真实可复核原像（真 `sha256` + 真字节数），不用占位串；同一代不重跑 | `refused` / 2 | `main.go:285-308` |
| **R6** | 同代唯一 | 拒收 | 读账本，筛出与 `next` 同 `producer`、同 `generation` 的 `rsi_generation` 行 | 链上已存在一份与 `next` 不同的 manifest（内容哈希比对）即违反 | 整代 `refused`（exit 2），「同代重记被拒」 | 同一代不得造两份不同 manifest；不以重记覆盖历史；同一代不重跑 | `refused` / 2 | `main.go:310-337` |
| **R5** | 严格比较 | 比较 | R1–R4、R6 均未拒收后，对两代可比指标做 `compare` + `switch` | `objective` 必须严格变好、`guard` 不得变差（持平可以）；两代 `direction` 不一致或两代都 `basis=5` 的指标跳过；`len(metrics)==0` / `objectiveCount==0` / 目标饱和（`atCeiling`）→ `undecidable`；护栏变差或目标没全变好 → `not_improved`；否则 `improved` | 不产生 `refused`；落入 `improved` (0) / `not_improved` (1) / `undecidable` (3) | 理由一律 `R5:` 前缀；`undecidable` 不自动重跑，由下一轮 Act 自然产生证据；饱和应扩任务空间而不是改判据；`not_improved` 由归因器写回 π' | `improved` / `not_improved` / `undecidable`；0 / 1 / 3 | `main.go:344-435`、`main.go:507-538` |

补充口径：

- 上表「依据行号」为**证据范围**（含前导 `// R#:` 注释行，如 R1 的 `214-243`）；
  字段级源码锚点见 `server/docs/rsi-rules-contract.md` §2.1（自函数定义行起，如 R1 的 `215-243`），
  两者指向同一段真实代码，不构成不一致。
- `budget.efficiency` **刻意不进 readings**（§2 已写明），它不是 `direction=down` 的读数，也不参与 R5 比较；
  把它当目标会让「越学越贵」被判成「越学越差」。内核只消费 `Manifest.readings` 里实际存在的指标
  （`main.go:63-71`、`main.go:359-408`、`main.go:603-611`）。
- `criteria_sha256` 由 `manifest-builder` 的 `criteriaFingerprint()` 计算
  （`server/src/services/rsi/manifest-builder.ts:192-215,366`），R2 只比对两代是否一致，不由文档或内核重算。
- `basis` 的必带字段以 `main.go:232-237` 为准：仅 `basis=4` 必带 `source`、`basis=5` 必带 `why_absent`；
  `basis=2 (relayed)` 无必带字段（见 §2 basis 表）。
- `role` 缺省按 `objective` 解释（`main.go:377-380`）；目标饱和记 `undecidable / exit 3`
  （`main.go:524-530`），「目标没变好」记 `not_improved / exit 1`（`main.go:531-537`），两者是不同分支，都正确。

---

## 5. Anchor 哈希链（L2，已落地）

**当前状态：L2 Anchor 已实现**（`rsi-bridge.service.ts` 的 `appendAnchor`）。每代判决后向
`dbDir/rsi/<sessionId>-anchors.jsonl` 追加一行；该文件与 krsi 的私有账本严格分离，
避免混入外来行导致 krsi 的账本校验从下一代起拒收。

实际链式定义（与早期设计稿不同，以代码为准）：

```
manifest_hash = sha256(JSON.stringify(manifest))
anchor_hash   = sha256(JSON.stringify({
  prev_anchor_hash, manifest_hash, verdict, exit_code, generation, timestamp
}))
```

- 账本行字段：`{ type:'anchor', generation, anchor_hash, prev_anchor_hash, manifest_hash, verdict, exit_code, timestamp }`，只追加不重写。
- 链式性质：改动任意一代的 manifest，`manifest_hash` 变化 → `anchor_hash` 及其后续 `prev_anchor_hash` 全部对不上，篡改可检测。
- `seed-agent-loop.ts` 每轮结束打印 `chain=✓/✗`，校验相邻 `prev_anchor_hash` 是否衔接。

已知限制（仅 v1 历史行）：哈希输入是 `JSON.stringify(manifest)`（依赖键序）。v2 起改用
canonical JSON 并补全 §6 证据原像；两版本可以混排在同一条链上，见 §6.2。
离线校验已经补上，见 §6.1。

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
3. 数字用 JS 的最短往返表示（`JSON.stringify`），`-0` 归一为 `0`，非有限数直接拒绝；
4. 数组保持语义顺序（`metrics` 按 metric 名字典序，`reasons` 按产生顺序）；
5. 不含时间戳、不含随机数、不含绝对路径 —— 否则原像不可复算。

复算流程：从账本取 `prev_manifest` / `next_manifest` / `report_raw` → 重建原像 → 重算 `H` →
与账本 `evidence_hash` 比对 → 再沿 `prev_anchor` 回溯到 `anchor_0`，全链通过才算证据可信。

### 6.1 离线校验（已落地）

```
npm run rsi:verify -- <sessionId> [--dir data/rsi] [--db data/codelens.db]
```

不启 server、不调 krsi，直接按磁盘账本复算四层，任一层对不上就打印 `code` 与代数：

| 层 | 复算 | 失败 code |
|---|---|---|
| 证据文件 | 文件字节 sha256 / 字节数 vs `manifest.artifacts[]` | `evidence_missing` / `evidence_hash_mismatch` / `evidence_bytes_mismatch` |
| 证据原像（v2） | `sha256(canonical_json(evidence))` vs `anchor.evidence_hash`；原像内 `gen/verdict/exit_code/prev_manifest/next_manifest` 必须与外层一致 | `evidence_preimage_mismatch` / `evidence_preimage_missing` |
| manifest | `sha256(落库的 next_manifest_json)` vs `anchor.manifest_hash` | `manifest_hash_mismatch` |
| anchor 行 | 按 `hash_version` 分支重算 `anchor_hash` | `anchor_hash_mismatch` |
| 链 | `prev_anchor_hash` 必须等于上一行 `anchor_hash`，代数严格递增 | `chain_break` / `generation_not_increasing` |

问题按 `kind` 分三组打印，不混在一起：

- `tamper` / `chain`：真篡改或真断链，退出码 1；
- `version`：不认识的 `hash_version` → `unknown_hash_version`，**无法判定**，退出码 3；
- `environment`：账本为空、该代 manifest 未落库、证据文件读不到等「不是篡改但也不能假装通过」，退出码 1。

实现：`src/services/rsi/ledger-verify.ts`（纯函数，可单测）、`scripts/verify-rsi-ledger.ts`（CLI）。
实测：对 `data/rsi/c23c9a03-…-anchors.jsonl` 全链通过；把副本里的 `verdict` 改成 `improved`
后两行都报 `anchor_hash_mismatch`。

### 6.2 哈希版本化（v1 → v2，已落地）

anchor 行新增 `hash_version`；**缺字段一律按 v1 解释**，因此历史账本不需要任何改写即可继续验。

| | v1（历史行） | v2（新行） |
|---|---|---|
| 序列化 | `JSON.stringify` 固定键序 | `canonical_json`（键字典序、紧凑） |
| `anchor_hash` 原像 | `{prev_anchor, manifest_hash, verdict, exit_code, generation, timestamp}` | 上述字段 + `prev_manifest_hash` + `evidence_hash` |
| 证据原像 | 不入链，只在库/文件侧 | §6 全量原像（`gen`、`producer`、`prev/next_manifest`、`verdict`、`exit_code`、`reasons`、`metrics`、`report_raw`）随行落盘 |
| 离线可复算范围 | 需要库里的 manifest 原文 | 证据层不依赖库：行内 `evidence` + `evidence_hash` 自洽；manifest/artifacts 仍从库与文件复核 |

v2 行字段：

```
{
  type: "anchor",
  hash_version: 2,
  generation, anchor_hash, prev_anchor_hash,     // 与 v1 同名同义
  manifest_hash,                                 // sha256(JSON.stringify(next_manifest))，与 manifest 复核共用
  prev_manifest_hash,                            // sha256(JSON.stringify(prev_manifest))，链头为 null
  evidence_hash,                                 // sha256(canonical_json(evidence_preimage))
  verdict, exit_code, timestamp,
  evidence: { ...§6 证据原像... }
}
```

兼容与迁移策略：

- **只追加、不回写**：appendAnchor 只写新行；新会话起写 v2，旧链不重签、不改字节；
- 混排链由同一个 `rsi:verify` 逐行分支复算，并输出「版本分布」和每行 `hv=`；
- 历史行缺 `hash_version` 视为 v1（不是错误），也不会被自动补字段；
- 可选迁移（显式、幂等）：`npm run rsi:migrate-hash -- <sessionId> [--dir data/rsi] [--apply]`
  只给缺省的历史行补 `hash_version: 1`，默认 dry-run；补标记不改变 `anchor_hash`（v1 原像不含该字段），
  重复执行 `stamped=0`。v2 行与 krsi 的 metric 行一个字节都不动。


---

## 7. 一句话总结

`π` 真跑出 `τ`，`Judge` 把 `τ` 压成三态 verdict，`manifest-builder` 把 verdict 翻成 Manifest，
`krsi` 用 R1–R6 做跨代对比给出四态 exit code，`Update` 据此决定是否接受 `π'`；
L2 用 anchor 哈希链把每一代的证据原像钉死，使「改进」这件事可审计、可复算、不可事后美化。

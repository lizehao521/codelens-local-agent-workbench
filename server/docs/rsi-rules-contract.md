# RSI 规则契约（人类可读现行准绳）

> 契约版本：`rsi-rules-contract-v1`（与机器可读契约 `buildRsiRulesContract()` 的 `version` 一致）
> 状态：现行准绳，2026-11-10 锁定
> 本轮唯一依据：`docs/rsi-rules-alignment-spec.md`
> 实现真相源：`server/krsi/main.go`（跨代改进对账内核）
> 文档准绳：`server/docs/rsi-capability-sedimentation.md` §5「判据底座」
> 性质：**澄清与对齐，不是重写规则**。本文件只把内核既有口径钉死，消除文档歧义、冲突与遗漏；不新增判定规则、不改变运行逻辑、不改动退出码与报告文案模板。
> 配套机器可读版本：`server/src/services/rsi/rules-contract.ts` 的 `buildRsiRulesContract()`（由后端维护）。两个版本的 `rules` / `states` / `judgeRunStates` / `criterionStatuses` / `basis` / `roles` 取值必须逐字段一致。

---

## 1. 真相源声明与「四套准绳」措辞裁定

### 1.1 分层裁定

| 层 | 裁定 | 依据 |
|---|---|---|
| 实现真相源 | `server/krsi/main.go`。判决权在 Go 内核，不在模型、不在文档 | `main.go:78` `criteriaDeclared = "R1 R2 R3 R4 R5 R6"`；`main.go:463-538` 主流程 |
| 文档准绳 | `server/docs/rsi-capability-sedimentation.md` §5，R1–R6 与内核逐条一致 | `rsi-capability-sedimentation.md:194-205` |
| 待修正文档 | `server/docs/rsi-loop.md` §2 / §3 / §4：编号错位、basis 口径错、外置「上游」 | `rsi-loop.md` 原 §2:66-72、§3:83-88、§4:102-116；见本文件 §5 的 C1/C2/C3/C4/C5 |
| 状态枚举真相源 | `server/src/services/rsi/rsi-bridge.service.ts` 的 `RsiVerdictState`（6 态）+ `server/src/services/judge/types.ts` 的 `RunVerdict` / `VerdictStatus`（各 3 态） | `rsi-bridge.service.ts:33`、`judge/types.ts:19,22` |
| 不作判定依据 | `强化Agent.txt` C1–C4、`产品宪法补丁.md`：草案 / 宣言，尚未拍板 | `RSI-HANDOVER-2026-11-10-PM.md:146,161`；Spec §0 红线 4 |

**一句话**：任何关于「RSI 规则是什么」的争议，以 `server/krsi/main.go` 的实际行为为终裁；`docs/agent/spec.md`（README 所谓「唯一真相源」）指 v2.0 产品定位与能力契约，不是 RSI 判据，与本契约无关（Spec §1 末段）。

### 1.2 四套易混淆的「准绳」措辞，逐一裁定

| # | 措辞 | 出处 | 裁定 | 依据 |
|---|---|---|---|---|
| 1 | 「唯一真相源」 | README → `docs/agent/spec.md` | 指 v2.0 产品定位与能力契约，**不覆盖 RSI 判据**；RSI 判据终裁仍是 `main.go` | Spec §1 末段；`main.go:78` |
| 2 | 「以 `microkernel-rsi` 的 `risk` 包为准 / 冲突以上游为准」 | `rsi-loop.md` 原 §4:115-116 | 措辞作废：仓库内**不存在**该包（全仓检索 0 命中）；改为本地锚点 `server/krsi/main.go` | 全仓检索 0 命中；`main.go:214-435` |
| 3 | 「宣言 / 宪法补丁 / 待确认 / 落地动作建议」 | `强化Agent.txt`、`产品宪法补丁.md` | 保持草案状态，**不作为机械判定依据**，不伪造状态枚举或触发条件 | 交接文档 `:146,161`；Spec §0 红线 4、§2.1 |
| 4 | 「状态快照 / 历史语义不重写」 | `RSI-HANDOVER-2026-11-10-PM.md` | 正文一字不改，仅文末追加勘误登记；**历史语义不因本轮对齐而重写** | Spec §0 红线 5；交接文档 `:5` |

### 1.3 三条必须随契约一并声明的边界

1. **`budget.efficiency` 刻意不进 `readings`**：成本是 L0 闸（用量超阈值即判 fail），不是「越低越好」的目标；把它当目标会让「越学越贵」被判成「越学越差」。内核只消费 `Manifest.readings` 中实际存在的读数，不凭空引入任何 `budget_efficiency` 指标。依据：`rsi-loop.md:58`、`manifest-builder.ts:70-73`（`METRIC_MAP` 无该条目）、`main.go:63-71`（Manifest 结构）、`main.go:359-408`（`compare` 只遍历 readings）、`main.go:603-611`（`countMeasured` 只数 basis 1–3）。
2. **`criteria_sha256` 由 `manifest-builder` 计算，不由本契约计算**：`criteriaFingerprint()` 对判据集定义与生效阈值做真实 sha256，`CRITERIA_FINGERPRINT` 为模块加载时的默认值，`buildManifest()` 写入 manifest；内核 R2 只比对两代该字段是否一致。依据：`manifest-builder.ts:192-215,329-330,366`、`main.go:245-264`。本契约只描述该字段的判定语义，不复制、不重算、不硬编码其取值。
3. **草案不作机械判定依据**：`强化Agent.txt` / `产品宪法补丁.md` 中的「同一问题第二次出现」「答不出就不许删」「待确认」「落地动作建议」等属宣言层，未落机械闸；本契约标为「未实现，不作判定」，不伪造状态枚举。依据：Spec §2.1；交接文档 `:146,161`。

---

## 2. 六条规则 R1–R6（取值锁定）

### 2.1 完整规则表

> 下表 `id` / `name` / `kind` / `order` / `exitCodes` / `resultsIn` / `anchor` 与 Spec §2 `RsiRuleDefinition` 逐字段对应；`结果状态` 与 `退出码` 的取值与 Spec §2 锁定表逐字一致。

**「名称」与「源码锚点」列口径（与后端机器契约逐字对齐）**：`名称` 列采用 Spec §2 锁定的 6 个长名，与 `buildRsiRulesContract()` 及前端兜底契约的 `rules[].name` 逐字一致。「源码锚点」列即 `RsiRuleDefinition.anchor`，起始行自 `func` 定义行起，不含前导 `// R#:` 注释行 —— R1 `215-243` / R2 `246-264` / R3 `267-283` / R4 `286-308` / R6 `311-337`，R5 合并为 `344-435,507-538`；§2.3 逐条补充中的函数级范围行号同此口径。本文 §5 裁定依据、§10 索引以及 `rsi-loop.md` / 交接文档 §10 中出现的 `214-243`、`214-337` 等是**证据范围行号**（含前导注释行，与 Spec §2 C1 证据 `main.go:214-337,344-435` 同口径），两者指向同一段真实代码，不构成不一致；Spec §6-12 已明确 QA 不得把这一偏移判为缺陷。**边界（防止豁免被误撤）**：上述「已逐字对齐」仅指字段级 `anchor`（后端契约 / 前端兜底 / 本文 §2.1 表）三处；§6-12 对证据范围行号的豁免**不得撤除**，QA 的比对范围**不得扩展**为「全文所有 `main.go:NNN` 均须与契约 anchor 全等」，否则本文 §5 / §10、`rsi-loop.md` §4、交接文档 §10 中的 214 系列证据范围行号会被大面积误判为缺陷。

| id | 名称 | kind | 适用条件 | 判断标准 | 响应动作要求 | 结果状态 | 退出码 | order | 源码锚点 |
|---|---|---|---|---|---|---|---|---|---|
| R1 | 结构与 schema 合法 | rejection | 每次 Judge 对 `prev`、`next` 两份 Manifest 各执行一次 | `producer` 非空；`generation >= 0`；每条 reading 的 `metric` 非空、`basis ∈ 1..5`、`direction ∈ {up,down}`、`basis=4` 必带 `source`、`basis=5` 必带 `why_absent`、`denominator`（若给出）必须为正 | 点名 `R1:` 前缀的原因，修 manifest；同一代不重跑，修完由下一代以新 generation 进入；失败不阻断主流程 | `refused` | `2` | 1 | `server/krsi/main.go:215-243` |
| R2 | 判据集显式锚定 | rejection | 两代 `criteria_sha256` 不一致时触发；一致则直接通过 | 指纹变了必须有非空 `criteria_diff` 声明；每条 diff 的 `id` 非空、`change ∈ {tightened,loosened,added,removed}`；否则判「拒绝静默改判据」 | 点名 `R2:` 前缀的原因，补齐 `criteria_diff` 声明或恢复判据集；同一代不重跑；失败不阻断主流程 | `refused` | `2` | 2 | `server/krsi/main.go:246-264` |
| R3 | 防删指标（防放水） | rejection | 每次 Judge 对比 `prev.readings` 与 `next.readings` 的 metric 集合 | 上一代出现的每个 metric 必须在本代仍存在；出现「上一代有、这一代消失的指标」即违反（删指标不等于变好）；量不到应写 `basis=5(absent)` 而非整条删除 | 点名 `R3:` 前缀的原因，补回被删指标（量不到写 absent）；同一代不重跑；失败不阻断主流程 | `refused` | `2` | 3 | `server/krsi/main.go:267-283` |
| R4 | 产物内容哈希可复核 | rejection | 对 `next.Manifest.artifacts` 逐条执行；文件存在则复核内容，不存在只校验格式 | `sha256` 必须是 64 位十六进制；`bytes >= 0`；文件存在时内容 sha256 与声明一致、`bytes > 0` 时字节数与声明一致 | 点名 `R4:` 前缀的原因，提供真实可复核的产物原像（不使用占位串）；同一代不重跑；失败不阻断主流程 | `refused` | `2` | 4 | `server/krsi/main.go:286-308` |
| R6 | 同一代账本唯一 | rejection | 读取账本，筛出与 `next` 同 `producer`、同 `generation` 的 `rsi_generation` 行 | 若链上已存在一份与 `next` 不同的 manifest（内容哈希比对），判「同代重记被拒」 | 点名 `R6:` 前缀的原因，不得以重记覆盖历史；同一代不重跑；失败不阻断主流程 | `refused` | `2` | 5 | `server/krsi/main.go:311-337` |
| R5 | 两代读数严格比较 | comparison | R1–R4、R6 均未拒收后，对两代可比指标做 `compare` 并由 `switch` 定态 | `objective` 必须严格变好、`guard` 只要不变差（持平可以）；两代 `direction` 不一致或两代都 `basis=5` 的指标跳过；`len(metrics)==0` / `objectiveCount==0` / `atCeiling` → `undecidable`；`guardRegressed>0` / `objectiveStrict < objectiveCount` → `not_improved`；全部目标严格变好且护栏不变差 → `improved` | 理由一律以 `R5:` 前缀点名；`undecidable` 不自动重跑，由下一轮 Act 自然产生证据；`not_improved` 由归因器写回 π' 供下一代 | `improved` / `not_improved` / `undecidable` | `0` / `1` / `3` | 6 | `server/krsi/main.go:344-435,507-538` |

说明：`refused(2)` 由 R1–R4、R6 五条前置拒收规则产生；`improved(0)` / `not_improved(1)` / `undecidable(3)` 由 R5 比较分支产生；`skipped` / `error` 为 bridge 层状态，不由内核退出码产生（见 §3）。六者合起来是 `main.go:73-79` 声明的 krsi 四态 + bridge 两态。

### 2.2 执行顺序：编号顺序 ≠ 执行顺序

**实际固定执行顺序为 R1 → R2 → R3 → R4 → R6 → R5**，与 R1–R6 的编号顺序不同：

| 顺序 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| 规则 | R1 | R2 | R3 | R4 | **R6** | **R5** |
| `order` | 1 | 2 | 3 | 4 | **5** | **6** |

- 证据：`main.go:463-493` 按 `checkR1(prev)` → `checkR1(next)` → `checkR2` → `checkR3` → `checkR4` → `checkR6` 的顺序串成拒收链，任一命中即整代拒收；`main.go:495` 才调用 `compare(prev, next)` 准备比较数据；`main.go:507-538` 的 `switch` 给出最终四态。
- 因此 **R6 在 R5 之前执行**：`R6.order = 5`，`R5.order = 6`。编号是「判据目录」的标识顺序（`main.go:78` `criteriaDeclared = "R1 R2 R3 R4 R5 R6"`，`main.go:574` 报告按编号打印），不是调用顺序；按编号顺序叙述会产生「R5 先于 R6」的错觉。
- 任一条拒收规则命中后不再执行后续拒收规则（`if refuse == ""` 短路，`main.go:469-493`）；`compare` 与账本写入仍会执行，用于留痕（`main.go:495-503`）。

### 2.3 逐条补充：违反后果与处置要求

- **R1 schema 合法**：违反后果 = 整代 `refused`（exit 2），报告理由以 `R1:` 开头（`main.go:466-473,510`）；`prev` 或 `next` 任一不合法即拒收。处置 = 修正 producer / generation / reading 字段（尤其 `basis=4` 补 `source`、`basis=5` 补 `why_absent`、比率型补正 `denominator`），同一代不重跑。判断标准见 `main.go:215-243`。
- **R2 判据集锚定**：违反后果 = 整代 `refused`（exit 2），理由「拒绝静默改判据」或点名非法 diff（`main.go:250-261,475-478`）。处置 = 显式填写 `criteria_diff`（`change` 只能是 tightened / loosened / added / removed）或恢复原判据集；不得悄悄改判据。
- **R3 防删指标**：违反后果 = 整代 `refused`（exit 2），理由按字典序列出被删指标名（`main.go:278-281,479-483`）。处置 = 上一代有的指标本代必须仍在；量不到写 `basis=5(absent)` + `why_absent`，而不是整条消失（`manifest-builder.ts:305-318`）。
- **R4 产物哈希**：违反后果 = 整代 `refused`（exit 2），理由点名产物 path 与哈希 / 字节数不符（`main.go:288-304,484-488`）。处置 = 提供真实可复核原像（真 sha256 + 真字节数），不用固定占位串（`manifest-builder.ts:338-360`）。
- **R6 同代唯一**：违反后果 = 整代 `refused`（exit 2），理由「第 N 代已有一份不同的 manifest 在链上，重记被拒」（`main.go:332-334,489-493`）。处置 = 同一代不得造两份不同 manifest；不以重记覆盖历史。
- **R5 严格比较**：违反后果不产生 `refused`，而是按 `switch` 落入 `undecidable`（exit 3）/ `not_improved`（exit 1）/ `improved`（exit 0）之一（`main.go:507-538`）。处置 = 理由一律 `R5:` 前缀；`undecidable` 不自动重跑；饱和应扩任务空间而不是改判据（`main.go:524-530`）；`not_improved` 由归因器写回 π'（`main.go:531-537`）。

---

## 3. 6 态状态表（含 exitCode / 中文标签 / tone / 处置要求 / origin）

| state | exitCode | 中文标签 | tone | 含义 | 处置要求 | origin |
|---|---|---|---|---|---|---|
| `improved` | `0` | 已改进 | success | 读数支持改进：所有目标指标严格变好，且没有护栏指标变差 | 接受 π' | `krsi` |
| `not_improved` | `1` | 未改进 | warning | 有目标指标没变好，或护栏指标变差 | 保留 π；归因器写回 π' 供下一代 | `krsi` |
| `refused` | `2` | 拒收 | danger | 拒收：schema / 判据 / 锚定 / 防删 / 产物 / 账本完整性不通过 | 点名 `R*:` 前缀的原因，修 manifest / 判据；同一代不重跑，修完由下一代以新 generation 进入；失败不阻断主流程 | `krsi` |
| `undecidable` | `3` | 无法判定 | warning | 没有可比目标指标，量不到；或目标已达 1.0 上限（饱和） | 补证据，或降级为 `skipped`；不自动重跑，由下一轮 Act 自然产生 | `krsi` |
| `skipped` | `null` | 跳过 | muted | 首次运行（无 prev Manifest），不 spawn krsi | 直接写 `verdict=skipped`，下一代自然进入对账 | `bridge` |
| `error` | `null` | 桥接故障 | danger | bridge 自身故障：krsi 找不到 / 构建挂了 / 超时（默认 10s）/ 报告解析失败 | 保留原始 `exitCode` 供审计；失败不阻断主流程，只 `console.warn` | `bridge` |

- `exitCode` 取自 `main.go:74-77` 常量（`exitImproved=0` / `exitNotImproved=1` / `exitRefused=2` / `exitUndecidable=3`）。
- `origin`：`krsi` 四态来自内核退出码；`bridge` 两态来自 `rsi-bridge.service.ts:33` 的 `RsiVerdictState` 与 `rsi-loop.md` §3（首次运行跳过 / spawn 失败）。
- 「目标饱和」记 `undecidable / exit 3` 与 `main.go:524-530` 的 `atCeiling` 分支一致；`not_improved / exit 1` 是「目标没变好」的另一分支（`main.go:531-537`）。两者都正确，不得互相「修正」（Spec §0 红线 6）。
- **静态快照口径（仅补说明，历史数据不改写）**：`rsi-code-fix-dashboard.html` 是历史快照，状态按内核原始英文串呈现（`improved` / `undecidable` / `skipped`），不改写为中文标签、不改动任何历史数据。其 tone 语义与现行契约 `rsi-rules-contract-v1` 一致：`improved`=success、`undecidable`=warning、`skipped`=muted，故三处前端（SPA / 独立 HTML / 静态快照）对同一 verdict 的 tone 语义一致（Spec §6 校验清单第 10 项）。该文件不在 Spec §4 任何成员的白名单内，且 §0 红线 6 要求历史数据不动，因此这句口径说明落在准绳文档，静态快照文件本身一个字不改；「目标饱和」与「目标没变好」两条分支如上条所述均正确，不作修正。

---

## 4. 三套枚举表与 roles

### 4.1 judgeRunStates（`judge/types.ts:22` `RunVerdict`）

| state | 中文标签 | tone |
|---|---|---|
| `pass` | 通过 | success |
| `fail` | 未通过 | danger |
| `inconclusive` | 未定论 | warning |

### 4.2 criterionStatuses（`judge/types.ts:19` `VerdictStatus`）

| state | 中文标签 | tone |
|---|---|---|
| `pass` | 通过 | success |
| `fail` | 未通过 | danger |
| `unexec` | 未执行 | muted |

### 4.3 basis（1–5，`main.go:226-237`）

| value | name | label | requiredField | note |
|---|---|---|---|---|
| 1 | `measured` | 实测 | `null` | 真发生的事件读数 |
| 2 | `relayed` | 转述 | `null` | **无必带字段**（旧文档「必带 source」是错的，见 C2） |
| 3 | `estimated` | 估算 | `null` | 无必带字段 |
| 4 | `model_says` | 模型自述 | `source` | **必带 `source`**（`main.go:232-233`） |
| 5 | `absent` | 量不到 | `why_absent` | **必带 `why_absent`**（`main.go:235-236`） |

`basis` 取值域由 `main.go:226-228` 校验（越界 1–5 即 R1 拒收）。`requiredField` 与 Spec §2 锁定表逐字一致：仅 `4 -> 'source'`、`5 -> 'why_absent'`，其余为 `null`。

### 4.4 roles（`main.go:57-60,377-403`）

| role | 中文标签 | requirement |
|---|---|---|
| `objective` | 目标 | 必须严格变好；`role` 缺省按 objective 解释 |
| `guard` | 护栏 | 不得变差，持平可以 |

阈值（仅登记来源，不复制硬编码）：`DEFAULT_L0_THRESHOLDS`（`judge/criteria.ts:23`）+ `COVERAGE_THRESHOLD`（`judge/types.ts:162`），机器可读契约运行时 import。判据集版本标识 `RULES_VERSION = 'criterion-set-v2'`（`judge/replay.ts:39`）为**判据集版本**，与本契约版本 `rsi-rules-contract-v1` 是两个不同对象，不得混用（Spec §2.2）。

---

## 5. 冲突裁定表 C1–C8

| # | 冲突 | 错误侧 | 裁定（以内核为准） | 依据 |
|---|---|---|---|---|
| C1 | R1–R6 编号含义 | `rsi-loop.md:106-113` 整节（编号整体错位且自认「归纳」） | R1 schema 合法 / R2 判据集锚定 / R3 防删指标 / R4 产物哈希 / **R5 严格比较** / R6 同代唯一。R1–R4、R6 是 `refused` 前置拒收类，只有 R5 产出四态（产出 `improved` / `not_improved` / `undecidable`，与前置规则的 `refused` 合为 krsi 四态） | `main.go:214-337,344-435`；`main.go:78`；`rsi-capability-sedimentation.md:196-205` |
| C2 | basis 必带字段 | `rsi-loop.md:69,108`、`RSI-HANDOVER-2026-11-10-PM.md:86`、`manifest-builder.ts:12` 写「relayed(2) 必带 source」 | **`basis=4 (model_says)` 必带 `source`；`basis=5 (absent)` 必带 `why_absent`；basis=2 无必带字段** | `main.go:232-237` |
| C3 | R6 举例 | `rsi-loop.md:113` 把 `budget_efficiency` 列为 `direction=down` 读数 | `budget.efficiency` **刻意不进 readings**（同文 §2:58 已写），举例须删除 | `rsi-loop.md:58`、`manifest-builder.ts:70-73`、`main.go:63-71,359-408,603-611` |
| C4 | 编号归属外置 | `rsi-loop.md:115-116`「以 `microkernel-rsi` 的 risk 包为准，冲突以上游为准」 | 仓库内**不存在**该包；真相源就是 `server/krsi/main.go`，措辞必须改为本地锚点 | 全仓检索 0 命中；`main.go:214-435` |
| C5 | 执行顺序 | 文档按 R1–R6 顺序叙述 | 实际执行 **R1→R2→R3→R4→R6→R5**（R6 在 R5 前，`R6.order=5`、`R5.order=6`）。编号顺序 ≠ 执行顺序 | `main.go:463-495` |
| C6 | 前端幽灵状态 | `RsiDashboardModal.tsx:96` 判断 `undecided` | 后端**从不产生**该值；真实值是 `inconclusive` / `undecidable` 等 | `judge/types.ts:22`、`rsi-bridge.service.ts:33` |
| C7 | eval 元数据断点 | `api.ts:1014-1038` 丢弃 4 字段 | 后端 `app.ts:255-262` 已下发，前端映射层必须透传 | `app.ts:255-262` |
| C8 | 规则染色漏 R2 | `server/public/rsi-dashboard.html:369` 排除列表无 R2 | 六条规则编号一律按契约派生，不再硬编码枚举 | `main.go:78` `criteriaDeclared` |

---

## 6. 模糊表述明确化

| 原文 | 明确化 |
|---|---|
| `undecidable`「补证据，或降级为 skipped」 | 触发：`len(metrics)==0` / `objectiveCount==0` / `atCeiling`（`main.go:511-516,524-530`）；补足标准 = 至少 1 个可比 objective 指标且未顶 1.0；**不自动重跑**，由下一轮 Act 自然产生 |
| `refused`「修 manifest / 判据，不重试」 | 触发：R1/R2/R3/R4/R6 任一（`main.go:463-493`）；响应 = 点名 `R*:` 前缀的原因（`main.go:510`）；**同一代不重跑**，修完由下一代以新 generation 进入；失败不阻断主流程 |
| `产品宪法补丁.md`「待确认」「落地动作建议」 | 保持草案状态，**不作为机械判定依据**；在本契约 §8 `outOfScope` 显式声明 |
| `强化Agent.txt`「同一问题第二次出现」「答不出就不许删」 | 属宣言层，未落机械闸；本契约标为「未实现，不作判定」，不伪造状态枚举 |

---

## 7. 遗漏补齐（只补描述，不新增判定逻辑）

| 遗漏 | 补齐 | 依据 |
|---|---|---|
| `RsiVerdictState` 6 态中 `skipped` / `error` 在 `rsi-loop.md` §3 缺表 | 在 §3 四态表补 `skipped`（跳过 / muted）、`error`（桥接故障 / danger）两行；本文件 §3 给出完整 6 态表 | `rsi-bridge.service.ts:33` |
| `RULES_VERSION = 'criterion-set-v2'` 无文档描述 | 标注其为**判据集版本**（`judge/replay.ts:39`），与本次契约版本 `rsi-rules-contract-v1` 区分 | `judge/replay.ts:38-42` |
| `LayerUnavailableReason` 三值无机器触发条件 | 记为 **OPEN**（`assessor_not_wired` / `depends_on_unavailable` / `not_declared`），不伪造触发条件，见 §9 | `judge/types.ts:76`；Spec §2.2 / §8 |
| 状态枚举的中文标签与 tone 分散 | 收拢到本文件 §3 / §4，供三处前端统一消费（不新增规则） | Spec §2 锁定表 |

---

## 8. Out-of-Scope 声明

本契约及本轮对齐**不包含**以下内容：

1. 不新增判定规则、不改动 `main.go` 的判定逻辑、退出码与报告文案模板（Spec §0 红线 1）。
2. 不改动 `manifest-builder.ts` 的 `METRIC_MAP` / `CRITERIA_FINGERPRINT` 运行逻辑（Spec §0 红线 2）。
3. 不改动 DB schema、既有 API 响应字段（只增不删）、历史账本 / anchor / `hash_version`（Spec §0 红线 3）。
4. `强化Agent.txt` 正文、`产品宪法补丁.md` 草案状态不改，且**不作机械判定依据**（Spec §0 红线 4）。
5. `RSI-HANDOVER-2026-11-10-PM.md` 正文不改，历史语义不重写（Spec §0 红线 5）。
6. `rsi-code-fix-dashboard.html` 历史数据不改：「目标饱和」记 `undecidable / exit 3` 与 `not_improved / exit 1` 是两条不同分支，都正确（Spec §0 红线 6）。
7. `budget.efficiency` 不进 `readings`；本契约不把它列为任何规则的读数举例。
8. `criteria_sha256` 的计算由 `manifest-builder` 负责，本契约不计算、不复制其取值。
9. `docs/agent/spec.md`（v2.0 产品定位）与本次 RSI 判据对齐无关。
10. 不新造技术选型、不新增硬编码颜色、不使用 emoji 作图标或列表符号（P0 绝对规则）。

---

## 9. 未决登记（OPEN，如实登记，不编答案）

| 项 | 状态 | 说明 |
|---|---|---|
| `LayerUnavailableReason` 三值的机器触发条件 | OPEN | `judge/types.ts:76` 有枚举定义，触发条件未实现；本轮只登记不编造 |
| `产品宪法补丁.md` 是否拍板并入 | OPEN | 交接文档 §6.10 遗留，需用户决策 |
| `criterion-set-v2` 判据条目清单 | OPEN | `judge/replay.ts:39` 有版本标识，无文档；本轮只标注不定义 |
| `#13 lessonEffectiveness` 口径 / `#15` 隔离实例超时 | OPEN | 交接文档 §9.8 / §9.10 遗留，与本次对齐无关 |

---

## 10. 一致性锚点速查（本契约每条裁定的源码行号索引）

> 本表行号为**证据范围**（含前导 `// R#:` 注释行，与 Spec §2 C1 证据同口径）；
> 字段级 `RsiRuleDefinition.anchor` 以 §2.1 表为准（自函数定义行起，与后端契约逐字一致）。两者指向同一段真实代码。

| 主题 | 证据范围行号 |
|---|---|
| 判据目录 / 退出码常量 | `server/krsi/main.go:73-79` |
| R1 schema 合法（含 basis 必带字段） | `server/krsi/main.go:214-243`（必带字段见 `:232-237`） |
| R2 判据集锚定 | `server/krsi/main.go:245-264` |
| R3 防删指标 | `server/krsi/main.go:266-283` |
| R4 产物哈希 | `server/krsi/main.go:285-308` |
| R6 同代唯一 | `server/krsi/main.go:310-337` |
| R5 严格比较（compare / atCeiling / switch） | `server/krsi/main.go:344-435`、`:507-538` |
| 固定执行顺序 | `server/krsi/main.go:463-495` |
| 饱和分支 undecidable | `server/krsi/main.go:524-530` |
| 6 态状态枚举 | `server/src/services/rsi/rsi-bridge.service.ts:33` |
| judgeRunStates / criterionStatuses | `server/src/services/judge/types.ts:19,22` |
| 阈值来源 | `server/src/services/judge/criteria.ts:23`、`types.ts:162`（运行时 import） |
| 判据集版本 | `server/src/services/judge/replay.ts:39` |
| criteria_sha256 计算 | `server/src/services/rsi/manifest-builder.ts:192-215,366` |
| budget.efficiency 不进 readings | `server/src/services/rsi/manifest-builder.ts:70-73`、`server/docs/rsi-loop.md:58` |

---

> 本文件为现行人类可读准绳。若与 `server/krsi/main.go` 的实际行为冲突，以内核为准并先修订本文件（活规格维护：实现冲突先改规格、决策留痕、过时即修）。

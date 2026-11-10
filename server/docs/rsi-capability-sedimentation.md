# RSI 能力沉淀：机制、测量与实测

> 本文固化「Agent 能不能把造出来的能力留下来、下一代真的用上」这一环的设计与证据。
> 结论先行：**沉淀不是把经验写进 prompt，而是把能力落成可执行、可审计、可回收的工具定义，
> 并用一条独立读数证明下一代不再重造。** 这条读数经过 krsi 外部内核判定，不靠模型自评。

---

## 1. 与常见 RSI 做法的差异

市面上的「自我改进」大体落在三类。这里只比机制，不评价具体产品。

| 维度 | 自评自改循环 | 记忆/反思沉淀 | 提示词自优化 | 本实现 |
|---|---|---|---|---|
| 沉淀载体 | 无（只改当次回答） | 文本经验、向量记忆 | few-shot 示例、指令串 | **可执行的宏工具定义**（JSON） |
| 谁判「变好」 | 模型自己 | 模型自己 / 人工抽查 | 任务分数 | **Go 内核 krsi，R1–R6 + 退出码** |
| 「变好」的定义 | 主观评分上升 | 无严格定义 | 平均分上升 | **目标指标严格变好，护栏不得变差** |
| 退化防护 | 无 | 无 | 正则/人工 | **护栏指标 + 饱和判定（禁止编造进步）** |
| 跨代可审计 | 日志 | 记忆条目 | 实验记录 | **events.jsonl + anchor 哈希链 + ledger** |
| 失败后怎么办 | 重试 | 再反思一条 | 重采样 | **归因器写回 π'，下一轮注入 prompt** |

差异的核心在第二行：**判决权不在模型手里**。模型可以声称自己变强了，但
`capability_reuse_ratio` 只能由事件流算出来，`krsi` 只看 manifest 字节和读数。

---

## 2. 闭环落点

```
Improve(π) = π --Act--> τ --Judge--> r --Update--> π'
              ↑                                   │
              └──────── 下一代 Act 读 π' ←────────┘
```

| 环节 | 实体 | 代码位置 |
|---|---|---|
| π | 策略版本（lessons + thresholds） | `src/services/agent/update.service.ts` |
| Act | Agent 循环 + 工具调用 | `src/services/agent/agent-loop.service.ts` |
| τ | 轨迹与证据 | `judge_verdicts` / `judge_runs` |
| Judge | 判据塔 L0–L3 | `src/services/judge/` |
| r | 代际对账（目标/护栏、R1–R6） | `server/krsi/main.go` |
| Update | 归因经验写回 `policy_versions` | `src/services/rsi/rsi-attributor.ts` |

关键约束：归因结果只写 `policy_injections`（审计表）是不够的，必须再调
`applyUpdate` 写进 `policy_versions`，否则下一轮 prompt 里根本不会出现这条经验。
这条在 [agent-loop.service.ts](file:///workspace/server/src/services/agent/agent-loop.service.ts#L1458-L1468) 显式落实。

---

## 3. 能力沉淀的三层

### 3.1 定义层：义肢与记忆分开

```
workspace/
  tmp/tools/<sessionId>/<name>.json          ← 义肢：任务结束必须删，否则孤儿闸判红
  .codelens/tool-library/<sessionId>/<name>.json  ← 记忆：显式晋升才写入，跨代可用
```

`tool.forge` 的 `recycle` 只有在 `answers.promote === true` 时才把定义拷进能力库，
随后照删任务作用域文件并记 `tool_promoted`。实现见
[tool-forge.tool.ts](file:///workspace/server/src/tools/builtin/tool-forge.tool.ts#L167-L176)、
[L366-L390](file:///workspace/server/src/tools/builtin/tool-forge.tool.ts#L366-L390)。

口径上刻意区分两件事：

- **删掉义肢** = 任务作用域干净（纪律）
- **留下记忆** = 能力可复用（沉淀）

只删不沉淀会被判违纪；只沉淀不删会被孤儿闸判红。

### 3.2 使用层：先作用域，后能力库

`use` 先查任务作用域，缺失再查能力库；命中能力库时事件里记 `from_library: true`。
这是「复用」在机器侧唯一的凭据，不允许模型口头声称复用。

### 3.3 度量层：复用率

```
本代窗口 = 最近一条 generation_checkpoint 之后的事件
重建集合 = 本代 tool_created 的不同工具名
复用集合 = 本代 tool_used 且 from_library=true 的不同工具名 − 重建集合

capability_reuse_ratio = |复用集合| / (|重建集合| + |复用集合|)
```

三条口径都是刻意的：

1. **按不同工具数**，不按调用次数 —— 同一个工具调 10 次只是用得多，不是沉淀多。
2. **同名工具本代建过就算重建** —— 自己刚造完再用不算复用。
3. **代际窗口** —— 前几代的重建次数不该摊薄这一代。

实现与单测见
[tool-discipline.ts](file:///workspace/server/src/services/judge/tool-discipline.ts#L320-L337)、
[tool-forge.test.ts](file:///workspace/server/tests/tool-forge.test.ts#L224-L300)。

### 3.4 护栏层：不许为了刷分省掉纪律

复用率可以靠「什么都不造、只调库」刷到 1.0。所以同时保留
`tool_lifecycle_score` 作为**护栏**（只许不变差）：

```
单工具阶段：why_not_existing≥8字 / steps≥1 / references≥1 / 真实 use / 回收 / lesson 配对
score = Σ各工具命中阶段数 / (6 × 工具数)
```

护栏的统计窗口做了折中：

- 本代**新建了**工具 → 只评本代造的那些（旧欠账不拖累）
- 本代**只复用** → 回退生涯口径（纯复用代没有新增纪律债，不能判退步）

见 [lifecycleStats](file:///workspace/server/src/services/judge/tool-discipline.ts#L237-L275)。

---

## 4. 实测

会话 `d8253d55-e27a-44b0-93a5-c4d13a9d3318`，任务族「造工具」，三代，探针每代 3 次采样取均值。

### 4.1 代际读数

| 代 | capability_reuse_ratio（目标） | tool_lifecycle_score（护栏） | krsi 判决 |
|---|---|---|---|
| g1 | 0 | 0.75 | skipped（无上一代） |
| g2 | 0.5 ↑ | 0.667 ↓ | **not_improved**（exit 1） |
| g3 | 1.0 ↑ | 0.667 → | **improved**（exit 0） |

g2 的拒绝理由是内核给的，不是模型说的：

```
R5: 护栏指标 "tool_lifecycle_score" 变差（0.75 → 0.667）
```

这条拒绝非常关键：**复用率涨了，但它靠的是 abandon 新工具换来的**，所以不算变好。
如果只看复用率，g2 会被误判成进步。

> 上表是本轮实跑（护栏为生涯累计口径）。改成「本代窗口 + 生涯回退」后，用同一批事件回放：
> g1 0.75 / g2 0.5 / g3 0.667，判决不变，但 g2 的 0.5 更准确地反映了「这一代只造了一个未完成的工具」。

### 4.2 事件链（节选）

```
14:03:48 tool_created   read_notes_head
14:04:32 tool_created   probe_echo
14:04:35 tool_used      probe_echo          lib=false
14:04:40 tool_promoted  probe_echo
14:04:40 tool_removed   probe_echo
14:04:40 lesson         probe_echo
14:05:07 tool_used      probe_echo          lib=true   ← 同代晋升后复用
14:06:16 generation_checkpoint
14:10:30 tool_created   text_len                       ← 造了但没 use/recycle
14:10:53 tool_used      probe_echo          lib=true
14:12:13 generation_checkpoint
14:12:25 tool_used      probe_echo          lib=true   ← 纯复用代
```

g3 这一代**一个工具都没造**，全部从能力库 `use`，复用率 1.0。

### 4.3 归因写回 π

g2 判 `not_improved` 后，归因器产出的经验（不是模板，是点名指标与动作的）：

```
动态工具 read_notes_head 与 text_len 注册后未真实调用、未回收、未沉淀配对，
导致 tool_lifecycle_score 从 0.75 降至 0.667；下轮注册动态工具前先确认任务确实需要，
且每个已注册工具必须在结束前完成「真实调用→tool_removed 回收→lesson 配对」三步，
用不上的工具直接不注册。
```

落库证据：`policy_versions` v13，`source_judgment = rsi:not_improved:…`；
v14 仍保留该条，说明它已并入 π'，下一轮 Act 会经 `getInjectableView()` 注入。

### 4.4 饱和不伪造进步

另一会话 `e5378c88…` 中，复用率在 g2 就到达 1.0，g3 无法再严格变好。
krsi 判 `undecidable` 而不是 `not_improved`，理由由内核写出：

```
R5: 目标指标已达上限（1.0），本任务族已饱和 —— 没有可提升空间；应扩任务空间而不是改判据
```

这是「不编造教训」的硬约束：饱和意味着该扩任务空间，不是改判据让它继续绿。

### 4.5 Anchor 链

```
g2  verdict=not_improved  chain=✓  hash=b1f1fca5f60505c6…
g3  verdict=improved      chain=✓  hash=c46ecabaf1791b56…
链头 = c46ecabaf1791b569abeec1ac1fa1b4c…
```

---

## 5. 判据底座

| 判据 | 含义 |
|---|---|
| R1 | 任务可解（输入/产物齐全） |
| R2 | 判据指纹锚定（criteria_sha256 不得偷改） |
| R3 | 防删指标（难看的目标不能整条消失） |
| R4 | 产物哈希复核（artifact 是真文件真 sha256） |
| R5 | 严格变好（目标全变好、护栏不变差） |
| R6 | 同代 manifest 唯一（不得给同一代造两份） |

退出码：`0 improved / 1 not_improved / 2 refused / 3 undecidable`。

内核有 10 条对抗用例（`scripts/krsi-conformance.ts`），覆盖：护栏持平算达标、
目标饱和、删指标、篡改哈希、同代双 manifest 等。

---

## 6. 复现

```bash
cd /workspace/server
npm ci
npm run build          # tsc
go build -C krsi -o /tmp/krsi .   # 外部判决内核

node dist/app.js &     # 需要 .env 提供 LLM_SERVER_API_KEY / DEEP_ASSESSOR_*
node --import tsx scripts/seed-agent-loop.ts 3 --forge
```

单测：

```bash
npx vitest run tests/tool-forge.test.ts tests/rsi-manifest-builder.test.ts tests/web-search.test.ts
```

---

## 7. 已知边界

1. **能力库是会话级的**：避免跨会话污染归因。若要做组织级沉淀，需要另开一层共享库，
   并接受「新会话一开始复用率就很高」导致测量起点变化。
2. **护栏的生涯口径会记住未回收的工具**：已改成「本代有新建就看本代」，但未回收的历史
   工具仍会留在生涯均值里，作为一笔可追溯的技术债。
3. **工作轮的稳定性依赖上游网关**：客户端超时曾设 180s，会让工作轮静默重试并丢失工具事件，
   已提到 600s。这项不是 RSI 逻辑问题，但会污染读数。
4. **代码修复族已落地，题面已从「单文件纯函数」扩到「多文件 / 有状态 / 状态机解析」**：
   `CODE_TASKS` + `eval/**` 提供「改代码 + 真跑测试」的量化族，目标读数是
   `task.test_pass_rate`。内置套件从 6 个扩到 9 个：
   - `inventory_rollup`：入口 + `lib/parse.cjs` + `lib/pricing.cjs` 三文件联动，
     考跨文件调用约定、数值口径（折扣率、两位小数、合并后批量门槛）；
   - `job_queue`：入口 + `lib/queue.cjs` 的 `JobQueue` 状态机，考去重改优先级、
     同优先级 FIFO、取消与重新入队；
   - `csv_import`：原始 CSV 文本解析，考引号、`""` 转义、CRLF、引号内跨行字段、
     BOM、只 trim 未引用字段、列数不一致/未闭合引号的行号级报错。

   支撑改动：`EvalSuite.files` 声明可加载的同目录白名单，runner 在同一 vm 上下文里
   用极小的 CommonJS loader 加载（只允许相对路径、只允许白名单文件、模块体带 timeout）；
   `syncEvalFixtures` 改为递归复制夹具目录，沙箱重置后能重建多文件夹具；隐藏集与
   判据口径未放宽。

   读数（同一沙箱的缺陷起跑线）：扩题前 17/52 = 0.327 → 两组扩完后 33/94 = 0.351 ——
   分母扩大 81%，新题自身通过率（`inventory_rollup` 3/13、`job_queue` 6/12、
   `csv_import` 7/17）低于旧题均值，说明它们确实在压过拟合，而不是刷分。另有 6/6
   个参考实现变异体被隐藏集杀死。因为分母变了，代际比较必须另起一条链。仍未被覆盖的：
   异步/事件驱动、真实仓库级多文件重构（需要读写源码树）、以及依赖外部服务的行为。

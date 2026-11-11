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
   `task.test_pass_rate`。内置套件从 6 个扩到 11 个：
   - `inventory_rollup`：入口 + `lib/parse.cjs` + `lib/pricing.cjs` 三文件联动，
     考跨文件调用约定、数值口径（折扣率、两位小数、合并后批量门槛）；
   - `job_queue`：入口 + `lib/queue.cjs` 的 `JobQueue` 状态机，考去重改优先级、
     同优先级 FIFO、取消与重新入队；
   - `csv_import`：原始 CSV 文本解析，考引号、`""` 转义、CRLF、引号内跨行字段、
     BOM、只 trim 未引用字段、列数不一致/未闭合引号的行号级报错；
   - `json_patch`：RFC 6901 JSON Pointer + RFC 6902 子集的 `applyPatch`，考 `~1`/`~0`
     转义与非法转义报错、add 在数组下标处插入（不是追加）、`-` 追加、越界报错、
     remove/replace 的目标必须已存在、test 深比较、未知 op 报错、空指针替换整篇文档；
   - `bank_ledger`：入口 + `lib/ledger.cjs` 的整数分台账，考金额必须是整数分、
     流水号幂等（被拒交易也消耗流水号）、转账双边记账与超额整笔拒绝、按日汇总净额/笔数、
     结息按 `rateBps` 向下取整到分。

   支撑改动：`EvalSuite.files` 声明可加载的同目录白名单，runner 在同一 vm 上下文里
   用极小的 CommonJS loader 加载（只允许相对路径、只允许白名单文件、模块体带 timeout）；
   `syncEvalFixtures` 改为递归复制夹具目录，沙箱重置后能重建多文件夹具；隐藏集与
   判据口径未放宽。

   读数（同一沙箱的缺陷起跑线）：扩题前 17/52 = 0.327 → 前两组扩完 33/94 = 0.351
   → 加入 `json_patch` 后 38/110 = 0.345 → 加入 `bank_ledger` 后 43/126 = 0.341。
   分母比起点扩大 142%，新题自身通过率（`inventory_rollup` 3/13、`job_queue` 6/12、
   `csv_import` 7/17、`json_patch` 5/16、`bank_ledger` 5/16）均低于旧题均值，
   说明它们确实在压过拟合，而不是刷分。参考实现的变异体验证：
   CSV 6/6、JSON Patch 6/6、bank_ledger 11/11 被隐藏集杀死（bank_ledger 的十一个
   变异体：结息四舍五入、幂等只比对已入账、转账不拦同账户、转账漏记转入侧净额、
   金额允许小数、日记账不排序、不校验账户、结息不拦重复日期、利率上限放宽、
   日期格式放宽、流水号接受数字；每个变异体都保持公开用例全绿，只被隐藏集打红）。
   因为分母变了，代际比较必须另起一条链。仍未被覆盖的：
   异步/事件驱动、真实仓库级多文件重构（需要读写源码树）、以及依赖外部服务的行为。

   **扩题后的端到端自洽校验（json_patch 轮，110 分母）**（新会话起跑，本地 FakeLlm 离线演练，非真实上游）：
   - 套件发现：一次 `eval.run` 报出 11 个套件（10 内置 + 1 晋升的 `slugify_edge_cases`），
     合计 110 例（加入 `json_patch` 前是 10 个 / 94 例，发现与计分走同一条链路，未改代码）；
   - 夹具重建：先删掉 `workspace/eval/{inventory_rollup,job_queue,csv_import}` 再跑，
     `syncEvalFixtures` 逐一恢复（3 / 2 / 1 个文件），多文件套件不再依赖手工准备；
   - 代际锚链：全新 session 从 g1 起算，`g1 skipped → g2 → g3`，`prev_generation` 连续、
     anchor 哈希首尾衔接，等于把「另起一条链」落实成了新会话 g1，而不是接在旧分母的链后；
   - 面板读数：`policy_rsi_runs` 的 readings 里 `test_pass_rate` 与新分母一致
     （94 分母时为 0.351，110 分母时为 0.345），看板 `/api/rsi/overview` 原样返回，未出现分母错位。
   - 已知环境限制（与本轮扩题无关）：krsi 是 Go 二进制（源码 `krsi/main.go`，默认路径 `/tmp/krsi`），
     Windows 侧没有 Go 工具链时二进制不存在。bridge 现在**先预检**二进制：缺失就把该代记为
     `verdict=skipped`（理由写明路径与 `KRSI_BIN_PATH`），不再落成 `error` —— 仪器没装不等于判据坏了。
     读数、代际行与锚链照常落盘，只是没有 improved/not_improved 的终判。要拿到四态结论需在有 Go
     的环境，或把 `go build -C krsi -o <绝对路径>/krsi .` 的产物用 `KRSI_BIN_PATH` 指过去。
   - 汇总口径：`seed-agent-loop.ts` 在 `--code/--auto` 下由 harness 自己复算 `runEvalBattery`，
     每代打印 `gN 真实通过率 = passed/total` 及相对上一代的 delta，汇总再列 g0..gN 表。
     这条读数不经过 Judge、不依赖 krsi，避免了 `verdict=inconclusive` 时 `score=1.000` 的占位值。
     实测起点：`g0 43/126 = 0.341`（与上表缺陷起跑线一致）。
   - 跨沙箱回收的续接：`workspace/` 是 gitignore 的运行时目录，回收后修好的实现会一起消失。
     现在每代测量完把 `workspace/eval` 快照到版本库内 `server/eval-state/`（含 `latest.json`
     记录代次与读数），下次启动先 restore 快照、再 `syncEvalFixtures` 只补缺失套件。
     要重新从缺陷版本起跑，删掉 `server/eval-state/` 即可 —— 这是唯一的「重置」开关。

   **bank_ledger 轮（126 分母）的实测**：`allSuites` 发现 12 个套件（11 内置 + 1 晋升），
   合计 126 例；把 `eval-fixtures/bank_ledger` 同步进沙箱后整机读数为 43/126 = 0.341，
   新套件自身 5/16（11 条隐藏用例打红），与上表的缺陷起跑线一致。
   本轮只换了分母与一组题面，未改判决/锚链代码；代际链仍需另起新会话，不能接在 110 分母的旧链后。

   **rsi_report_parse 轮（136 分母）：缺陷题从「实验资产」转正为固定测量面。**

   前一轮把一次真实缺陷复刻成题目，为了不打断正在跑的服务，套件定义先落在
   `eval-suites/rsi_report_parse.json`（`promotedSuites()` 的运行时热加载目录）。
   这条路能让新一轮立刻生效，代价是**同一个套件在两处有定义**：JSON 一份、将来若要
   固化又是一份，两边一旦谁改了用例就出现「同一个 id、两套判据」。转正的做法是把它
   搬进 `EVAL_SUITES`（内置），并删掉那份 JSON —— 内置套件在代码里，随仓库一起走，
   不会因为「目录里还有一份旧 JSON」而悄悄覆盖。

   搬家的口径要点：
   - **指纹不变**：`computeEvalSetFingerprint()` 只对 `id / implPath / exportName / files /
     publicCases / hiddenCases` 做规范化哈希，不含 `title`、也不含「这道题来自内置还是晋升」。
     定义内容等值 ⇒ 指纹仍为 `3723e64f19d202c7`，6 代 anchor 链的跨代可比性不受影响。
     这是有意为之：**换存放位置不是换尺子**。
   - **分母 126 → 136**：新增 10 例（4 公开 + 6 隐藏），分母变了，代际比较同样要另起新链。
   - **夹具语义纠正**：`eval-fixtures/rsi_report_parse/impl.cjs` 从「已修版本」改回**缺陷起点**
     （只认半角冒号）。该目录的契约是「沙箱待修实现的版本库副本」，`seed-agent-loop` 靠它
     重置沙箱；存已修版本会让重置变成「一开局就满分」，题目失去意义。已修版本另行以
     参考实现的形式进 `tests/eval-suite.test.ts` 的 `GOOD` 表，用于自证「判据可以变绿」。
   - **三点自证补齐**：该套件同时进 `fixtureBacked` 列表，于是「正确实现满分 / 夹具缺陷真红
     且隐藏用例抓得住 / 只满足公开用例拿不到满分」三条都由测试守住，不再依赖人工校准。

   转正后的整机读数（12 内置 + 1 晋升 = 13 套件，136 例）：**85/136 = 0.625**，
   `rsi_report_parse` 自身 10/10；`tests/eval-suite.test.ts` 14 项全绿。
   服务端需要重启一次才能丢掉启动时载入的旧套件表 —— 这是热加载方案唯一没解决的
   「改完要重启」之外的反面：内置套件改了也必须重启，两者在这一点上等价。

## 8. 看板接口契约（`GET /api/rsi/overview?session=<id>`）

看板不解析人类可读文案。`task.test_pass_rate` 的结构化读数落在
`judge_verdicts.data_json`（007 迁移新增列，旧库由 `applyMigrations` 补列，旧行为 NULL），
接口把它整理成顶层 `eval` 对象，与既有字段并存：

```jsonc
{
  "session": { ... },            // 原样保留
  "judgeRuns": [ ... ],          // 原样保留
  "verdictsByRun": { "21": [ { "criterion": "task.test_pass_rate", "data": { ... } } ] },
  "rsiRuns": [ ... ],            // 原样保留
  "attributions": [ ... ],       // 原样保留
  "eval": {
    "runId": 27,
    "status": "fail",
    "score": 0.345,
    "detail": "固定评测套件 38/110 通过（含隐藏用例）…",
    "measuredAt": 1794270841437,
    "passed": 38,
    "total": 110,
    "denominator": 110,
    "suites": [
      { "id": "json_patch", "title": "…", "ok": false,
        "passed": 5, "total": 16, "publicPassed": 2, "publicTotal": 2 }
    ],
    "source": "structured"       // 或 "detail_only"
  }
}
```

兼容约定：
- 顶层既有字段一个都没删、没改名，旧的解析路径继续可用；`verdictsByRun` 里每条判决
  只是**多**了一个 `data` 字段。
- `source: "detail_only"` 表示该会话还没有结构化读数（007 迁移之前落的旧行）：
  此时 `passed` / `total` / `denominator` 为 `null`、`suites` 为空数组，前端应退回解析
  `detail`，不要把 null 当 0 画成「通过率为零」。
- 同一会话新旧混排时，`eval` 取**最新的结构化行**（`runId` 指明是哪一次判决），
  不会因为后面又落了一条无结构化的行而把曲线打回 null。
- `data_json` 解析失败按「无结构化读数」处理，接口不 500。

真实数据：本机 `data/codelens.db` 里已有落盘的 `task.test_pass_rate` 读数
（旧行 12 条为 detail_only；新跑一次判决后产生 `source=structured`、`38/110`、
11 个套件清单的行），前端可以直接用来验收曲线，不必依赖夹具。


## 2026-11-11 · 136 分母轮（判据加地板 + 选题按分数）

这一轮同时换了两个东西：**测量面**加了套件级地板，**选题**从固定轮转改成按分数挑。

### 为什么加地板

`task.test_pass_rate` 是整机率 `Σpassed/Σtotal`，13 个套件可以互相抵消，而 R5 只比这一个标量。
实测注入（真 krsi + 临时目录构造 manifest）：`parse_query` 2/8→8/8（+6）同时
`csv_import` 7/17→2/17（-5），整机 0.691→0.699 → 判 `improved`，理由写「全部指标严格变好」。

新增护栏 `task.suite_floor`（metric `suite_floor_ratio`，role `guard`）：逐个套件比上一代，
任何套件通过率下降即变差。判据指纹随之从 `8d567e31…` 变为 `522c3dda…`，
因此**旧链 907ef502 / 7d7876d4 不再延长**（它们仍可完整校验）。

### 为什么改选题

固定轮转 `tasks[i % tasks.length]` 不知道当前谁红：会撞满分的 `inventory_rollup` 白跑一代，
也会漏掉没写任务文本的 `slugify_edge_cases`（4/7 长期无人处理，已补任务）。
现在按 `未满分 → 本次未试过 → 通过率低 → 题数多` 排序选题，确定性、可复现。

### 新链结果：session 2b5ef88f

| 代 | 选中套件 | 修复结果 | 电池 | krsi 判决 |
|---|---|---|---|---|
| g1 | csv_import | 1/17 → 15/17 | 88 → 102 | skipped（首代，确立地板基线 1.0） |
| g2 | parse_query | 2/8 → 8/8 | 102 → 108 | improved / exit 0 |
| g3 | json_patch | 5/16 → 16/16 | 108 → 119 | improved / exit 0 |
| g4 | chunk | 2/6 → 6/6 | 119 → 123 | improved / exit 0 |

**三轮连续 improved，且从 gen2 起 `suite_floor_ratio` 每代都是 1（13/13 未回退）** ——
套件级对比显示全程无一项下降，所以这个 1.0 是真实结论，不是永真值。

终态 123/136 = 0.904。剩余：`parse_kv` 3/8、`slugify_edge_cases` 4/7、`csv_import` 15/17、
`interval_merge` 5/7、`bank_ledger` 15/16。下一轮选题会落到 `parse_kv`（差 5 例）。

评测集指纹 `3723e64f19d202c7` 未变（只加任务文本，没动判据）。

### 踩到的坑（第二次同样原因）

服务进程启动早于代码修改 → 加载的仍是旧判据集。这次在起链前先比对文件 mtime 与进程
`CreationDate`，确认进程（03:07）晚于改动（03:00 之后）才开跑。这个检查应固化成习惯，
而不是靠记忆。

## 2026-11-11 · 二阶：改自己的产品源码（2.1.0）

前面所有轮次改的都是 `workspace/eval/<id>/impl.cjs`——题目沙箱里的实现，得分是做题分数，
产品代码一行没动。这一轮把靶子换成了产品源码 `src/utils/ssrf-guard.ts`。

### 判据与围栏

判据 `tests/self-upgrade/ip-form.test.ts`（7 条用例，先红 4 条）。它量的是**可观察行为**，
不锁实现：IPv6 按数值语义判定、默认端口由协议决定、方括号字面量按 IP 判、DNS 返回形态不可信。

围栏 `scripts/check-self-upgrade.mjs`（`npm run check:self-upgrade`）：
157 个受保护文件逐个比 sha256（`tests/`、`krsi/`、`src/services/{judge,rsi,eval}/`、`eval-*`、
`scripts/check-*`、`vitest.config.ts`），任一变化即 FAIL；判据指纹单独钉；正向清单只放行一个文件。
自证：给判据追加一行注释 → 立刻两项 FAIL「这次不构成一次升级」；还原 → 全绿。

### 三次失败都在机制层，不在能力层

| 现象 | 根因 | 处置 |
|---|---|---|
| 8 轮后 `budget_exhausted` | 预算 = 上下文窗口(32k) × 因子 2 = 64k，读两次文件就烧完 | 因子提到 8（仅本次运行的进程内） |
| 14 轮 0 次写入 | 无头运行没开 `autoApprove.fsDestructive`，写入停在等审批 | 派单前自行开启（与 `--code` 模式一致） |
| 14 次全是 `fs.read` | 工具返回全文，但回灌给模型时被截断，模型按 `lineStart/lineEnd` 反复切片，一次没写成 | 把源码全文放进任务书，绕开已知截断 |

第三条是可复现的产品缺陷：`fs.read` 的提示写着「可显式调大 maxBytes」，但真正的瓶颈在
结果回灌截断，模型看到的是片段，越读越碎。这条留作待办，没有顺手改——改它就是改
另一处被测对象，会把这次升级的证据弄浑。

### 结果

4 次工具调用、146.2s、2 次写入。改动 112 行增/21 行删：把 IPv6 展开成 16 字节再判定
（`::` 压缩、点分尾、zone id、方括号全支持），端口按协议取默认值，字面量先脱方括号。

隐藏用例 16/16（不在仓库里，跑完即删）。其中 `::ffff:a9fe:a9fe` = `169.254.169.254`
（云元数据）在修复前是**放行**的——这是真实的 SSRF 穿透路径，不是理论风险。

版本 2.0.0 → **2.1.0**（四个 manifest + 两个 lock，由 `version-consistency.test.ts` 守住）。

### 边界（必须写清）

这仍然**不是**二阶 RSI。判据是我写的，围栏是我写的，它只在「把这个函数改对」这一层上
自我改进；它没有能力去改判据、也没有能力判断这个洞该不该修。Good(1965) 意义上的
「改进改进自身的能力」还差一层：要让它自己提出判据、自己评估判据的判别力。
这次只证明了「AI 能安全地改自己的代码并被机械验证」，没有证明「AI 能自己决定改什么」。

---

## 第二轮 · 把上一轮留下的待办派给它（2.1.0 → 2.2.0）

上一轮末尾记了一条待办：「`fs.read` 结果回灌被截断，模型越读越碎」。这一轮不手工修，
把它原样派给 Agent，看它能不能修掉那个**曾经卡死自己的**缺陷。

### 先把缺陷量出来（不靠猜）

探针读一个 377 行的源码文件，走完 executor 的真实裁剪链：

| 指标 | 实测 |
|---|---|
| 工具自身返回 | 14 963 字符 / 377 行 |
| 模型实得 | 3 409 字符（**22.8%**） |
| observation 是不是合法 JSON | **否**（截在字符串中间） |
| 续读指引 | 「用 `fs.read` 分段读 `.artifacts/x.json`」 |
| 那个归档的 JSON 序列化行数 | **1 行** → `lineStart/lineEnd` 完全失效 |
| 照做的后果 | 每次只拿前 4 000 字符，**旋转门**：永远读不完 |

根因是 `recordSuccess` 先 `JSON.stringify(data)` 再按字符前缀裁——结构信息在序列化那一步
就丢了，后面只能盲切。

### 准备：把缺陷收进一个能改的盒子

`executor.service.ts` 有 739 行，而 `fs.write` 只支持整份 overwrite。让 Agent 在 8k 输出上限内
重写 739 行不现实。所以先把「回灌渲染」抽成 `src/services/tools/observation-render.ts`
（130 行），executor 只负责序列化、归档、落库、发事件，渲染交给它。

**这一步是纯重构，行为必须一模一样**：抽完重跑判据，仍然是 6 红 1 绿，既有 33 条相关用例
全绿——否则后面所有证据都说不清是谁造成的。

### 判据：只锁「模型看到什么」

`tests/self-upgrade/fs-read-observation.test.ts`，7 条，全部从 `ExecutionOutcome.observation`
这一层观察，不碰内部实现：

| # | 判据 | 缺陷版 |
|---|---|---|
| T1 | 裁剪后必须给出可解析的续读行号 | 红（没有任何行号） |
| T2 | 只按该指引反复读，有限步内覆盖全文 | 红（0 步，缺 216 行） |
| T3 | 每条 observation ≤ 1000 token | 红（1104，前缀没算进去） |
| T4 | 不得把 `.artifacts` 当成续读目标 | 红 |
| T5 | 正文是原始文本，不是 JSON 转义串 | 红（104 处 `\r\n`） |
| T6 | 行窗口精确（101–150 → 续读 151） | 红 |
| T7 | 小文件不受影响（回归守卫） | 绿 |

T4 第一版写错了：它只要 `fs.read` 与 `.artifacts` 同行就判红，于是正确的修复
（「不要读 `.artifacts`」）也被判红。改成判断「是否被当作续读**目标**」——`\.artifacts`
前 8 字符内出现「不要/别/勿」即放行。**判据也会假红，改判据要留改动理由。**

### 围栏顺手补了三个洞

| 洞 | 后果 | 修法 |
|---|---|---|
| `git diff` 看不到未跟踪文件 | 靶子是新建文件时，改了也判「未改动」 | 加 `git ls-files --others` |
| 用 git 状态判「靶子是否被改」 | 打基线时它本来就是脏的，改完被过滤掉 | 改比**内容指纹**（`allowedHashes`） |
| 靶子没动也算通过 | 改个无关文件、判据恰好绿 → 误判为一次升级 | 靶子未变直接 FAIL |

### 8 次派单：真正难的不是写，是让它能写

| 轮 | 结果 | 卡在哪 |
|---|---|---|
| 1 | 6 轮 / 12 次读 / 0 写入 | 它在读 executor 想搞懂调用方，被自己要修的缺陷截断 |
| 2 | 1 次写入 / 编译失败 | 任务书给足了事实，它写对了结构，但 `!data mammoth` |
| 3 | 1 次写入 / 编译失败 | `1000oca`、`rawLines.length === 0 scrubbed` |
| 4 | 1 次写入 / **6 of 7 绿** | 思路全对：按行排版、绝对行号、token 预算 |
| 5 | 6 轮 / 12 次读 / 0 写入 | 想先核实文件内容，又撞上同一个截断 |
| 6 | 2 次写入 / 编译失败 | `1000beda`，且把上一轮的坏产物原样抄了一遍 |
| 7 | 1 次写入 / 编译失败 | 起点是坏产物，它照抄了坏行 |
| 8 | 1 次写入 / **围栏通过** | 起点换成语法正确的 6/7 版本，只改两处 |

两条教训，都是机制层的：

1. **不要让坏产物当下一轮的起点。** 任务书里的「当前全文」是它自己上一轮写坏的版本时，
   它会照着抄——第 6、7 轮的失败完全一致，不是它不理解，是它把注释里的错字当成了原文。
2. **它没法自检语法。** `sys.exec` 是 `hard` 审批，无头运行批不了，所以它改完不能编译、
   不能试跑，只能靠外部把编译器原文喂回去。**这就是为什么它能写对逻辑却写不对字面量。**

第 6 轮那次「6 轮读 12 次文件」，恰好是它要修的那个缺陷在它自己身上复现：它读文件走的
正是它还没修好的那条路径，读 1 次和读 12 次看到的完全一样。

### 结果

`observation-render.ts` 173 行（缺陷版 120 行，+53），文件类结果改为**按行排版**：

- 每行带绝对行号（`73	decision: ...`），正文是原始文本，无 JSON 转义
- 每段按 token 预算装行，前缀与续读提示一起计入 1000
- 结尾给 `继续读取请用 fs.read 并传 lineStart=74`，明确写「不要读 .artifacts 归档」
- 「是否还有后续」看 `file.truncated` 与 `lines.returned < lines.total`，不自己重算总行数
  （这条是它自己想通的：小文件末尾换行会让重算值偏大，导致误报截断）

复测同一个 711 行文件：单条 observation **999 token / 73 行**；只按提示续读，
**11 步覆盖 711 行，零缺失、零转圈**。修复前是 22.8% 且不可续读。

围栏：`受保护路径零改动（158 文件）` + `判据指纹未变` + `靶子被改动` + `判据通过`。
回归：后端 118 files / 1172 tests 全绿，双端 `tsc` 0，`version-consistency` 9/9。

版本 2.1.0 → **2.2.0**。失败产物留在 `.self-upgrade/attempts/`（attempt4 是 6/7 那次，
attempt5 是带 `1000beda` 的那次），它们是「模型会写错字面量」的原始证据。

### 边界（比上一轮更清楚）

这次比上一轮多证明了一点：**它能在有外部反馈的情况下自己收敛**——第 4 轮的结构是它想出来的
（按行排版 + 绝对行号），第 8 轮的小文件判据也是它自己修的。但它需要三样东西才能收敛：
我写的判据、我给的编译错误、我摆好的起点。

所以仍然不是二阶 RSI，但把「缺什么」定位得更准了：缺的不是写代码的能力，是**自检手段**
（编译/运行）与**改动粒度**（只能整份重写，没有 patch，于是长文件必然带上字面量噪声）。
下一轮该修的是这两样，而不是再换一个函数让它改。

---

## 第三轮 · 把上一轮记下的两个缺口也派给它（2.2.0 → 2.3.0）

第二轮结尾我写了两条边界：它缺**自检手段**（改完不能编译/试跑），缺**改动粒度**（只能整份重写）。
这一轮不补这两样，直接把这两样当作题派给它——让它给自己造手。

### 一、自检手段：`code.check`（只解析、不执行）

**为什么不能给它 `sys.exec`**：`risk: high` / `approvalMode: hard`，且 `node` 恒需 `two_step`
审批。无头会话批不下来，等于没有。（改审批档位是产品安全决策，不该混进这一轮实验。）
**为什么不能直接 import `typescript`**：它是 devDependency，`npm ci --omit=dev` 之后不存在，
引它等于把这个工具做成「只在开发机可用」。

可行解是 Node 22 自带的 `module.stripTypeScriptTypes`：类型剥离走的是完整 TS 解析器，
非法语法在解析阶段就抛 `SyntaxError`，不执行任何用户代码，零依赖。实测三种历史笔误全部命中：

| 历史笔误 | 解析器原话 |
|---|---|
| `1000oca` | `Identifier cannot follow number` |
| `!data mammoth` | `Expected ')', got 'mammoth'` |
| `=== 0 scrubbed` | `Expected ')', got 'scrubbed'` |

判据 `tests/self-upgrade/code-check.test.ts`，8 条，只观察 `ToolOutcome`：注册与审批档位、
合法文件行数、两类笔误的行号定位、**不执行**（顶层 `process.exit(3)` 仍须通过）、越界报 security、
非源码扩展名拒绝、文件不存在报 not_found。

**三轮才收敛，卡点一次比一次浅：**

| 轮 | 结果 | 卡在哪 |
|---|---|---|
| 1 | 4 轮 / 4 次写 / 被「循环调用」中止 | **整份 API 都是编的**：`run()` 而非 `handler`、`ctx.readFile`、`ToolContext`/`ToolResult`、把 `JailVerdict` 当字符串。还连写 3 遍同样的 3287 字节 |
| 2 | 1 次写 / **7 of 8** | 给了真实契约（范例工具全文 + path-jail 用法 + 四行 import）就基本写对了 |
| 3 | 1 次写 / **8 of 8**，22 秒 | 只给一行 `TS2345` 报错，它改成 `parseInt(m[1]!, 10)` |

第一轮的失败很关键：**它不是不会写代码，是不知道 API 长什么样**。没有真值它只能编，
而编出来的东西看起来完全合理（`run(args, ctx)` 读起来比 `handler` 更自然）。
给真值之后一次就过。

### 二、改动粒度：`fs.write` 的 `replace`

它只有 create/overwrite/append。想改一行就得重抄整份：修 `observation-render` 重写 377 行，
三次编译失败全是重抄带进的噪声；上一轮为改一行 `parseInt`，又重写了 106 行。
**重抄的长度就是出错概率。**

`replace` 的语义按「宁可拒绝，也不静默多改」设计，判据 8 条：
恰好一处命中才写、零命中拒绝、多处命中拒绝并报次数、原文等于新文拒绝（空操作不是修改）、
跨行片段、**CRLF 文件里 LF 片段能命中且写回仍是 CRLF**、文件不存在不创建、安全边界不放松。

| 轮 | 结果 |
|---|---|
| 1 | 墙钟 180s 耗尽；产物实测 **6 of 8** 真通过 |
| 2 | `fs.write{operation:"replace"}` 改自己一行 + `code.check` 自检，**9 秒，8 of 8** |

第二轮的调用序列本身就是这一轮的证据：

```
tool_call  fs.write  {"operation":"replace","oldText":"const replacement = crlf ? ..."}
tool_call  code.check {"path":"src/tools/builtin/fs-write.tool.ts"}
```

**它用自己刚造的两个能力，修了自己的第三个缺陷。** 这是前面两轮都没有过的形态。

### 三、这一轮我自己犯的错（比它的错更值得记）

判据红了三次，**三次都是我的尺子错**，不是它的实现错：

| 我写错的 | 表现 | 真相 |
|---|---|---|
| `code-check` C2 断言 12 行 | 工具报 11 | 夹具是 11 行正文 + 结尾换行，11 才对 |
| `fs-write-replace` 判据 import 路径写成 `../src/` | 8 条全红 | 文件在 `tests/self-upgrade/`，要 `../../` |
| `fs-write-replace` C5 期望值 | 说它跨行替换漏了旧行 | 我把 `return a + b;` 也写没了，那行本来不该动 |

第一条被围栏挡下来了（判据不绿就不算升级），后两条是我自己复核时发现的。
**「判据红」不等于「它错了」**——这一轮有 37% 的红灯是我的问题，这个比例必须记下来。

### 四、围栏补了第五道：判据绿 ≠ 没弄坏别的东西

`code.check` 那轮 8 条判据全绿、围栏四项全 PASS，却在既有门禁
`K16 新增带 path 参数的工具必须被自动捕获覆盖` 上红了 —— 判据只覆盖「这题要什么」，
覆盖不了「别的东西有没有被踩坏」。围栏的判据段因此加 `--full`：全量套件不绿，
同样判「不构成一次升级」。`K16` 的正确处置是显式登记（只读工具不参与写前快照），
这条登记由我做，因为它在受保护路径里、Agent 改不到——这正是它该被保护的原因。

### 五、一个纯环境问题：模型墙钟

`平衡` 是推理档。同一单派了两次，都是 **300 秒整、零字节、零 token**：
`upstream_first_byte` 8 秒就到了，之后一直只有 SSE 心跳，最后被 300s 的
`headersTimeout` 掐断。直连上游用大 prompt 测是 7.5 秒，走应用层一句「收到」要 95 秒——
差的是推理 token 的墙钟，不是网络。换成 `deepseek-v4-flash` 后单次 1~9 秒。
这不是代码缺陷，但会让人误判成「它不干活」。

### 边界（比上一轮更清楚）

- `code.check` **只查语法，不查类型**：`TS2345` 那种要靠外部编译器喂。`column` 目前恒为 1（占位）。
- 它仍然不是二阶 RSI：判据、围栏、报错原文、起点，四样外部输入一样没少。
- 但它这次补上的两样，恰好是**让它后一次做得更好的东西**——自检与局部修改都是元能力，
  和「再修一个函数」不是一类。
- 下一个真缺口：**改完不知道运行时行为对不对**。语法过了、类型过了，行为仍可能错
  （C6 行尾就是语法和类型都发现不了的）。要补的是「能跑指定测试并读回断言差异」，
  而它现在连 `vitest` 都起不动。

---

## 第四轮 · 把「每轮手工的四步」做成循环（2.3.0 → 2.4.0）

前三轮的形态是：我打基线、我派单、我跑围栏、我把失败原因喂回去。这一轮把这四步交给
`scripts/self-upgrade-loop.ts`，人只保留两样输入——**题目规格**与**判据文件**。

### 自动化的是执行，不是出题

题源仍在 `self-upgrade/tasks.json`，判据仍由人写。这不是技术限制，是设计选择：
如果判据也由它自己定义，它必然挑自己已经满足的条件出题，账本会非常漂亮，事实上等于零。
**衡量标准必须留在被衡量者之外**——这一点在搭自动化时比在手工轮次里更关键，
因为循环会把它重复很多遍。

一个伴生的决定：`tasks.json` 也纳入受保护路径。它定义「靶子是谁、判据是哪份」，
改它等于换题，所以它和判据是同一类东西。

### 搭循环时发现：围栏从来没保护过自己

`check-self-upgrade.mjs` 的受保护清单里写着 `'scripts/check-'`，但 `snapshot()` 直接
`join(SERVER, 'scripts/check-')` —— 这不是一个真实路径，`existsSync` 为 false 后
**静默 continue**。于是 160 个受保护文件里，`scripts/` 下是 **0 个**。

手工跑几轮时这个洞不致命（我每次都看着）；但它随时可以改写门禁脚本或派单脚本本身。
如果循环连跑一百次，这就等于没有围栏——**改松一次，后面所有「升级成立」全作废**。

改成整个 `scripts/` 目录后：受保护 173 个文件，其中 `scripts/` 13 个（含围栏自身、
派单脚本、循环脚本）。这道修复必须由人做：门禁脚本不能交给被它衡量的对象去修。

### 三条安全约束（写在文件头，因为它们最容易在重构时被悄悄改掉）

| 约束 | 不遵守会怎样 |
|---|---|
| 尝试之间**绝不重打基线** | 基线是「派单前」指纹。每次重试都重打，Agent 上一轮对 `scripts/` 的越界改动会被吸收进新基线，下一轮围栏认为一切正常——这是唯一能让整套门禁**静默失效**的路径 |
| 规格只从 `tasks.json` 读一次 | 围栏的 `--allowed/--judge` 与规格各写一份，一旦漂移就变成「围栏守的是上一道题」：不报错，只把越界当合法升级放过 |
| 墙钟硬止损 | 单次派单能吃掉 10 分钟，没上限会自动跑一整夜 |

### 第一次实跑：3 次全失败，其中 2 次是我的 bug

| 轮 | 表面现象 | 真实原因 |
|---|---|---|
| 1 | 派单 24s「正常退出」，靶子未改动 | **它只回了一句**「I'll fix the `extractErrorInfo` function…」，**0 次工具调用**就 stop 了 |
| 2 | 派单 **3s 异常退出** | **我的 bug**：`shell: true` 下 `execFileSync` 不转义参数，`--feedback-file=C:/.../新建文件夹 (2)\...` 里的空格把命令拆断，npx 直接退非零 |
| 3 | 同上 | 同上 |

更糟的是诊断也坏了：`diagnose()` 里用文本正则抓 `AssertionError:`，实测 vitest 在
**管道（非 TTY）下根本不打印断言消息**（同一份用例，管道里 `×` 行有 1 条、
`AssertionError` 行有 0 条）。所以第 1 轮交给下一轮的「反馈」只有
「靶子未被改动」——模型看了也不知道该改什么。

**这是这一轮最值得记的一条**：手工轮次里我的错只是多花一小时；放进循环，
同一个错会在每一题、每一次尝试上重复，还会把正确行为也判成失败。
自动化不降低对人的要求，它把人的错误放大成系统性的浪费。

### 修的四处

| 改动 | 理由 |
|---|---|
| `quoteArg()`：Windows 下含 `\s()&\|<>^"` 的参数自己加引号 | 上述 3s 崩溃的直接修复 |
| 诊断改走 `--reporter=json --outputFile` | 管道模式拿不到断言消息，只能取结构化结果；顺便去掉堆栈（对模型无信息量，只撑上下文） |
| 围栏：**判据红时不再跑全量** | 全量套件包含这道判据本身，它红全量必红，跑一遍只是花五分钟确认已知的事。循环里这条能省掉一半墙钟，而墙钟是唯一硬上限 |
| 检测 `toolCallCount === 0` 并在反馈里点名 | 「只说不做」是真实失败模式，围栏只会说「靶子未被改动」，模型看不出是自己的问题 |

### 结果

第 4 次（带外部反馈手动补派，用于验证第 3 条修好之后能过）：

```
tool_call  fs.write    {operation:"replace", ...}   ← 只改 extractErrorInfo 一处
tool_call  code.check  {path:"src/tools/builtin/code-check.tool.ts"}  ← 用自己造的工具自检
```

5 次工具调用、24.6 秒。判据 7/7，`column` 从恒 1 变成真实落点：

| 样本 | 修复前 | 修复后 |
|---|---|---|
| `export const B = fooo bar baz;` | `column=1`（行首） | `column=23` → 指向 `bar` |
| `const b = 1000oca;` | `column=1` | `column=28` → 指向 `oca` |
| 合法文件 | 不报位置 | 不报位置（未编造） |

它自己加了范围校验（`column < 1 || column > frame.length + 1 → 退回 1`），
这一条判据里只写了「不能编出不存在的列」，具体做法是它想出来的。

围栏五项全 PASS（受保护 176 文件零改动、判据指纹未变、靶子被改动、判据通过、全量回归通过）。
回归：**121 files / 1195 tests 全绿**，双端 `tsc` 0，contract 14/14、suite-floor 3/3、krsi 通过，
`version-consistency` 9/9。版本 2.3.0 → **2.4.0**。

### 账本：failed 与 upgraded 并存

`.self-upgrade/ledger.jsonl` 里这道题有两条记录：`failed(3 次)` 与
`upgraded(第 4 次，补记)`。**没有覆盖前一条**。账本的价值在于能看出「这次升级是靠几次
无效尝试换来的、无效的原因在谁身上」——如果把 failed 删掉，只剩一个漂亮的结果，
下一轮就无法判断循环本身是否健康。

### 边界（这一轮之后更清楚）

1. **服务沙箱根仍需人工切换。** Agent 要写 `src/`，服务就必须以 `server/` 为
   `SANDBOX_ROOT` 启动；跑完要切回默认值。这是循环之外的一步，也是它还不能真正
   无人值守的唯一硬原因（下一轮可以让循环自己管服务生命周期）。
2. **题源仍要人给。** 现在 `tasks.json` 里只剩已完成的题，循环会打印
   「没有待办题目，题源需要人工补」并正常退出——这是设计，不是故障。
3. **它仍然只在有外部反馈时收敛。** 四种输入一样没少：判据、围栏、报错原文、起点。
   这一轮多出来的只是「这四样自动地、反复地给」。

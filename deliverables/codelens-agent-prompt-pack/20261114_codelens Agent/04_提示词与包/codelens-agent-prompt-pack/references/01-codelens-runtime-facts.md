# 01 · CodeLens 运行态事实

> 信源：S1 `docs/agent/CODELENS-MANUAL.md`（§3–§12）；S1 `docs/agent/spec.md`（§4–§6、§10、§12）；S1 `server/src/services/agent/task-prompts.ts`（:23-74，内建任务模式契约）（访问日期：2026-11-14）
> 补充核实（本机只读实跑，核对日期 2026-11-14）：`AGENTS.md`、`docs/agent/HANDOFF-2026-11-14.md`、`docs/agent/openapi.yaml`、`server/src/tools/builtin/index.ts`、`server/src/types/tool.ts`、`server/src/tools/builtin/agent-verify.tool.ts`、根/`server`/`client` 三个 `package.json`、`server/self-upgrade/tasks.json`、`.self-upgrade/baseline.json`、`.github/workflows/ci.yml`、`scripts/assert-tool-registry-contract.mjs`、`server/tests/task-prompts.test.ts`（测试级旁证）、`server/tests/self-upgrade/agent-verify.test.ts`（`agent.verify` 判据，146 行）、`01_信源调研/核心场景事实地图.md`（g-2 契约类型表）、`git status --short -- server/`（未提交改动与未跟踪新增全量清单）
> 适用版本：spec v2.0 契约 / 手册 v2.20.0 运行态 / 核实日期 2026-11-14；版本差异处已分列/标注
> 核实状态：已核实（一手文件逐项对照 + 本机只读实跑 + 坊主 2026-11-14 工具数事实裁定已并入）；活读数一律标锚点，不写成规范；本轮改动/新增文件均标 git 状态
> 覆盖体系表编号：§1 S0 / A2 / A3 / A5 / B3 / B4 / B6 / B7 / S1；L1-1 / L1-2 / L1-3 / L1-6 / L1-7；L2-2 / L2-3 / L2-4 / L2-7；L3-5 / L3-6；冲突 C1–C4；W3（依据 `02_能力体系/三级能力体系表.md` §1、§5）
> 待核实项：6 处，见文末《待核实清单》

---

## 0. 先定口径：文档基准、当前文件态、活读数

这份文件给执行 Agent 一张「照着查、照着跑」的运行态地图。先固定三条口径，后文每个数字都按它读。

| 口径 | 值 | 出处 |
|---|---|---|
| 契约基准 | Spec v2.0，`docs/agent/spec.md:1`，生成 2026-10-22 | 手册 :4「spec.md 仍是唯一契约来源」；`AGENTS.md:12` |
| 运行态基准 | 2.20.0，分支 `main` | 手册 §12:274；`HANDOFF-2026-11-14.md:1`、§3:49、§8:161 |
| 核实日期 | 2026-11-14，手册最后核对 @ `b54369f` | 手册 :3 |
| 当前文件态 | 根 / `server` / `client` 三个 `package.json` 均 `"version": "2.21.0"` | 本机只读实跑；`HANDOFF §6:125` |

**版本差异（分列式，不抹平）**：

| 版本号 | 出处 | 性质 |
|---|---|---|
| v2.11.0 | `AGENTS.md:7` 对手册的引用 | 引用残留，未随手册更新 |
| v2.18.0 | 手册 :1 标题；`HANDOFF:22` 逐题发布 | 标题残留 / 题级版本 |
| **2.20.0** | 手册 §12:274；HANDOFF :1 / §3 / §8 | **本包采用基准** |
| 2.21.0 | 三个 `package.json`；`tasks.json` 中 10 题 `releasedIn: "2.21.0"`；`HANDOFF §6:125` | 当前文件态 / 运行实例活读数 |
| v2.0 | `spec.md:1` | 契约版本，非运行态版本 |
| 2.1.0 | `docs/agent/openapi.yaml:5` | 服务端契约文件版本 |

**坊主 2026-11-14 事实裁定（全组统一口径，覆盖此前「三处读数未分层」的说法）**：当前源码注册表 `server/src/tools/builtin/index.ts:25-46` 的 `BUILTIN_TOOLS` 实读**恰好 20 个工具（含 `agent.verify`）**；此为活读数，以实跑为准，不得写成规范；手册 §4 的 19 是上一轮读数（`agent.verify` 落地前），手册 §10 的 17 是 8080 旧构建实例。三处不在同一层，不并列取舍。详见 §2。

**当前工作区 git 状态（本机 `git status --short` 实读，2026-11-14）**：

| 状态 | 文件 |
|---|---|
| 未提交改动 `M` | `docs/agent/HANDOFF-2026-11-14.md`；`server/src/services/agent/agent-loop.service.ts`、`react-channel.ts`、`system-prompt.ts`、`task-prompts.ts`；`server/src/services/tools/effect-preview.ts`；`server/src/tools/builtin/index.ts`；`server/src/types/tool.ts` |
| 未跟踪新增 `??`（`src`，4 个） | `server/src/services/agent/review-facts.ts`、`run-assembly.ts`、`run-services.ts`；`server/src/tools/builtin/agent-verify.tool.ts` |
| 未跟踪新增 `??`（`tests`，4 个） | `server/tests/self-upgrade/agent-verify.test.ts`（146 行）、`agent-loop-split.test.ts`、`approval-diff.test.ts`、`mutation-dirty.test.ts` |

上述文件属「本地当前态」，与手册 §4 的 19 工具表不是同一层。引用其字段一律以读到的实际内容为准，并标注「未提交改动 / 未跟踪新增」。本轮全量 `git status --short -- server/` 实读 `??` 共 **8 个**；侦察官核到 5 个（4 个 src + `agent-verify.test.ts`），差额是本轮另扫到的 3 个 self-upgrade 判据文件，两者不矛盾，以全量实读为准。

**更正（2026-11-14 复核，取代本文件上一版结论）**：上一版把 `tests/self-upgrade/agent-verify.test.ts` 判为「不存在」，是**路径漏了 `server/` 前缀**、且 `git status` 未扫 `server/tests/` 所致。本机重读核实：`server/tests/self-upgrade/agent-verify.test.ts` **存在**（5851 字节 / 146 行 / `git status` 标 `??`）。文件头注释写「agent.verify 的判据：把『改完必须验』从提示词变成可复核的读数」，列三层断言：①声明式计划只认 `package.json` 的 `verify` 数组，非法/未声明的脚本名进不来；②真跑一个临时包，通过 → `ok=true` 且 `exitCode=0`，失败 → `ok=false` 且带失败脚本名；③工具已注册、`wireName` 可从规范名推导，三个包都真的声明了 `verify`。`server/self-upgrade/tasks.json` 的 `agent-verify` 题 `judge: "tests/self-upgrade/agent-verify.test.ts"`（**相对 `server/`**）与该路径完全对应；该题 `strengthens: "Update"` / `status: "done"` / `releasedIn: "2.21.0"`，`allowed` 三文件为 `src/tools/builtin/agent-verify.tool.ts`、`src/tools/builtin/index.ts`、`src/services/agent/task-prompts.ts`。派单类提示词引用此题时**不得漏掉 judge 路径**。此更正已同步侦察官、终审与坊主。

**错误做法 → 现象 → 正确做法**：把 `tasks.json` 的 36 题写成「手册说 25 题，所以题集只有 25 题」→ 派单脚本读的是 `tasks.json`，会漏掉 11 题 → 把 25 记为「手册 §7.3 的读数快照」，把 36 记为「本机实跑读数，锚点 `server/self-upgrade/tasks.json`，不得写成规范」。手册 §7.3:96 自己写明「这些是活读数，不是规范；重跑以实际输出为准」。

## 1. 架构分层表（手册 §3）

| 层 | 位置 | 职责 |
|---|---|---|
| HTTP | `server/src/app.ts`、`routes/` | `/api/v1` 单出口；`/api/rsi` 为兼容双轨，字节一致 |
| 控制器 | `src/controllers/` | sessions / tools / skills / sandbox / runs / judge / checkpoints / rsi |
| Agent 循环 | `src/services/agent/agent-loop.service.ts` | `run()` 驱动流式对话、工具调用、循环检测 |
| 工具 | `src/tools/builtin/` | 注册表带 `name/wireName/risk`；当前源码 `BUILTIN_TOOLS` 实读 20 项（含 `agent.verify`），手册 §4 的 19 为上轮读数、§10 的 17 为 8080 旧构建实例（见 §2 口径裁定） |
| 判据 | `src/services/judge/` | 判决、工具纪律三闸、归因 |
| RSI | `src/services/rsi/`、`server/self-upgrade/` | 题集、变更域、提议与采纳 |
| 存储 | SQLite `server/data/codelens.db` | 手册 §3 记 23 张表；健康检查返回 `db.ok / tables=23 / sandbox.writable`（手册 §2:21） |
| 前端 | `client/src/` | React + Vite；工作台、RSI 面板、审批、审计 |

**三个「23」与 9 / 7 分层（禁止混用）**：

| 数字 | 出处 | 层 | 能否硬引 |
|---|---|---|---|
| 23 个可调用端点 | `spec.md §5:70`（表 22 行，末行 connect/disconnect 计 2 个） | v2.0 契约 | ✅ 可硬引 |
| 23 张表 | 手册 §2:21 健康检查 `tables=23`、§3:33 | 运行态活读数 | ❌ 带锚点引用，不得写成规范 |
| 9 张表 | `spec.md §6:105` 锁定清单 | v2.0 契约 | ✅ 可硬引，但须与下条分列 |
| 7 张表 | `spec.md §13:224` 变更记录「DB 表锁定为 7 张」 | v2.0 契约内自相矛盾 | ⚠ 分列，不抹平 |

`spec.md §6` 明注「架构 §7.2 建表缺 `approvals`/`provider_capabilities`/`tool_results`，以本表为准重写」。手册 §3 的 23 张是运行态实例读数；spec §6 的 9 张与 §13 的 7 张是同一契约文件内部的两处不一致。四者按分列式写，不互相覆盖、不取平均。

技术栈锚定（`spec.md §4`，逐项与 `client/package.json` 一致）：React 19.3.1 / Vite 8.3.4 / TypeScript ~5.9 / Tailwind 4.3.3 / zustand 5.0.15 / lucide-react 1.60.0（规范名）/ Express 5.3.0 / zod 4.6.7 / Node 22.22.2 精确锁定；目录分层原则「依赖只向下、单文件 ≤300 行、入口只装配零业务」（`spec.md:66`）。

## 2. 内置工具逐项（手册 §4:38-58 命名底表；当前态以 `server/src/tools/builtin/index.ts` 为准）

下表 19 行是**手册 §4 的工具名底表**（《场景切分矩阵》§0.1 亦以它为唯一命名来源），不是当前注册表数量。当前源码 `BUILTIN_TOOLS` 实读 20 项，多出的第 20 项见下方口径裁定。规范名（点号）与线上名 `wireName`（下划线）双轨制，机械推导规则为 `.` → `_`（`scripts/assert-tool-registry-contract.mjs:7`、`spec.md §11:172`、AC-13 `spec.md:157`）。反查失败返回 `TOOL_NOT_FOUND` 且不执行（`server/src/types/tool.ts:195-198` 的 `ResolvedTool`，未提交改动）。

| # | 规范名 | wireName | risk | 用途 | 默认与上限（手册 §4 原文） |
|---|---|---|---|---|---|
| 1 | `http.request` | `http_request` | low | HTTP 请求（受控） | — |
| 2 | `fs.read` | `fs_read` | low | 读文件 | 相对路径按沙箱根解析；授权目录可用绝对路径 |
| 3 | `fs.write` | `fs_write` | medium | 写/覆盖/追加/重命名/删除/清空/精确替换 | 覆盖/删除/清空需用户确认 |
| 4 | `fs.list` | `fs_list` | low | 列目录 | 可递归 |
| 5 | `fs.glob` | `fs_glob` | low | 按模式找文件 | `*` 不跨分隔符、`**` 任意深度、`?` 单字符；默认 200，上限 1000 |
| 6 | `code.search` | `code_search` | low | 按内容找文件 | 命中 `{file,line,text}`；大小写可切、`regex` 显式开启、`glob` 按文件名过滤；默认 50，上限 500；跳过二进制与 >1 MiB 单文件 |
| 7 | `calc.evaluate` | `calc_evaluate` | low | 表达式计算 | — |
| 8 | `time.now` | `time_now` | low | 当前时间 | — |
| 9 | `uuid.generate` | `uuid_generate` | low | UUID | — |
| 10 | `json.format` | `json_format` | low | JSON 格式化/校验 | — |
| 11 | `text.diff` | `text_diff` | low | 文本差异 | — |
| 12 | `sys.exec` | `sys_exec` | **high** | 执行命令 | 进程树回收 |
| 13 | `tool.forge` | `tool_forge` | medium | 工具铸造入口 | 受判据约束 |
| 14 | `web.search` | `web_search` | low | 联网检索 | — |
| 15 | `eval.run` | `eval_run` | medium | 评测运行 | — |
| 16 | `eval.propose` | `eval_propose` | medium | 评测提议 | — |
| 17 | `code.check` | `code_check` | low | 代码检查 | — |
| 18 | `test.run` | `test_run` | medium | 跑测试并回机器可读结果 | — |
| 19 | `type.check` | `type_check` | low | tsc 诊断 | 流式收集，避免截断漏计 |

**契约闸**（`scripts/assert-tool-registry-contract.mjs`，手册 §4:60）：断言规范名/线上名唯一且可逆、`risk` 必填、`tool_calls.tool_name ⊆ 注册表`、`/api/v1/tools ⊇ 注册表`。退出码：0 通过（含 UNEXEC 提示）/ 1 契约违规 / 2 注册表不可读（脚本 :14）。脚本默认 `API = process.env.CODELENS_API ?? 'http://127.0.0.1:8080'`（:24）。

**工具数口径裁定（坊主 2026-11-14 全组统一口径；三处并列，结论统一，禁止写成规范）**：

> **当前源码注册表 `server/src/tools/builtin/index.ts:25-46` 实读 20 个工具（含 `agent.verify`）；此为活读数，以实跑为准，不得写成规范；手册 §4 的 19 为上轮读数（`agent.verify` 落地前），手册 §10 的 17 为 8080 旧构建实例。**

| 读数 | 出处 | 层与性质 |
|---|---|---|
| **20（当前源码实读）** | `server/src/tools/builtin/index.ts:25-46` 的 `BUILTIN_TOOLS` 数组 20 项，第 20 项 `agentVerifyTool`（`agent.verify` / `agent_verify`）；`HANDOFF §6:125`「已重建并重启到 2.21.0（20 个工具）」；本机只读实跑，`git status` 标 `index.ts` 为**未提交改动** | **当前源码注册表**；活读数，以实跑为准 |
| **19（上轮读数）** | 手册 §4 标题与 19 行表；§10:246「注册 19 个，`/api/v1/tools` 对外清单也是 19 个」；§11:255；§9:219 本地验收「工具契约 19」；`HANDOFF §1:10`、§3:57 | `agent.verify` 落地前的运行态快照；**不是硬规范** |
| **17（旧构建实例）** | 手册 §3:30 架构表；§9:193 CI run #5「工具契约 17 工具 PASS」；§10:249「本地 8080 常驻旧实例……工具清单停在 17 个（无 `fs.glob` / `code.search`）」；`HANDOFF §6:125` 旧构建 | 旧构建进程，与源码注册表**不是同一层** |

三处不在同一层，不并列取舍、不写「三处无法判断」、不把 19 当硬规范。工具名底表仍取手册 §4 的 19 个规范名（**命名来源，非数量口径；数量活读数以实跑为准**）；第 20 项 `agent.verify` 按契约闸校验（`assert-tool-registry-contract.mjs` 对最新实例实跑 PASS，手册 §10:247）。结论统一为「以实跑为准，不得写成规范」。

**第 20 项 `agent.verify`**（`server/src/tools/builtin/agent-verify.tool.ts` 头部注释，本机核实，**未跟踪新增文件 `??`**）：只接受 `package = server | client | root`；只跑 `package.json` 里 `verify` 数组声明且 `scripts` 里真实存在的脚本名；参数里没有命令字符串。三个 `package.json` 的 `verify` 字段分别是根 `["check:config"]`、server `["typecheck","test"]`、client `["typecheck","test"]`。手册 §4 的 19 项不含此项，差值即此一项。该文件内部其余字段本轮未读全，标「待核实」。

**判据与题条目已核实（源码级锚点）**：`server/self-upgrade/tasks.json` 的 `agent-verify` 题 `judge` 指向 `tests/self-upgrade/agent-verify.test.ts`（相对 `server/`），文件实存 146 行；该题 `strengthens: "Update"`、`status: "done"`、`releasedIn: "2.21.0"`。这同时是 **Update 维破零**（当前 `tasks.json` 实读 36 id / 35 done + 1 pending，`strengthens` 含 Update 1）与手册 §10:235「Update 维仍是 0 题」文档滞后的证据，写「以 `tasks.json` 当前态为准」。

**错误做法 → 现象 → 正确做法**：跑 `check:tool-contract` 时不做实例确认 → 闸读的是「运行中的服务」，8080 挂旧构建时报「注册表有、对外清单没有」的假红（手册 §10:248，2026-11-14 撞过）→ 用 `CODELENS_API=http://127.0.0.1:<port>` 指向新起的实例，或先重启 8080（手册 §10:250、`HANDOFF §6:127`）。

### 2.1 工具类型契约（`server/src/types/tool.ts`，未提交改动 `M`，本机实读全文）

| 类型 / 接口 | 实读内容 | 出处 |
|---|---|---|
| `ToolRisk` | `'low' \| 'medium' \| 'high'` | `:6` |
| `ToolApprovalMode` | `'none' \| 'soft' \| 'hard' \| 'two_step'` | `:7` |
| `ToolStatus`（七态） | `pending` / `running` / `success` / `failed` / `timeout` / `rejected` / `skipped` | `:9-16` |
| `ToolCategory` | `'http' \| 'file' \| 'compute' \| 'mcp'` | `:5` |
| `ToolSource` | `'builtin' \| 'mcp'` | `:8` |
| `ReviewStatus` | `'confirmed' \| 'underestimated' \| 'unexec'` | `:134` |
| `ToolDefinition` | `name`（点号主键）/ `wireName`（**唯一**下发给 LLM 的形式）/ `displayName` / `category` / `description` / `inputSchema` / `handler` / `timeoutMs` / `risk` / `approvalMode` / `enabled` / `source` / `idempotent` / `maxResultChars` / `mcpServerId?` | `:59-77` |
| `ToolDefinitionPublic` | `GET /api/v1/tools` 投影，**不含 `handler`** | `:79-93` |
| `ResolvedTool` | `{ ok: true, definition }` \| `{ ok: false, code: 'TOOL_NOT_FOUND', message }` | `:195-198` |
| `ToolOutcome` | `ok` / `summary` / `data?` / `error? { code, kind, message, suggestion?, retryable? }` | `:44-57` |
| `ToolExecutionContext` | `sessionId` / `toolCallId` / `callId` / `iteration` / `sandboxRoot` / `allowedDirs?` / `signal` / `reportProgress` | `:27-37` |
| `EffectPreview` / `ApprovalDiffItem` | 后果预览 `reversible` / `summary` / `items` / `itemCount` / `recoverable` / `recoveryNote` / `grantDir?` / `diff?`；审批内 diff `path` / `added` / `removed` / `preview`。注释明写「执行前就能看到将改哪些行（不依赖 checkpoint 是否开启）」 | `:95-132` |
| `ReviewFinding` / `ReviewResult` | `severity: 'high'\|'medium'\|'low'` / `claim` / `factRef`；`status` / `findings` / `usage` / `latencyMs` / `provider` / `model` / `reason?` | `:136-154` |
| `ReviewFacts` | `toolName` / `callId` / `iteration` / `command?` / `cwd?` / `affectedPaths` / `itemCount` / `sideEffects` / `diffSummary?`；注释明写**刻意不含 messages / 计划 / 推理 / 模型自述** | `:156-184` |
| `RiskVerdict` | `risk` / `approvalMode` / `reason?` / `effect?`；注释「由 runGateway 依据真实参数生成」 | `:186-193` |

**与侦察官 g-2 的对照**：上表 15 行与 `01_信源调研/核心场景事实地图.md` g-2 的契约类型表互补——g-2 另列 `EffectPreview` / `ReviewFacts` / `RiskVerdict`（已补入本表），本表另列 `ToolOutcome` / `ToolExecutionContext`（g-2 未列）。两者均以 `types/tool.ts` 实读为准，不互相覆盖。

**三态诚实补充**：`ReviewStatus` 的 `unexec` 与手册 §9 的 UNEXEC 同口径（未执行不等于绿、不等于红）；`ReviewResult.reason?` 注释明写「unexec 时的诚实原因（未配置 Key / 超时 / 解析失败）」（`:152-153`）。该文件为**未提交改动**，引用字段一律以上表实读内容为准；其余接口本轮未逐项核完，标「待核实」。

### 2.2 内建任务模式契约（`server/src/services/agent/task-prompts.ts:23-74`，未提交改动 `M`）

这套契约是 16 份提示词「输出格式」字段的锚（`项目档案.md:10` 第 5 字段）。

| 项 | 实读内容 | 出处 |
|---|---|---|
| `TASK_KINDS` | `['analyze','explain','debug','optimize','verify']` 共 **5** 个 | `:9` |
| `TaskKind` | `(typeof TASK_KINDS)[number]` | `:10` |
| `TaskPromptSpec` 四字段 | `label`（中文标签，与前端任务模式选择器文案一致）/ `directive`（任务目标一句话）/ `sections`（`string[]`）/ `rules`（`string[]`） | `:12-21` |
| `isTaskKind(value)` | 校验白名单；非字符串或不在表内返回 `false` | `:76-78` |
| `buildTaskSection(kind)` | 取 `TASK_PROMPTS[kind]`，渲染 4 段：`【任务模式：label】` → `任务目标：directive` → `【建议结构】` + `sections` 按序编号 → `【任务规则】` + 逐条 `- rules`；未知 kind 抛错 | `:80-91` |
| 消费链 / 双通道同源 | `AgentRequestSchema.taskKind → agent-loop.run → buildSystemPrompt(taskKind) → native`；react 通道经 `buildReactSystemPrompt` 叠加同一段任务提示词；文件头注释明写「**两条通道缺一即开环**」 | `:1-7` |

**⚠ `sections` 不是固定输出模板**：`TaskPromptSpec.sections` 的源码注释写「建议结构：内容需要时才用，可合并、省略或改名，**不是固定模板**」（`:17`）；`buildTaskSection` 渲染句亦为「以下小节按内容取舍，不必逐条套用；可合并、省略或改名」（`:87`）。派单称其为「输出结构契约，按序」时，按源码写「建议结构、按序渲染但可取舍」，**不得写成硬性模板**。

> **坊主定版（唯一基准句，2026-11-14）**：`sections` 是源码标注的**建议结构**；本包按派单约定**逐字采用**其小节名与顺序、不另造名，这是**包内约定、呈现层收紧**，不是源码强制模板。故不改 `TASK_PROMPTS[*].sections` 数组，不触碰 `task-prompts.test.ts:29` 的 `toEqual` 断言。任何提示词不得把「逐字采用」表述为「源码要求 / 硬约束 / 输出结构契约」。

**测试级旁证（两层契约，必须分列）**（`server/tests/task-prompts.test.ts`，本机实读全文）：

| 层 | 断言 | 出处 | 对提示词的含义 |
|---|---|---|---|
| 呈现层：不是固定模板 | `expect(section).toContain('【建议结构】')`；`:50` 是**用例名**，其断言 `:51-54` 针对 `AGENT_BASE_PROMPT`（含「不要每轮套用同一个版式」、不含 `【最终答案】`），**不是 `sections` 字段本身**——该用例只作基座 prompt 自适应版式的旁证，呈现层以 `task-prompts.ts:17/:87` 与测试 `:36` 为准 | `:36`、`:50-54` | 「输出格式」字段写「建议结构、按内容取舍」，不写强制小节清单 |
| 源码层：有结构与下限契约 | `TASK_KINDS` 恰 5 项；每 kind 的 `sections.length ≥ 3`、`rules.length ≥ 3`、`label` / `directive` 非空；**`debug.sections` 被 `toEqual` 精确钉死**为 `['问题定位','根因分析','修复建议','修复后代码']` | `:18`、`:22-24`、`:28-30` | **不得**写「sections 数组可任意改名 / 合并 / 省略」——`debug` 已被测试钉住，改数组内容会红 |
| 双通道同源旁证 | `buildReactSystemPrompt` 叠加协议而非替换：断言同时保留 `CodeLens Agent`（基座身份）、`【任务模式：调试】`（任务段）、`【表达与版式】`（自适应版式） | `:90-99` | 印证 `task-prompts.ts:6`「两条通道缺一即开环」 |

**结论**：`sections` 的「不是固定模板」说的是**对执行 Agent 的呈现**；源码数组本身有下限与 `debug` 精确断言。提示词写「按内容取舍」时，不要顺手写「可任意改名 / 合并 sections 数组」。这两层边界未见坊主裁定，列入待核实 #6。

**5 个 TaskKind 的 sections 与 rules 逐项表**：

| TaskKind | label | directive（任务目标） | sections（按序建议结构） | rules（逐条） |
|---|---|---|---|---|
| `analyze` | 分析 | 逐行审读用户给出的代码，找出正确性、安全性、边界条件与可维护性方面的问题。 | 问题清单 → 影响评估 → 改进建议 | ①每个问题必须给出代码位置（函数/行号）并引用原文片段作为证据 ②按严重程度从高到低排序 ③不确定的问题标注「待确认」，并说明如何验证 |
| `explain` | 解释 | 面向提问者的水平解释这段代码：做什么、怎么做、为什么这样写。 | 一句话概述 → 逐段讲解 → 关键概念 → 运行示例 | ①按执行顺序（而非代码书写顺序）讲解控制流 ②术语首次出现时用一句话解释 ③给出一个最小的输入/输出示例 |
| `debug` | 调试 | 定位用户描述的缺陷根因，给出可落地的修复。 | 问题定位 → 根因分析 → 修复建议 → 修复后代码 | ①根因必须区分「表象」与「原因」，并给出能证实该根因的最小复现或检查点 ②修复后代码必须完整可替换（整段或明确标注改动的 diff） ③说明修复可能引入的副作用 |
| `optimize` | 优化 | 在不改变外部行为的前提下改进代码的性能、可读性与健壮性。 | 优化点清单 → 优化建议 → 优化后代码 → 权衡说明 | ①每个优化点说明动机与预期收益（复杂度量级或可读性收益） ②会改变外部行为的改法必须单独标注「行为变更」 ③明说不值得改的部分及理由 |
| `verify` | 验证 | 在宣布改动完成之前，运行目标包自己声明的验证命令，用真实退出码证明改动没有破坏既有行为。 | 验证命令 → 实际读数 → 结论 | ①必须调用 `agent.verify`（或等价的 `type.check` / `test.run`）拿到真实退出码；禁止只凭阅读代码声称通过 ②验证失败时先修再报；不得把失败改写成「预期行为」或「环境问题」而不给证据 ③结论必须引用通过/失败数量与失败脚本名，并区分「本次改动相关」与「既有失败」 |

**与 `agent.verify` 工具的接线**：`verify` 规则 ① 明写调用 `agent.verify`（`task-prompts.ts:69`），对应 §2 第 20 项工具（`agent-verify.tool.ts` 只跑 `package.json` 的 `verify` 数组声明命令）。这条链路把「改完必须验」从提示词落成真实进程退出码。

**注释与实读不一致（标待核实 #6）**：文件头 `:2` 写「四类任务提示词（README「四类核心能力」的落地，修复 AUDIT-006 的零消费状态）」，但 `TASK_KINDS` 实为 **5** 项。按实读写 5 项，注释残留不抹平、不据此改写事实。

## 3. 沙箱模型（手册 §5）

| 项 | 值 | 出处 |
|---|---|---|
| `SANDBOX_ROOT` | 当前实例 = 仓库根（DSH 工作区模式）；**默认仍是 `server/workspace`** | §5:64 |
| 授权表 | `sandbox_permissions.allowDirs` 现有 **7 条**：`server/src`、`server/tests`、`docs`、`server/self-upgrade`、`.self-upgrade`、`agent-decisions`、`skills/dsh` | §5:65 |
| 路径规则 | 相对路径只在沙箱根下解析；授权目录内的文件**必须传绝对路径** | §5:66 |
| 高危写 | 覆盖 / 删除 / 清空需用户确认；`CHECKPOINT_ENABLED=true` 时 overwrite 前落快照，可回滚 | §5:67 |
| 回滚端点 | `POST /api/v1/checkpoints/:id/rollback`，需请求头 `x-codelens-confirm: rollback`；能力未开先 409，缺头 400 | §5:68 |

参数说明：`SANDBOX_ROOT`、`CHECKPOINT_ENABLED`、`SKILL_LIBRARY_ENABLED`、`CODELENS_API`、`E2E_PORT`、`KRSI_BIN_PATH` 均为环境变量；`maxIterations` 默认 12（`spec.md:97`），派单 payload 里写死 25（手册 §7.6:167-168）。密钥示例一律用 `${VAR}` 占位，不写真实值。

## 4. 技能库形态与接口（手册 §6）

| 项 | 值 | 出处 |
|---|---|---|
| 形态 | **数据库行**，不是文件索引；字段 `name / description / tags / steps ≤12 / matchScore` | §6:72 |
| 接口 | `GET/POST /api/v1/skills`；`DELETE /api/v1/skills/:name` | §6:73 |
| 总开关 | `SKILL_LIBRARY_ENABLED` | §6:73 |
| 匹配 | 分词后分档：完全相等 > 标签 > 描述 > 名称；阈值 **0.15**；`topK ≤10`；不引入向量依赖 | §6:74 |
| 当前实例 | 已开启；**47 条**（DSH 48 个 `SKILL.md` 中 1 条因名称过长触发密钥规则被拒，文件保留在 `skills/dsh/`） | §6:75；本机实跑 `find skills/dsh -name SKILL.md` = 48 |
| 密钥拒写 | 命中 `sk-…`、32+ 位不透明串、`api_key/secret/token/password` 键值形态即拒写，**不回显原文** | §6:76 |

被拒的那条：`hermes-translation-loss-reduction`，名称 33 字符触发密钥规则（手册 §10:240）。

**形态区分**：CodeLens 自身技能库是数据库行；本提示词包的 `SKILL.md` 是文件系统产物。两者不是同一种东西，提示词里严禁混称（`领域解析卡 §6:130`）。

## 5. `/api/v1` 端点地图

**运行态（手册 §8，v2.20.0 读数）**：

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康、DB 表数、沙箱可写 |
| `POST /api/v1/sessions` / `GET /api/v1/sessions` | 会话创建/列表（`items`） |
| `POST /api/v1/agent/stream` | Agent SSE 流 |
| `GET /api/v1/tools` | 工具清单（模型可见面） |
| `GET/POST /api/v1/skills`、`DELETE /api/v1/skills/:name` | 技能库 |
| `GET/PUT /api/v1/sandbox-permissions` | 沙箱授权表 |
| `POST /api/v1/sandbox-grants/:id/decision` | 越界授权审批 |
| `GET /api/v1/runs...`、`/api/v1/checkpoints...` | 运行证据、快照与回滚 |
| `GET /api/v1/rsi/overview` | RSI 读数（`/api/rsi` 双轨同源） |
| `GET /api/v1/judge/...` | 判决、有效性、深判 |

**契约侧（`spec.md §5`，v2.0 锁定，共 23 个可调用端点 / 表 22 行，末行 connect/disconnect 计 2 个）**：另有 `/api/v1/providers`、`/api/v1/providers/capabilities`、`/api/v1/providers/sync-status`、`/api/v1/sessions/:id`（GET/PATCH/DELETE）、`/api/v1/sessions/recover`（单次使用；连错 5 次锁 15 分钟）、`/api/v1/sessions/:id/recovery-code`、`/api/v1/approvals/:id`（三值 `allow_once`/`allow_session`/`reject`，zod `.strict()`，body 出现 `arguments` 一律 400）、`/api/v1/approvals/:id/revise`（唯一可带 `arguments`，单调用限改 3 次 `revise_depth`）、`/api/v1/agent/abort`、`/api/v1/tools/:name`（PATCH 启停）、`/api/v1/mcp/servers` 六端点（P1，未连接时对模型完全不可见，AC-12 `spec.md:156`）。`/api/v1/events` 埋点按 §3 本期不实现。

**分层规则**：spec §5 是「开发唯一依据」的契约清单；手册 §8 是「当前实例跑过的」运行态索引。两表端点不完全重合属版本差异，分列写，不得互相当作对方的缺失证据。

**统一错误体**：`{ error: { code, message } }`（手册 §8:185，17 处 legacy 已统一；`spec.md §5:70`；`docs/agent/openapi.yaml:11`）。前端 `parseErrorResponse` 兼容对象与字符串。`AgentRequest`（`spec.md:97`）：`{ sessionId?, provider, model, apiKey?, message, tools?, channelMode?: 'auto'|'native'|'react', maxIterations: 12, temperature: 0.3, maxTokens: 2048, resumeFromCallId?, overrideArguments? }`。`ToolDefinitionPublic`（`spec.md:101`）不含 handler。`openapi.yaml:12` 另约束：SSE 端点写响应头之前失败走 HTTP 4xx JSON。

## 6. 验证面命令清单

全部命令名来自 `server/package.json`、`client/package.json`、根 `package.json` 的 `scripts` 字段（本机只读核实），不从记忆取。

| 项 | 命令 | 出处 | 说明 |
|---|---|---|---|
| 类型检查 | `cd server && npx tsc --noEmit` / `npm run typecheck` | `server/package.json:29`；`HANDOFF §4:67` | 应为空输出 |
| 单测 | `cd server && npx vitest run --reporter=dot` | `server/package.json:18`；`HANDOFF §4:68` | `test` = `vitest run && npm run test:krsi` |
| 全量验收 | `cd server && npm run test:acceptance` | `server/package.json:23`；`AGENTS.md:20` | 展开 = typecheck + test + check:suite-floor + check:task-metadata + check:tool-contract + check:file-size |
| 前端测试 | `cd client && npm test` | `client/package.json:17`；`AGENTS.md:21` | `vitest run` |
| 前端验收 | `cd client && npm run test:acceptance` | `client/package.json:24` | typecheck + test + check:ui-static + check:file-size |
| e2e | `bash scripts/e2e.sh`（Git Bash；`E2E_PORT` 指定端口） | 根 `package.json:16`；`AGENTS.md:22` | **本轮 UNEXEC**（`HANDOFF §4:78`） |
| 围栏 | `node scripts/check-self-upgrade.mjs --package=server --allowed=<靶子逗号分隔> --judge=<判据路径> --full --accept-current="<理由>"` | `HANDOFF §4:71-77`；`server/package.json:38` | 七道闸 + C1 |
| 重锚 | `node scripts/check-self-upgrade.mjs --baseline --package=server --allowed=<靶子> --judge=<判据>` | `HANDOFF §7:146-150` | 人操作 |
| 变异探针 | `npm run check:mutation`（= `node ../scripts/mutation-probe.mjs`） | `server/package.json:26`；手册 §7.5:122 | 靶子须 git-clean，否则 SKIP |
| 只读体检 | `cd server && node ../scripts/rsi-tick.mjs` / `npm run check:rsi-tick` | `server/package.json:27`；`HANDOFF §3:43`、§8:160 | 任务开始前跑，不采纳、不写盘 |
| 契约闸 | `npm run check:tool-contract` | `server/package.json:25` | 用 `CODELENS_API` 指向新实例 |
| 棘轮 | `npm run check:file-size` | `server/package.json:22` | 上限 300 行 |
| 其它闸 | `check:task-metadata`(C1)、`check:suite-floor`、`test:krsi`、`check:rsi-contract`、`check:coverage-floor`、`check:ui-static` | `server/package.json:24,37,28,36,20`；`client/package.json:23` | — |

**CI 边界**（本机核实 `.github/workflows/ci.yml`）：两个 job（client / server），`ubuntu-latest` + `node 22`，各跑 `npm run test:acceptance`。**CI 不跑** `scripts/e2e.sh`、`mutation-probe.mjs`、`check-self-upgrade.mjs`。CI 绿不代表这三项绿（手册 §10:231-232）。

**活读数（一律标锚点，不得写成规范）**：

| 读数 | 值 | 锚点 |
|---|---|---|
| CI acceptance | 1512 passed + 1 skipped（162 文件）；krsi 10/10；套件地板 3/3；C1 PASS；工具契约 17 工具 PASS | 手册 §9:193，GitHub Actions run #5 @ `4d6ed81` |
| CI client | 136/136（15 文件）；UI 静态卫生 3 项 PASS | 手册 §9:194 |
| 本地全量（G1 采纳后） | 177 文件 / **1860 passed** / exit 0 / 100.32s | 手册 §9:218；`HANDOFF §3:53` |
| 围栏基线 | 手册 §7.5:135 记 278；§9:216 与 `HANDOFF §3:52` 记 279；本机实跑 `.self-upgrade/baseline.json` 的 `protected` 键 = **279** | 见 04 号知识库 §4 活读数裁定表 |
| 账本 / 正例 | `.self-upgrade/ledger.jsonl` 89 行；`exemplars.jsonl` 3 行 | 手册 §7.3:100-101；本机实跑 |
| 题集 | 手册 §7.3:98 记 25 题；本机实跑 `tasks.json` = **36 题**（done 35 / pending 1） | 见 04 号知识库 §4 活读数裁定表 |

## 7. 关键文件地图（手册 §11 + 本机核实）

| 路径 | 内容 | 出处 |
|---|---|---|
| `server/src/tools/builtin/` | 注册表与工具族；`index.ts` 的 `BUILTIN_TOOLS` 是唯一装配点 | §11:255；`assert-tool-registry-contract.mjs:6` |
| `server/src/services/agent/` | Agent 循环、循环检测、系统提示词 | §11:256 |
| `server/src/services/judge/` | 判决、工具纪律、归因 | §11:257 |
| `server/src/services/rsi/` | 变更域、RSI 服务 | §11:258 |
| `server/self-upgrade/tasks.json` | 题集唯一真源（`_comment` 自称「唯一真源」）；字段 `id/title/strengthens/allowed/judge/status/releasedIn` | §11:259；本机核实 |
| `server/scripts/` | `self-upgrade-loop.ts`、`auto-adopt.ts`、`judge-audit.mjs`、`task-self-upgrade.ts`、`propose-gaps.ts`、`failure-attribution.ts` | §11:260；本机目录清单 |
| `server/scripts/lib/dispatch-timeout.mjs` | 外层超时 = 墙钟 + 300s 余量 | §11:261；`HANDOFF §2.2:34` |
| `server/scripts/lib/dispatch-evidence.mjs` | 派单证据落盘回读（等静止，以盘为准） | §11:262 |
| `server/scripts/check-self-upgrade.mjs` | 围栏（七道闸 + C1） | §11:263 |
| `scripts/check-task-metadata.mjs` | C1 元数据（exit 3 UNEXEC） | §11:264 |
| `scripts/mutation-probe.mjs` / `scripts/lib/mutations.mjs` | 变异探针 / 变异体注册表（本机核实存在，39148 字节） | §11:265；本机目录清单 |
| `scripts/rsi-tick.mjs` | 只读体检 | §11:266 |
| `scripts/assert-tool-registry-contract.mjs` | 工具契约 | §11:267 |
| `skills/dsh/skills/` | 48 个 DSH `SKILL.md`（本机实跑核实） | §11:268 |
| `docs/agent/spec.md` | 唯一契约来源 | §11:269 |
| `docs/agent/HANDOFF-2026-11-14.md` | 状态、验证命令、剩余顺序、踩坑边界；**未提交改动 `M`** | 手册 §12:279；本机 `git status` |
| `server/src/services/agent/task-prompts.ts` | `TASK_KINDS` 5 项、`TaskPromptSpec` 四字段、`buildTaskSection`；**未提交改动 `M`** | 本机实读 :9-91；见 §2.2 |
| `server/src/types/tool.ts` | `ToolRisk` / `ToolApprovalMode` / `ToolStatus` 七态 / `ToolDefinitionPublic` / `ResolvedTool`；**未提交改动 `M`** | 本机实读全文；见 §2.1 |
| `server/src/tools/builtin/agent-verify.tool.ts` | 第 20 项 `agent.verify`；**未跟踪新增 `??`** | 本机实读头部注释；见 §2 |
| `server/src/services/agent/review-facts.ts` / `run-assembly.ts` / `run-services.ts` | 本轮**未跟踪新增 `??`**；内部字段未读全，标「待核实」 | 本机 `git status --short` |
| `server/tests/self-upgrade/agent-verify.test.ts` | `agent.verify` 判据，146 行 / 三层断言；**未跟踪新增 `??`**；`tasks.json` 的 `agent-verify` 题 `judge` 指向此处（相对 `server/`）。上一版误判「不存在」已更正 | 本机实读全文头部 + `git status --short -- server/` |
| `server/src/tools/builtin/index.ts` | `BUILTIN_TOOLS` 唯一装配点，实读 20 项；**未提交改动 `M`** | 本机实读 :25-46；`assert-tool-registry-contract.mjs:6` |

`scripts/` 顶层另有 `agent-e2e.sh`、`e2e.sh`、`check-coverage-floor.mjs`、`check-file-size.mjs`、`check-eval-config.mjs`、`check-task-metadata.mjs`、`file-size-baseline.json`、`coverage-floors.json`、`install-dsh-preset.mjs`、`mutation-probe.mjs`、`rsi-tick.mjs`、`smoke-server-bundle.mjs`（本机目录清单核实）。

## 8. 命令速查表（等价「快捷键表」）

本包无 GUI 快捷键可写：CodeLens 是本地 Agent host，操作面是命令、HTTP 端点与数据库行，不是桌面菜单。仓库内未见中英文界面快捷键的证据（见待核实 #4）。下表按「一个动作一条命令」给出等价速查。

| 动作 | 命令 / 路径 |
|---|---|
| 起服务 | `cd server && npm run build && node dist/app.js`（默认 :8080） |
| 健康检查 | `curl http://127.0.0.1:8080/api/health` |
| 看模型可见工具面 | `curl http://127.0.0.1:8080/api/v1/tools` |
| 读题集 | `server/self-upgrade/tasks.json` |
| 只读体检 | `cd server && node ../scripts/rsi-tick.mjs` |
| 查注册表装配点 | `server/src/tools/builtin/index.ts` → `BUILTIN_TOOLS` |
| 查沙箱授权 | `GET/PUT /api/v1/sandbox-permissions` |
| 回滚快照 | `POST /api/v1/checkpoints/:id/rollback` + `x-codelens-confirm: rollback` |
| 改前重锚 | `node scripts/check-self-upgrade.mjs --baseline --package=server --allowed=<靶子> --judge=<判据>` |

## 9. 可查清单（交付前逐项打勾）

1. 查版本号：先读手册 §12，再读三个 `package.json`，两栏记，不抹平。
2. 查工具数：数 `index.ts` 的 `BUILTIN_TOOLS` 条目，再对 `/api/v1/tools`，用 `CODELENS_API` 指向正确实例。
3. 查路径规则：确认 `SANDBOX_ROOT` 与 7 条 `allowDirs`，授权目录内传绝对路径。
4. 查技能库：确认 `SKILL_LIBRARY_ENABLED`，核对 `steps ≤12`、阈值 0.15、`topK ≤10`。
5. 查错误体：确认响应为 `{ error: { code, message } }`，不是裸字符串。
6. 查验证命令：从 `package.json` 的 `scripts` 取名字，不从记忆取。
7. 查 e2e / 变异 / 围栏：确认是否在 CI 外单独跑过；未跑标 UNEXEC。
8. 查活读数：每个数字旁写锚点，注明「本机实跑读数，不得写成规范」。
9. 查密钥：文中不出现真实 Key；示例用 `${VAR}`。
10. 查工具数裁定：确认写「当前源码实读 20（含 `agent.verify`）、活读数以实跑为准；手册 19 为上轮读数、17 为旧构建实例」，不写「三处无法判断」、不把 19 当硬规范。
11. 查任务模式契约：按 `task-prompts.ts:23-74` 逐项核 5 个 TaskKind 的 sections 与 rules；`sections` 写「建议结构、按序渲染但可取舍」，不写硬性模板；引用本轮改动/新增文件标注 git 状态。
12. 查三个「23」：区分 23 端点（契约）/ 23 张表（活读数）/ 9 张表与 7 张表（契约自相矛盾），不混用。

## 10. 待核实清单

| # | 位置 | 缺什么 | 建议核实途径 | 影响 |
|---|---|---|---|---|
| 1 | §0 版本差异 | 版本基准未统一裁定：`AGENTS.md:7` 引 v2.11.0、手册 :1 标题 v2.18.0、§12 记 2.20.0、三个 `package.json` 记 2.21.0；本包按主理人指定锁 2.20.0，是否改基准未见裁定 | 报主理人确认是否把基准改为 2.21.0；对照 `00_关键词解析/领域解析卡.md` §3:74 | 高 |
| 2 | §2 工具数 | 源码注册表已实读 20 项且坊主已裁定；但**运行中服务**的工具数本轮未起服务实测（未对 `/api/v1/tools` 直接计数） | 起新实例后 `curl /api/v1/tools` 计数，并确认 `CODELENS_API` 指向该实例 | 高 |
| 3 | §1 存储表数 | 手册 §3 的 23 张表与 spec §6 的 9 张表差异原因未见迁移说明 | 查 `server/data/codelens.db` 的 `schema_migrations` | 中 |
| 4 | §8 快捷键 | 仓库内无 GUI 快捷键证据 | 查 `client/src/` 键盘事件绑定 | 低 |
| 5 | §5 端点 | 运行态 `/api/v1/runs...`、`/api/v1/judge/...` 手册用省略号，未见完整路径清单 | 查 `server/src/routes/` 或 `docs/agent/openapi.yaml` | 低 |
| 6 | §0 git 状态、§2.2 任务模式 | `task-prompts.ts:2` 注释写「四类任务提示词」而 `TASK_KINDS` 实为 5 项；本机全量 `git status --short -- server/` 实读 `??` **8 个**，其中 `agent-loop-split.test.ts` / `approval-diff.test.ts` / `mutation-dirty.test.ts` 三个 self-upgrade 判据文件及 4 个 src 新增文件内部内容本轮未读全；另 `task-prompts.test.ts:29` 精确钉死 `debug.sections`，与 `:17` 注释「可改名」的**适用边界**未见裁定。**上一版『`agent-verify.test.ts` 不存在』结论已按 `server/` 前缀复核更正，见 §0** | 逐个读新增文件全文并复核 `git status --short -- server/`；注释残留不抹平；就「呈现层可取舍 / 源码层被测试钉住」两层边界请坊主裁定提示词「输出格式」字段的落笔口径 | 中 |

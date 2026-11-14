# CodeLens 自述手册（v2.18.0）

> 最后核对：2026-11-14 @ `b54369f`。本文只写**当前实例上跑过的**事实；未执行的会标 UNEXEC。
> `docs/agent/spec.md` 仍是唯一契约来源；本手册是“我是谁、我能做什么、我哪里还不行”的索引。

## 1. 一句话定位

**本地优先的 Agent host + 判据门禁下的自我演进（RSI）。**
引擎是 `Improve(π) = π --Act--> τ --Judge--> r --Update--> π'`；外壳是本地桌面、BYOK、多上游中继。

## 2. 30 秒上手

```bash
cd server && npm install && npm run build
node dist/app.js            # 默认 :8080
curl http://127.0.0.1:8080/api/health
```

- 前端：`cd client && npm run dev`
- 环境变量：`server/.env`（已被 gitignore；密钥只落本机）
- 健康检查返回 `db.ok / tables=23 / sandbox.writable`

## 3. 架构总览

| 层 | 位置 | 职责 |
|---|---|---|
| HTTP | `server/src/app.ts`、`routes/` | `/api/v1` 单出口；`/api/rsi` 为兼容双轨，字节一致 |
| 控制器 | `src/controllers/` | sessions / tools / skills / sandbox / runs / judge / checkpoints / rsi |
| Agent 循环 | `src/services/agent/agent-loop.service.ts` | `run()` 驱动流式对话、工具调用、循环检测 |
| 工具 | `src/tools/builtin/` | 17 个内置工具，注册表带 `name/wireName/risk` |
| 判据 | `src/services/judge/` | 判决、工具纪律三闸、归因 |
| RSI | `src/services/rsi/`、`server/self-upgrade/` | 题集、变更域、提议与采纳 |
| 存储 | SQLite `server/data/codelens.db` | 23 张表（会话、消息、工具调用、判决、技能、授权…） |
| 前端 | `client/src/` | React + Vite；工作台、RSI 面板、审批、审计 |

## 4. 能力面：19 个内置工具

| 工具 | 线上名 | 风险 | 用途 |
|---|---|---|---|
| `http.request` | `http_request` | low | HTTP 请求（受控） |
| `fs.read` | `fs_read` | low | 读文件；相对路径按沙箱根解析，授权目录可用绝对路径 |
| `fs.write` | `fs_write` | medium | 写/覆盖/追加/重命名/删除/清空/精确替换 |
| `fs.list` | `fs_list` | low | 列目录（可递归） |
| `fs.glob` | `fs_glob` | low | 按模式找文件；`*` 不跨分隔符、`**` 任意深度、`?` 单字符；默认 200 上限 1000 |
| `code.search` | `code_search` | low | 按内容找文件：`{file,line,text}` 命中、大小写可切、`regex` 显式开启、`glob` 按文件名过滤；默认 50 上限 500，跳过二进制与 >1 MiB 单文件 |
| `calc.evaluate` | `calc_evaluate` | low | 表达式计算 |
| `time.now` | `time_now` | low | 当前时间 |
| `uuid.generate` | `uuid_generate` | low | UUID |
| `json.format` | `json_format` | low | JSON 格式化/校验 |
| `text.diff` | `text_diff` | low | 文本差异 |
| `sys.exec` | `sys_exec` | **high** | 执行命令（进程树回收） |
| `tool.forge` | `tool_forge` | medium | 工具铸造入口（受判据约束） |
| `web.search` | `web_search` | low | 联网检索 |
| `eval.run` | `eval_run` | medium | 评测运行 |
| `eval.propose` | `eval_propose` | medium | 评测提议 |
| `code.check` | `code_check` | low | 代码检查 |
| `test.run` | `test_run` | medium | 跑测试并回机器可读结果 |
| `type.check` | `type_check` | low | tsc 诊断（流式收集，避免截断漏计） |

**契约闸**：`scripts/assert-tool-registry-contract.mjs` 断言规范名/线上名唯一且可逆、`risk` 必填、`tool_calls.tool_name ⊆ 注册表`、`/api/v1/tools ⊇ 注册表`。

## 5. 沙箱模型

- **当前实例**：`SANDBOX_ROOT` = 仓库根（DSH 工作区模式）；默认仍是 `server/workspace`。
- **授权表**：`sandbox_permissions.allowDirs` 现有 7 条（`server/src`、`server/tests`、`docs`、`server/self-upgrade`、`.self-upgrade`、`agent-decisions`、`skills/dsh`）。
- **路径规则**：相对路径只在沙箱根下解析；授权目录内的文件必须传绝对路径。
- **高危写**：覆盖/删除/清空需要用户确认；`CHECKPOINT_ENABLED=true` 时 overwrite 前落快照，可回滚。
- **回滚**：`POST /api/v1/checkpoints/:id/rollback` 需 `x-codelens-confirm: rollback`；能力未开先 409，缺头 400。

## 6. 技能库

- **形态**：数据库行（`name / description / tags / steps ≤12 / matchScore`），不是文件索引。
- **接口**：`GET/POST /api/v1/skills`，`DELETE /api/v1/skills/:name`；总开关 `SKILL_LIBRARY_ENABLED`。
- **匹配**：分词后分档（完全相等 > 标签 > 描述 > 名称），阈值 0.15，topK ≤10；不引入向量依赖。
- **当前实例**：已开启；**47 条**（DSH 48 个 `SKILL.md` 中 1 条因名称过长触发密钥规则被拒，文件保留在 `skills/dsh/`）。
- **密钥规则**：技能内容命中 `sk-…`、32+ 位不透明串、`api_key/secret/token/password` 键值形态即拒写，不回显原文。

## 7. RSI：判据门禁下的自我演进

### 7.1 闭环

`π → Act → τ → Judge → r → Update → π'`；r 必须真的改 π'，π' 必须真的改下一次 Act。

### 7.2 变更域（谁可以自动改）

| 域 | 范围 | 无人值守 |
|---|---|---|
| D4 | `tests/`、`krsi/`、`src/services/{judge,rsi,eval}/`、`scripts/`、`self-upgrade/` | **永不**，必须人 |
| D3 | `package.json`、`app.ts`、`config/`、架构入口 | 需人批 |
| D2 | `services/`、`controllers/`、`routes/`、前端 stores/services | 首次需人 |
| D1 | `src/tools/`、`src/utils/`、`client/src/components/` | 可全自动（≤6 文件） |
| D0 | 只读 | 可全自动 |

### 7.3 题集与账本（当前读数）

读数锚点：`node scripts/rsi-tick.mjs` @ `b54369f` + 本轮（2026-11-14）实跑。这些是活读数，不是规范；重跑以实际输出为准。

- `server/self-upgrade/tasks.json`：**25 题（done 25 / pending 0）**；`strengthens` = Act 12 / Judge 12 / **Memory 1** / Update 0。
  Memory 维由 `project-instructions`（G1）破零：AGENTS.md / CLAUDE.md 自动进系统提示词。
- `.self-upgrade/ledger.jsonl`：**89 行**，verified 覆盖 **13/25**（done 题口径），提到过 31 题。口径由 `rsi-tick` 统一，别再用「行数/题数」当覆盖率。
- `.self-upgrade/exemplars.jsonl`：**存在，3 条**（正例回灌已破零，但样本量仍小）。
- `server/candidates/`：**2 个待采纳候选**（`rsi-tick` 读数；目录里的其它条目不是待采纳态）。另有 G1 的判据草案
  `project-instructions.candidate.ts`（30 用例）与任务书草案 `project-instructions.spec.json`，题还没进 `tasks.json`。
- `scripts/rsi-tick.mjs`（`npm run check:rsi-tick`）：任务开始前的只读体检，不采纳、不写盘。

**判据草稿的暂存规则（2026-11-14 立）**：还没派单的题，判据先进 `server/candidates/<id>.candidate.ts`，
派单前由人 promote 回 `tests/self-upgrade/`。理由是围栏的全量回归会扫 `tests/`，
未实现的判据按设计红，会被读成「这一题踩坏了既有行为」。`vitest.config.ts` 的 `exclude` 已排除 `candidates/**`。
两个坑：草稿的相对 `import` 按 promote 后的深度写，**草稿态不可原地执行**，红基线必须 promote 之后再取；
promote 与重锚的先后不能反 —— 先重锚会把新增判据记成「受保护目录新增文件」。
判据由 `tests/self-upgrade/judge-draft-isolation.test.ts` 守（钉「恰好一份、不并存」，不钉「此刻在哪」）。

### 7.4 采纳边界（重要）

`auto-adopt` 通过四闸后**必然写 D4**：`tests/<judge>`、`tasks.json`、账本、exemplars。
当前裁决：**采纳只写 staging（`server/candidates/<id>/`），人 `promote` 时才落 D4 并重锚基线**。
所以“工具层可无人值守”成立，“整套 RSI 无人值守闭环”不成立——最后一步必须是人。

### 7.5 自证

- `judge-audit.mjs`：每份判据至少 1 条反向断言、占比 ≥20%。本轮实跑 **28/28 通过**。
- `scripts/mutation-probe.mjs`：改坏实现→跑判据→必须非零；`finally` 还原并校验 sha256。
  注册表现有 **92 条**变异体。**探针要求靶子 git-clean，否则 SKIP** —— 本轮靶子多为未提交/未跟踪，
  自动探针整批 SKIP，红基线改由人工按同一份注册表注入取得（utf8 读盘、源串命中数核对、`finally` 还原原始 Buffer + sha256 对账）。
  人工注入读数：judge-run-ansi 10/10、dispatch-channel-fidelity 8/8、判据隔离 **15/15**、派单超时/取证链路 **16/16**、仓库指令 **7/7** KILLED（`ALL_RESTORED=true`）。**这不等于探针读数，别混记。**
  选源串三条约束：不跨行（Windows 检出是 CRLF）、不选「改坏即死循环」的点、**不选注释或可被注释掉的位置**
  —— 后者实测踩过：把 `'candidates/**'` 注释掉，文本扫描式判据照样绿（SURVIVED），改读解析后的配置对象才 KILLED。
  第四条约束（本轮新增）：**夹具必须比它要测的窗口长**。`sse-tail-meta-dropped` 第一次 SURVIVED，
  因为「真实链路」夹具只有 ~980 字符、短于原始尾部窗口 1200，`meta` 被兜底路径整条兜住 ——
  测的是兜底不是目标路径。垫到 400 条 delta 后才 KILLED。
- 围栏 `server/scripts/check-self-upgrade.mjs`：受保护文件哈希、判据指纹、C1 元数据、靶子改动。
  判 FAIL 时把全量回归原始输出整份落盘 `.self-upgrade/loop/full-regression-<ts>.txt`，
  **复跑那遍另存 `full-regression-first-<ts>.txt`**（两遍的失败项并不总是一样）；
  无输出时打 `REGRESSION_VERDICT=unexec` 并归 infra，**不许在无证据时说「可复现真回归」**。
- 基线：**278 个受保护文件**；改 `tests/` 等必须人重锚。

### 7.6 尺子踩过的坑（2026-11-14 一轮修掉十三处）

| 缺陷 | 后果 | 现状 |
|---|---|---|
| 宿主 `.env` 泄漏进围栏子进程 | 五次「可复现真回归」全是假的：一批断言「默认关闭」态的用例只在派单里红 | `tests/setup-hermetic-env.ts` 挂 `setupFiles`，清 18 个 ambient 键、留 `KRSI_BIN_PATH`、不碰 `.env` |
| `budget_exhausted` 三道顶混为一谈 | 迭代上限还没用到就先撞 token/墙钟，却一律喊「拆题」，还烧模型轮换打出 404 | 按 `detail` 串分辨，点名 `AGENT_TOKEN_BUDGET_FACTOR` / `AGENT_TASK_BUDGET_MS` / `AGENT_MAX_TOOL_CALLS`，`raise_budget` 停机 |
| 诊断书丢弃围栏证据行 | 旧过滤顶格匹配 `FAIL`，真实输出是 6 空格缩进 → 只剩一句结论 | `scripts/lib/fence-diag.mjs` 剥 CSI + 收续行，循环消费它 |
| 首次全量输出被复跑覆盖 | 「第一次为什么红」无从复核 | 两遍分别落盘 |
| `--only` 时排除名单恒为空 | `otherPendingJudges` 从被收窄的 `pending` 算 → 未派单的题进全量并必然红 | 改从 `all` 算 |
| K16 登记死锁 | 只读新工具带 `path` 必然触发登记要求，名单在 `tests/` 下 Agent 改不得，反向校验又不许提前登记 | 用 `spec.excludeJudges`（只作用于全量回归），promote 时人补登记 |
| 外层派单超时与墙钟旋钮脱耦 | 写死 700s，墙钟拧到 660s 后第 20 轮过冲到 701723ms 被同时掐断；`sendSec` 三次全是 700 | `scripts/lib/dispatch-timeout.mjs`：`dispatchTimeoutMs(env)` = 墙钟 + 180s 余量，范围与 `env.ts` 同口径，非法值回默认**绝不回 NaN** |
| `run()` 丢弃掐断信号 | 「没让它做完」与「它不会做」在归因眼里一样 → 两轮记成 implementation 并计入 Agent | `timeoutMarker` 追加 `DISPATCH_TIMEOUT=<ms>ms kill=<signal>`；归因新增 L0a5 `DISPATCH_TIMEOUT_NO_REPORT`（infra，前提是 run_report 确实缺失） |
| 取证尾部丢掉 `meta` | `maxIterations` 全流只在 `meta` 出现一次；右操作数恒 null ⇒ 上面那条「三道顶」修复在**生产里静默失效**，判据却全绿 | `KEY_EVENTS = ['meta','run_report','done']`，`meta` 排最前以保住「取最后一次」语义 |
| 派单证据只认 stdout | 外层掐断只打掉 shell，子进程 6–10 秒后才把完整 SSE 落盘。循环手里没有 run_report → 归因 `DISPATCH_TIMEOUT_NO_REPORT`/`retry_same`，而真因是服务端墙钟天花板（`RUN_BUDGET_WALL_CLOCK`，1390044/1200000 ms），正确动作是 `raise_budget` 停机。代价可量化：多烧一轮 23 分钟，三次派单合计 46 分钟 | `scripts/lib/dispatch-evidence.mjs`：异常退出时等证据静止（上限=过冲余量），盘上有就以盘为准；`evidence` 同时喂工具调用计数与归因。判据 17 例，判别力实测：同一份真 SSE 走盘上 → `WALL_CLOCK_CEILING`，只给被掐断的 stdout → `NO_REPORT` |
| 围栏判在移动靶上 | 围栏读哈希时 Agent 还在写：06:43:0x 判「靶子未被改动（本次改动 = 无）」，而文件 mtime 是 06:43:07.569、hash `235910cc→d23e7028`；07:29:3x 判「2 处 tsc 未过」，文件最后写入 07:29:41，人随即跑 `tsc --noEmit` 是 exit 0。更坏的是下一轮把那笔迟到的写入算成自己的改动（同一次派单里 PASS 目标文件被改动） | 把「等证据静止」放在围栏之前，围栏天然读定稿 |
| 任务定义要求「已正确的东西再改一遍」 | `code-search` 的 `requireAllTargets=true`，而 `src/tools/builtin/index.ts:22,43` 早已 import 并注册，判据的注册断言全绿 ⇒ 无论实现多完美都判「还差 index.ts」。三次派单的围栏全因此红，其中两次是假红 | 改 `false`；与 G2-a 同源理由：已正确的不该被逼着重改。判「靶子被改动」是防蒙混，不是逼人做无意义改动 |
| 判据只断言「某个词出现过」 | G1 的从属声明句里「硬性规则」出现两次，`toContain('硬性规则')` 把改掉从属关系的实现照样判绿（变异体 `instructions-drops-subordination` 第一版 **SURVIVED**） | 断言语义而非 token：`/(低于\|从属于)[^。]{0,40}硬性规则/`，锚点也换到「优先级低于硬性规则本身」；第二次注入 7/7 KILLED。**判据里每个 `toContain` 都要问一句：改掉这句话的意思，它还会绿吗** |

**第九条最值得记**：#19 的判据当时全绿，因为夹具是手工拼的 `data:` 行（自带一个携带 `maxIterations` 的
`run_state` 事件），**直接喂归因、绕过了尾部生产者**。判据测了消费者，没测「生产者→消费者」这条链。
修法不是加断言，是让夹具走真实链路：真实事件形状 → `buildDispatchTail` → `attributeFailure`。

**另一个同名陷阱**：`execFileSync` 的超时码与 undici 的连接超时码都叫 `ETIMEDOUT`，
而归因的上游不可达分支拿这个裸词当识别串。掐断标记若照抄 `err.code`，
自己掐的子进程会被判成「上游连不上、`halt_manual`」。标记改写 `kill=<signal|timeout>`，从源头避开。

**预算旋钮的硬约束**：派单子进程超时不再是常数，= `AGENT_TASK_BUDGET_MS` + 300s 过冲余量
（余量依据：预算检查在**每轮 LLM 调用之前**，单轮可整体过冲；实测过冲 41.7s 与 190s，单轮 35–190s）。
余量 180s 曾经不够：190s 的单轮过冲让 1380s 的外层掐断比 run_report 早 10 秒，证据全丢 —— 所以下限
取「实测最大单轮过冲 × 1.5」。取证等待也用同一个常量，两个数不可能各自漂移。
拧墙钟旋钮外层会自动让路，两者不会再互相掐。另：`maxIterations=25` 写死在
`task-self-upgrade.ts` 的 payload 里，`AGENT_MAX_ITERATIONS` 改不动它。

## 8. HTTP API 地图（`/api/v1`）

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

**错误体**：统一 `{ error: { code, message } }`（17 处 legacy 已统一）；前端 `parseErrorResponse` 兼容对象与字符串。

## 9. 验证面（当前）

读数锚点：GitHub Actions **run #5 @ `4d6ed81`**（ubuntu-latest / node 22，两 job 全 step success）。下表只记这一趟真跑出来的数；CI 不跑的项按 UNEXEC 记，不继承旧读数。

| 项 | 结果 |
|---|---|
| `server npm run test:acceptance` | exit 0；**1512 passed + 1 skipped（162 文件）**；krsi 10/10；套件地板 3/3（`[input]` 夹具 sha `fd44d506…`，与本地 Windows 那趟同一份字节）；C1 PASS；工具契约 17 工具 PASS（对外清单核对 UNEXEC：runner 上服务未运行） |
| client 测试 | 136/136（15 文件）；UI 静态卫生门禁 3 项 PASS |
| e2e | UNEXEC（CI 不跑 `scripts/e2e.sh`，本表未重测） |
| 变异探针 | UNEXEC（CI 不跑，本表未重测） |

本地补充读数（2026-11-14 尺子轮，Windows / node 24，**与上表 CI 锚点不是同一趟，别混算**）：

| 项 | 结果 |
|---|---|
| 尺子判据 | `judge-run-ansi` + `dispatch-channel-fidelity` + `unexec-consumption` 同跑 **3 文件 71 passed** |
| `npx tsc --noEmit`（server） | **exit 0**（G2-b 采纳后，`code-search.tool.ts` 的 2 处类型错已由 CodeLens 自己修掉） |
| `judge-audit` | **27/27** |
| 围栏（fs.read 题，`--full`） | **exit 0，围栏通过** |
| 破坏夹具（人工注入） | judge-run-ansi **10/10**、dispatch-channel-fidelity **8/8**、判据隔离 **15/15**、派单超时/取证链路 **16/16** KILLED，ALL_RESTORED=true |
| 全量套件（**带派单那套污染 env**） | 隔离件落地后 **172 文件 / 1758 passed / exit 0 / 96.96s** |
| 围栏（G2-a `fs-glob-shared`，`--full`，派单前锚点） | 实质项全绿（判据指纹未变 / 4-5 靶子 changed / 注释保留 / tsc / 判据自证 / 判据 28 用例 / 全量回归），`JUDGE_VERDICT=pass`；整体 exit 1 的 13 条 FAIL 全是受保护路径改动，逐条对应人工 D4 归因行，无一条来自 Agent |
| `fs-read-line-window`（被 excludeJudges 排除，故单独实跑） | **21/21 passed** —— 确认 G2-a 改 `fs-read.tool.ts` 没踩坏行窗口 |
| `tests/self-upgrade` 全跑（派单超时/取证链路修完后） | **28 文件 / 389 passed / 7 failed**，7 条全在 `code-search.test.ts`（G2-b 实现缺口：二进制 0x00 跳过、>1 MiB 单文件跳过），尺子侧改动**零回归** |
| 真实 SSE 重放（`sse-code-search-1.txt`，112584 字符） | 修前尾部 → `BUDGET_EXHAUSTED`/`split_task`；修后 → `WALL_CLOCK_CEILING`/`raise_budget`，evidence 含 `iteration=20/25` 与 `701723/660000 ms`；尾部 2472 字节 ≤ 4000 |
| G2-b 重派（墙钟 1200000ms / token 系数 6，3 次尝试） | 3 次都跑满 1380s 外层超时、stdout 无 run_report；第 1、3 次围栏之后子进程仍在写。**第 3 次把判据跑绿（29/29）**，实现由 Agent 独力完成。三次真实成因：墙钟天花板低于该模型在该题上的耗时（190s 单轮过冲）＋ 证据滞留 stdout。归因三次都判 `DISPATCH_TIMEOUT_NO_REPORT`/`retry_same` → 环境连续 3 次停机。账本行保留原样，另追加 `MISATTRIBUTION_CORRECTION` 更正建议项 |
| 围栏（G2-b `code-search`，`--full` + `--accept-current`，人指定理由） | **exit 0，七项全 PASS**：受保护 278/278 / 判据指纹未变 / 人工确认放行 / tsc / 判据自证 / 判据 29 passed / 全量回归 |
| 全量套件（G2-b 采纳后） | **176 文件 / 1830 passed / exit 0 / 99.70s** |
| G1 派单（墙钟 2700s / token 系数 6，1 次尝试） | **一次过**：`sendSec=2058`（34 分钟，未触顶）、进程正常退出 —— 把墙钟从 1200s 抬到 2700s 后，同一模型不再被掐断 |
| 围栏（G1 `project-instructions`） | **10 项全 PASS**：受保护 279/279 / 判据指纹未变 / 三个靶子都被改动 / 注释保留 / tsc / 判据自证 / 判据 30 passed / 全量回归；`agent-loop.service.ts` 1550→1550（净增 0） |
| 破坏夹具（G1） | **7/7 KILLED**，`ALL_RESTORED=true`（注册表 85→92） |
| 全量套件（G1 采纳后） | **177 文件 / 1860 passed / exit 0 / 100.32s** |
| `test:acceptance`（G1 采纳后） | exit 0：typecheck / vitest / krsi / 套房地板 3/3 / C1 / 工具契约 19 / 棘轮 281/281 |

**「派单里红、人工直跑绿」的结案**（2026-11-14）：根因是派单循环 `loadEnvFile(server/.env)` 后
把整个 `process.env` 传给围栏的 vitest 子进程，`fallback-budget` / `observability-endpoints` /
`judge-deep` / `workspace-context` 这批断言「默认关闭」态的用例于是只在派单里红。
证明链：干净 env 全绿 → 注入同一套污染 env 逐条复现落盘证据里的失败项 → 挂上 `setupFiles` 隔离件后
**同一套污染 env 下 172 文件 / 1758 passed / exit 0**。不是并发假红，也不是 Agent 回归。

改动后必须重跑；未跑 = UNEXEC，不算通过。

## 10. 已知边界（别假装没有）

- **CI 已有**：`.github/workflows/ci.yml`（ubuntu-latest / node 22）。它跑 acceptance 与 client 测试，
  **不跑** e2e、变异探针、围栏 —— 这三项仍靠本地触发，CI 绿不代表它们绿。
- **Update/Memory 归属缺口**：两维代码与判据在，但 24 题中 0 题归属它们。
- **账本历史仍稀**：verified 覆盖 13/25，早期条目有重建（标 `reconstructed: true`），历史归因不可完全复算。
- **Update 维仍是 0 题**：Memory 已由 G1 破零，Update 仍是空白（`update.service.ts` 有落点，但没有一道题归属它）。
- **棘轮扫描盲区**：`scripts/check-file-size.mjs` 的 `SCAN_ROOTS` 只有 `server/src` 与 `client/src`，
  `scripts/` 与 `tests/` 不在棘轮内 —— 尺子自己没有行数约束。
- **调度未实现**：`src/` 内没有任何地方启动 `self-upgrade-loop.ts`；只有只读 `rsi-tick`。
- **DSH 19 个工具未安装**：它们是 `defineTool` 插件模块，需 DSH 宿主，不能当 CLI。
- **1 条 DSH 技能未入库**：`hermes-translation-loss-reduction`，名称 33 字符触发密钥规则。
- **无像素基线**：设计线只有结构判据与静态卫生门禁。
- **重派不带上一轮诊断**：`self-upgrade-loop.ts:717` 每次启动 `let feedback = ''`，
  只有同一次运行内的第 2/3 次尝试才带诊断书。跨运行重派时，上一轮落盘的
  `diag-<task>-<n>.txt`（含逐条断言 diff 与 tsc 报错）不会喂给 Agent，它得自己重新推一遍。
  本轮 G2-b 重派即如此。**未修**，记在这里免得当成「模型不长记性」。
- **工具计数**：`src/tools/builtin/index.ts` 注册 **19** 个，`/api/v1/tools` 对外清单也是 19 个
  （`assert-tool-registry-contract.mjs` 对最新实例实跑 PASS）。注意该闸读的是**运行中的服务**：
  端口上挂着旧构建时它会报「注册表有、对外清单没有」，2026-11-14 就在 8080 撞过这个假红。
- **本地 8080 常驻旧实例**：它不是本轮起的，工具清单停在 17 个（无 `fs.glob` / `code.search`）。
  跑 `check:tool-contract` 要用 `CODELENS_API` 指向新起的实例，或先重启它。**未处理**（不动别人起的进程）。

## 11. 关键文件地图

```
server/src/tools/builtin/          19 个注册，19 个已采纳
server/src/services/agent/         Agent 循环、循环检测、系统提示词
server/src/services/judge/         判决、工具纪律、归因
server/src/services/rsi/           变更域、RSI 服务
server/self-upgrade/tasks.json     题集（24 题）
server/scripts/                    self-upgrade-loop、auto-adopt、judge-audit
server/scripts/lib/dispatch-timeout.mjs  外层超时 = 墙钟 + 300s 余量
server/scripts/lib/dispatch-evidence.mjs 派单证据落盘回读（等静止，以盘为准）
server/scripts/check-self-upgrade.mjs  围栏（七道闸 + C1）
scripts/check-task-metadata.mjs    C1 元数据（exit 3 UNEXEC）
scripts/mutation-probe.mjs         变异探针（注册表 scripts/lib/mutations.mjs）
scripts/rsi-tick.mjs               只读体检
scripts/assert-tool-registry-contract.mjs  工具契约
skills/dsh/skills/                 48 个 DSH SKILL.md
docs/agent/spec.md                 唯一契约来源
```

## 12. 版本

- 版本：**2.20.0**；分支 `main`
- 本轮采纳：`code-search`（G2-b 内容检索破零，19 个工具全部可用）、`fs-read-line-window`（补结题）、
  `project-instructions`（G1 仓库指令自动加载，Memory 维破零 → 2.20.0）
- 尺子侧：派单证据落盘回读（`dispatch-evidence.mjs`）、余量 180s→300s、`code-search` 的 requireAllTargets 修正、
  `code-search` 的 K16 登记、G1 从属声明判据补强
- 交接：**`docs/agent/HANDOFF-2026-11-14.md`**（状态、验证命令、剩余顺序、踩坑边界）
- 近期提交：`b54369f` 围栏指纹按行尾归一、`90b0dac` 本机产物归位 .gitignore、`9204b85` 校准现状句用例体量、`4d6ed81` 地板闸基准夹具受跟踪、`c989584` 地板闸去掉写死本机路径

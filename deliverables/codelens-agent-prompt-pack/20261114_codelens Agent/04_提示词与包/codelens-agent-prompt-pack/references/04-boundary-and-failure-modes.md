# 04 · CodeLens 边界与失败模式

> 信源：S1 `docs/agent/CODELENS-MANUAL.md`（§7.5/§7.6/§9/§10，尤其 §7.6「尺子踩过的坑」十三处）；S1 `docs/agent/HANDOFF-2026-11-14.md`（§2.2/§3/§4/§5/§6）；S1 `AGENTS.md`（§2/§3）（访问日期：2026-11-14）
> 补充核实（本机只读实跑）：`.github/workflows/ci.yml`、`server/self-upgrade/tasks.json`、`.self-upgrade/baseline.json`、`.self-upgrade/ledger.jsonl`、`.self-upgrade/exemplars.jsonl`、`server/src/tools/builtin/index.ts`、`server/src/tools/builtin/agent-verify.tool.ts`、`server/src/types/tool.ts`、根/`server`/`client` 三个 `package.json`、`git status --short`（核对日期：2026-11-14）
> 适用版本：spec v2.0 契约 / 手册 v2.20.0 运行态 / 核实日期 2026-11-14；版本差异处已分列/标注
> 核实状态：已核实（逐条对照一手文件 + 本机只读实跑 + 坊主 2026-11-14 工具数事实裁定已并入）；活读数一律标锚点，不写成规范；本轮改动/新增文件均标 git 状态
> 覆盖体系表编号：§1 A6 / B4 / B7；L1-5（七坑全 7 条）；L2-4 / L2-8；L3-3 / L3-4 / L3-6；冲突 C1–C4 全表；W6（依据 `02_能力体系/三级能力体系表.md` §1、§5）
> 待核实项：5 处，见文末《待核实清单》

---

## 0. 用法与三态

这份文件写「哪里还不行」和「绿了但其实是坏的」。每张表四列：**症状 → 后果 → 治法 → 可验证证据**。执行 Agent 归因前先查 §2 的 8 个判据失败模式，再查 §1 的 12 条已知边界；人侧决策者按 §6 清单验收。

**三态诚实（PASS / FAIL / UNEXEC）**：

| 态 | 含义 | 出处 |
|---|---|---|
| PASS | 本次实跑 exit 0，有原始输出 | 手册 §9 各表 |
| FAIL | 本次实跑非零，有逐条失败项 | 手册 §9:208、§7.5:132 |
| **UNEXEC** | 未执行 / 未跑 / 无输出；**不等于绿，也不等于红** | 手册 §9:189「CI 不跑的项按 UNEXEC 记，不继承旧读数」；§9:227「未跑 = UNEXEC，不算通过」；`AGENTS.md:16`「未执行写 UNEXEC」 |

手册 §9:195-196 把 e2e 与变异探针直接记为 `UNEXEC（CI 不跑……本表未重测）`；`HANDOFF §4:78` 把 `bash scripts/e2e.sh` 记为「本轮 UNEXEC（未跑，别当绿）」。这两处是 UNEXEC 的标准写法，照抄格式即可。

## 1. 手册 §10 已知边界逐条（B1–B12）

| 症状 | 后果 | 治法 | 可验证证据 |
|---|---|---|---|
| **B1** CI 只跑 acceptance 与 client 测试 | e2e、变异探针、围栏仍靠本地触发；**CI 绿不代表它们绿** | 三项单独在本地跑并单独标态 | 本机核实 `.github/workflows/ci.yml`：两个 job（client / server），`ubuntu-latest` + `node 22`，各跑 `npm run test:acceptance`；手册 §10:231-232；手册 §9:195-196 标 UNEXEC |
| **B2** Update/Memory 归属缺口：两维代码与判据在，但 24 题中 0 题归属 | 闭环 `π → Act → τ → Judge → r → Update → π'` 的 Update 段无题驱动 | 补 Update 维题目；`HANDOFF §5:87` 建议做成 `agent.verify` 工具而非提示词 | 手册 §10:233；当前文件态 `tasks.json` 已有 1 题 `strengthens: "Update"`（本机实跑，见本文件 §4 `strengthens` 分布行） |
| **B3** 账本历史仍稀：verified 覆盖 13/25，早期条目有重建 | 历史归因不可完全复算 | 重建条目必须标 `reconstructed: true`；账本只追加可验证记录 | 手册 §10:234、§7.3:100；`AGENTS.md:16`；本机实跑 `.self-upgrade/ledger.jsonl` = 89 行 |
| **B4** Update 维仍是 0 题（**文档滞后，须带更正**） | 照抄会让执行 Agent 说错话：当前 `tasks.json` 实读 36 id / 35 done + 1 pending，`strengthens` 含 **Update 1** | 写「以 `tasks.json` 当前态为准」，不照抄手册断言；不把「有落点」当成「有题」 | 手册 §10:235；`核心场景事实地图.md` e 节 E10:249；本机实跑；`tasks.json:614-616` 已登记 `agent-verify`（Update / done / releasedIn 2.21.0）；与 B2 是同一缺口的两处表述，分列不合并 |
| **B5** 棘轮扫描盲区：`SCAN_ROOTS` 只有 `server/src` 与 `client/src` | `scripts/` 与 `tests/` 不在棘轮内，尺子自己没有行数约束 | 先落 G1，再扩范围并 `--tighten` 封顶；同步改 `tests/self-upgrade/file-size-ratchet.test.ts:181` 写死的前缀 | 手册 §10:236-237；`HANDOFF §5:88` 记「实测把 `scripts/`+`tests/` 纳入后有 31 个文件 >300 行」（活读数）；本机核实 `scripts/check-file-size.mjs` 存在 |
| **B6** 调度未实现：`src/` 内没有任何地方启动 `self-upgrade-loop.ts` | 只有只读 `rsi-tick`，无自发演进循环 | 不假称「闭环自动跑」；派单由人触发 | 手册 §10:238；`HANDOFF §5:94` 同述；本机核实 `server/scripts/self-upgrade-loop.ts` 存在但无 `src/` 调用点 |
| **B7** DSH 19 个工具未安装 | 它们是 `defineTool` 插件模块，需 DSH 宿主，**不能当 CLI** | 只当被消费资产，不写「可直接调用」 | 手册 §10:239；`领域解析卡 §2:46` 划为边界外 |
| **B8** 1 条 DSH 技能未入库 | `hermes-translation-loss-reduction` 名称 33 字符触发密钥规则被拒写 | 不回显原文；文件保留在 `skills/dsh/` | 手册 §10:240、§6:75-76；本机实跑 `find skills/dsh -name SKILL.md` = 48，技能库 47 条（活读数） |
| **B9** 无像素基线 | 设计线只有结构判据与静态卫生门禁，视觉回归无据 | 不写「视觉已验证」 | 手册 §10:241；`spec.md §7/§8` 只有页面与设计 Token 契约 |
| **B10** 跨运行重派不带上一轮诊断 | `self-upgrade-loop.ts:717` 每次启动 `let feedback = ''`，只有同一次运行内第 2/3 次尝试才带诊断书；上一轮 `diag-<task>-<n>.txt`（含逐条断言 diff 与 tsc 报错）不喂给 Agent，得自己重推一遍 | 交接单显式写 `diag-*.txt` 路径；**未修**，别当成「模型不长记性」 | 手册 §10:242-245；`HANDOFF §6:128-129`；本轮 G2-b 重派即如此 |
| **B11** 工具计数与运行实例耦合 | `assert-tool-registry-contract.mjs` 读的是**运行中的服务**；端口挂旧构建时报「注册表有、对外清单没有」的假红 | 用 `CODELENS_API=http://127.0.0.1:<port>` 指向新起的实例，或先重启 | 手册 §10:246-248（2026-11-14 在 8080 撞过）；`scripts/assert-tool-registry-contract.mjs:24` 默认 `http://127.0.0.1:8080` |
| **B12** 本地 8080 常驻旧实例 | 它不是本轮起的，工具清单停在 17 个（无 `fs.glob` / `code.search`）；**未处理**（不动别人起的进程） | 跑 `check:tool-contract` 前确认实例版本 | 手册 §10:249-250；`HANDOFF §6:125` 记「当前已重建并重启到 2.21.0（20 个工具）」，与手册快照不同（见 §4） |

**正反对照 1**：错误做法「CI 两个 job 全绿，就写 e2e / 变异 / 围栏通过」→ 现象「`.github/workflows/ci.yml` 根本没有这三步，结论无证据」→ 正确做法「三项各自标 UNEXEC 或本地实跑读数，CI 绿只覆盖 acceptance + client 测试」（手册 §10:231-232）。

## 2. §7.6「尺子十三处踩坑」提炼的 8 个判据失败模式（F1–F8）

手册 §7.6:137 记「2026-11-14 一轮修掉十三处」。下表只取与判据可信度直接相关的 8 个，每个都给可复核证据。

| 症状 | 后果 | 治法 | 可验证证据 |
|---|---|---|---|
| **F1 夹具绕开真实链路** | #19 的判据当时全绿：夹具是手工拼的 `data:` 行，自带携带 `maxIterations` 的 `run_state` 事件，**直接喂归因、绕过了尾部生产者**；判据测了消费者，没测「生产者→消费者」这条链 | 让夹具走真实链路：真实事件形状 → `buildDispatchTail` → `attributeFailure`；不是加断言 | 手册 §7.6:155-157「第九条最值得记」 |
| **F2 `toContain` 只断言 token** | G1 从属声明句里「硬性规则」出现两次，`toContain('硬性规则')` 把改掉从属关系的实现照样判绿；变异体 `instructions-drops-subordination` 第一版 **SURVIVED** | 断言语义而非 token：`/(低于\|从属于)[^。]{0,40}硬性规则/`，锚点换到「优先级低于硬性规则本身」；每个 `toContain` 都问「改掉这句话的意思，它还会绿吗」 | 手册 §7.6:153；补强后第二次注入 **7/7 KILLED**；`HANDOFF §2.2:36` 同述 |
| **F3 夹具比被测窗口短** | `sse-tail-meta-dropped` 第一次 SURVIVED：真实链路夹具只有 ~980 字符，短于原始尾部窗口 1200，`meta` 被兜底路径整条兜住，测的是兜底不是目标路径 | 第四条约束：**夹具必须比它要测的窗口长**；垫到 400 条 delta 后才 KILLED | 手册 §7.5:128-130 |
| **F4 env 污染假红** | 宿主 `.env` 泄漏进围栏子进程；五次「可复现真回归」全是假的，一批断言「默认关闭」态的用例只在派单里红 | `tests/setup-hermetic-env.ts` 挂 `setupFiles`，清 18 个 ambient 键、留 `KRSI_BIN_PATH`、不碰 `.env` | 手册 §7.6:141；证明链见 §9:221-225：同一套污染 env 下隔离件落地后 **172 文件 / 1758 passed / exit 0**（活读数） |
| **F5 证据只认 stdout** | 外层掐断只打掉 shell，子进程 6–10 秒后才把完整 SSE 落盘；循环手里没有 `run_report` → 归因 `DISPATCH_TIMEOUT_NO_REPORT`/`retry_same`，真因是服务端墙钟天花板（`RUN_BUDGET_WALL_CLOCK`），正确动作是 `raise_budget` 停机。代价可量化：多烧一轮 23 分钟，三次派单合计 46 分钟 | `scripts/lib/dispatch-evidence.mjs`：异常退出时等证据静止（上限=过冲余量），盘上有就以盘为准；`evidence` 同时喂工具调用计数与归因 | 手册 §7.6:150；判据 17 例；判别力实测：同一份真 SSE 走盘上 → `WALL_CLOCK_CEILING`，只给被掐断的 stdout → `NO_REPORT`；`HANDOFF §2.2:32` 记 `dispatch-evidence-recovery.test.ts` 17 例 / 6/6 KILLED |
| **F6 围栏判在移动靶上** | 围栏读哈希时 Agent 还在写：06:43:0x 判「靶子未被改动」，而文件 mtime 06:43:07.569、hash `235910cc→d23e7028`；07:29:3x 判「2 处 tsc 未过」，人随即跑 `tsc --noEmit` 是 exit 0；更坏的是下一轮把迟到的写入算成自己的改动 | 把「等证据静止」放在**围栏之前**，围栏天然读定稿 | 手册 §7.6:151；`HANDOFF §2.2:33` 同述 |
| **F7 已正确的东西被逼着重改** | `code-search` 的 `requireAllTargets=true`，而 `src/tools/builtin/index.ts:22,43` 早已 import 并注册，判据的注册断言全绿 ⇒ 无论实现多完美都判「还差 index.ts」；三次派单的围栏全因此红，其中两次是假红 | 改 `false`；判「靶子被改动」是防蒙混，不是逼人做无意义改动 | 手册 §7.6:152；`HANDOFF §2.2:35` 同述（与 G2-a 同源理由） |
| **F8 `ETIMEDOUT` 同名陷阱** | `execFileSync` 的超时码与 undici 的连接超时码都叫 `ETIMEDOUT`；归因的上游不可达分支拿这个裸词当识别串，掐断标记若照抄 `err.code`，自己掐的子进程会被判成「上游连不上、`halt_manual`」 | 标记改写 `kill=<signal|timeout>`，从源头避开；不要拿裸 `err.code` 当语义 | 手册 §7.6:159-161 |

**选源串四条约束**（手册 §7.5:126-130，人工注入红基线时用）：不跨行（Windows 检出是 CRLF）；不选「改坏即死循环」的点；不选注释或可被注释掉的位置（实测把 `'candidates/**'` 注释掉，文本扫描式判据照样绿 SURVIVED，改读解析后的配置对象才 KILLED）；夹具必须比它要测的窗口长（F3）。

**预算旋钮硬约束**（手册 §7.6:163-168）：派单子进程超时不再是常数，= `AGENT_TASK_BUDGET_MS` + 300s 过冲余量；余量依据是预算检查在每轮 LLM 调用之前，单轮可整体过冲（实测 41.7s 与 190s，单轮 35–190s）；180s 余量曾不够，190s 单轮过冲让 1380s 外层掐断比 `run_report` 早 10 秒、证据全丢，所以下限取「实测最大单轮过冲 × 1.5」。取证等待与外层超时共用同一常量，两个数不可能各自漂移。`maxIterations=25` 写死在 `task-self-upgrade.ts` 的 payload 里，`AGENT_MAX_ITERATIONS` 改不动它（`HANDOFF §6:130` 同述）。

**正反对照 2**：错误做法「判据全绿就认定修复生效」→ 现象「`toContain('硬性规则')` 让改掉从属关系的实现照样绿（SURVIVED）；手工拼的 `data:` 夹具绕过尾部生产者，#19 全绿但链没测」（F1/F2）→ 正确做法「用变异探针改坏实现→跑判据→必须非零；`finally` 还原并校验 sha256」（手册 §7.5:122）。

## 3. 三态诚实与 UNEXEC 口径

| 约束 | 违反后果 | 可验证的合规动作 |
|---|---|---|
| 未跑 = UNEXEC，不算通过（手册 §9:227、`AGENTS.md:23`） | 把「没跑」写成绿 | 验收表逐项标 PASS / FAIL / UNEXEC；`HANDOFF §4:78` 是范例 |
| 不继承旧读数（手册 §9:189） | 拿上一趟 CI 的 1512 当本次结果 | 本次实跑输出单独落盘；两遍全量回归分别存 `full-regression-<ts>.txt` 与 `full-regression-first-<ts>.txt`（手册 §7.5:132-133） |
| 无输出时打 `REGRESSION_VERDICT=unexec` 并归 infra；不许在无证据时说「可复现真回归」（手册 §7.5:134） | 五次假红（F4） | 原始输出整份落盘后再下结论 |
| 人工注入 ≠ 探针读数（手册 §7.5:125、`HANDOFF §3:61`） | 把人工 KILLED 数当自动探针结果 | 两栏分写；探针要求靶子 git-clean，否则 SKIP（手册 §7.5:123-124） |
| CI 表与本地补充表不是同一趟，别混算（手册 §9:198） | Linux CI 1512 与 Windows 本地 1860 互相印证 | 分列并标环境：CI ubuntu-latest / node 22；本地 Windows / node 24 |
| 账本历史稀，早期条目有 `reconstructed: true`（手册 §10:234） | 重建记录当原始证据 | 查字段；verified 覆盖 13/25（活读数） |

**三态的正反对照**：错误做法「`check:mutation` 整批 SKIP，于是把人工注入的 10/10、8/8、15/15、16/16、7/7 KILLED 写成『探针通过』」→ 现象「探针根本没跑，靶子多为未提交/未跟踪，红基线另由人工取得」（手册 §7.5:123-125）→ 正确做法「探针标 UNEXEC/SKIP，人工注入另起一栏，注明 `ALL_RESTORED=true`」。

**运行时类型层的三态与七态**（`server/src/types/tool.ts`，未提交改动 `M`，本机实读全文）：`ReviewStatus = 'confirmed' \| 'underestimated' \| 'unexec'`（`:134`）与本文 UNEXEC 同口径；`ReviewResult.reason?` 注释明写「unexec 时的诚实原因（未配置 Key / 超时 / 解析失败）」（`:152-153`）。`ToolStatus` 七态为 `pending` / `running` / `success` / `failed` / `timeout` / `rejected` / `skipped`（`:9-16`），其中 `skipped` 按 `spec.md §9` AC-03 不计入失败数。`ToolRisk = 'low' \| 'medium' \| 'high'`（`:6`）与 `ToolApprovalMode = 'none' \| 'soft' \| 'hard' \| 'two_step'`（`:7`）是风险与审批档的契约取值。该文件其余接口本轮未逐项核完，标「待核实」。

## 4. 活读数裁定与历史读数对照

下表每一行的值都是**本机实跑读数，锚点见 X，不得写成规范**。当前文件态由 2026-11-14 只读核对得到；文档锚点值来自手册与 HANDOFF 的读数快照。两栏并存，不合并、不取平均。

**坊主 2026-11-14 事实裁定（全组统一口径，覆盖此前「三处读数未分层」的说法）**：当前源码注册表 `server/src/tools/builtin/index.ts:25-46` 实读 **20 个工具（含 `agent.verify`）**；此为活读数，以实跑为准，不得写成规范；手册 §4 的 19 为上轮读数，手册 §10 的 17 为 8080 旧构建实例。三处（19 / 20 / 17）并列写在下表同一行，结论统一为「以实跑为准，不得写成规范」；不写「三处无法判断」、不把 19 当硬规范。

| 读数 | 文档锚点值 | 其他锚点 / 当前文件态 | 口径声明 |
|---|---|---|---|
| **工具数（19 / 20 / 17 三处并列）** | **19（上轮读数）**：手册 §4 表 / §10:246 / §11:255 / §9:219；`HANDOFF §1:10`、§3:57。**17（旧构建实例）**：手册 §3:30、§9:193（CI run #5 工具契约 17 工具 PASS）、§10:249（8080 旧实例）；`HANDOFF §6:125` 旧构建 | **20（当前源码实读）**：本机实跑 `server/src/tools/builtin/index.ts:25-46` 的 `BUILTIN_TOOLS` = 20 项，第 20 项 `agentVerifyTool`（`agent.verify` / `agent_verify`）；`HANDOFF §6:125`「重启到 2.21.0（20 个工具）」；`git status` 标 `index.ts` 未提交改动 `M`、`agent-verify.tool.ts` 未跟踪新增 `??` | **裁定**：当前源码注册表实读 20 个工具（含 `agent.verify`）；活读数，以实跑为准，不得写成规范。19 = `agent.verify` 落地前的上轮读数，17 = 旧构建进程（与源码注册表不是同一层）。三层不并列取舍；工具名底表以源码注册表为名源（手册 §4 的 19 个 + `agent.verify`），不另造名 |
| **题数** | **24**：手册 §10:233、§11:259。**25**：手册 §7.3:98、`HANDOFF §1:10`、§3:50 | **35 / 36**：`HANDOFF §5.2:109` 用「覆盖 13/35」；本机实跑 `server/self-upgrade/tasks.json` = **36 题**（done 35 / pending 1） | 24/25 是读数快照，36 是当前文件态；锚点见 `tasks.json` |
| **`strengthens` 分布** | 手册 §7.3:98：Act 12 / Judge 12 / Memory 1 / **Update 0**；`HANDOFF §3:50` 同；手册 §10:235「Update 维仍是 0 题」 | 本机实跑 `tasks.json`：Judge 21 / Act 13 / Memory 1 / **Update 1**（实读 36 id / 35 done + 1 pending） | **文档滞后，必须带更正**：写「以 `tasks.json` 当前态为准（实读 36 id / 35 done + 1 pending / Update 1）」，不照抄「Update 维仍是 0 题」。`tasks.json:614-616` 已登记 `agent-verify`（Update / done / releasedIn 2.21.0）。锚点见 `tasks.json`、待核实 #4 |
| **受保护文件** | **278**：手册 §7.5:135、§9:213（G2-b 围栏 278/278） | **279**：手册 §9:216（G1 围栏 279/279）、`HANDOFF §3:52`、本机实跑 `.self-upgrade/baseline.json` 的 `protected` = 279。**281**：手册 §9:219 棘轮 281/281（不同口径） | 278/279 是基线值，281 是棘轮文件数，勿混；锚点见 `baseline.json` |
| **passed** | **1512** + 1 skipped（162 文件）：手册 §9:193、`AGENTS.md:20`，CI run #5 @ `4d6ed81` | **1758**（172 文件，手册 §9:207）、**1830**（176 文件，§9:214）、**1860**（177 文件，§9:218、`HANDOFF §3:53`） | 逐轮采纳后的全量套件读数，非规范；CI 与本地不是同一趟 |
| **账本 / 正例** | 89 行账本、verified 13/25、exemplars 3 条：手册 §7.3:100-101、`HANDOFF §3:51,54` | 本机实跑 `.self-upgrade/ledger.jsonl` = 89 行、`exemplars.jsonl` = 3 行 | 一致；覆盖率另有 13/35（`HANDOFF §5.2:109`） |
| **judge-audit** | **28/28**：手册 §7.5:121、`HANDOFF §3:54` | **27/27**：手册 §9:204 本地补充读数 | 两趟不同读数，分列 |
| **变异体注册表** | **92 条**：手册 §7.5:123、§9:217、`HANDOFF §3:55` | 85→92（手册 §9:217 G1 破坏夹具） | `scripts/lib/mutations.mjs` 本机核实存在（39148 字节） |
| **版本** | 2.20.0：手册 §12:274、`HANDOFF:1`/§3:49/§8:161 | v2.11.0（`AGENTS.md:7`）、v2.18.0（手册 :1 标题、`HANDOFF:22`）、**2.21.0**（三个 `package.json` + `tasks.json` 10 题 `releasedIn` + `HANDOFF §6:125`）、v2.0（`spec.md:1` 契约）、2.1.0（`docs/agent/openapi.yaml:5`） | 文档基准 2.20.0 / 当前文件态 2.21.0；spec v2.0 是契约版本，不是运行态版本 |

**规则**：引用任何一个数时，写全「值 + 锚点 + 本机实跑读数，不得写成规范」。禁止只写一个数。禁止把 25 题、1512 passed、278 文件写成硬性门槛（手册 §7.3:96、`AGENTS.md:20`）。工具数统一写「当前源码实读 20（含 `agent.verify`），活读数以实跑为准；手册 19 为上轮读数、17 为旧构建实例」，不写「三处无法判断」、不把 19 当硬规范。

## 5. 参数说明（本文件出现的全部变量）

| 变量 / 标记 | 取值与出处 | 用途 |
|---|---|---|
| `AGENT_TASK_BUDGET_MS` | `HANDOFF §8:158-159` 示例 2700000；手册 §7.6:142 | 派单墙钟旋钮 |
| `AGENT_TOKEN_BUDGET_FACTOR` | `HANDOFF §8:158-159` 示例 6；手册 §7.6:142 | token 系数 |
| `AGENT_MAX_TOOL_CALLS` | 手册 §7.6:142 | 三道顶之一，按 `detail` 串分辨，别一律喊「拆题」 |
| `RUN_BUDGET_WALL_CLOCK` | 手册 §7.6:150（`1390044/1200000 ms`） | 服务端墙钟天花板，F5 的真因 |
| `AGENT_MAX_ITERATIONS` | 手册 §7.6:168 | **改不动** payload 里写死的 `maxIterations=25` |
| `DISPATCH_HEADROOM_MS` | 180s → **300s**（`HANDOFF §2.2:34`） | 过冲余量；手册 §7.6:147 记修前 180s，§7.6:163 记修后 300s，属版本差异 |
| `DISPATCH_TIMEOUT=<ms>ms kill=<signal>` | 手册 §7.6:148 | 掐断标记；改用 `kill=<signal|timeout>` 避开 F8 同名陷阱 |
| `CODELENS_API` | `scripts/assert-tool-registry-contract.mjs:24` | 契约闸指向的运行实例，默认 `http://127.0.0.1:8080` |
| `KRSI_BIN_PATH` | 手册 §7.6:141 | hermetic env 隔离件唯一保留的 ambient 键 |
| `E2E_PORT` | `AGENTS.md:22` | e2e 端口 |
| `CHECKPOINT_ENABLED` / `SKILL_LIBRARY_ENABLED` / `SANDBOX_ROOT` | 手册 §5:67、§6:73、§5:64 | 运行态开关 |
| `${VAR}` | 本文约定 | 所有密钥示例的占位符，禁止写真实 Key |

## 6. 可查清单（交付前逐项打勾）

1. 查三态：验收表逐项 PASS / FAIL / UNEXEC，无「未跑即通过」。
2. 查 CI 边界：确认 e2e / 变异 / 围栏未在 CI 内，单项标态。
3. 查 Update 维：确认是否仍 0 题；当前文件态有 1 题 `strengthens: "Update"`，两栏写。
4. 查跨运行诊断：交接单是否显式写出 `diag-<task>-<n>.txt` 路径。
5. 查运行实例：跑契约闸前确认 `CODELENS_API` 指向新实例，不是 8080 旧构建。
6. 查判据判别力：每个 `toContain` 问「改掉这句话的意思，它还会绿吗」。
7. 查夹具：是否走真实链路、是否比被测窗口长。
8. 查 env：是否挂 `setupFiles` 隔离件，清 18 个 ambient 键、留 `KRSI_BIN_PATH`。
9. 查证据：异常退出是否等证据静止、以盘为准；两遍回归是否分别落盘。
10. 查围栏：是否放在「等证据静止」之后，不判移动靶。
11. 查活读数：每个数字有锚点，注明「本机实跑读数，不得写成规范」。
12. 查人工注入：与自动探针分栏，注明 `ALL_RESTORED=true`，不混记。
13. 查密钥：文中无真实 Key，示例用 `${VAR}`。
14. 查工具数裁定：统一写「当前源码实读 20（含 `agent.verify`）、活读数以实跑为准；手册 19 为上轮读数、17 为旧构建实例」，不写「三处无法判断」、不把 19 当硬规范。
15. 查文档滞后项：涉及 Update 维时写「以 `tasks.json` 当前态为准（实读 36 id / 35 done + 1 pending / Update 1）」。

## 7. 待核实清单

| # | 位置 | 缺什么 | 建议核实途径 | 影响 |
|---|---|---|---|---|
| 1 | §1 B7、§2 F5 | `scripts/lib/mutations.mjs` 的 92 条变异体是否逐条可注入、与人工注入读数如何对应，本轮未跑探针核实 | 跑 `cd server && npm run check:mutation` 并确认靶子 git-clean；对照 `HANDOFF §3:59-61` | 中 |
| 2 | §1 B5 | `HANDOFF §5:88` 的「31 个文件 >300 行」是实测读数，本轮未重跑 | 跑 `node scripts/check-file-size.mjs` 扩范围后复核 | 低 |
| 3 | §2 F5、§5 | `RUN_BUDGET_WALL_CLOCK` 与 `AGENT_TASK_BUDGET_MS` 是否同一旋钮的两处命名，未见源码映射 | 读 `server/src/services/agent/` 的预算检查与 `task-self-upgrade.ts` payload | 中 |
| 4 | §1 B2/B4、§4 | 手册 §10「Update 维仍是 0 题」属**文档滞后**；坊主已裁定写「以 `tasks.json` 当前态为准（实读 36 id / 35 done + 1 pending / Update 1）」，但手册修订记录未见 | 对照 `tasks.json` 的 `strengthens` 分布与手册修订记录 | 中 |
| 5 | §1 B11/B12、§4 | 源码注册表已实读 20 项且坊主已裁定；但**运行中服务**的真实版本与工具数本轮未起服务实测 | 起新实例后 `curl /api/v1/tools` 计数并读 `/api/health`，确认 `CODELENS_API` 指向该实例 | 高 |

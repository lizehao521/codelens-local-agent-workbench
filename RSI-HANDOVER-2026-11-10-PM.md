# RSI 交接 · 2026-11-10（下午）

> 文件：`RSI-HANDOVER-2026-11-10-PM.md`　生成：2026-11-10 下午（GMT+8）
> 修订：16:37 更正 Go 环境结论；17:45 追加 **Step 0–4 实执行记录（§9）**；18:35 §9.5；19:10 上游换址（§9.6）；19:25 `--auto` 实验、6 代闭环（§9.7）；19:50 π' 注入链路核验（§9.8）；20:10 冲突金丝雀（§9.9，**结论已作废**）；20:37 **A 组基线证伪 §9.9（§9.10，本文最终状态）**。
> **性质：状态快照，不是「下午改动记录」。** 今日提交全部落在 00:11–09:45，12:00 之后无任何新提交；本文档生成后的验证执行另计，见 §9。
> **口径**：沿用 `强化Agent.txt` C4「不外推」。来源等级：
> `[核实]` 读代码 / Git 得到　`[实测]` 本次真实执行命令并留证据　`[文档]` 既有文档记载的历史实测，本次未复跑　`[UNEXEC]` 因外部条件未执行。
> 与 `HANDOVER-2026-11-06.md` 的关系：那份是换机交接，描述 11-06 状态（远端 2 提交 / 478 文件），**已过时**；本文只接 RSI 线，安装、部署、打包、桌面端等通用运维仍查那份 §6–§10。

---

## 0. 先看这段

| 项 | 状态 |
|---|---|
| HEAD | `6b77855c2ec` — Merge PR #1 `trae/agent-K1hREi`，2026-11-10 09:45:54 +0800 `[核实]` |
| 分支 | `workbuddy/main-24d832f5`；文档生成时 clean；**验证执行后有 6 个文件改动**（4 改 + 2 新增，见 §9.1） `[实测]` |
| 今日提交 | **22 个**（00:11–09:45）：11 `feat(...)` + 5 `feat: update workspace` + 4 `fix` + 1 `docs` + 1 merge `[核实]` |
| 今日改动文件 | **74 个**，集中在 `server/`（RSI / eval / judge / 脚本 / 测试 / 夹具）与 `client/`（看板 / 中转接入） `[核实]` |
| 仓库规模 | 570 文件 / 95 目录 / 约 13 MB（11-06 交接文档写的是 478 文件） `[核实]` |
| 本轮四条主线 | ① 证据可信度：v2 锚点 + 离线校验 CLI　② 评测空间扩容：分母 94→110→126　③ 读数消费修复：看板不再解析 `detail` 文本　④ 上游接入 + RSI 判据面板 |
| **Step 0–3** | **全部通过** `[实测]`：依赖安装、双端 typecheck、krsi conformance 10/10、server 定向 51/51、client 13/13、账本单测级金丝雀 |
| **Step 4** | **6 代闭环已完成** `[实测]`：g1 `skipped` → g2/g3 `improved` → **g4 `not_improved`(1)** → **g5/g6 `improved`(0)**；5 行 v2 anchor 全链 `rsi:verify` exit 0，篡改副本精确打红；`eval` 从 53/126=0.421 → 60/126=0.476 → **75/126=0.595**，`slugify` 由 0/7 修到 7/7。详见 §9.7 |
| 环境 | **已具备** `[实测]`：Go `1.27.2 windows/amd64`（`C:\Users\Admin\sdk\go`，不在 PATH）、Node `v22.22.2`、npm `10.9.7`；前后端依赖已装、`server/.env` 已配（gitignore 忽略）、anchor 账本已生成 |

> 首版曾写「Go 未安装」，是误判：只查了 PATH 与 `C:\Go`、`C:\Program Files\Go` 等常见位置，漏了 `~/sdk/go`。经用户指出后已实测更正。

---

## 1. 今日提交时间线（22 条，`git log --since=2026-11-10 00:00`）

| 时段 | 提交 | 内容 |
|---|---|---|
| 00:11 / 00:26 / 00:43 | `ca479dd` `f99e2a4` `4f48a0e` | 3 次 `feat: update workspace`（工作区快照） |
| 06:46 | `06c5d4f` | 提案工具改为**平铺参数**，修复模型「只检索不提交」 |
| 06:47 | `3e9c75a` | workspace 快照 |
| 06:49 | `6771f08` | 评测资产纳入版本管理，沙箱重置后可重建 |
| 06:49 | `5e93a00` | **安全**：移除脚本中硬编码 API key，改为只读环境变量（但公网 URL 未一并移除，见 §9.1） |
| 06:53 | `17fe797` | RSI 新增 `--auto` 模式，由 Agent 按读数自选修复目标 |
| 06:54 | `b3b30d9` | workspace 快照 |
| 07:36 | `652690a` | 修复两处判据完整性漏洞 |
| 07:38 | `9f1c54c` | **测量轮改为只读探针**，避免提前计入下一代修复 |
| 07:39 | `f7f5714` | 修正两处过期结论（文档） |
| 07:52 | `c0d3c40` | 实时面板真正消费 `task.test_pass_rate` |
| 08:02 | `337863d` | 评测扩题至多文件与有状态套件 |
| 08:08 | `d271b59` | 新增 `csv_import` 套件 |
| 08:34 | `ecb8e65` | 新增 `json_patch` 套件（RFC 6901/6902），分母 **94→110** |
| 08:40 | `2b30bf4` | overview 增结构化评测读数，前端不再解析 `detail` 文本 |
| 09:20 | `74c55dc` | 客户端接入模型中转 + 新增 RSI 判据面板，修复走查问题 |
| 09:23 | `e127160` | 补离线账本校验 CLI `rsi:verify`，复算 evidence/manifest/anchor/链 |
| 09:31 | `2d13748` | 新增 `bank_ledger` 套件（整数分台账语义），分母 **110→126** |
| 09:37 | `fa5d2b7` | **版本锚点 v2**：canonical JSON + 全量证据原像 |
| 09:45 | `6b77855` | Merge PR #1（当前 HEAD） |

---

## 2. 改动范围（74 文件，按职责）

| 区域 | 关键文件 | 作用 |
|---|---|---|
| 证据链 | `server/src/services/rsi/manifest-builder.ts` `rsi-bridge.service.ts` `ledger-verify.ts` `ledger-migrate.ts` 及相关测试 | v2 锚点、证据原像、离线四层复算、v1→v2 版本化 |
| 校验 CLI | `server/scripts/verify-rsi-ledger.ts` `migrate-rsi-hash-version.ts` | `rsi:verify` / `rsi:migrate-hash` |
| 评测 | `server/src/services/eval/{propose,runner,suites}.ts` `eval-propose.tool.ts` `eval-run.tool.ts` | 提案/执行/套件发现；`EvalSuite.files` 白名单 + vm 内 CommonJS loader |
| 评测资产 | `server/eval-fixtures/`（12 个任务目录）`server/eval-suites/slugify_edge_cases.json` | 今日新增 `csv_import` `json_patch` `bank_ledger` 及多文件夹具 |
| 判据 | `server/src/services/judge/{judge.service,eval-rate,replay,types}.ts` `judge.repository.ts` `schema.ts` | 判据完整性、`test_pass_rate` 结构化读数落 `judge_verdicts.data_json`（007 迁移） |
| 客户端 | `RsiDashboardModal.tsx` `lib/rsi-series.ts` `lib/relay.ts` `services/api.ts`、`components/layout/*`、`settings/*`、`tests/rsi-*.test.ts` | RSI 判据面板、时序、模型中转接入、状态栏与设置页 |
| 看板产物 | `server/public/rsi-dashboard.html`、`rsi-code-fix-dashboard.html`、`rsi-dashboard-live.png` | 面板与截图证据（**静态产物，非实时数据源**） |
| 测试 | `server/tests/{closure-drill,eval-proposal,eval-suite,judge-*,rsi-ledger-verify,rsi-overview}.test.ts`、`client/tests/rsi-*.test.ts` | 今日随功能一并落盘；**§9 已实跑定向子集** |

---

## 3. 接手必读的架构（`[文档]`，来源 `server/docs/rsi-loop.md`、`rsi-capability-sedimentation.md`）

### 3.1 闭环与判决权

```
Improve(π) = π --Act--> τ --Judge--> r --Update--> π'
```

`Judge` 是**单代内**判据塔（`CriterionVerdict[]`），`r` 是**跨代**对比结论；`manifest-builder` 把前者翻成 `RsiManifest` 交给 Go 内核 `krsi` 判 R1–R6。**判决权不在模型手里**。

### 3.2 三条不能踩的口径

- Manifest 里 `objective`（目标）必须**严格变好**，`guard`（护栏）只要求**不得变差**。成功率、覆盖率这类有天花板的指标若当目标，R5 会永远否掉真实进步。
- `budget.efficiency` **刻意不进** readings：成本是 L0 闸不是目标，否则「越学越贵」会被判成「越学越差」。
- `basis` 固定 1–5（measured / relayed / estimated / model_says / absent），`absent` 必带 `why_absent`，`relayed` 必带 `source`。

### 3.3 krsi 四态 + bridge 两态

| exit | state | 处置 |
|---|---|---|
| 0 | `improved` | 接受 π' |
| 1 | `not_improved` | 保留 π |
| 2 | `refused` | 点名违反哪条 R 判据，**修 manifest / 判据，不重试** |
| 3 | `undecidable` | 量不到；补证据或降级 skipped |

其他 exit code = bridge 自身故障。另有 `skipped`（首次运行无 prev Manifest，不 spawn krsi）与 `error`（spawn 失败 / 10s 超时 / 解析失败）。**失败不阻断主流程**。本次实测 `krsi` 用法签名：`krsi <上一代.json> <这一代.json> <报告.txt> <账本.jsonl>` `[实测]`。

### 3.4 证据链：v1 / v2 混排

- 每代向 `<dbDir>/rsi/<sessionId>-anchors.jsonl` 只追加一行，与 krsi 私有 metric 行**严格分离**。
- v1 原像 = `JSON.stringify` 固定键序；**v2** = canonical JSON（键字典序、紧凑、无时间戳/随机数/绝对路径）+ 行内 `evidence` 全量原像 + `evidence_hash` + `prev_manifest_hash`。
- **缺 `hash_version` 一律按 v1 解释**，历史账本不改写、不重签；`rsi:migrate-hash` 只补标记（默认 dry-run，`--apply` 才写），不改变 `anchor_hash`。
- `rsi:verify` 复算 **evidence → manifest → anchor → 链** 四层，并校验 `prev_anchor_hash` 衔接与代数严格递增。§9.3 已实测该链路可验真、可验伪。

### 3.5 能力沉淀的两条读数

`capability_reuse_ratio`（目标，按**不同工具数**算）+ `tool_lifecycle_score`（护栏，只许不变差）。工具是义肢：`tmp/tools/<sessionId>/` 任务结束必删（孤儿闸），显式晋升才进 `.codelens/tool-library/`；`tool_removed` 必须与 `lesson` 配对（沉淀配对闸）。

### 3.6 看板契约 `GET /api/rsi/overview?session=<id>`

顶层新增 `eval` 对象（`runId / status / score / passed / total / denominator / suites[] / source`），既有字段一个没删。`source: "detail_only"` 表示 007 迁移前的旧行：此时 `passed/total/denominator` 为 `null`，**前端必须退回解析 `detail`，不要把 null 画成 0**。

---

## 4. 命令速查（`[核实]`，§9 已实跑）

```bash
# 在 server/ 目录下
npm ci
npm run typecheck                       # tsc --noEmit
npm test                                # vitest run && npm run test:krsi
npm run test:krsi                       # 现为跨平台脚本，见 §9.1
npm run rsi:verify -- <sessionId> [--dir data/rsi] [--db data/codelens.db]
npm run rsi:migrate-hash -- <sessionId> [--dir data/rsi] [--apply]
npm run rsi:auto / rsi:code / rsi:propose
```

**Windows 要点（已修）**：`krsi-conformance.ts:27` 与 bridge 默认找 `/tmp/krsi`（POSIX 约定），`runtime.ts:214` 只在显式设置 `KRSI_BIN_PATH` 时才把它传给 `RsiBridgeService`。新增的 `run-krsi-conformance.mjs` 会自动定位 Go、把二进制编译到 `%TEMP%/krsi.exe` 并注入该变量；手动起 server 时仍需显式设置。

`rsi:verify` 退出码：`0` 全链通过 / `1` 篡改、断链、证据不一致或环境问题 / `2` 参数或账本文件缺失 / `3` 仅「不认识的 `hash_version`」= 无法判定，**不等于篡改**。

---

## 5. 历史实测数据（`[文档]`，本次**未复跑**，勿当作 §9 的今日验收结果）

| 证据 | 数据 | 出处 |
|---|---|---|
| 三代「造工具」会话 `d8253d55…` | g1 复用率 0 / 护栏 0.75 → `skipped`；g2 0.5 / 0.667 → **`not_improved`**（R5 点名护栏变差）；g3 1.0 / 0.667 → **`improved`** | `rsi-capability-sedimentation.md` §4.1 |
| 饱和不伪造进步 | 另一会话 g2 复用率到 1.0，g3 判 **`undecidable`**，内核写明「应扩任务空间而不是改判据」 | 同上 §4.4 |
| 归因写回 π | g2 判 `not_improved` 后归因器产出点名指标的经验，落 `policy_versions` v13，v14 保留 → 已并入 π' | 同上 §4.3 |
| 评测分母演进 | 17/52=0.327 → 33/94=0.351 → 38/110=0.345 → **43/126=0.341**（分母扩大 142%） | 同上 §7.4 |
| 变异体验证 | CSV 6/6、JSON Patch 6/6、bank_ledger 11/11 被隐藏集杀死，且每个变异体公开用例全绿 | 同上 §7.4 |
| 锚链金丝雀（历史） | 对 `c23c9a03…` 账本全链通过；把副本 `verdict` 改成 `improved` 后两行报 `anchor_hash_mismatch` | `rsi-loop.md` §6.1 |

判据底座：`强化Agent.txt` 的 C1 中心性 / C2 闭环 / C3 自证 / C4 不外推，判据塔 L0–L3「低层不能替高层签字」；`产品宪法补丁.md` 把它落到开发判据。**这两份是草案/宣言，不是已通过验收的结论。**

---

## 6. 已知边界与未完成

1. **环境已不再是障碍** `[实测]`：§9.1 已固化。Go 不在 PATH 的问题由新脚本的 `GO_BIN → PATH → ~/sdk/go` 探测解决；`KRSI_BIN_PATH` 由脚本注入；`server/.env` 已配且被 `.gitignore:6` 忽略；`npm ci` 已装。手动起 server 时记得带 `KRSI_BIN_PATH`。
2. **分母变了必须另起一条链** `[文档]`：52→94→110→126 每次扩题都要用**新会话从 g1 起算**，不能接在旧分母的链后。§9.3 的会话即为 126 分母新链。
3. **上游已换新地址并恢复，不再是未决项** `[实测]`：旧中继 `1.92.92.200` 于 18:29–18:33 连续 502 `upstream connect failed`；18:58 用户改指 `http://1.92.150.5:8787/v1`，`/v1/models` 200 且含「平衡」、最小 chat completion 200 / 0.98s。旧 IP 已在 8 个文件中全量替换（§9.6）。**#6 已于 19:08 接续同链补齐 g3/g4**，现在是 4 代完整对账。
4. **~~`eval-suite.test.ts` 在干净检出下会红~~ 已修复（18:32）** `[实测]`：根因是 `evalPassRateGate` → `runEvalBattery(config.sandboxRoot)`，若 `server/workspace/eval/` 为空则 `battery.total=0` → 按 C4 记 `unexec`。现已在 `tests/eval-suite.test.ts` 的 `task.test_pass_rate` describe 加 `beforeAll`，复用文件内现成的 `FIXTURES_DIR` / `copyDir` **只补缺失、不覆盖已有实现**（保护 Agent 修好的 53/126 读数）。验证见 §9.5。
5. **能力库是会话级** `[文档]`；**护栏生涯口径记旧账** `[文档]`；**客户端超时已从 180s 提到 600s**（不是 RSI 逻辑问题，但会污染读数）`[文档]`。
6. **未覆盖题型** `[文档]`：异步/事件驱动、真实仓库级多文件重构、依赖外部服务的行为。
7. **今日安全改动别回退** `[核实]`：`5e93a00` 移除硬编码 API key；§9.1 又移除了 `seed-agent-loop.ts:402` 残留的硬编码公网地址。`client/src/lib/relay.ts` 的 44 个模型快照是静态候选，不冒充实时列表。**上游为 `http://` 明文 + 公网 IP，密钥已在对话中明文出现，建议轮换。**
8. **看板 HTML / PNG 是静态证据** `[核实]`，不是实时数据源；三份产物需人工确认是否同源、是否过期。
9. **11-06 遗留待决策项，今天未处理** `[核实]`：依据是今日 74 个改动文件中不含 `electron-builder.yml`、`checkpoint.service.ts`、`run-state.service.ts`、`loop-budget.ts`。四项为：① 安装包代码签名；② 撤销是否也删 `sys.exec mv` 产生的 rename 产物；③ live 预算验收缺真实上游 Key；④ `context_full` 汇报卡「异常终止」标签去重。另有 `docs/review-20261105/architecture-2026-11-05.html` 架构图未按后续改动更新。
10. **`产品宪法补丁.md` 状态为「补丁草案」** `[核实]`，尚未拍板。

---

## 7. 复现步骤（§9 已全部执行，此处留作手册）

1. `npm ci --prefix server && npm ci --prefix client`（本轮未复现 11-06 担心的 lockfile 不同步）。
2. 复制 `.env.example` → `server/.env`：`AGENT_DB_PATH`、`SANDBOX_ROOT`、`CHECKPOINT_ENABLED`；连上游需 `LLM_SERVER_API_KEY` + `TRIAL_MODE_ENABLED` + `TRIAL_BASE_URL` + `TRIAL_MODEL`，**另加** `DEEP_ASSESSOR_BASE_URL` + `DEEP_ASSESSOR_MODEL`（`agent-loop.service.ts:1426` 的 `hasCreds` 要求 key/baseUrl/model 三项齐全，只配 `TRIAL_*` 会让归因器静默跳过，r → Update 断环）。**密钥只走环境变量，不落仓库。**
3. `npx tsc --noEmit` 双端。
4. `npm run test:krsi`（10 条内核对抗用例）。
5. 沙箱夹具：`eval-suite.test.ts` 现在会自己补齐缺失项（§6.4）；跑 seed 脚本的 `--code/--auto` 时 `syncEvalFixtures()` 同样会补。该目录已被 `.gitignore:27/72` 忽略。
6. RSI 定向测试：`npx vitest run tests/rsi-ledger-verify.test.ts tests/rsi-manifest-builder.test.ts tests/rsi-overview.test.ts tests/eval-suite.test.ts`；client 侧 `rsi-dashboard.test.ts` / `rsi-series.test.ts`。
7. 起 server 后跑 `node --import tsx scripts/seed-agent-loop.ts 4 --code`，再 `npm run rsi:verify -- <sessionId>`；用篡改副本验金丝雀。
8. 拍板 §6 第 9 条的 4 个遗留待决策项，并决定 `产品宪法补丁.md` 是否并入宣言。

---

## 8. 本文的事实来源

- `[核实]`：`git log`/`git status`、目录与体积扫描、三个 `package.json`、`.env.example`、`client/src/lib/relay.ts`、`krsi/go.mod`、`env.ts` / `runtime.ts` / `judge.service.ts` / `registry.ts` / `agent-loop.service.ts` 中的配置与凭证映射、`seed-agent-loop.ts` 参数解析、`eval-rate.ts`。
- `[实测]`：§9 全部命令与产物——`go version` / `go env` / `go build`、`npm ci`、`tsc --noEmit`、`npm run test:krsi`、vitest 定向、`/api/health`、`/v1/models` 冒烟、`seed-agent-loop.ts 4 --code`、`rsi:verify` 正本与篡改副本、DB 表计数。
- `[文档]`：`server/docs/rsi-loop.md`、`rsi-capability-sedimentation.md`、`HANDOVER-2026-11-06.md`、`强化Agent.txt`、`产品宪法补丁.md`、`verify-rsi-ledger.ts` 头部契约。
- **本次未做**：全量 `npm test`（server 全量约 13 分钟）、npm build、桌面端打包、真实浏览器双标签页实时检查；`docs/` 与 `agent-decisions/` 下的既有文档均未改动。

---

## 9. 验证执行记录（Step 0–4，2026-11-10 16:5x–17:4x）

> 用户确认的三项前提：模型名「平衡」、密钥写 `server/.env`、跑完整多代闭环。本节全部为真实执行 `[实测]`。

### 9.1 改动清单（6 个文件）

| 文件 | 改动 |
|---|---|
| `server/scripts/run-krsi-conformance.mjs` | **新增**。跨平台编译 krsi → 输出 `os.tmpdir()/krsi[.exe]` → 以 `KRSI_BIN_PATH` 注入 conformance；Go 解析顺序 `GO_BIN → PATH → ~/sdk/go → 常见位置`，找不到即快速失败 |
| `server/package.json` | `test:krsi` 从硬编码 `go build -C krsi -o /tmp/krsi . && ...` 改为调用新脚本 |
| `package.json` / `client/package.json` | engines `>=20.19` → `>=22.5.0`，与 server、Dockerfile `node:22-alpine` 一致 |
| `server/scripts/seed-agent-loop.ts` | `customBaseUrl` 移除硬编码公网地址，改从 `RSI_BASE_URL ?? TRIAL_BASE_URL` 读取（`5e93a00` 当时只清了 key，没清 URL；与 `env.ts:132`「源码不硬编码任何试用地址」口径对齐） |
| `server/.env` | **新增，被 `.gitignore:6` 忽略**。6 项上游配置 + 本地 DB / 沙箱 / 快照 / 超时；不含任何密钥明文于本文档 |

### 9.2 Step 0–3 门禁

| Step | 结果 |
|---|---|
| 0 | `git check-ignore server/.env` → `.gitignore:6:.env` 命中；`process.loadEnvFile` 能解析中文模型名；三处 engines 一致；上游 `/v1/models` **HTTP 200** 且列表含「平衡」 |
| 1 | `npm ci --prefix server` 176 包 / 43s、`--prefix client` 206 包 / 1m，均 exit 0；双端 `npx tsc --noEmit` **exit 0** |
| 2 | `npm run test:krsi` **10/10 通过，exit 0**：真改进 / 护栏天花板 → improved，自评变好 / 护栏退步 → not_improved，改判据 / 删指标 / 伪造哈希 / 改写历史 → refused，量不到 / 目标饱和 → undecidable。新脚本自动定位 `C:\Users\Admin\sdk\go\bin\go.exe` 并编译 `krsi.exe` |
| 3 | 首跑 server 4 文件 51 例**1 红**（见下）；补齐夹具后 **51/51**；client **13/13**；`rsi-ledger-verify.test.ts` 的 `anchor_hash_mismatch` / `chain_break` 破坏夹具通过 |

**Step 3 红灯与根因**：`eval-suite.test.ts > task.test_pass_rate 判据 > 调用过 eval.run → 产出可计分的判据` 得 `unexec`。`evalPassRateGate` 调 `runEvalBattery(config.sandboxRoot)`，干净检出下 `server/workspace/eval/` 为空 → `battery.total = 0` → 按 C4 诚实记 `unexec`。**环境前置缺失，非代码回归**。执行 `seed-agent-loop.ts:624` 等价的 `syncEvalFixtures`（16 个夹具复制到 `workspace/eval/`）后复跑 51/51 绿。该目录已被 `.gitignore:27/72` 忽略，未污染仓库。缺陷本身登记在 §6.4。

### 9.3 Step 4 真实上游闭环

- 会话 `23ae700c-b517-47ef-b85f-675752b05579`，`--code` 模式，126 分母新会话 g1 起算，目标 4 轮，脚本耗时 **25m22s**、exit 0。
- server `/api/health` 200：DB 23/23 表、sandbox 可写；`AGENT_APPROVAL_SECRET` 留空 → 自动生成 0600 主密钥于 `server/data/approval-secret.key`（被忽略）。
- Judge 4 次：`run#1 fail 0.800` / `run#2 inconclusive 1.000` / `run#3 fail 0.600` / `run#4 inconclusive 1.000`；`judge_runs=4`、`judge_verdicts=52`。
- **RSI 代际只有 2 代**：`g1 skipped`（无上代 manifest）、**`g2 improved` exit=0**。`exit_code=0` 证明 krsi 真被 spawn 且给出四态判决，不是 `verdict=error`。
- `policy_injections=2`、`policy_versions=1` → 归因经验写回 π'，**r → Update 这一环未断**，六项配置里的 `DEEP_ASSESSOR_*` 确实生效。
- anchor：`server/data/rsi/<sid>-anchors.jsonl` 1 行，g2、`hash_version=2`、canonical JSON，`chain=✓`，链头 `856bc90ccc67…`。
- `npm run rsi:verify -- <sid>` → **exit 0**：`v2(canonical)` 口径，evidence → manifest → anchor → 链 四层全一致。
- **篡改金丝雀**：复制账本、把 anchor 的 `verdict` 改成 `not_improved` → **exit 1**，精确报 `evidence_preimage_mismatch`（证据原像外层还是 `improved`）+ `anchor_hash_mismatch`（重算 `b6515ecf…` ≠ 落盘 `856bc90c…`）。副本已清理。
- **UNEXEC 边界（C4）**：第 3、4 轮干活轮遭上游限流/熔断，各退避重试 4 次后失败，**未产生 g3/g4 代际判决**。目标 4 轮 ≠ 完成 4 代；现有可采信证据是 g1→g2 这一条完整、可验真可验伪的链。

### 9.4 遗留登记

1. ~~g3/g4 因上游限流 UNEXEC~~ **已于 19:08 补齐**，见 §9.6。旧地址 502 的时间线记录保留在 §9.5，仅作当时的状态快照。
2. ~~`eval-suite.test.ts` 干净检出会红~~ **已于 18:32 修复**，见 §9.5。
3. 上游 `http://` 明文 + 公网 IP；密钥已在对话中明文出现，**建议轮换**。
4. 全量 `npm test`、npm build、桌面端打包、双标签页实时检查未做。
5. 11-06 四个待决策项与 `产品宪法补丁.md` 草案状态，本轮未处理。

### 9.5 后续推进（18:2x–18:35）

**任务登记**：把上一轮的建议顺序落为 #6 补齐 g3/g4、#7 修测试隔离、#8 拍板 11-06 四项待决策；另加 #9 前端界面同步 RSI、#10 浏览器预览。当前 **#9 / #10 / #7 已完成**，#6 受上游阻塞，#8 待用户拍板。服务按用户要求**保留运行**：`127.0.0.1:8080`（server）、`127.0.0.1:5173`（Vite）。

**#9 前端 URL 直达**：SPA 支持 `?rsi=1&session=<id>` —— `AgentWorkbench.tsx` 的 `rsiOpen` 按参数初始化、`RsiDashboardModal` 优先用 URL 的 sessionId；`App.tsx` 在 `loadList()` 后选中该会话（失败不阻断，面板可独立取数）。原来藏在按钮后面的面板现在打开即见。client `tsc --noEmit` exit 0、RSI 测试 13/13、Vite `/api` 代理实测 200。

**前端真实读数**：`/api/rsi/overview` 返回 `judgeRuns=4`、`rsiRuns=2`、`attributions=2`、`eval = 53/126 = 0.421`（structured，12 套件）。高于历史缺陷起跑线 `43/126 = 0.341`，说明干活轮真修好了部分夹具。

**#7 测试隔离修复**：`tests/eval-suite.test.ts` 的 `task.test_pass_rate` describe 加 `beforeAll`，把版本库夹具补进 `config.sandboxRoot/eval`，**只补缺失、不覆盖已有实现**。三重验证：
- `SANDBOX_ROOT=./data/_clean_check`（全新空目录）跑 `eval-suite.test.ts` → **12/12 绿**，干净检出不再红
- 正常环境 4 文件 → **51/51 绿**，`tsc --noEmit` exit 0
- API 复核 `eval` 仍 `53/126 = 0.421` → 真实夹具未被回退

**#6 当时的阻塞证据（已被 §9.6 解除）**：18:29 一次、18:33 两次最小 chat completion 探活，全部 **HTTP 502 `upstream connect failed: connection timed out`**（约 10s）。按 C4 记 UNEXEC，未硬跑、未伪造代际。

### 9.6 上游换址与 4 代闭环收官（18:58–19:10，本文最终状态）

> 本节取代 §9.3–§9.5 中「g3/g4 UNEXEC」「上游 502 阻塞」等**当时的快照**表述；那些记录保留作为时间线，不代表当前状态。

**地址变更**：用户告知上游换为 `http://1.92.150.5:8787/v1`。探活：`/v1/models` 200（含「平衡」）、最小 chat completion **200 / 0.98s**，旧中继的 502 消失。旧 IP `1.92.92.200` 在 **8 个文件**中全量替换：`server/.env`（`TRIAL_BASE_URL` + `DEEP_ASSESSOR_BASE_URL` 两处）、`client/vite.config.ts`、`config/modelsync.json`、`client/.env.example`、`server/start.sh`、`client/src/lib/storage.ts`、`server/scripts/seed-agent-run.ts`、`client/src/components/settings/ProviderZone.tsx`（placeholder）。Grep 全仓 `1.92.92.200` **0 命中**。`seed-agent-loop.ts` 上一轮已改为读环境变量，无需再改；`.env.example` / `deploy/codelens.env.example` 保留 `127.0.0.1` 本地示例，未改。
双端 `tsc --noEmit` exit 0；Vite 配置变更自重启后仍 200；**后端已重启**让新 `DEEP_ASSESSOR_BASE_URL` 生效（该值启动时读入，只改 `.env` 不重启不会生效，是本次最容易踩的坑）。

**#6 补齐（7m30s）**：`node --import tsx scripts/seed-agent-loop.ts 2 --code --session=23ae700c-…`，用 `--session=` 接续同一条链，分母仍 126、代际可比，未重开会话。

| 代 | 判决 | exit | 理由 |
|---|---|---|---|
| g1 | `skipped` | – | 首次运行，无上代 manifest |
| g2 | `improved` | 0 | — |
| g3 | `improved` | 0 | — |
| g4 | **`not_improved`** | 1 | `R5: 目标指标 "test_pass_rate" 没变好（0.476 → 0.476）` |

**g4 被拦下是本轮最有价值的结果**：判据不是永真闸。目标没变好就判 `not_improved`，并触发归因器写出点名用例族的经验（`slugify 0/7`、`to_roman 1/9`、`parse_query 2/8`、`parse_kv 3/8`），r → Update → π' 真的闭环，而不是一路绿灯的表演。

**最终证据**：
- `rsi:verify` **exit 0**：3 行 v2 anchor、代数 `[2,3,4]`、canonical JSON，evidence → manifest → anchor → 链 四层全一致；链头 `c291af0c44b8…`
- 篡改金丝雀（把 g3 的 `verdict` 改成 `not_improved`）→ **exit 1**，报 `evidence_preimage_mismatch` + `anchor_hash_mismatch`（重算 `a775bde9…` ≠ 落盘 `112e3d1e…`）；副本已清理
- DB：`policy_rsi_runs` 4 行、`policy_injections=3`、`policy_versions=3`、`judge_runs=8`、`judge_verdicts=104`
- 前端 `/api/rsi/overview` 同步：`judgeRuns=8`、`rsiRuns=4`、`attributions=3`、`eval = 60/126 = 0.476`（structured，12 套件）；较本轮起点 `43/126 = 0.341`、接续前 `53/126 = 0.421` 均提升
- 一共 8 次 Judge 判决；服务按用户要求保留运行（8080 / 5173），浏览器面板点刷新即可看到 4 代数据

**仍待办**：#8 四项待用户拍板（安装包签名 / 撤销是否删 rename 产物 / live 预算验收 / `context_full` 标签去重）；#11 π' 注入对照实验（见 §9.7）。

### 9.7 `--auto` 判决性实验：修掉调度开环（19:15–19:25，本文最终状态）

**问题定位**：`--code` 模式用 `CODE_TASKS[i % 11]`，而主循环的 `i` 每次进程启动都从 0 重置，因此 `--session=` 接续时又从 `bank_ledger` / `inventory_rollup` 开始，**重复修已修好的套件**，后 9 个套件（含 `slugify`）从未被点名。核查证据：`workspace/eval/slugify/impl.cjs` 与 `eval-fixtures/slugify/impl.cjs` 逐字节一致；题面（`suites.ts:55–65`）规范完整、实现只做 `\s+→-` → `slugify 0/7` 是「没被点名」，不是「修不动」。这正是 C2 的开环：归因器把「该修 slugify 0/7」写进 π'，但下一轮 Act 的调度不读 π'。

**实验**：改用今天 06:53 `17fe797` 加入、此前从未使用过的 `--auto`（`AUTO_TASK`：先 `eval.run` 拿失败列表 → 挑通过率最低的一个 → 只修一个 → 复验），接续同一条链跑 2 轮（3m21s）。分母仍 126、代际可比。

| 代 | 判决 | exit |
|---|---|---|
| g1–g4 | `skipped` / `improved` / `improved` / **`not_improved`** | – / 0 / 0 / 1 |
| **g5** | **`improved`** | 0 |
| **g6** | **`improved`** | 0 |

**结果**：
- `slugify` 被 Agent 改成标准三段实现（`toLowerCase` + `[^a-z0-9]+ → -` + 去首尾 `-`），**7/7 满分**
- `eval` **60/126 = 0.476 → 75/126 = 0.595**（12 套件）；`judgeRuns=12`、`rsiRuns=6`、`attributions=3`、`policy_injections=3`、`policy_versions=3`
- `rsi:verify` **exit 0**：5 行 v2 anchor、代数 `[2,3,4,5,6]`，四层全一致；链头 `414dc42f…`

**诚实边界（C4，不可外推）**：本实验证明的是「**读数驱动选目标**能解除固定轮换造成的开环」，**没有证明 π' 注入（`policy_injections` 的归因文本）被模型读进 prompt 并影响决策**。`--auto` 的选目标依据是实时 `eval.run` 失败列表，与 π' 指向同一套件，两者共线、无法区分。要钉死需做对照实验：禁用或篡改 π' 注入后跑 `--auto`，或检查 `getInjectableView()` 的实际注入证据。登记为待办 #11。

**工程结论**：`--code` 的接续逻辑有缺陷（`i` 未按已有代际对齐），建议修；但更关键的是**默认走 `--auto`**，让读数而非固定下标决定 Act。

### 9.8 #11：π' 注入链路核验（19:41–19:50，本文最终状态）

**问题**：§9.7 的 `--auto` 实验里，读数驱动（`AUTO_TASK` 先 `eval.run` 挑最低分）与 π'（`policy_injections` 归因文本）指向同一套件，两者共线，无法区分 `r → Update → π' → 下一次 Act` 是否真的闭合。

**机械链路（已证）**：
1. DB 实测 `policy_versions` **v3** 的 `policy_json.lessons` 含归因经验「test_pass_rate 卡在 0.476…slugify 0/7…」，且 v3 写于 g4 `not_improved` 之后、g5/g6 之前。
2. `agent-loop.service.ts:653` 每 run 调一次 `getInjectableView()`；`:657` 生成 `policyForPrompt`；`:688` 传入 `buildSystemPrompt(req.taskKind, policyForPrompt)`。`:650` 的不变量要求 `recordInjections` 与 prompt 吃**同一个数组**，否则 `lessonEffectiveness` 的 `injected` 会系统性失真。
3. `insight.ts:7` 那句「一个没有任何出口的 `getInjectableView()`」是**洞察视图出现之前的历史描述**；`judge.controller.ts:207` 已有出口，不是「没进 prompt」。
4. 回归闸 **20/20 全绿**：`update-closed-loop.test.ts` 6 例（含「applyUpdate 写入经验后，下一轮 Act 的 system prompt 包含该经验」「回滚后不再读到被回滚的经验」）、`judge-policy-loop.test.ts` 12 例、`closure-drill.test.ts` 2 例（「第 1 轮失败产出 π，第 2 轮读到 π′ 并注入经验」「同一会话第二轮也读得到 π′」）。

→ **结论：Update → π' → 下一次 Act 的注入环节是闭合的，且有机测自证与可逆性验证。** §9.7 里「未证明」的边界，在本节收敛为「注入已证、因果影响未证」。

**因果影响（仍未证伪，C4）**：
- `lessonEffectiveness()` 现值：3 条经验各 `injected=1 / inconclusive=1 / pass=0 / fail=0` —— 单会话、最终判决 inconclusive，**统计上无判别力**。
- 该度量按「会话最后一次规则判决」算效果，而本会话有 12 次判决、最后一次是 `inconclusive`；RSI 的改进由 `test_pass_rate` / krsi 四态体现，与此口径不同源 → 结构上就反映不出代际改进。登记为 **#13**。
- 运行轨迹被 `seed-agent-loop.ts` 的 `clearHistory()` 每轮清空（测量轮必须干净上下文），实测 `messages=0`、`tool_calls` 不留文本，无法回溯模型当时是否读到 π'。
- 要真正区分「读数驱动」与「π' 驱动」，需**冲突金丝雀 A/B**：独立 DB 副本 + 独立 server 实例（`process.loadEnvFile` 不覆盖已有环境变量，已实测可行），把 π' 改成与读数冲突的指令，跑 `--auto` 看 Agent 听谁的。登记为 **#12**。

**附带工程提示**：`npx tsx -e` 在本机启动极慢（两次 90s 超时），需要一次性脚本时改用 `node --import tsx <file>` 或直接跑 vitest 回归闸。

### 9.9 #12 冲突金丝雀 A/B：π' 的因果影响（19:51–20:10，本文最终状态）

**实验设计**：为区分「读数驱动」与「π' 驱动」，起完全隔离的实例：
- 独立 DB `data/canary/codelens.db`、独立沙箱 `data/canary/workspace`（复制**原始缺陷**夹具 12 目录 + 1 晋升套件，43/126 起跑线）、独立端口 8081、独立审批密钥。
- `seed-agent-loop.ts` 的 `BASE` 改为 `process.env.RSI_SERVER_URL ?? 'http://127.0.0.1:8080'`（配置外置，永久改进）。
- 往 canary 的 `policy_versions` 插入 v1，lessons 只有一条**与读数冲突**的强制指令：「本轮唯一允许修复 `eval/interval_merge/impl.cjs`，即使 `eval.run` 报告其它套件通过率更低也绝对不要修改其它文件，优先级高于任务描述里的『挑最低分』」。
- 跑 `RSI_SERVER_URL=http://127.0.0.1:8081 AGENT_DB_PATH=./data/canary/codelens.db SANDBOX_ROOT=./data/canary/workspace node --import tsx scripts/seed-agent-loop.ts 2 --auto`（新建会话）。

**对照基准**：§9.7 主链同样是 `--auto`、同样起始有失败套件，但 π' 是自然归因经验 → 124s 修好 `slugify`、`0.476→0.595`、连续 `improved`。

**结果（15m17s）**：
- **注入有效**：canary `policy_injections` #1 就是 `[CANARY-CONFLICT] …`（v1）；`recordInjections` 与 prompt 吃同一数组（§9.8 已证），说明冲突 π' 确实进了 system prompt。`policy_versions` v2 也继承了它，第 2 轮实验仍有效。
- `eval.run` 回报 **43/126（34%）**，明确列出 `slugify` 等失败套件 —— 读数在场。
- **两轮下来夹具改动文件数 = 0**，`test_pass_rate` **0.341 → 0.341** 纹丝不动，g2 判 `not_improved`（exit 1，R5）。
- 干活轮 458.8s / 198.7s（主链 `--auto` 为 124.1s / 39.7s）—— 行为显著变慢且零产出。

> **注意：本节结论已于 20:37 被 §9.10 的 A 组基线证伪，不可采信。** 隔离实例本身存在 600s 超时故障，零产出与 π' 无关。以下保留原文仅作实验记录。

**当时的结论（已作废，C4 口径）**：
- `r → Update → π' → 下一次 Act` **存在因果影响**：π' 进 prompt 后，Act 与对照组显著不同（有产出 → 零产出）。§9.8 留的「因果影响未证」由此收窄为「**因果已证，方向未必正向**」。
- **但不能说 π' 被采纳**：Agent 既没按读数修最低分套件，也没按 π' 修 `interval_merge`，而是停摆。这是**指令冲突导致的负向干预**，不是策略执行。
- **暴露的工程风险**：归因经验若写成强制口吻、与任务指令的选目标规则冲突，会让 Agent 卡死。真实的 `policy#3` 是建议口吻（「下轮应优先…」），强度低得多，**不能把本次结果外推到真实 π'**。
- **单样本局限**：只跑了一次 2 轮实验，且构造的是极端措辞。要贴近真实需做「弱冲突」对照（π' 建议修 X、读数指向 Y，看模型选谁且仍能产出）→ 登记 **#14**。

**隔离核验与清理**：主链 `rsi:verify` 仍 **exit 0**（5 行 anchor、代数 `[2,3,4,5,6]`）、`rsiRuns=6`、`eval=75/126=0.595` 未变；canary server 已停、`data/canary/` 已删、8080 主服务保留。汇总里的 `ledger 读失败 ENOENT` 是 seed 脚本汇总段硬编码 `ROOT/data/rsi`、而 canary 账本写在 `data/canary/rsi` 所致，仅影响显示，不影响判定。

**当前待办**：#8 四项待拍板、#13 `lessonEffectiveness` 口径、#14 弱冲突对照。

### 9.10 A 组基线：证伪 §9.9（20:20–20:37，本文最终状态）

**动机**：§9.9 把「零产出」归因于 π' 冲突，却没有排除替代解释——**隔离实例本身写不进去**。按 C3 自证要求补一组中性 π' 基线：环境与 #12 完全相同（独立 DB / 独立沙箱原始缺陷夹具 43/126 / 端口 8081 / 独立审批密钥），唯一差异是**不插任何 `policy_versions`**（`getInjectableView()` 返回 EMPTY_POLICY，注入 0 条）。

**结果**：
- 第 1 轮干活轮 **600.7s**，正好撞上 `postStream` 的 `req.setTimeout(600_000)` 上限
- 夹具改动数 **0**，`tool_calls = 0`（连一次工具调用都没有）
- 主链同样 `--auto`（§9.7）：124.1s / 39.7s，修好 `slugify`、`0.476→0.595`

**判定**：π' 为空时隔离实例同样零产出且撞超时 → **零产出是隔离环境的系统性故障，不是 π' 造成的**。§9.9 的「π' 有因果影响」「强制口吻导致停摆」两条结论**全部作废**；`r → Update → π' → 下一次 Act` 的**注入环节**仍由 §9.8 机械证据成立，**因果影响回到「未证」**。

**未定位的根因（C4，不外推）**：可能是第二实例与主实例共用同一上游 Key 触发并发排队、`postStream` 600s 超时、或 canary 沙箱路径/审批差异；没有日志证据能区分，不做断言。要继续弱冲突对照，必须先让基线组跑出正常产出 → 登记 **#15**。

**收尾**：A 组已中止（第 2 轮不再跑）、canary server 已停、`data/canary/` 已删；主链 `rsi:verify` 仍 **exit 0**（5 行 anchor / 代数 `[2,3,4,5,6]`）、`rsiRuns=6`、`eval=75/126=0.595`；8080 / 5173 保留。

**本轮顺带完成 #8-④**：`run-state.service.ts:271` 改为 `context_full` 用「上下文已满」、其它 `error/aborted` 仍用「异常终止」，保持 `triggers` 非空以免 `hasMaterialChange=false` 让整张汇报卡消失；`run-state.test.ts` 加正反两条断言，**11/11 通过**、`tsc` exit 0。#8 剩 ①②③ 待拍板。

**当前待办（最终）**：#8（①②③）、#13 `lessonEffectiveness` 口径、#15 修隔离实例 600s 超时（#14 弱冲突对照在其之后）。

### 9.11 联网检索驱动的评测能力改进（21:00–21:20）

完整报告见 `docs/agent-rsi-eval-improvements-2026-11-10.md`（含来源、发布时间、一手/二手标注、采纳与不采纳理由、受影响范围、验证数据）。

摘要：检索 RSI-Exam（2026-08-28）、Terminal-Bench 4.0（2026-08-28）、Anthropic《Demystifying evals for AI agents》（2026-01-09）等，统一落地 4 项**纯增量**改进——① 评测集指纹（规范化 SHA-256，跨 5 层透传）② 机械失败分类 `public_fail / hidden_only / suite_error / passed` ③ 采样数与 `reliability: unmeasured` 诚实标注 ④ 配置一致性自检 `npm run check:config` + seed 汇总「基础设施噪声」行。

**未改**：分母 126、判据口径、`criteria_sha256`、`RsiManifest` 映射、anchor 证据原像、DB 历史行、主链 6 代。新字段从下一次判据运行生效，历史行返回中性缺省（`fingerprint=null` / `failureKinds={}`），不回写以免篡改证据。

**验证**：server 全量 **112 文件 / 1114 测试**、client 全量 **13 文件 / 83 测试**、krsi **10/10**、双端 `tsc` 0、`check:config` 0、`rsi:verify` 仍 exit 0（5 行 v2 anchor）、`/api/rsi/overview` 读数仍 `75/126=0.595`，无回归。

---

## 10. 规则口径勘误登记（2026-11-10 晚，追加，不改写正文）

> 本节为**文末追加**，正文 §0–§9 一字不改。本文是状态快照，历史语义不重写，勘误仅供后续接手；
> **以 `server/docs/rsi-rules-contract.md` 为现行准绳**，实现终裁仍为 `server/krsi/main.go`。
> 下文 `main.go` 行号均指 `server/krsi/main.go`。

| # | 勘误项 | 本文正文的旧表述 | 勘误（以内核为准） | 依据（源码行号） |
|---|---|---|---|---|
| C1 | R1–R6 编号含义 | §3.1 只写「判 R1–R6」；`server/docs/rsi-loop.md` 旧 §4 的编号整体错位（旧 R2 写成「指标可比较」、旧 R3 写成「证据充分性」、旧 R4 写成「单调性」、旧 R5 写成「同名对比较」、旧 R6 写成「无回归闸」） | 正确编号：R1 schema 合法 / R2 判据集锚定 / R3 防删指标 / R4 产物哈希 / **R5 严格比较** / R6 同代唯一；且实际执行顺序为 R1→R2→R3→R4→R6→R5（R6 在 R5 前），编号顺序 ≠ 执行顺序 | `main.go:78`（criteriaDeclared）、`:214-243`（R1）、`:245-264`（R2）、`:266-283`（R3）、`:285-308`（R4）、`:310-337`（R6）、`:344-435`（R5 比较）、`:463-495`（执行顺序）；文档准绳 `server/docs/rsi-capability-sedimentation.md:196-205` |
| C2 | basis 必带字段 | 本文 §3.2 第 3 条写「`relayed` 必带 `source`」（同源错误见 `server/docs/rsi-loop.md:69,108` 与 `server/src/services/rsi/manifest-builder.ts:12`） | **必带 `source` 的是 `basis=4 (model_says)`，不是 `relayed(2)`**；`basis=5 (absent)` 必带 `why_absent`；`basis=2 (relayed)` 无必带字段 | `main.go:232-237`（`:232-233` 校验 basis=4 的 source，`:235-236` 校验 basis=5 的 why_absent，全文无 basis=2 的 source 校验） |
| C3 | `budget_efficiency` 不进 readings | `server/docs/rsi-loop.md` 旧 §4 的 R6 举例把 `budget_efficiency` 当作 `direction=down` 的读数 | `budget.efficiency` **刻意不进 readings**，不作任何规则的读数举例；内核只消费 `Manifest.readings` 中实际存在的指标，不凭空引入该指标 | `main.go:63-71`（Manifest 结构，readings 是唯一读数来源）、`:359-408`（compare 只遍历 readings 中的 metric）、`:603-611`（countMeasured 只数 basis 1–3 的 readings）；`server/src/services/rsi/manifest-builder.ts:70-73`（METRIC_MAP 无该条目）、`server/docs/rsi-loop.md:58`（同文已写明不进 readings） |

**声明**：以上三处均为**口径勘误**，不改写本文 §0–§9 的任何历史语义与实测数据；本文是 2026-11-10 下午的状态快照，历史语义不重写，勘误仅供后续接手。现行准绳为 `server/docs/rsi-rules-contract.md`，实现终裁为 `server/krsi/main.go`；`强化Agent.txt` / `产品宪法补丁.md` 仍为草案，不作机械判定依据。

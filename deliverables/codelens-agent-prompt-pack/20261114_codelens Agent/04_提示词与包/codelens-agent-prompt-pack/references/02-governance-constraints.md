# 02 · CodeLens 治理硬约束

> 信源：S1 `AGENTS.md`（§2、§3）；S1 `docs/agent/CODELENS-MANUAL.md`（§7.2/§7.3/§7.4/§7.5/§7.6/§9/§10）；S1 `docs/agent/HANDOFF-2026-11-14.md`（§3/§4/§7）（访问日期：2026-11-14）
> 补充核实（本机只读实跑）：`docs/agent/spec.md`（§10、§11）、`server/self-upgrade/tasks.json`、`.self-upgrade/baseline.json`、`server/scripts/auto-adopt.ts`（目录清单核实存在）、`00_关键词解析/领域解析卡.md`（§3 版本冲突全表、§4 用户画像）、工厂规范 `04-信源分级与不编造规则.md`（§四、§六）（核对日期：2026-11-14）
> 适用版本：spec v2.0 契约 / 手册 v2.20.0 运行态 / 核实日期 2026-11-14；版本差异处已分列/标注
> 核实状态：已核实（逐条对照一手文件 + 坊主 2026-11-14 工具数事实裁定已并入）；活读数一律标锚点，不写成规范
> 覆盖体系表编号：§1 B1 / B3 / B4 / B5 / S1；L1-2 / L1-5 / L1-6；L2-3 / L2-4 / L2-6 / L2-8 / L2-9；L3-2 / L3-3 / L3-6；冲突 C3 / C4；W4（依据 `02_能力体系/三级能力体系表.md` §1、§5）
> 待核实项：5 处，见文末《待核实清单》

---

## 0. 用法

这份文件只写「不许做什么」和「怎么证明自己没做」。每张表三列：**约束 / 违反后果 / 可验证的合规动作**。执行 Agent 派单前逐行核；人侧决策者按第 9 节清单验收。编号 G1–G30 供提示词交叉引用。

`AGENTS.md:3` 先定调：「本文件是仓库级操作约定；权限与执行边界仍由运行时与 `docs/agent/spec.md` 决定，本文件不扩大任何权限。」治理约束不替代契约，只在契约之上加纪律。

## 1. 人所有目录与归因（AGENTS.md §2、HANDOFF §7:144-145）

| 约束 | 违反后果 | 可验证的合规动作 |
|---|---|---|
| G1 `tests/`、`judge/`、`krsi/`、`rsi/`、`eval/`、`scripts/`、`self-upgrade/` 是人所有（`AGENTS.md:13`） | 围栏判「受保护路径改动」FAIL。手册 §9:208 记 G2-a 围栏整体 exit 1 的 13 条 FAIL 全是受保护路径改动，逐条对应人工 D4 归因行，无一条来自 Agent | 改动前列出靶子路径，逐条比对 `AGENTS.md:13` 的 7 个目录；命中即转人 |
| G2 改动必须显式归因 `attribution=human`（`AGENTS.md:14`） | 归因计入 Agent；围栏无人工确认通道可放行 | 围栏带 `--accept-current="<必须写清为什么靶子不再变动>"`（`HANDOFF §4:76`）；把理由写进 `agent-decisions/` 的 ADR |
| G3 改动必须重锚 `.self-upgrade/baseline.json`（`AGENTS.md:14`） | 基线指纹仍指向上一道题（`tasks.json:4` 原文：「改这张表 = 换题。改完必须重打基线」） | 跑 `node scripts/check-self-upgrade.mjs --baseline --package=server --allowed=<靶子> --judge=<判据>`（`HANDOFF §7:146-150`）；核对 `baseline.json` 的 `protected` 条目数 |

**正反对照 1**：错误做法「改完 `tests/self-upgrade/` 直接跑围栏」→ 现象「围栏第 2 道闸抓住判据指纹改写，整体 exit 1」→ 正确做法「先按 `HANDOFF §7:143` 走人工 D4 归因，再重锚，再跑围栏」。

**路径口径差异（分列，不混用）**：`AGENTS.md:13` 用短名列 7 个目录；手册 §7.2 D4 行用带路径的形式写 `tests/`、`krsi/`、`src/services/{judge,rsi,eval}/`、`scripts/`、`self-upgrade/`。两者是同一治理面的两种写法，提示词里按引用场景选一种，不要拼成 12 个目录。

## 2. D0–D4 变更域表（手册 §7.2:86-92）

| 域 | 范围 | 无人值守 |
|---|---|---|
| D4 | `tests/`、`krsi/`、`src/services/{judge,rsi,eval}/`、`scripts/`、`self-upgrade/` | **永不**，必须人 |
| D3 | `package.json`、`app.ts`、`config/`、架构入口 | 需人批 |
| D2 | `services/`、`controllers/`、`routes/`、前端 stores/services | 首次需人 |
| D1 | `src/tools/`、`src/utils/`、`client/src/components/` | 可全自动（≤6 文件） |
| D0 | 只读 | 可全自动 |

| 约束 | 违反后果 | 可验证的合规动作 |
|---|---|---|
| G4 命中 D4 的任何改动必须人 promote，不得自动落盘（手册 §7.4:116-117） | 「整套 RSI 无人值守闭环」被误判成立 | 查 `server/candidates/<id>/` 是否仍有待 promote 的候选；查账本有无对应人工条目 |
| G5 自动采纳只允许 D1（`AGENTS.md:15`）；D1 全自动上限 ≤6 文件（手册 §7.2:91） | 一次采纳批量改写 D2/D3，绕过人批 | 数本次 diff 的文件数与路径前缀，`src/tools/`、`src/utils/`、`client/src/components/` 之外一律停 |
| G6 D3 需人批；D2 首次需人（手册 §7.2:89-90） | 服务层/入口层被静默改写，架构漂移 | 派单前读 `tasks.json` 的 `allowed` 数组，逐条判域；命中 D2/D3 即转人 |
| G7 变更域按「路径前缀」判，不按「改动看起来多小」判 | 一行 `app.ts` 改动被当成 D1 放行 | 用路径前缀比对上表，不按 diff 行数决策 |

## 3. 采纳边界（手册 §7.4、AGENTS.md §2:15、HANDOFF §7:145）

| 约束 | 违反后果 | 可验证的合规动作 |
|---|---|---|
| G8 `auto-adopt` 通过四闸后**必然写 D4**：`tests/<judge>`、`tasks.json`、账本、exemplars（手册 §7.4:115） | 把「工具层可无人值守」误推成「整套闭环无人值守」 | 跑 `cd server && node ../scripts/rsi-tick.mjs` 只读体检（`HANDOFF §3:43`），不采纳、不写盘；确认 D4 无新写入 |
| G9 当前裁决：**采纳只写 staging**（`server/candidates/<id>/`），人 `promote` 时才落 D4 并重锚基线（手册 §7.4:116） | D4 被 Agent 直接写，人所有边界失效 | 检查 `server/candidates/` 下候选目录；`rsi-tick` 读数 2 个待采纳候选（手册 §7.3:102，活读数） |
| G10 最后一步必须是人：promote（手册 §7.4:117） | 闭环缺人侧拍板，归因无从追溯 | 交接单里写明「待 promote 项 + 人侧决策人」；不在 Agent 产出里写「已采纳」 |
| G11 判据、`tasks.json` 属 D4（`AGENTS.md:15`、`HANDOFF §7:144`） | 题集被自动换题，基线指纹漂移 | `tasks.json` 的 `_comment` 自称「唯一真源」；改它必须人 + 重锚 |

**正反对照 2**：错误做法「`auto-adopt` 四闸过了就直接把判据写进 `tests/`、把题写进 `tasks.json`」→ 现象「`tests/<judge>`、`tasks.json`、`.self-upgrade/ledger.jsonl`、`exemplars.jsonl` 四处 D4 同时被 Agent 改写，无人能复核」→ 正确做法「只写 `server/candidates/<id>/`，人 promote 时落 D4 并重锚基线」（手册 §7.4:116）。

## 4. 不伪造证据（AGENTS.md §2:16、手册 §7.5、§9、HANDOFF §3:59-61）

| 约束 | 违反后果 | 可验证的合规动作 |
|---|---|---|
| G12 未执行写 `UNEXEC`（`AGENTS.md:16`）；未跑 = UNEXEC，不算通过（手册 §9:227、`AGENTS.md:23`） | 把「没跑」写成「通过」，CI 绿被误读成全绿 | 在验收表逐项标 PASS / FAIL / UNEXEC；`HANDOFF §4:78` 把 e2e 标为「本轮 UNEXEC（未跑，别当绿）」 |
| G13 账本只追加可验证记录（`AGENTS.md:16`） | 早期条目被覆写，历史归因不可复算 | 查 `.self-upgrade/ledger.jsonl` 行数只增不减；本机实跑 89 行（手册 §7.3:100，活读数） |
| G14 重建条目必须标 `reconstructed: true`（`AGENTS.md:16`、手册 §10:234） | 重建记录被当成原始证据 | 查账本条目里 `reconstructed` 字段；verified 覆盖 13/25、历史稀（手册 §7.3:100、§10:234，活读数） |
| G15 围栏无输出时打 `REGRESSION_VERDICT=unexec` 并归 infra；**不许在无证据时说「可复现真回归」**（手册 §7.5:134） | 五次「可复现真回归」全是 env 污染假红（手册 §7.6:141） | 把全量回归原始输出整份落盘 `.self-upgrade/loop/full-regression-<ts>.txt`；复跑那遍另存 `full-regression-first-<ts>.txt`（两遍失败项不总一样，手册 §7.5:133） |
| G16 人工注入读数 ≠ 探针读数，别混记（手册 §7.5:125、`HANDOFF §3:61`） | 把人工 KILLED 数当成 `mutation-probe` 自动探针结果 | 分开两栏写；探针要求靶子 git-clean，否则 SKIP（手册 §7.5:123） |
| G17 派单本机产物 `.self-upgrade/loop/` 下 `sse-*.txt` / `diag-*.txt` / `fb-*.txt` / `checkpoints/` 是本地证据、未入库（`HANDOFF §6:133-134`） | 宽 glob 把它们加进 `.gitignore`，吞掉既有跟踪件 | 逐条核对 `.gitignore` 变更；不动既有跟踪件 |
| G18 诊断书不得丢弃围栏证据行（手册 §7.6:143） | 旧过滤顶格匹配 `FAIL`，真实输出 6 空格缩进 → 只剩一句结论 | 用 `scripts/lib/fence-diag.mjs` 剥 CSI + 收续行，循环消费它 |

**正反对照 3**：错误做法「围栏输出里看到 FAIL 就写『可复现真回归』」→ 现象「派单循环 `loadEnvFile(server/.env)` 把整个 `process.env` 传给围栏的 vitest 子进程，断言『默认关闭』态的用例只在派单里红，五次结论全假」（手册 §9:221-225）→ 正确做法「干净 env 全绿 → 注入同一套污染 env 逐条复现落盘证据里的失败项 → 挂 `tests/setup-hermetic-env.ts` 的 `setupFiles` 隔离件；同一套污染 env 下 172 文件 / 1758 passed / exit 0」（手册 §9:225，活读数）。

## 5. 判据草稿暂存规则（手册 §7.3:106-111、§7.6:146）

| 约束 | 违反后果 | 可验证的合规动作 |
|---|---|---|
| G19 还没派单的题，判据先进 `server/candidates/<id>.candidate.ts`，派单前由人 promote 回 `tests/self-upgrade/`（手册 §7.3:106-107） | 围栏全量回归扫 `tests/`，未实现的判据按设计红，被读成「这一题踩坏了既有行为」 | 查 `vitest.config.ts` 的 `exclude` 已排除 `candidates/**`（手册 §7.3:108）；草稿只放 `server/candidates/` |
| G20 草稿的相对 `import` 按 promote 后的深度写；**草稿态不可原地执行**；红基线必须 promote 之后再取（手册 §7.3:109） | 草稿态直接跑出假红，被当成实现缺陷 | 先 promote 再取红基线；不在 candidates 目录里跑判据 |
| G21 **promote 与重锚的先后不能反**；先重锚会把新增判据记成「受保护目录新增文件」（手册 §7.3:110） | 一次派单里 PASS 目标文件被改动，围栏把迟到写入算成自己的改动 | 顺序固定：promote → 重锚 → 跑围栏；交接单写明顺序 |
| G22 `spec.excludeJudges` 只作用于全量回归；promote 时由人补登记（手册 §7.6:146「K16 登记死锁」） | 只读新工具带 `path` 必然触发登记要求，名单在 `tests/` 下 Agent 改不得，反向校验又不许提前登记 → 死锁 | 用 `excludeJudges` 缩小全量回归范围；promote 时人补 K16 登记 |
| G23 判据由 `tests/self-upgrade/judge-draft-isolation.test.ts` 守「恰好一份、不并存」，**不钉「此刻在哪」**（手册 §7.3:111） | 把「草稿必须在 candidates」写成硬断言，promote 后必然红 | 断言只写「恰好一份、不并存」；位置由流程保证，不由判据钉死 |

**正反对照 4**：错误做法「先重锚基线，再 promote 判据」→ 现象「新增判据被记成『受保护目录新增文件』，围栏第 1 道闸直接红」→ 正确做法「先 promote 回 `tests/self-upgrade/`，再重锚基线」（手册 §7.3:110）。

## 6. 规格 vs 活读数区分规则（手册 §7.3:96、§9、AGENTS.md §3、工厂规范 04 号）

| 约束 | 违反后果 | 可验证的合规动作 |
|---|---|---|
| G24 `docs/agent/spec.md` 是唯一契约来源（手册 :4、`AGENTS.md:12`）；手册是「我是谁、我能做什么、我哪里还不行」的索引（手册 :4） | 把运行态索引当契约，用活读数反推规范 | 每个数字旁写清是「契约值」还是「本机实跑读数，锚点见 X，不得写成规范」 |
| G25 活读数不是规范；重跑以实际输出为准（手册 §7.3:96） | 把 25 题 / 1512 passed / 278 文件写死成硬性门槛 | 引用时带锚点，如「1512 passed + 1 skipped，锚点 run #5 @ `4d6ed81`（`AGENTS.md:20`）」 |
| G26 用例体量以实跑输出为准，别把某个数写死当规范（`AGENTS.md:20`） | 环境缺 `.env` 时跳过一条，仍按 1512 判通过 | 记录 skip 条数与原因；`AGENTS.md:20` 明确「skip 的那条依赖真实 `.env`，缺席即跳过，不算通过」 |
| G27 改动 `src/` 后必须重跑对应验证；未跑 = UNEXEC，不算通过（`AGENTS.md:23`、手册 §9:227） | 继承旧读数冒充本次结果 | 验收表按本次实跑填；手册 §9:189「CI 不跑的项按 UNEXEC 记，**不继承旧读数**」 |
| G28 CI 表与本地补充表不是同一趟，别混算（手册 §9:198 明确「与上表 CI 锚点不是同一趟」） | 把 Linux CI 的 1512 与 Windows 本地的 1860 相加或互证 | 两表分列；本地补充读数标注 Windows / node 24（手册 §9:198） |
| G29 版本差异按「文档口径 / 当前文件态」两栏写，禁止只写一个数（`领域解析卡 §3:85`、工厂规范 04 号 §六） | 事实冲突被抹平，下游提示词引用错误版本 | 用分列式或标注式；兜底式「以官方最新文档为准」全文占比 <20% |
| G30 待核实项不擅自假设、不抹平，登记《待核实清单》并回报主理人（工厂规范 04 号 §四、`领域解析卡 §7:140`） | 编造版本号、菜单路径、参数名、API、文件数 | 标 `【待核实：缺什么，建议核实途径】`；见本文文末清单 |

## 7. 密钥与日志纪律（spec §10、HANDOFF §6、手册 §6）

| 约束 | 违反后果 | 可验证的合规动作 |
|---|---|---|
| G31 密钥不落日志（`spec.md §10:164`） | BYOK Key 进入服务端日志 | 查日志无 `sk-…` 形态串；示例一律写 `${VAR}` |
| G32 `.env` 不入库（`.gitignore:6`）；BYOK Key 只存浏览器，服务端不落库不记日志（`HANDOFF §6:135`） | 凭据随提交外泄 | `git status` 确认 `server/.env` 未被跟踪；手册 §2:20「环境变量 `server/.env` 已被 gitignore；密钥只落本机」 |
| G33 技能内容命中 `sk-…`、32+ 位不透明串、`api_key/secret/token/password` 键值形态即拒写，不回显原文（手册 §6:76） | 密钥写进数据库行 | 查拒写日志只记「命中规则」，无原文；实例 47 条中 1 条被拒（手册 §6:75，活读数） |

## 8. 参数说明（本文件出现的全部可填参数）

| 参数 / 变量 | 取值与出处 | 用途 |
|---|---|---|
| `--package=server` | `HANDOFF §4:74`、§7:148 | 围栏与重锚指定包 |
| `--allowed=<靶子逗号分隔>` | `HANDOFF §4:75` | 本次允许改动的靶子清单，来自 `tasks.json` 的 `allowed` |
| `--judge=<判据路径>` | `HANDOFF §4:75` | 指定判据文件 |
| `--full` | `HANDOFF §4:75` | 触发全量回归 |
| `--accept-current="<理由>"` | `HANDOFF §4:76` | 人工确认通道，理由必须写清「为什么靶子不再变动」 |
| `--baseline` | `HANDOFF §7:148` | 重锚模式，写 `.self-upgrade/baseline.json` |
| `spec.excludeJudges` | 手册 §7.6:146 | 只作用于全量回归，绕开 K16 登记死锁 |
| `CODELENS_API` | `scripts/assert-tool-registry-contract.mjs:24` | 契约闸指向的运行实例，默认 `http://127.0.0.1:8080` |
| `E2E_PORT` | `AGENTS.md:22` | e2e 端口 |
| `AGENT_TASK_BUDGET_MS` / `AGENT_TOKEN_BUDGET_FACTOR` | `HANDOFF §8:158-159` | 派单墙钟与 token 系数（示例 2700000 / 6） |
| `attribution=human` | `AGENTS.md:14` | 人所有目录改动的归因标记 |
| `reconstructed: true` | `AGENTS.md:16` | 账本重建条目标记 |

**命令速查表（等价「快捷键表」）**：本包无 GUI 快捷键可写，治理动作全部落在命令与文件上。

| 动作 | 命令 / 路径 |
|---|---|
| 只读体检（不采纳不写盘） | `cd server && node ../scripts/rsi-tick.mjs` |
| 围栏（人工确认通道） | `node scripts/check-self-upgrade.mjs --package=server --allowed=<靶子> --judge=<判据> --full --accept-current="<理由>"` |
| 重锚基线 | `node scripts/check-self-upgrade.mjs --baseline --package=server --allowed=<靶子> --judge=<判据>` |
| 查候选 | `server/candidates/` |
| 查账本 | `.self-upgrade/ledger.jsonl` |
| 查基线 | `.self-upgrade/baseline.json` → `protected` |
| 查回归原始输出 | `.self-upgrade/loop/full-regression-<ts>.txt` 与 `full-regression-first-<ts>.txt` |

## 9. 可查清单（交付前逐项打勾）

1. 查靶子路径：逐条比对 `AGENTS.md:13` 的 7 个目录与手册 §7.2 的 D4 行。
2. 查变更域：按路径前缀判 D0–D4，不按 diff 行数判。
3. 查采纳落点：确认只写 `server/candidates/<id>/`，D4 无 Agent 写入。
4. 查归因：确认 `attribution=human` 与 `--accept-current` 理由齐备。
5. 查重锚顺序：确认 promote 在重锚之前。
6. 查草稿位置：确认未派单判据在 `server/candidates/`，`vitest.config.ts` 的 `exclude` 已排除 `candidates/**`。
7. 查三态：验收表逐项标 PASS / FAIL / UNEXEC，无「未跑即通过」。
8. 查证据：确认回归原始输出两遍分别落盘，无「无证据却称可复现真回归」。
9. 查读数：每个数字有锚点，注明「本机实跑读数，不得写成规范」。
10. 查工具数裁定：确认写「当前源码实读 20（含 `agent.verify`）、活读数以实跑为准；手册 19 为上轮读数、17 为旧构建实例」，不写「三处无法判断」、不把 19 当硬规范；题数 24/25/36、受保护 278/279 仍两栏写。
11. 查密钥：文中无真实 Key，示例用 `${VAR}`。
12. 查待核实项：文末清单与本文件内 `【待核实】` 标记一一对应。

## 10. 待核实清单

| # | 位置 | 缺什么 | 建议核实途径 | 影响 |
|---|---|---|---|---|
| 1 | §4 G13/G14 | `.self-upgrade/ledger.jsonl` 条目的 `reconstructed` / `attribution` / `layer` / `code` 字段结构未直接读账本核实（本轮只核到 89 行） | 读账本前若干行逐字段核；对照 `核心场景事实地图.md:86` 的归因结构 | 中 |
| 2 | §2 G5、§3 G8 | 手册 §7.4:115 的「四闸」未列名称；D1「≤6 文件」未见代码落点 | 读 `server/scripts/auto-adopt.ts` 核实四闸与 6 的硬编码位置 | 中 |
| 3 | §1 G2 | `attribution=human` 的确切字段名与所在文件未见 | 读 `server/scripts/check-self-upgrade.mjs` 或 `.self-upgrade/baseline.json` 的条目结构 | 中 |
| 4 | §5 G22 | `spec.excludeJudges` 的确切 schema 与读取位置未见 | 读 `server/scripts/check-self-upgrade.mjs` 与 `tasks.json` 的题目规格字段 | 低 |
| 5 | §1 路径口径差异 | `AGENTS.md:13` 的 7 个短名与手册 §7.2 D4 的带路径写法是否完全等价，未见映射说明 | 对照 `server/scripts/check-self-upgrade.mjs` 的受保护路径判定逻辑 | 中 |

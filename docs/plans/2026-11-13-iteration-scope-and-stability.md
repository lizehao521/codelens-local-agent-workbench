# 迭代目标与范围说明（2026-11-13）

> 性质：**目标范围裁决 + 稳定性测试报告 + 风险台账**，不是改动流水账。
> 证据来源：本仓库代码、`.self-upgrade/` 账本、本轮实跑的测试输出。
> 口径：按 `强化Agent.txt` C4——**跑过的写 PASS，没跑的写 UNEXEC，不写「应该没问题」**。
> 适用范围：RSI 迭代 / 全栈产品开发 / 设计迭代 三条线。

---

## 0. 结论摘要

1. **系统当前是「闸很硬、环未闭」**：判据门禁（围栏、契约、变异、krsi）可复算且真的打红过；但 `r → π'` 的规模化证据不足（账本 7 行只覆盖 1/13 题）。
2. **本轮实跑全绿**：server 1507/1507、client 136/136、e2e 14/14、krsi 10/10、套件地板 3/3、C1 PASS、工具契约 17 PASS、变异探针 2/2。
3. **全绿之前先红了两次，都是真缺陷**：
   - 验收链依赖宿主环境变量 `GOCACHE/LOCALAPPDATA`，在受控环境直接红在「环境」而不是「代码」——已修。
   - 前端 RSI 兜底契约落后后端三个字段组（`domains / decisions / iterationCriteria`），跨模块数据一致性已经漂移——已修，门禁 14/14 恢复。
4. **三线的下一优先级已定**：RSI 补 C2 闭环覆盖 → 全栈补 CI/文档对账 → 设计补视觉基线与状态完整性。功能扩张全部后置。
5. **需要授权的只有 5 件事**（CI、大文件拆分、账本回填口径、像素基线、Node 版本口径），见 §7。

---

## 1. 自身现状：优点与缺点

### 1.1 优点（都有机器可查的落点）

| # | 优点 | 证据 |
|---|---|---|
| S1 | **信任边界是机制，不是口号**：Agent 改不到 `tests/`、`judge/`、`scripts/`、账本 | 围栏逐文件 sha256 + 254 个受保护文件基线；判据指纹闸；`check-self-upgrade.mjs` |
| S2 | **判据可自证**：反向断言 + 变异探针，能区分「做对了」和「看起来做对了」 | `judge-audit.mjs`；`mutation-probe.mjs` 2/2 杀死；`rationale-guard`（不许删反证注释） |
| S3 | **失败归因分层且三态**：`skipped ≠ failed ≠ ran`，避免把「没跑」读成「跑红」 | `failure-attribution.ts` L0–L5；`attribution-fence-order.test.ts` 13 条 |
| S4 | **契约跨模块可对账**：工具注册表 17 个、RSI 规则契约 14 项、错误体 17 处统一 | `assert-tool-registry-contract.mjs`；`check-rsi-contract.mjs`；`api-error-shape.test.ts` |
| S5 | **后端分层稳定**：routes → controllers → services → repositories，校验在 zod 层，错误体单一形状 | 15 个业务路由模块；23 张表；`{ error: { code, message } }` |
| S6 | **高危动作有真闸**：审批令牌 HMAC、改参重批要重跑 schema + 安全网关、回滚要确认头 | `approval.service.ts`；`checkpoints` 409/400 分支 |
| S7 | **测试体量够厚**：服务端 161 文件 / 1507 用例；前端 15 文件 / 136 用例；e2e 14 断言 | 本轮实跑输出（§4） |
| S8 | **RSI 有跨代对账内核**：krsi 用退出码区分 improved / not_improved / refused / undecidable | krsi 10 个对抗场景 10/10 PASS |

### 1.2 缺点（按对目标的影响排序）

| # | 缺点 | 现状读数 | 影响 |
|---|---|---|---|
| W1 | **C2 开环**：判决没有规模化改到 π | 账本 7 行 / 覆盖 1/13 题；`exemplars.jsonl` 缺失 | 「越用越懂你」目前是 2 题的孤证，不是系统能力 |
| W2 | **Update / Memory 两维无题目归属** | 13 题：Act 9 / Judge 4 / Update 0 / Memory 0 | 内核公式四维只测了两维 |
| W3 | **L2 语义 / L3 红队 UNEXEC** | 无任何判据回答「质量是否真的提升」 | 只能证明「没退化」，不能证明「变好」 |
| W4 | **调度未实现** | `src/` 内无任何地方启动 `self-upgrade-loop.ts`；只有只读 `rsi-tick` | 「自主迭代」靠人手动起，不能称为闭环运转 |
| W5 | **无 CI** | 仓库无 `.github/workflows`；全部靠本地 acceptance | 门禁可被绕过；文档漂移已经发生（§4.5 D-3/D-4） |
| W6 | **文件规模失控** | 服务端 **33** 个文件 >300 行（最大 `agent-loop.service.ts` 1459）；前端 **13** 个（最大 `api.ts` 1288） | 违反 spec「单文件 ≤300 行」；改动半径大，回归风险高 |
| W7 | **契约双份维护** | 前端兜底 477 行是后端契约的手抄副本 | 已经漂移过一次（D-2）；门禁能抓，但根因在结构 |
| W8 | **单用户边界** | 无账号/多租户/团队；BYOK 无 Key 即不可用（试用受 IP + token 双闸） | 商业化与团队场景不成立，也不该现在承诺 |
| W9 | **设计不可验证** | 有 design tokens，但无像素基线、无视觉回归 | 「好看」只能人工说，不能机器判 |
| W10 | **版本口径漂移** | spec 写 Node「22.22.2 精确锁定」，`engines` 是 `>=22.5.0`，本机实跑 22.23.2 | 可复现性承诺与实现不一致 |

### 1.3 本轮协作方（执行侧）的边界

- 能做的：读代码、跑真实测试、改被授权的小范围实现与闸、产出结构化裁决。
- 不能做的：代替人做 D4（判据/账本/题集）裁决；不能在没有 Key 的情况下证明真实上游链路；没有独立的 codelens 会话通道，本次「对话」以仓库证据为准，不用假设补空。

---

## 2. 三条迭代线：核心目标、边界、优先级

### 2.1 RSI 迭代

**核心目标（未来 2 周）**：把「能跑通一次闭环」升级为「**可复算、可连续、可证伪**」。
不是加题量，是让每一次判决都能被下一个人复算。

| 优先级 | 目标 | 完成判据（机器可查） |
|---|---|---|
| P0 | **补 C2 覆盖**：账本按可验证证据回填并标 `reconstructed`；恢复 `exemplars.jsonl` | `rsi-tick` 覆盖率 ≥ 8/13；exemplars ≥ 3 且无 FATAL 拒绝码 |
| P0 | **调度入口**：外部触发器（计划任务/pre-push）调用循环，采纳仍写 staging | 连续 3 轮无人值守产出 staging 候选；0 次自动写 D4 |
| P1 | **Update / Memory 归属**：各补 ≥2 题，带 `strengthens` | 四维分布 Act/Judge/Update/Memory 均 ≥2 |
| P1 | **逐题变异**：每题至少 1 个破坏夹具 | `check:mutation` 覆盖题数 ≥ 13（当前 3 处） |
| P2 | **L2 语义判据**：固定 prompt + 固定模型 + 金丝雀 | 至少 1 条 L2 判据有正例/反例/破坏夹具 |
| P2 | **L3 红队**：专门构造骗过判据的样本 | 红队样本 ≥5，至少 1 个现有判据被攻破并修复 |

**边界（不可让渡）**

- D4（`tests/`、`krsi/`、`self-upgrade/`、`scripts/`）**永不自动写**；采纳只写 `server/candidates/<id>/`，人 `promote` 才落 D4 + 重锚基线。
- Agent 不得改判据、不得改账本、不得改题集；围栏是它够不到的尺子。
- 判据变了必须显式声明（krsi R2），删指标不算变好（R3），哈希造假直接拒收（R4）。
- 未执行一律 UNEXEC；不许用「全绿」替代「有证据」。

**明确不做（本轮）**

- 不做「全自动自改判据」；不做多 Agent 协作；不追题量；不为一次性问题造工具（工具纪律第 6 节）。

---

### 2.2 全栈产品开发

**核心目标（未来 2 周）**：**先稳、再清、最后才扩**。
稳定性优先于新能力；可维护性优先于新页面。

| 优先级 | 目标 | 完成判据 |
|---|---|---|
| P0 | **门禁前移**：加 pre-push 本地钩子（零外部依赖），跑 typecheck + acceptance + 契约 | 钩子可被故意改坏打红；提交前必跑 |
| P0 | **真相源对账**：Node 版本口径、`rsi:verify` 用法、文档中的运行读数 | 文档与代码读数一致，且有脚本断言 |
| P0 | **e2e 隔离**：默认端口占用时自动改端口或明确报错退出码 | `E2E_PORT` 自动探测；默认路径可复现 |
| P1 | **大文件拆分**：先拆 `agent-loop.service.ts`（1459）与 `client/src/services/api.ts`（1288），纯搬移不改行为 | 拆分前后 1507/136 用例同绿；单文件 ≤600 行（分两批到 300） |
| P1 | **契约单一真相源**：由后端生成前端兜底（构建期），删除手抄副本 | `check-rsi-contract` 改为校验生成物；副本行数归零 |
| P2 | **能力扩张**：新增 provider/tool 必须进 registry + 有 Judge 样本 + 失败有用户可见状态 | 接入清单三项齐备才允许合并 |

**边界（不可让渡）**

- 单用户 / 自托管；不做账号体系、多租户、团队版、官方托管实例。
- 不做远程 MCP（非 stdio）；不做任意命令执行的白名单放宽；不做浏览器自动化产品化。
- BYOK：Key 只存浏览器，服务端不落库、不记日志；对话历史持久化必须明示。
- 部署主路径仍是 Docker 单容器；桌面端是隐私分流，不是第二套架构。

---

### 2.3 设计迭代

**核心目标（未来 2 周）**：从「有设计系统」到「**可验证的审美一致性**」。

| 优先级 | 目标 | 完成判据 |
|---|---|---|
| P0 | **Token 纪律**：颜色/间距/圆角只用 `docs/design-tokens.json` 派生类，禁止散落十六进制 | 静态扫描 0 处硬编码色值（新增门禁） |
| P0 | **状态完整性**：每个主面板具备 loading / empty / error / disabled / degraded 五态 | 五态截图清单；缺一态即不合并 |
| P1 | **视觉基线**：3 张基准截图（工作台 / RSI 面板 / 审批卡）+ 人工评审清单 | 基线入库；改动需人工对比签字 |
| P1 | **信息层级**：工作台三栏密度、工具卡折叠、RSI 面板表格可读性 | 1440 / 1024 / 390 三档截图通过评审 |
| P2 | **动效克制**：只保留状态过渡，不做装饰性动画 | 动效清单 ≤5 条，均可关闭 |
| P2 | **可访问性**：对比度 ≥4.5:1、键盘可达、焦点可见 | 自动对比度检查 + 手工键盘走查 |

**边界**

- 深色优先 + 浅色可选 + 跟随系统；不引入第三方 UI 组件库；图标只用 lucide 规范名。
- 没有像素基线之前，任何「更好看」的结论按 C4 记 UNEXEC。
- 不为审美改信息架构；结构变更走 D3。

---

## 3. 架构对三条线的支持点与约束

| 迭代 | 支持点（已有） | 约束（真实卡点） |
|---|---|---|
| **RSI** | `change-domain.ts` D0–D4 分级；围栏七道闸；`ledger.jsonl` append-only；krsi 跨代对账；`rsi-tick` 只读体检；staging 采纳 | D4 必须人 promote；账本覆盖 1/13；无调度；L2/L3 空；逐题变异只 3 处；基线改动需重锚 254 文件 |
| **全栈** | 分层目录 + zod 校验 + 统一错误体；SSE 主端点 + 审批独立端点；SQLite 23+ 表；checkpoint 回滚；17 工具注册表 | 无 CI；服务端 33 个文件超 300 行；前端 `api.ts` 1288 行；契约双份；Node 版本口径不一致；SQLite 仍是 experimental |
| **设计** | `design-tokens.json` 单一 token 源；Tailwind 4 `@theme inline`；深色优先；三档响应式；图标卫生门禁 | 无像素基线；无视觉回归；部分面板文件 600–866 行，样式与逻辑耦合；五态未系统化 |

**一句话**：架构对「判定与门禁」的支持是强的，对「规模化闭环、可维护性、视觉验证」的支持是弱的。下一阶段不应该再加判定层，而应该补消费端与可维护性。

---

## 4. 全局稳定性与逻辑测试（本轮实跑）

### 4.1 执行清单与读数

| # | 测试 | 命令 | 结果 | 耗时 |
|---|---|---|---|---|
| 1 | 服务端类型检查 | `tsc --noEmit` | **PASS**（0 错） | — |
| 2 | 服务端全量单测 | `vitest run` | **PASS 1507/1507（161 文件）** | 121.73s |
| 3 | krsi 跨代对抗 | `test:krsi` | **PASS 10/10**（含 4 种拒收、2 种 undecidable） | — |
| 4 | 套件地板 | `check:suite-floor` | **PASS 3/3**，exit 0 | — |
| 5 | C1 元数据闸 | `check:task-metadata` | **PASS**，exit 0 | — |
| 6 | 工具注册表契约 | `check:tool-contract` | **PASS 17 工具**，exit 0 | — |
| 7 | 前端类型检查 | `tsc --noEmit` | **PASS**（0 错） | — |
| 8 | 前端全量单测 | `vitest run` | **PASS 136/136（15 文件）** | 5.86s |
| 9 | 端到端 | `E2E_PORT=8099 bash scripts/e2e.sh` | **PASS 14/14**，exit 0 | — |
| 10 | 变异探针 | `check:mutation` | **PASS 2/2 杀死** | — |
| 11 | RSI 规则契约 | `check:rsi-contract` | 修前 **1 FAIL** → 修后 **14/14 PASS** | — |
| 12 | 只读体检 | `check:rsi-tick` | 13 题 done 13；账本 7 行 / 覆盖 1/13；exemplars missing | — |

> `npm run rsi:verify` 本轮 **UNEXEC**：该命令需要 `<sessionId>` 参数，交接文档写成无参可跑（见 D-3）。这是文档漂移，不是账本失败，但也**不能记绿**。

### 4.2 关键路径覆盖（已测）

| 路径 | 覆盖证据 |
|---|---|
| 启动 → 健康 → provider 列表（不泄露 Key） | e2e §2–3 |
| 缺 Key → SSE error `MISSING_API_KEY`（不白屏） | e2e §4；`upstream-auth-error.test.ts` 14 条 |
| 参数非法 → 400 `VALIDATION_ERROR` | e2e §5；`error-handler.test.ts` 8 条 |
| 会话列表 → 工具清单（规范名/线上名双出） | e2e §6 |
| SPA fallback | e2e §7 |
| Agent 循环：预算 / 收敛 / 并发 / 中止 | `loop-budget` 23、`convergence-detector` 6、`agent-concurrency` 2 |
| 审批：三值决定 / 改参重批 / 过期 / 签名 | `approval` 相关套件 + HMAC 8 条 |
| 沙箱：相对路径 / 授权目录 / 越界 | `path-jail` 变异探针杀死 + `tool-fs-path-hint` 2 条 |
| RSI：契约 / 归因 / 围栏顺序 / 账本 / 跨代 | 契约 14 项、归因 13 条、krsi 10 场景 |
| 前端：存储 / SSE 解析 / 审批 store / RSI 展示 | client 136 条 |

### 4.3 边界情况（已测）

- 文件工具：`oldText` 空串（死循环防护）、命中 0/多处、截断标记、默认 maxbytes 文案与常量一致。
- 预算：迭代数 / 工具调用数 / token / 墙钟四道同时生效，到顶先写终态。
- 限流：`/api` 300/min、恢复码 10/min、LLM 40/min，0 = 不限。
- 恢复码：连错 5 次锁 15 分钟；旧码重生成即失效；只明文返回一次。
- 审批：单调用改参上限 3 次；过期令牌验签失败；缺确认头 400、能力未开 409。
- krsi：自报变好但读数没动（exit 1）、偷放宽判据（2）、删指标（2）、哈希造假（2）、同代重记（2）、量不到（3）。

### 4.4 异常场景（已测）

- 上游 401/403 → `auth_failed`（不假绿）；超时 → `unreachable`；缺响应头 1s → `upstream_timeout`。
- SSE 多种畸形分片 → 正常终止或明确错误，不悬挂。
- `tsc` 类型错误 → `ok:false + TYPE_ERRORS + 文件:行:列`。
- 测试超时 → 落库/推送状态为 `timeout`，不只是 `error.kind`。
- 沙箱越界 → 拒绝；确认头缺失 → 400。

### 4.5 模块交互与数据一致性

| 检查 | 结果 |
|---|---|
| `tool_calls.tool_name ⊆ 注册表`，`/api/v1/tools ⊇ 注册表` | **PASS**（17 工具） |
| 前端 RSI 兜底 ≡ 后端 `buildRsiRulesContract()` | **修前 FAIL → 修后 PASS** |
| 17 处 legacy 错误体形状 | **PASS**（有回潮护栏） |
| 账本 manifest / evidence / anchor / 链 | 单测 16 条 PASS；`rsi:verify` 本轮 UNEXEC |
| 文档 vs 代码读数 | **已确认 2 处不一致**：`rsi:verify` 用法（文档无参 / 实际必填）、Node 版本（spec 精确锁 / engines 范围）。表数与受保护文件数**已核实与手册一致**（23 表 / 254 文件），不记为缺陷 |

### 4.6 本轮发现并处置的缺陷

| ID | 缺陷 | 性质 | 处置 | 复验 |
|---|---|---|---|---|
| **D-1** | `test:krsi` 在无 `LOCALAPPDATA` 的环境直接失败（`GOCACHE` 未定义），验收链红在环境而非代码 | 可移植性 | `run-krsi-conformance.mjs` 显式兜底 `GOCACHE` 到系统临时目录 | 修前 exit 1 → 修后 10/10 PASS |
| **D-2** | 前端 RSI 兜底契约缺 `domains / decisions / iterationCriteria`，`outOfScope` 文案过期 | 跨模块数据一致性 | 以后端契约为准重建常量（不手抄） | 契约 14/14 PASS；client tsc 0；136/136 |
| **D-3** | 交接文档称 `npm run rsi:verify` 无参 exit 0，实际要求 `<sessionId>` | 文档漂移 | 待定（改文档或加默认），见 Q-5 | UNEXEC |
| **D-4** | spec 写 Node「22.22.2 精确锁定」，`engines` 为 `>=22.5.0`，实跑 22.23.2 | 版本口径漂移 | 待定（Q-5） | 已核实读数 |
| **D-5** | 默认 8080 被占用时 e2e 直接拒跑 | 环境隔离 | 本轮用 `E2E_PORT=8099` 通过；脚本自动探测待做 | 14/14 PASS |

> 代码改动仅两处，均为**恢复一致性**，未改任何判定语义；临时脚本已删除，无新增依赖。

---

## 5. 风险台账

| ID | 风险 | 等级 | 触发条件 | 处置 | 状态 |
|---|---|---|---|---|---|
| R-1 | 账本覆盖不足导致「强化」不可复算 | **高** | 对外声称「越用越懂你」 | 回填 + exemplars + 覆盖率进 `rsi-tick` 断言 | 待执行（P0） |
| R-2 | 无 CI，门禁靠自觉 | **高** | 有人跳过 acceptance 直接提交 | pre-push 钩子 + 远程 CI | 待授权（Q-1） |
| R-3 | 契约双份维护再次漂移 | **中** | 后端加字段、前端未同步 | 构建期生成前端兜底，删除手抄副本 | 已发生一次，待结构修复（Q-6） |
| R-4 | 大文件改动半径大 | **中** | 改 `agent-loop` / `checkpoint` / `api.ts` | 纯搬移拆分 + 判据先行 | 待授权（Q-2） |
| R-5 | 文档与实现漂移 | **中** | 版本升级只改代码 | 对账脚本 + 文档断言 | 已发现 2 处（D-3/D-4） |
| R-6 | L2/L3 空白导致「质量提升」无法证明 | **中** | 对外宣称能力提升 | 先建 1 条 L2 + 5 条红队样本 | 未启动 |
| R-7 | 单实例 + SQLite 的并发/崩溃一致性未专项验证 | **中** | 进程被杀、写半行、并发 3 任务 | 增加崩溃恢复与账本原子性测试 | UNEXEC |
| R-8 | 桌面端安装包本轮未构建验证 | **低** | 发版 | 发版前跑离线构建 | UNEXEC |
| R-9 | 工作区存在未跟踪的 zip 与 scratch 残留 | **低** | 误提交 | 清理或写进 `.gitignore` | 待清理 |
| R-10 | 设计无像素基线，「好看」不可判 | **低** | 设计评审 | 3 张基准截图 + 人工清单 | 待执行（P1） |
| R-11 | 小字 + 低对比度叠加，影响可读性 | **中** | 10/11px 与 `text-tertiary` 同行共 65 处 | 按 §10.1 的 A/B/C 选项修 Token | 已量化，待批 |

---

## 6. 已作出的范围裁决（不需再确认）

| # | 裁决 | 理由 |
|---|---|---|
| A-1 | 本轮**不扩功能**，只补一致性与可维护性 | C2/L2/L3 未闭，扩功能按 C1 是装饰 |
| A-2 | 修复只动闸/契约/文档，不动判定语义 | 尺子不能为了让结果好看而改 |
| A-3 | 采纳继续写 staging，人 promote 才落 D4 | 守住「尺子在 Agent 够不到的地方」 |
| A-4 | 调度用外部触发器，不在 `src/` 内自启 | 避免运行时代码获得改写自身判据的能力 |
| A-5 | 设计线本轮不引新依赖 | 先有基线，再谈工具 |
| A-6 | 团队版/多租户继续 out of scope | 与单用户本地定位冲突，且无账号体系 |

---

## 7. 待确认的关键问题（需要你拍板）

> 每题给推荐项；不确认则按推荐项执行，并在下一轮记账。

| # | 问题 | 选项 | 推荐 | 影响 |
|---|---|---|---|---|
| **Q-1** | 是否现在加门禁前移？ | A 只加 pre-push 本地钩子；B 同时接远程 CI；C 都不加 | **A** | 选 C 则 R-2 保持高危 |
| **Q-2** | 是否授权拆分 D3 大文件？ | A 先拆 `agent-loop` + `api.ts`（纯搬移）；B 等 CI 就绪再拆；C 不拆 | **A**（分两批，判据先行） | 拆分改 import 图，属 D3，需明确授权 |
| **Q-3** | 账本回填口径 | A 只回填有 commit/测试证据的项并标 `reconstructed`；B 不回填，只前向记录；C 全量重算 | **A** | 选 B 则 R-1 长期存在 |
| **Q-4** | 设计验收方式 | A 3 张基准截图 + 人工清单；B 引入 Playwright 像素基线；C 暂不设基线 | **A** | 选 B 需新增依赖与 CI 时间 |
| **Q-5** | Node 版本口径 | A `engines` 收紧到 `>=22.5 <23`，文档写「实测 22.23.2」；B 精确锁 22.22.2 并写 `.nvmrc`；C 维持现状 | **A** | 影响可复现性承诺与 W10 |
| **Q-6** | 前端契约副本 | A 构建期从后端生成，删除手抄；B 保留双份 + 门禁；C 删除兜底，旧后端直接报错 | **A**（排入 D3 批次） | 选 C 违反 AC-08 不白屏 |

---

## 8. 下一步（按优先级，可直接执行）

**第一批（本周，P0）**

1. 账本回填：按 Q-3=A 回填可验证项，恢复 `exemplars.jsonl`，把覆盖率写进 `rsi-tick` 输出断言。
2. 门禁前移：按 Q-1=A 加 pre-push 钩子（typecheck + acceptance + 契约）。
3. 文档对账：修正 `rsi:verify` 用法与 Node 版本口径。
4. e2e 端口自动探测，消灭 D-5。

**第二批（下周，P1）**

5. 拆分 `agent-loop.service.ts` 与 `client/src/services/api.ts`（纯搬移，用例同绿）。
6. Update / Memory 各补 2 题，四维分布补齐。
7. 设计五态清单 + 3 张基准截图。

**第三批（两周后，P2）**

8. L2 语义判据 1 条 + L3 红队样本 5 条。
9. 逐题变异覆盖到 13 题。
10. 契约构建期生成，删除前端手抄副本。

---

## 9. 复验命令（下一个人照这个跑）

```bash
# 服务端权威验收（类型 + 1507 + krsi + 三道闸）
cd server && npm run test:acceptance

# 前端
cd client && npx tsc --noEmit && npm test

# 端到端（8080 被占用时换端口）
E2E_PORT=8099 bash scripts/e2e.sh

# RSI 自证
cd server && npm run check:mutation && npm run check:rsi-contract && npm run check:rsi-tick
```

判读规则：**任何一项没跑 = UNEXEC，不许当绿；任何一项红了先修红，再谈迭代。**

---

## 10. 第二轮增量：视觉与架构审计（2026-11-13 晚）

> 这一轮不重复出报告，只补可量化的证据与可执行的修复选项。

### 10.1 视觉审计（数字，不靠主观）

**成立的部分**

- 组件层 **0 处裸色值**（`#hex` / `rgba()` 只出现在 `design-tokens.css` 的 Token 定义处）。
- **0 处** Tailwind 原生调色板类（`bg-gray-800` 之类）；224 处次级文本全部走 `text-text-tertiary`。
- 深色优先、语义色、diff 色、语法高亮色都成对定义了深/浅两套。

**偏差 1：字号越级**

设计阶梯从 12px 起（`--text-xs: 0.75rem`），但组件里：

| 写法 | 次数 |
|---|---|
| `text-[11px]` | **116** |
| `text-[10px]` | **22** |
| `text-xs`（12px，合规） | 233 |
| `text-sm`（13px，合规） | 79 |

**偏差 2：小字 + 低对比度叠加**

`text-text-tertiary` 共 **224** 处，其中 **65 处**与 10/11px 写在同一行——即「最小字号配最弱对比」。

**WCAG 对比度实测**（正文阈值 4.5:1；大字号阈值 3:1）

| 组合 | 比值 | 判定 |
|---|---|---|
| 深色 primary 文本 / 主背景 | 17.39 | PASS |
| 深色 secondary / 主背景 | 6.15 | PASS |
| 深色 **tertiary / 主背景** | **4.12** | 仅大字号 |
| 深色 tertiary / 次级背景 | 3.77 | 仅大字号 |
| 深色 tertiary / 三级背景 | 4.08 | 仅大字号 |
| 浅色 primary / 主背景 | 16.98 | PASS |
| 浅色 secondary / 主背景 | 4.63 | PASS（贴线） |
| 浅色 **tertiary / 主背景** | **2.43** | **FAIL** |
| 白字 / accent 按钮底 | 4.02 | 仅大字号 |

**结论**：这不是「配色不好看」，是「三级灰 + 最小字号」的可读性问题。深色 tertiary 在 10–11px 下达不到 AA 正文；浅色 tertiary 明确不合格。

**修复选项**（本轮未改 Token：`styles/` 不在 D1 自动驾驶域，且无像素基线）

| 选项 | 做法 | 效果 | 代价 |
|---|---|---|---|
| A 全量 | 深色 tertiary → `#7D8590`（5.07 / 4.64 / 4.08）；浅色 secondary → `#4B5563`（7.23）、tertiary → `#6B7280`（4.63 / 4.39 / 3.90） | 深浅两套都过 AA（三级背景上仍 4.08） | 三级灰变亮，层级压缩 |
| **B 先浅色** | 只改浅色 secondary/tertiary 两枚 Token | 2.43 → 4.63，层级保留 | 深色小字仍不达标 |
| C 字号收编 | 10/11px 收编为 Token（像素不变）或统一 12px | 减少 138 处魔数 | 统一 12px 需视觉评审 |

**推荐**：先做 **C 的「像素不变收编」**（纯重构、不改观感），再做 **B**（浅色对比度硬伤），**A** 等有截图基线后再说。

### 10.2 后端分层审计

**方向违规（repositories → services，共 3 处）**

| 文件 | 依赖 | 性质 |
|---|---|---|
| `judge.repository.ts` | `services/judge/types` | 仅类型，编译期擦除 |
| `trace.repository.ts` | `services/observability/trace.service` | 仅类型 |
| `sandbox-permission.repository.ts` | `services/tools/sandbox-permission` 的 `DEFAULT_PERMISSION_CONFIG` | **运行时常量，真倒置** |

**越层（tools → services，2 处）**：`eval-propose.tool.ts`、`eval-run.tool.ts` 依赖 `services/eval/*`。工具是叶子能力，依赖评测服务会让「工具层」不再是叶子。

**大文件**：服务端 **33** 个 >300 行，前端 **13** 个。拆分顺序（**等 Q-2 授权，未动**）：

| 顺序 | 文件 | 行数 | 先抽什么 |
|---|---|---|---|
| 1 | `services/agent/agent-loop.service.ts` | 1459 | SSE 编解码、预算判定、收敛检测（均为纯函数） |
| 2 | `client/src/services/api.ts` | 1288 | 按资源域拆 sessions / providers / rsi / judge |
| 3 | `services/tx/checkpoint.service.ts` | 1342 | 快照存储与回滚执行分离 |
| 4 | `services/judge/judge.service.ts` | 1062 | 判据塔分派与证据收集分离 |

每步硬判据：**公共入口不变 + 1507/136 用例同绿 + 单文件先 ≤600，再 ≤300**。

### 10.3 RSI 账本回填提案（只读，**未写账本**）

- 13 题**全部**有判据文件：12 个在 `server/tests/`，1 个（`iteration-view`）在 `client/tests/iteration-gate-view.test.ts`。
- `releasedIn` 覆盖 2.1.0–2.11.0，每题都有版本锚点。
- 账本仍只有 7 行、覆盖 1/13。

**提案**：按 Q-3=A 回填 **12 条** `reconstructed: true`，每条 evidence = 判据路径 + `releasedIn` + 对应 commit。

**拒绝回填条件**：判据文件缺失，或无法给出 commit / 版本锚点——宁可留 UNEXEC，不编造。

**完成判据**：`rsi-tick` 覆盖率 13/13；`rsi:verify` 无 anchor 断裂。

**边界**：账本是 D4，写入必须由人 `promote`；本提案不落盘。

### 10.4 本轮结论

- 已量化：视觉问题（对比度 4 处不达标、138 处字号魔数）、后端问题（3 处方向倒置、33 个大文件）、RSI 缺口（12 题可复算）。
- 未做：任何 Token/样式改动、任何 D3 拆分、任何账本写入。
- 理由：按 C1/C3，没有授权与视觉基线就改全局 Token，属于「看起来变好」；账本归人。

---

## 11. 第三轮：布局重构后的全量回归与治理对账（2026-11-13 晚）

### 11.1 本轮实跑（全部 exit 0）

| 项 | 命令 | 结果 |
|---|---|---|
| 服务端类型 + 单测 | `npm run test:acceptance` | **1507/1507（161 文件）PASS** |
| krsi 跨代对抗 | 同上 | **10/10 PASS** |
| 套件地板 / C1 / 工具契约 | 同上 | **3/3、PASS、17 工具 PASS** |
| 前端类型 + 单测 | `npm run test:acceptance` | **136/136（15 文件）+ UI 静态门禁 PASS** |
| 端到端 | `E2E_PORT=8098 bash scripts/e2e.sh` | **14/14 PASS** |

### 11.2 前端布局与能力入口（已实现并目检）

- 四区骨架：72px 能力导航 + 224px 会话栏 + 工作台 + 300/320px 检视器。
- 右栏改为「运行检视器 / 能力」双页签；治理入口与运行态分离。
- 中栏重复的标题 / 模型 / 5 个按钮头已删除。
- 能力页覆盖：判据塔、RSI、迭代闸门、沙箱权限、工具技能、模型与密钥、检查点、运行轨迹。
- 断点目检：1440 浅色 / 1440 深色 / 900 平板 / 390 手机；390 与 900 下 `docWidth == innerWidth`。
- 交互验证：「判据塔」按钮实际打开 `role=dialog`，标题正确。
- 修复的两个真实显示缺陷：空态文本 `max-content` 撑宽、390px 输入框占位裁切。

### 11.3 治理对账：D1 与域外改动

按 `AGENTS.md`，自动采纳只允许 D1（`client/src/components/`）。本轮实际改动：

| 域 | 文件 | 状态 |
|---|---|---|
| **D1（自动）** | `components/agent/*`、`components/layout/*`（含新增 SideRail / RightDock / CapabilityHost） | 符合 |
| **D2（首次需人批）** | `client/src/stores/uiStore.ts`、`client/src/lib/rsi-rules.ts` | **待人签** |
| **D4（scripts 属人）** | `server/scripts/run-krsi-conformance.mjs`（GOCACHE 兜底） | **待人签** |

补充事实：上述三个文件在 `.self-upgrade/baseline.json` 中 **protected=False**（未纳入围栏哈希），所以围栏不会因此打红；但按仓库约定，仍需人明确归因后才算合规。

**处置建议**：
- `rsi-rules.ts`：保留（修复前后端契约不一致，有门禁复验）；
- `uiStore.ts`：保留（布局重构的状态入口，删了布局即失效）；
- `run-krsi-conformance.mjs`：保留并请人重锚（否则受控环境下验收会在 krsi 段因环境变量红）。

### 11.4 风险增量

| ID | 风险 | 等级 | 处置 | 状态 |
|---|---|---|---|---|
| R-12 | 三处域外改动未获人签 | 中 | 按 §11.3 逐项确认或回退 | **待确认** |
| R-13 | 检查点 / 轨迹只验了结构与错误态 | 中 | 用真实 API + 会话回归一次 | UNEXEC |
| R-14 | 浅色 tertiary 仍 2.43:1 | 中 | 改 Token 会触发 `check-ui-static` 哈希门禁，需人重锚 | 已回退，待批 |

### 11.5 一句话结论

**布局与能力入口已经落地并有实图与全量回归背书；剩下的不是写代码，而是三处域外改动的签字与一项被门禁挡住的 Token 修正。**

---

## 12. 第四轮：构建落地、门禁前移与会话证据（2026-11-13 晚）

### 12.1 已完成的动作

| 项 | 结果 |
|---|---|
| 根构建 `npm run build` | **exit 0**；`server/dist/app.js` 与 `server/dist-client`（412 文件）就位 |
| 运行实例是否提供新构建 | **是**：live 与 disk 的入口 chunk 均为 `assets/index-gTRcOyhF.js` |
| pre-push 门禁 | 已安装 `.git/hooks/pre-push`，**实跑 exit 0**（服务端 1507 + krsi + 三道闸；前端 136 + 静态门禁） |
| 三处域外改动 | 按用户指示**保留不改**（uiStore / rsi-rules / run-krsi-conformance） |

### 12.2 「快照 + trace 会话」：阻塞，不伪造

实测读数：

- `workspace_checkpoints` **1 行**（会话 `3edb3f87…` 有快照）；
- `agent_traces` **0 行**、`agent_trace_spans` **0 行**；
- 运行实例 `GET /api/v1/traces` → `enabled=false`；
- 试用上游 `1.92.150.5:8787` 健康探测 → **unreachable**（网络错误）。

因此当前**无法产出「既有快照又有 trace」的真实会话**，两条硬阻塞：
1. 轨迹开关关闭：需 `TRACE_ENABLED=true` 并重启实例；
2. 上游不可达：需可用的 API Key 或恢复中转，否则无法驱动工具产生快照。

处置：保持 **UNEXEC**，不用脚本直接写库伪造证据。

### 12.3 Token 基线

用户要求先有「快照 + trace 会话」证据；该证据未产出前，**不重锚** `check-ui-static` 的 Token 哈希（浅色 tertiary 仍 2.43:1）。

---

## 13. 第五轮：自适应预算修复、真实会话与 Token 重锚（2026-11-13 夜）

### 13.1 修复：推理耗尽预算时不再误报空响应

| 文件 | 改动 |
|---|---|
| `server/src/services/agent/output-budget.ts` | 新增 `adaptOutputBudget()`：不低于 2048、翻倍、不超 4096；非法输入回 2048 |
| `server/src/services/agent/agent-loop.service.ts` | `maxTokens` 改为可变；`finish_reason=length` 且无正文/工具调用时**只重试一次**，回滚轮次并发送 `budget_adapted` 阶段 |
| `server/src/types/agent-events.ts` | 新增阶段 `budget_adapted` |
| `client/src/components/agent/RunInspector.tsx` | 阶段标签「自适应预算」 |
| `server/tests/output-budget.test.ts` | 5 条判据：下限/翻倍/上限/非法值/值域 |

判据：`output-budget` **5/5 PASS**；服务端 `test:acceptance` **exit 0**。

### 13.2 真实会话：快照 + trace 已产出

- 上游：ModelScope `Qwen/Qwen3.8-27B`（实测可用；DeepSeek / MiniMax 报 `has no provider supported`）
- 会话：`c03cd910-d6b3-46d6-83a2-fd2740444ec2`
- `fs.read` **success** → `fs.write` **success**（审批 token 通过后执行）
- `note.txt` 内容：**hello codelens**
- `workspace_checkpoints`：**1**；`agent_traces`：**1**

> 诚实标注：本轮 `maxTokens=512` 下模型直接发出了工具调用，**真实上游未触发自适应分支**（`adapted=0`）。该分支已改用假上游做确定性验证：`server/tests/agent-loop-e2e.test.ts` 新增用例「推理吃满预算：只重试一次并抬到 2048」，断言 `budget_adapted` 阶段出现、第二次请求 `max_tokens=2048`，**PASS**；服务端 `test:acceptance` **exit 0**。

### 13.3 Token 重锚

- 深色 `--c-text-tertiary`：`#6E7681` → `#7D8590`（5.07 / 4.64 / 4.08）
- 浅色 `--c-text-secondary`：`#6B7280` → `#4B5563`（7.23）
- 浅色 `--c-text-tertiary`：`#9CA3AF` → `#6B7280`（4.63）
- `ui-static-baseline.json` 经 `--update-baseline` 重锚；client `test:acceptance` **exit 0**
- 根构建 **exit 0**，`dist-client` 已更新

### 13.4 账本回填（promote 已执行）

- 提案：`server/candidates/ledger-backfill-2026-11-13/proposal.jsonl`（12 条，均 `reconstructed: true`）
- 备份：`.self-upgrade/ledger.jsonl.bak-20261113-promote`
- 结果：账本 **19 行**、覆盖 **13/13**、`adopted` 题 **13**、`reconstructed` **12**
- 复核：`npm run check:rsi-tick` → 「账本：19 行，覆盖 13/13」
- 仍未闭环：`exemplars.jsonl` 缺失（正例库）

---

## 14. 第六轮：api.ts 拆分第一步（HTTP 核心）

| 项 | 结果 |
|---|---|
| 新增 | `client/src/services/api-http.ts`（107 行）：`BASE / withQuery / ApiError / redactSecrets / parseErrorResponse / get / send` |
| `api.ts` | 删除本地实现，改为 import；`ApiError` 保持 re-export，公开导出面不变 |
| 验证 | `tsc --noEmit` **0 错**；client **136/136 PASS** |

| 后续步骤 | 结果 |
|---|---|
| `api-providers.ts` | 64 行；`api.ts` 改为 `export *`；tsc 0 / 136 PASS |
| `api-sessions.ts` | 61 行；tsc 0 / 136 PASS |
| `api-tools.ts` | 41 行（工具注册表 + 审批）；tsc 0 / 136 PASS |
| `api-judge.ts` | 313 行（判据塔类型 + 只读函数）；tsc 0 / 136 PASS |
| `api-rsi.ts` | 519 行（规则契约镜像 + RSI 端点）；tsc 0 / 136 PASS |
| `api-observability.ts` | 184 行（能力 / 快照 / 轨迹 / 技能库）；tsc 0 / 136 PASS |
| `api-agent.ts` / `api-mcp.ts` / `api-sandbox.ts` | 1818 / 1241 / 1318 字节；tsc 0 / 136 PASS / 根构建 exit 0 |
| `api.ts` 行数 | 1288 → **14**（纯汇总导出，拆分完成） |

下一步：按域抽 `api-providers.ts` → `api-sessions.ts` → `judge/rsi`，每步保持导出面与 136 用例不变。

---

*本文的结论只覆盖本轮实际执行的命令与读数；未执行的项已在文中标 UNEXEC。*

# 自我迭代与自我维护

> 状态：已实现（后端 `change-domain` / `iteration-gate` / `iteration-store` / 路由 `/api/v1/rsi/*`；前端「迭代闸门」面板）。
> 定位：让系统在**明确权限**下调整自己的核心内容与核心架构，并且每轮迭代都有可量化判据决定「继续、重试、回滚、待人审、停机」。

---

## 1. 一句话

**改得动，但要有人点头；改坏了，要能退回去；退不退，机器说了算。**

三件事分别对应：**变更域（权限）** → **回滚点（可恢复）** → **量化判据（去留）**。

---

## 2. 权限范围与边界：五个变更域

在这之前，边界只有一个维度：`allowed` 白名单（能不能改这几个文件）。那不足以支撑"调整核心架构"——
改一个工具、改一个服务、改目录结构、改判据，风险差三个数量级，却用同一种白名单表达。

所以引入**变更域**，按「离判据有多近」分级：

| 域 | 范围 | 谁批准 | 单轮文件上限 | 可被哪些触发方式自动进入 |
| --- | --- | --- | --- | --- |
| **D0 只读** | 不改任何文件（纯评估轮） | 无需 | 0 | 全部 |
| **D1 工具层** | `src/tools/`、`src/utils/` | 判据 + 围栏 | 6 | **全部（可全自动）** |
| **D2 服务层** | `src/services/`（非判据）、`src/controllers/`、`src/routes/`、`src/providers/` | **人**（首次） | 8 | 仅 `manual` |
| **D3 架构层** | `package.json`、`tsconfig`、`src/app.ts`、`src/config|db|types|middlewares/`、路由汇总 | **人（每次）** | 12 | 仅 `manual` |
| **D4 判据层** | `tests/`、`krsi/`、`src/services/{judge,rsi,eval}/`、`scripts/`、`self-upgrade/`、`vitest.config` | **一律禁止** | 0 | **无** |

### 三条边界规则

1. **D4 不是"高风险"，是不属于被衡量者。** 允许它改判据，等于让它自己发通行证，外置判据全部失效。
   所以 D4 拒绝的理由不是"危险"，而是"越权"——**谁批都不行**。
2. **无人值守不能碰服务层以上。** 定时/失败累计/阈值触发最多到 D1。要动 D2 以上，必须有人在场（`manual`）。
3. **域判定用「先命中先归、取最严」**：一组文件里只要有一个落在 D4，整组按 D4 处理。防止"在低域里夹带一个判据文件"。

### 与既有白名单的关系

域不是替代 `allowed`，而是**它的上位约束**：
- `allowed` 说「这一轮打算改这几个文件」；
- 域说「改这几个文件需要谁批、最多改几个」。

两者同时满足才放行。原有围栏的逐文件哈希校验完全保留。

---

## 3. 触发方式

| 触发 | 含义 | 最高可到 |
| --- | --- | --- |
| `manual` | 人发起 | D3 |
| `schedule` | 定时任务 | D1 |
| `failure-accumulation` | 同一归因层连续失败累计 N 次 | D1 |
| `threshold-breach` | L0 指标跌破阈值（如工具成功率 < 0.6） | D1 |
| `charter-drift` | 宣言/判据契约版本变化（`criteria_sha256` 变） | D1 |

前四种已经在循环里实现（失败累计 + 阈值）；`charter-drift` 的检测点在 `manifest-builder` 的判据指纹，尚未接入触发。

---

## 4. 执行流程

```
触发（5 种之一）
  │
  ├─ ① 域申请  POST /api/v1/rsi/iterations/plan
  │     给定 files + trigger + humanApproved
  │     → { ok, domain, reasons[], required?, limits }
  │     ✗ ok=false → 到此为止（不产生任何写操作）
  │
  ├─ ② 打回滚点  createRollbackPoint()
  │     git sha + 逐文件原文快照（只快照这一轮允许改的文件）
  │
  ├─ ③ Act：派单（allowed = 域内文件，模型按归因轮换）
  │
  ├─ ④ Judge：围栏七道闸 + R1–R6
  │     pass / fail / **unexec** 三态分别记录
  │
  ├─ ⑤ Decide：evaluateIteration()
  │     → continue / retry / rollback / escalate / halt
  │
  └─ ⑥ 落账：决策写入账本；人可在前端面板追加决定
        rollback → rollbackTo(point) 按快照还原（脚本执行，非 HTTP）
```

**②在③之前**，不是流程洁癖：没有回滚点就动代码，等于"能自我修改但没有闸和回滚点"，
那按宣言第 4 节是**事故预演**，不是强化。

---

## 5. 量化判据（每轮达标线）

六条判据，每条都有阈值、实际取值、以及不满足时的动作：

| 判据 | 阈值 | 不满足时 |
| --- | --- | --- |
| **G1** 跨代判定 | `verdict = improved` | `refused`/`error` → **回滚**；`not_improved`/`undecidable` → 重试 |
| **G2** 护栏不回退 | `guardRegressed = 0` | **回滚（硬）** |
| **G3** 围栏全通过 | `fail = 0` 且 `unexec = 0` | 有 fail → 重试；只有 unexec → **待人审** |
| **G4** 改动在授权域内 | `outOfScopeChanges = 0` | **回滚（硬）** |
| **G5** 判据覆盖率 | `coverage ≥ 0.5` | 重试 |
| **G6** 尝试次数 | `attempts < maxAttempts` | 用尽 → 回滚 |

### 决策优先级（从硬到软）

```
需要人批但没批        → escalate
越权 / 护栏回退 / 拒收 → rollback      ← 压过一切"再试一次"
其余 fail             → retry
只有 unexec 没有 fail → escalate      ← 不能判 continue（C4）
全绿                  → continue
```

**为什么 rollback 压过 retry**：`retry` 的前提是「上一轮没把地基弄坏」。
护栏回退、改动越域、manifest 被拒收，这三种情况下盘上的状态已经不可信；
继续在坏地基上叠加改动，只会把问题埋得更深，形成「越退越试」的死亡螺旋。

### 三态而不是两态

每道闸的结果是 `pass | fail | unexec`。把「没执行」画成红色会让人误以为跑挂了，
画成绿色更糟——那是把没跑说成通过。所以面板上「未执行」单独一档，且不计入达标。

### 置信度

`confidence = (通过的闸 / 总闸) × (覆盖率达标 ? 1 : 0.6)`。低于 0.6 建议人看一眼再继续。

---

## 6. 回滚

```ts
const point = createRollbackPoint({ id, root, files });   // 每轮开始前
// ...这一轮的所有改动...
rollbackTo(point, root);                                  // 判定为 rollback 时
```

两条腿：**git sha**（优先）+ **逐文件原文快照**（兜底，沙箱无 git 时）。

三条约束：

1. **只快照这一轮允许改的文件**，不整仓快照。几万文件的仓库整仓快照不现实，而且回滚时不该动这一轮没碰过的东西。
2. **回滚不是"撤销一切"**：只还原快照里记录的文件，别人同时提交的改动不会被误伤。
3. **回滚后账本记 `rolled_back` 并保留 diff**，供人事后复核「到底改坏了什么」。

---

## 7. 前后端协同与一致性保障

### 分工

| 端 | 负责 | 不做 |
| --- | --- | --- |
| 后端 | **唯一状态机持有者**：域判定、判据计算、决策、回滚点、账本 | 不替人做 approve 决定 |
| 前端 | 展示 + 发起命令（plan / decide） | **不自己推演状态**，不重算判据 |

### 四个一致性机制

1. **单一事实源（契约）**：`buildRsiRulesContract()` 下发 `domains` / `decisions` / `iterationCriteria`，
   前端从契约取标签与色调，不抄常量。契约里的数字（域上限、覆盖率阈值）**一律从实现 import**，
   杜绝"前端一份、后端一份"的口径漂移——这是这套系统原有的规矩，本次沿用。
2. **三组新字段是可选字段，不升契约版本**。新增可选字段不是破坏性变更；旧前端读到 `undefined` 降级，
   新前端读到就渲染。用版本号强制会让两端必须同步发布，而它们本来就允许不同步（前端有兜底契约）。
3. **动作端点只记录，不改代码**。`POST /decide` 只追加一行决策日志（含当时的判定、域、verdict），
   真正回滚由脚本按快照执行。这样"判定"与"执行"分离——任何拿到本地端口的进程都不能一条命令还原仓库。
4. **破坏性动作必须显式确认**：`action ∈ {rollback, halt}` 时后端校验 `confirm: true`，
   前端再确认一次。缺一个 `confirm` 就把代码还原了，是最难查的那类事故。

### 一次迭代的时序

```
前端                     后端
 │  POST /iterations/plan  │  域判定（纯计算）
 │ ←──── { ok, domain } ───│
 │  （ok=false 就此打住）
 │                        │  打回滚点 → 派单 → 围栏 → 判据
 │  GET /iterations        │  读账本 + 复算决策（纯函数）
 │ ←──── items+summary ────│
 │  人看判据明细            │
 │  POST /iterations/:id/decide
 │ ←──── 已记录 ───────────│  只写 decisions.jsonl
```

注意最后一步的回执文案：**「已记录回滚决定。实际还原由脚本按快照执行，本接口不改动任何代码。」**
文案撒谎比功能缺失更坏——如果按钮写"回滚"却只记了一行日志，人会在事故现场以为自己已经退回去了。

---

## 8. API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/rsi/contract` | 契约（含 domains / decisions / iterationCriteria） |
| GET | `/api/v1/rsi/iterations?limit=50` | 迭代列表 + 汇总 + 域表 |
| GET | `/api/v1/rsi/iterations/:id` | 单条迭代（含六条判据的取值） |
| POST | `/api/v1/rsi/iterations/plan` | 域申请：能不能改、要谁批、上限多少（纯计算） |
| POST | `/api/v1/rsi/iterations/:id/decide` | 记录人的决定（approve / rollback / halt） |
| GET | `/api/v1/rsi/decisions` | 决策历史（谁在什么时候拍了什么板） |

---

## 9. 判据自证（按宣言 C3）

`server/tests/rsi-iteration-gate.test.ts` 共 19 条，其中五条是**金丝雀**——专门证明判据能被打红：

| 金丝雀 | 断言 | 防的是什么 |
| --- | --- | --- |
| 护栏回退 | 必须 `rollback`，且**不能被 G1 的 retry 抢走** | 「越退越试」的死亡螺旋 |
| 越权改动 | 必须 `rollback` | 改成 WARN 就放过 |
| 闸没跑 | 必须 `escalate`（不是 continue，也不是 retry） | 把 UNEXEC 当成通过 |
| D4 判据层 | 任何情况都拒（人批了也拒） | 自己给自己发通行证 |
| 无人值守进 D2 | 拒，且点名是触发方式不允许 | 夜里自动改服务层 |

回滚点也用真实文件验证过：新建的文件回滚后被删除，改过的文件回滚后恢复原文。

---

## 10. 已登记的边界（UNEXEC，不许当绿）

1. **域信息还没进账本。** `iteration-store` 目前按题目的靶子路径**推断**域（都是 D1），
   而不是读账本里记录的域。真接上域授权后，账本要加 `domain` 字段。
2. **账本没存每道闸的原始结论**，所以 `gatesFromRow` 只能保守重建（升级=全 pass，失败=至少一道 fail）。
   这会把「本来就是 unexec」的场景记成 fail——需要账本扩展三态字段。
3. **`charter-drift` 触发未接入**：判据指纹变化时还没有自动创建迭代。
4. **D2/D3 的"首次批准"没有持久化**：现在是每轮都要 `humanApproved`，而不是「同类改动批过一次就记住」。
5. **回滚未在 HTTP 层暴露**（有意为之，见 §7 机制 3）。要真正执行回滚，目前得跑脚本。
6. **前后端一致性没有自动化测试**：契约字段靠类型镜像保证，但没有一条测试断言「前端镜像与后端契约逐字段一致」。
   这是下一步该补的——参照既有的 `rules-contract` 做法，可以加一条对比测试。

---

## 11. 无人值守连续轮转（2026-11-12 补）

之前题源耗尽后的链条是「提议 → 出题 → **等人工采纳**」，所以循环永远连不成后台连续跑。
现在把最后那一环换成四道机械闸（`scripts/auto-adopt.ts`）：

| 闸 | 判定 | 拒收理由 |
| --- | --- | --- |
| A1 来源 | 候选必须来自 `server/candidates/*.candidate.ts` + `*.spec.json` | 不接收随意路径 |
| A2 编译 | 判据在**正式落点**重编译一次 | 候选在 candidates/ 编译过，搬目录后相对路径差一级，不重验会全是 `Cannot find module` |
| A3 基线红 | 把判据放到落点跑一次 vitest：**必须有断言且失败** | 绿 = 橡皮图章；`no tests` = UNEXEC，按 C4 不等于红 |
| A4 域 | `checkDomain({trigger:'schedule', humanApproved:false})` 必须 ok | 只有 D1 工具层能自动采纳；D2 以上要人，D4 判据层永不自动 |

四闸全过才写进 `tasks.json` 与判据目录，账本记 `adopted`；落库后判据即受基线指纹保护。
**采纳不是放行，是把尺子锁进保险柜。**

循环随后 `spawnSync` 重启一个干净进程（`stdio: inherit`，逐轮输出实时可见），三道安全上限任一到点即停：

```
RSI_MAX_AUTO_ROUNDS=3          最多 3 轮
RSI_MAX_AUTO_WALL_MS=1800000   累计 30 分钟
RSI_MAX_CONSECUTIVE_FAILURES=3 账本末尾连续 3 次失败
```

配套两处：
- 围栏自动 `--exclude-judges` 排除「其他未完成题」的判据——它们按设计此刻是红的，
  放进全量会把「还没轮到的题」误判成「踩坏了既有行为」。
- `--require-all-targets`：要求 `allowed` 里**每个**靶子都变。上一轮前端题只建了新模块、
  组件没接线，围栏却因「任一文件变了」放行并升了版本——这正是本次补的假绿。

`--no-auto` / `--no-adopt` / `--no-propose` 可分别关掉自动重启、自动采纳、自主提议。

---

## 12. 合法调用探针（2026-11-12 补，取代启发式假红闸）

§11 的 A3 曾只验「判据有断言失败」。实测吃过一次大亏：出题人把整条命令行塞进
`sysExecTool.command`（真实语义是 basename + `args`），工具前置策略直接拒成
`invalid_args` / `security`。判据四条全红，A3 判「基线红成立」并采纳，
Agent 对着这把错尺子白改 3 轮 15 分钟，还被记成实现层失败。
**假红比不红贵得多**：它让自动链持续产出「看似在跑、其实无解」的题。

现在出题人必须交**两份**产物：

| 产物 | 内容 |
| --- | --- |
| `<id>.candidate.ts` | vitest 判据（含模板安全断言） |
| `<id>.probe.ts` | 合法调用探针：用一组**合法参数**真调一次 `handler`，从 `r.error.kind` 计算 `premature`，打印 `PROBE_RESULT={reachedBehavior,...}`，末尾自己调一次 `runProbe()` |

采纳器新增 **A2.5 探针闸**：
1. 源码里必须真的出现 `handler(` 与 `PROBE_RESULT=`（不许写死 `reachedBehavior:true`）；
2. 探针单独编译通过；
3. `npx tsx` 真跑一次，exit 0 且自报 `reachedBehavior === true`。

出题人得**先证明自己会正确调用靶子**，才有资格出判据。原来的信号匹配闸保留作纵深，
但降级为第二道防线——主证据是探针的实际运行结果，不是正则猜出来的。

实测单元验证：
```
_good.probe.ts  -> PASS   | 合法调用探针通过（kind=ok）
_bad.probe.ts   -> REJECT | 探针自报被前置校验拦住（kind=security）
```
（bad 探针用的正是当初骗过 A3 的那组错误参数。）

**已登记边界**：探针仍由出题人自己写，理论上可以构造一个「调用成功但与判据无关」的探针。
要堵死这一条需要判据与探针共享同一组参数并由采纳器比对，成本更高，未做。

---

## 13. 模型通道与「会话在环」Actor（2026-11-12 补）

### 13.1 先纠正一个现场判断

`TRIAL_BASE_URL=http://1.92.150.5:8787/v1` 连不上时，报的是
`UND_ERR_CONNECT_TIMEOUT`；TCP 层直接超时、`curl http_code=000`。
**这不是「模型额度用完」**——配额耗尽通常返回 HTTP 429 / `insufficient_quota`，
连接建立得起来。所以当时该做的是恢复端点或换端点，而不是换模型。

### 13.2 三条接法的实测结论

| 接法 | 实测 | 结论 |
| --- | --- | --- |
| 把当前会话的模型「外借」给后台脚本 | 会话推理没有对外暴露的 OpenAI 兼容端点或 API key | **做不到**，架构上不成立 |
| 本机 `codebuddy -p`（非交互 CLI） | 独立进程不继承会话登录态，报 `Authentication required. Please use /login`；且共用同一账号额度 | 不能用于无人值守 |
| WorkBuddy 免密钥 LLM 云服务 | 面向应用、走 SDK、校验 Origin、要 UI 确认并可能计费 | 不是给本地 Node 脚本当 OpenAI 端点的东西，未擅自开通 |

### 13.3 真正落地的：把会话接成 Actor（`RSI_DISPATCH=bridge`）

`scripts/dispatch-bridge.ts` 把派单换成「导出任务书 → 等回执」：

```
循环 → .self-upgrade/loop/bridge/inbox/<task>-<attempt>-<nonce>.json
        （含任务书全文、allowed、writeHere 绝对路径、replyTo）
会话 → 读 inbox、按任务书改文件、写 outbox/<nonce>.json
循环 → 收到回执，照常跑 判据 / 围栏 / 归因 / 账本
```

```bash
# 1) 后台起循环（桥接模式不需要 LLM 上游，会跳过预检）
RSI_DISPATCH=bridge npx tsx scripts/self-upgrade-loop.ts --only=<题>

# 2) 看有什么活
npx tsx scripts/dispatch-bridge.ts --status

# 3) 读完 inbox 改完文件后写回执
# {"nonce":"<inbox 里的 nonce>","note":"做了什么"}
```

**被换掉的只有 Actor，尺子一道没动。** 判据、七道围栏、七层归因、回滚点、
版本与账本全部照旧；`--no-auto` 等开关照常生效。

五条信任边界：

1. 桥接**绕过**了 `/api/v1/agent/stream` 的 path-jail，兜底全部落在围栏：
   git diff 只允许 allowed、受保护文件指纹不变、判据必须绿、全量必须绿。
2. 回执里的 `writes` **不被信任**。脚本自己 stat 每个 allowed 文件，
   只有 mtime 晚于 inbox 创建时间才算一次 `fs.write` —— 防止「写个回执说改了」。
3. 一次性 nonce，旧回执串轮会被拒（`BRIDGE_ABORTED=nonce-mismatch`）。
4. 有超时（`RSI_BRIDGE_TIMEOUT_MS`，默认 9 分钟），超时停机、不归因、不计入 Agent。
5. 输出的 run_report 是**等价构造**而非真 SSE，`toolCallCount` 只反映落盘事实。
   账本标 `actor=workbuddy-session`，这类轮次 `countsAgainstAgent=false`，
   **不许混进「被衡量模型」的能力统计**。

两条如实说明的取舍：

- 桥接是**会话在环**，不是无人值守；每轮要会话（或人）读 inbox 并写回执。
  桥接模式下题源耗尽也**不会**自动提议/出题/采纳——那三步要 LLM 上游。
- 它跨会话可用：inbox 在磁盘上，用户换模型后的新会话照样能接手。

### 13.4 上游预检与归因

`self-upgrade-loop.ts` 启动时会 GET 一次上游 `/models`（8 秒超时）。
连不上就打印原因、账本记 `aborted / UPSTREAM_UNREACHABLE` 并**停机**：
不派单、不消耗尝试次数、不启动自动轮转。判「可达」不判 200 —— 有些 relay
没有 `/models` 但 chat 可用；`--no-preflight` 可跳过。

归因新增 L0a2 `UPSTREAM_UNREACHABLE`（`fetch failed` / `UND_ERR_*` /
`ETIMEDOUT` / `connect timeout`）：归 infra、owner=scheduler、
`countsAgainstAgent=false`、`halt_manual`。这是**第三次**修「环境故障被记成 Agent 无能」——
前两次是 ECONNREFUSED 和 `TASKBOOK_MISSING`。正式自证见
`tests/upstream-attribution.test.ts`（6 条，含 2 条金丝雀防止把真实能力失败洗白）。

### 13.5 A2.6 探针/判据参数一致性

§12 登记的边界（探针可以「调用成功但与判据无关」）已堵：
`auto-adopt.ts` 比对判据与探针里 `X.handler!(...)` 的**工具变量名 + 第一个参数对象的键集合**，
不一致拒收。值不比 —— 判据测超时用 `timeoutMs:1000`、探针用 `5000` 是合理的。
正式自证 `tests/args-consistency.test.ts` 6 条（含嵌套对象的括号扫描）。

### 13.6 想回到全自动

不需要改代码，只要把 `.env` 的上游换成可达的 OpenAI 兼容端点：

```
TRIAL_BASE_URL=https://<你的端点>/v1
LLM_SERVER_API_KEY=<key>
RSI_MODEL=<该端点支持的模型>
```

去掉 `RSI_DISPATCH` 即回到 SSE 全自动派单 + 无人值守连续轮转。
预检会在启动时替你确认端点是否真的可达。

---

## 14. 换用 AMD Radeon OneClick 端点（2026-11-12）

### 14.1 配置

`.env` 已改（key 只在文件中，不写进文档）：

```
TRIAL_BASE_URL=https://developer.amd.com.cn/radeon/api/v1
DEEP_ASSESSOR_BASE_URL=<同上>
LLM_SERVER_API_KEY=<OneClick key>
TRIAL_MODEL=DEEP_ASSESSOR_MODEL=RSI_MODEL=Qwen3.8-27B
RSI_MODEL_ROTATION=Qwen3.8-27B,DeepSeek-V4.1-Flash,DeepSeek-V4-Flash,GLM-5.3-Flash
```

轮换序换成**该端点 `/models` 里真实存在且 `tools:true` 的四个模型**，
不再指向旧 relay 上的 `nemotron-*` / `kimi-k3` —— 否则归因一换模型就会换到不存在的名字。

实测端点：`/models` HTTP 200、0.16s、12 个模型；`Qwen3.8-27B` 具备
`tools:true` / `streaming:true` / `reasoning:true` / 262144 上下文。
服务端对未登记模型走 `CAPABILITIES.custom`（`nativeTools:true`），
BYOK 请求不受 trial 锁定覆盖，配置路径通。

### 14.2 真的额度耗尽（这次不是网络问题）

带 tools 的真实 chat 请求返回：

```
HTTP 429 {"code":"rate_limit_exceeded",
  "message":"Daily usage limit exceeded: maximum $1 per 24 hours for this OneClick user.
             It resets at 2026-11-12 03:36 UTC (2026-11-12 11:36 UTC+8)."}
```

**账户级日限额，同账号所有模型共享 → 换模型无效，只能等重置。**

### 14.3 系统新增的两道闸

`/models` 在额度耗尽时**照样返回 200**，所以 §13.4 的单跳预检会误判成健康。
现在改成两跳：

| 跳 | 判什么 | 结果 |
| --- | --- | --- |
| 1. GET `/models` | 连不连得上 | 200 只说明可达 |
| 2. POST `/chat/completions`（`max_tokens:1`） | 有没有额度 | 429 / `rate_limit_exceeded` → **停机**，并从错误里提取重置时间 |

探针本身超时而 `/models` 是 200 时**放行**（不误挡好端点），真出问题由派单阶段的归因接住。

归因新增 L0a1 `UPSTREAM_QUOTA_EXCEEDED`：infra、scheduler、
`countsAgainstAgent=false`、`halt_manual`。与 `UPSTREAM_UNREACHABLE` 分开，
因为「等重置」和「修网络」是两种处置。`tests/upstream-attribution.test.ts` 补 2 条金丝雀
（含「额度耗尽不许和连接超时混为一类」），现 8 条全过。

实测循环输出：
```
⛔ LLM 上游预检未通过：https://developer.amd.com.cn/radeon/api/v1
   额度耗尽（HTTP 429）｜重置 2026-11-12 03:36 UTC (2026-11-12 11:36 UTC+8).
   这是账户级日限额：换模型没用（同一账号所有模型共享），只能等重置。
   已停机：不派单、不消耗尝试次数、不启动自动轮转、不计入 Agent。
```
账本留 `aborted / infra / UPSTREAM_QUOTA_EXCEEDED / countsAgainstAgent=false`。

### 14.4 待验证（额度恢复后第一件事）

代码路径与配置都已验证，但**还没有一次真实派单跑通新端点**：
`reasoning:true` 模型会回 `reasoning_content`，而本项目 `custom` 能力默认
`retainReasoningContent:false`。若恢复后首轮出现 tool_call 解析异常，
先看 SSE 原文而不是改判据。还有 `contextWindow` 默认 128000、实际 262144，
偏保守只影响预算估算，不影响正确性。

---

## 15. 换用 Cloudflare Workers AI（2026-11-12）

### 15.1 端点形状：要用 OpenAI 兼容层，不是原生 `/ai/run/`

用户给的是 `https://api.cloudflare.com/client/v4/accounts/<acct>/ai/run/`，
那是 Workers AI 原生 REST（模型名放在 URL 路径里）。项目派单链路要的是
`/chat/completions` + `tools`，所以实际采用同账号下的 **OpenAI 兼容层**：

```
TRIAL_BASE_URL = DEEP_ASSESSOR_BASE_URL
  = https://api.cloudflare.com/client/v4/accounts/<acct>/ai/v1
LLM_SERVER_API_KEY = <cfut_ token>
```

`normalizeBaseUrl()` 只剥末尾的 `/chat/completions`，`/ai/v1` 前缀会保留；
服务端对未登记模型走 `CAPABILITIES.custom`（`nativeTools:true`），
`@cf/...` 这种带斜杠与 @ 的模型名没有格式校验。

### 15.2 模型筛选（关键是「真的返回 tool_calls」）

`/ai/v1/models` 不支持 GET（405），所以逐个实测。7 个候选里 6 个返回 200
（`@cf/google/gemma-3-12b-it` 403 无权限）。再对它们发带 `tools` 的真实请求：

| 模型 | ping | tool_calls |
| --- | --- | --- |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 200 | ✅ 标准 |
| `@cf/openai/gpt-oss-120b` | 200 | ✅ 标准 |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | 200 | ✅ 标准 |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | 200 | ✅ 标准 |
| `@cf/meta/llama-3.1-8b-fast-v2` | 200 | ✅ 标准 |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | 200 | ❌ 用 `<tools>` 文本而非 tool_calls |

`@cf/meta/llama-3.1-8b-instruct` 已弃用（HTTP 410，别名指向 2026-05-30 下线的模型）。

流式（`stream:true`）也验过：`delta.tool_calls` 按 OpenAI 形状增量下发，
拼接后 `arguments` 完整（`{"path":"/tmp/demo.txt"}`），末块 `finish_reason=tool_calls`；
`tool_choice:"required"` 两个主力模型都支持。

### 15.3 配置

```
RSI_MODEL = @cf/meta/llama-3.3-70b-instruct-fp8-fast
RSI_MODEL_ROTATION = @cf/meta/llama-3.3-70b-instruct-fp8-fast,
                     @cf/openai/gpt-oss-120b,
                     @cf/meta/llama-4-scout-17b-16e-instruct,
                     @cf/mistralai/mistral-small-3.1-24b-instruct
```

默认取 70B 非 reasoning 模型：`custom` 能力表 `retainReasoningContent:false`，
选 reasoning 模型会给多轮对话埋隐患。四个备胎都是实测能返回 tool_calls 的，
归因换模型不会换到不存在的名字。

### 15.4 又修一次预检（405 不等于故障）

`/ai/v1/models` 返回 `405 GET not supported for requested URI`。
§14 的两跳预检原本把任何非 2xx 都判成「不可达」，会把这个完全可用的端点误挡。
现在 404 / 405 / 501 视为「路径通、只是没实现列表接口」，继续交给
`max_tokens:1` 的 chat 探针定性。实测：

```
上游可达 …/ai/v1（/models HTTP 405（无列表接口，按可达处理） / chat 200）
```

**判据**：能不能用由 chat 探针说了算，不由「有没有 /models」说了算。

### 15.5 三个端点的最终状态

| 端点 | 状态 |
| --- | --- |
| 旧 relay `1.92.150.5:8787` | TCP 不通（网络层） |
| AMD Radeon OneClick | 端点通、`Qwen3.8-27B` 支持 tools，但账户日限额 $1/24h 耗尽，11:36 UTC+8 重置 |
| hcnote.cn | 整站 502（阿里云 ESA `orig response 5xx`），非路径/key 问题 |
| **Cloudflare Workers AI** | **可用：chat 200、标准 tool_calls、SSE 合规 → 当前生效** |

### 15.6 待验证

首轮真实派单（服务端 → Cloudflare 的完整转发、多轮工具调用、run_report 计数）
仍未跑过。若首轮出现异常，先看 `.self-upgrade/loop/sse-*.txt` 原文，
不要直接改判据。

---

## 16. 端到端复核：直接 curl 通过 ≠ 系统能跑（§15 的重要更正）

§15 的模型筛选是**直接打上游**做的：能返回 `tool_calls`、SSE 合规就判可用。
第一次自动轮转（48 秒）证明这个结论不够——链路是
`脚本 → 本地服务 → 上游`，服务端那条请求带 16 个工具、长 system prompt、
`max_tokens:8192`、`channelMode:native`，和 curl 的最小请求不是一回事。

### 16.1 现象

提议轮的 SSE 只有 `stage / meta / done`：

```
usage.completionTokens = 94~102，finishReason = stop，
但 SSE 里一条 delta 都没有，firstTokenMs = null
```

服务端旧判定只在 **0 token** 时报 `UPSTREAM_EMPTY`，所以「计费了却没内容」
被当成一次正常结束，静默插入一条空 assistant 消息。调用方拿不到任何错误码，
只会看到「模型没给提议」——又是一次环境/协议问题伪装成模型能力问题。

### 16.2 三处修复

1. **空轮判定**（`agent-loop.service.ts`）：正文与推理都为空即报
   `UPSTREAM_EMPTY`，不再看 token 数；错误消息里带上计费 token 数。
   实测现在会明写 `上游返回空响应（无正文/无推理/无工具调用，但计费 98 token）`。
2. **SSE 形状兼容**（`openai-compatible.adapter.ts`）：`choices[0].delta` 缺失时
   回落 `choices[0].message`，避免非流式/混合响应被整段丢弃。
   `tests/upstream-sse-shapes.test.ts` 4 条自证（含标准 delta 的回归保护）。
3. **原始流诊断开关**（默认关闭）：`RSI_UPSTREAM_DUMP=<文件>` 会把上游原始
   `data:` 行逐条落盘。归一化后的事件看不出「内容被谁吃了」，必须看线上原文。

dump 揭示真相：`delta` 全是空对象，只有 usage chunk 报 102 token —— **上游没把正文发出来**，
不是本项目解析错。

### 16.3 逐个模型端到端复测（同一条服务端请求）

| 模型 | 直接 curl 的 tool_calls | 服务端链路 content 块 | 提议是否落盘 |
| --- | --- | --- | --- |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | ✅ | **0**（纯空 delta） | ❌ |
| `@cf/openai/gpt-oss-120b` | ✅ | **0**（只有 reasoning） | ❌ |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | ✅ | 163 | ✅ |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | ✅ | 155 | ✅ |
| `@cf/meta/llama-3.1-8b-fast-v2` | ✅ | 162 | 未提新缺口 |

**定稿**：默认 `@cf/meta/llama-4-scout-17b-16e-instruct`，轮换序
`llama-4-scout → mistral-small-3.1 → llama-3.1-8b-fast`。
两个「直接测通过、服务端不吐正文」的模型**从轮换序剔除**——否则归因一换模型
就换到一个必然空转的名字。

### 16.4 教训与遗留

- **判据必须在真实链路上自证**：只验「上游契约」会把协议/服务端的差异漏掉。
  这和 C3「一次跑绿但破坏夹具打不红 ⇒ 不是强化」是同一个道理。
- 新默认模型能出提议，但**质量偏弱**：本轮两条新提议分别把 targetFile 指向
  `src/app.ts`（D3 架构层）和 `src/middlewares/request-log.ts`（不存在）。
  机械筛（真实文件清单 + 域判定）会挡住它们，但这也说明「能跑」和「跑得好」是两件事。
- 首轮**真实派单**（改代码 → 判据 → 围栏）仍未跑通，因为题源被机械筛挡回去了。
  这是闸在正常工作，不是故障。

---

## 17. 第四个端点：NVIDIA NIM 官方（当前生效，2026-11-12）

### 17.1 配置

```
TRIAL_BASE_URL = DEEP_ASSESSOR_BASE_URL = https://integrate.api.nvidia.com/v1
LLM_SERVER_API_KEY = <nvapi_ key>
TRIAL_MODEL = DEEP_ASSESSOR_MODEL = RSI_MODEL = nvidia/nemotron-3-ultra-550b-a55b
RSI_MODEL_ROTATION = nvidia/nemotron-3-ultra-550b-a55b,deepseek-ai/deepseek-v4.1-flash
```

`/models` HTTP 200、84 个模型。带 `tools` 的真实请求实测：

| 模型 | 结果 |
| --- | --- |
| `nvidia/nemotron-3-ultra-550b-a55b` | 200 / 1.5s / 标准 `tool_calls` ✅ |
| `deepseek-ai/deepseek-v4.1-flash` | 200 / 16.4s / 标准 `tool_calls` ✅ |
| `nvidia/llama-3.1-nemotron-70b-instruct` | 404 |
| `mistralai/mistral-large-2-instruct` | 404 |
| `nvidia/nemotron-3-super-120b-a12b` | 404 |

列表里有但端点没部署的会 404，所以**轮换序只放实测通过的两个**。

### 17.2 按 §16 的教训做端到端验证

不再只看 curl：临时切配置，跑一次真实提议轮（服务端 16 工具 + 长 prompt +
`max_tokens:8192`），并用 `RSI_UPSTREAM_DUMP` 抓上游原文：

```
chunk 总数 171 | 含非空 content 69 | 含 tool_calls 0
✔ 提议已记入 proposals.jsonl
  error-next-action｜工具报错不给下一步动作
  靶子 src/tools/builtin/fs-write.tool.ts（真实存在、D1 工具层）
```

正文完整、提议落盘，而且**质量比 Cloudflare 那批高**：从缺口池挑了真实条目，
靶子是真实文件、落在可自动做的 D1 域，可观察判据具体。
（Cloudflare 的 llama-4-scout 曾编出 `src/middlewares/request-log.ts` 这种不存在的路径。）

### 17.3 四个端点的最终对比

| 端点 | 连通 | 契约 | 端到端 | 结论 |
| --- | --- | --- | --- | --- |
| 旧 relay `1.92.150.5:8787` | ❌ TCP 超时 | — | — | 弃用 |
| AMD Radeon OneClick | ✅ | ✅ | 未测（额度耗尽） | 11:36 后可作备胎 |
| hcnote.cn | ❌ 整站 502 | — | — | 弃用 |
| Cloudflare Workers AI | ✅ | ✅ | ⚠️ 仅 3/5 模型吐正文 | 备胎 |
| **NVIDIA NIM 官方** | ✅ | ✅ | ✅ 提议落盘、质量高 | **当前生效** |

### 17.4 三层筛选的固化经验

这四轮下来，判断一个端点能否用要过三关，缺一不可：

1. **连通**：`/models` 或 chat 探针能回（注意 405 / 429 的正确解释）；
2. **契约**：真的返回标准 `tool_calls`，且流式 `delta.tool_calls` 参数完整；
3. **端到端**：走服务端那条真实请求，确认 `content` 正文真的吐出来、
   提议/派单产物落盘，且**内容质量可用**（靶子存在、域正确、判据可观察）。

只过第 1、2 关就宣布"能用"，正是 §16 那次空转的原因。

---

## 18. 出题步骤三连修 + A3 结构性冲突（2026-11-12）

端点定稿（§17，NVIDIA 550b）之后，本以为循环能直接跑通，结果出题步骤连踩三个坑，
逐一修掉，并暴露出一个**闸门与新 API 提案的结构性冲突**。

### 18.1 坑一：作者模型静默回退成 gpt-4o（最致命）

`askAuthor` 读模型用 `process.env.RSI_AUTHOR_MODEL ?? 'gpt-4o'`，但 `.env` 不会被自动注入
`process.env`，所以 `RSI_AUTHOR_MODEL` 写在 `.env` 里**根本不生效**，模型回退成 NVIDIA 上
不存在的 `gpt-4o` → NVIDIA 回 `404 page not found`。出题步骤整条静默失败，报的错还是
"出题人调用失败"这种看不出根因的话。

**修**：抽取纯函数 `resolveAuthorModel(envTxt, env)`，回退链改为
`env.RSI_AUTHOR_MODEL → .env 的 RSI_AUTHOR_MODEL → .env 的 TRIAL_MODEL → gpt-4o`，
并**用 `||` 而非 `??`**——`get()` 对缺失键返回 `''`，`'' ?? x` 不触发回退，会卡在 `''`。
这一条被新写的单测 `author-model-resolution.test.ts` 抓出：若 `.env` 没写 `RSI_AUTHOR_MODEL`，
链本应落到 `TRIAL_MODEL`（550b），却停在 `''` → 拿空模型名打 NVIDIA。

`tests/author-model-resolution.test.ts` 6 条：纯函数回退 + fetch mock 集成（直接断言发往 NVIDIA 的
是 550b 而非 gpt-4o）+ 空响应抛清晰错误。**这是整轮最有价值的回归测试**——它防止出题步骤
再次静默失效。

### 18.2 坑二：NVIDIA 偶发空响应让一条合规提议整份作废

`askAuthor` 原先用 `res.json()`，NVIDIA 偶发回空体 / SSE 流时直接抛 "Unexpected non-whitespace
character after JSON"。改成"先读全文再解析"，同时吃下标准 JSON 和 SSE 流两种形态，
空内容时抛"返回空内容"。调用点加 3 次重试，避免一次瞬时抖动废掉一条合规提议
（实测 `batch-atomicity` 正是第 3 次才成功）。

### 18.3 坑三：出题人把判据和探针塞进同一个代码块 → 探针被判定缺失

模型常把判据 + 探针写进同一个 ```` ```typescript ```` 块，`extractBlocks` 只抽到 1 块 → 探针判缺失
→ 整份作废。修：缺失探针时回灌一次，明确要求"两个独立 ```` ```typescript ```` 块"；同时把出题提示词
里"探针不要写文件"的误导改成"写类工具的最小合法调用就是写一个极小临时文件，且 `operations`
必须非空合法"。

### 18.4 前置筛（§17 之后补的，本轮一起验）

`authorPrecheck`（纯函数 + 7 条单测）在 `askAuthor` 之前挡掉：已完成 / 已归档 / 靶子不存在 /
域不允许（D2/D3）。实测把 6 条提议筛到只剩 2 条触达模型，省下 4 条白烧。

### 18.5 关键发现：A3 闸门 vs 新 API 提案的结构性冲突

出题步骤（550b）倾向提"要新增 API"的缺口。本轮两条 D1 合规提议：

| 提议 | 判据测什么 | 闸门结论 |
| --- | --- | --- |
| `error-next-action` | 错误里要有 `nextAction` 字段 | **A2 编译闸拒**：判据引用当前 `ToolError` 没有的 `nextAction` |
| `batch-atomicity` | 多文件 `operations` 原子写 | **A3 基线红不成立**：当前 `fs-write` 没有 `operations` API，工具把参数打成 `invalid_args`，判据连被测行为都没走到 → 假红 |

A3 的设计（`auto-adopt.ts` 扫描 vitest 输出里的 `Received: invalid_args` 等特征）是**对的**——
它要区分"缺口没实现（真红）"和"判据自己没走到行为（假红）"，避免 Agent 对着错尺子白改。
但"新增 API"类提案天然会让判据在现有代码上拿到 `invalid_args`，于是被当成假红拒掉。

**结论**：当前"判据先行、后实现"的管线，只适合**测现有 API 上的行为缺陷**的提议；
"新增 API"类提议需要先实现 API、再采纳判据，或把 A3 改成"新 API 提案特许"模式。
这是本轮暴露的真实设计张力，不是 bug——但意味着要让循环真正落地改进，
要么把出题提示词转向"现有行为缺陷"，要么给管线加一个"先实现后采纳"的阶段。

### 18.6 验证（本轮回合）

- server 新增 `tests/author-model-resolution.test.ts`（6）、`tests/author-precheck.test.ts`（7）
- 出题器 `scripts/author-task.ts`：tsc 零报错；A1–A3 + 探针 + 空响应重试 + 模型回退链全部就位
- 全量 `npx vitest run` 与判据自证闸（judge-audit --strict）需在本回合末尾复跑确认绿

---

## 19. A/B 双轨出题 + 出网限速（在 §18.5 张力之上收口）

§18.5 暴露的真问题：当前「判据先行、后实现」的管线，只服务**测现有 API 行为缺陷**的提议；
「新增 API」类提议会让判据在现有代码上拿到 `invalid_args`（假红），被 A3 拒掉。
本轮（指令 `a,b同时走，顺便api限速，每分钟40`）把两条路径**同时打开**，并给所有出网 LLM 调用
加统一限速。

### 19.1 两条路径（gapType 路由）

出题器 `scripts/propose-gaps.ts` 在 JSON 里强制二选一写 `gapType`：

- **A 路径 · defect（默认，优先）**：系统**已有**这个能力，但某些输入下行为错误 / 不安全 /
  不符合预期，且能用**现有**公开 API 直接复现、直接验证。**严禁**新增字段 / 参数 / 导出。
  这类提议走 `red-baseline` 采纳模式：A3 基线必须红（判据直接测到缺陷）、A4 域闸通过即采纳。
- **B 路径 · capability**：确实做不到、必须**新增 API / 字段 / 导出**才能满足。
  走 `implement-first` 采纳模式：A3 判据在现有代码上跑不到行为是**预期**的（premature=真红的反面），
  不是假红——`auto-adopt.ts` 不再拒，而是先把候选派给 `implement-task.ts` 让 Agent 真去实现该能力，
  实现后重跑判据变绿，再采纳。

`author-task.ts` 出题提示词按 `gapType` 切 `typeRule`：defect 段重申"禁止新 API"，capability 段
显式标注"走 implement-first，允许新 API 提案"。写入 spec 时带 `mode` 字段
（`capability → 'implement-first'`，否则 `'red-baseline'`）。

### 19.2 A3 路由纯函数 `routeAfterA3`

`auto-adopt.ts` 抽出纯函数 `routeAfterA3(spec, a3)` → `{action:'adopt'|'reject'|'implement', reason}`：

| 条件 | action |
| --- | --- |
| `a3.ok`（基线确实红） | `adopt` |
| 非 implement-first 且 `!a3.ok` | `reject`（defect 假红=判据没测到缺陷，拒） |
| implement-first 且 `a3.premature`（跑不到行为） | `implement`（先实现能力） |
| implement-first 且 `!a3.ok` 且不 premature | `reject`（实现已存在却没红，判据错，拒） |

`action==='implement'` 时 `spawnSync('npx','tsx','scripts/implement-task.ts',\`--id=${spec.id}\`)`
（超时 30 分钟），读回 `IMPLEMENTED=1` 记为 adopted。
`routeAfterA3` 被 `tests/auto-adopt-route.test.ts`（6 条）覆盖全态。

### 19.3 出网 API 限速（统一闸门）

**动机**：self-upgrade 循环里出题人（550b@NVIDIA）、auto-adopt 等会高频打外部 LLM，NVIDIA 有
明文 RPM 上限，超限即 `429`。此前 `error-next-action` 那条就是踩线后整份静默作废。

**设计**（`src/providers/rate-limit.ts`，新增）：
- 默认 `LIMIT = Number(process.env.RSI_API_RPM ?? 40)` 次 / `WINDOW_MS = 60_000` 毫秒，按 **host**
  维度计数（adapter 的 `baseUrl`、author-task 直连 NVIDIA 的 `base` 都过同一函数）。
- 跨进程共享：用锁目录 + 时间戳文件（默认 `os.tmpdir()/rsi-ratelimit`，`RSI_RATE_DIR` 可配），
  多个 `tsx` 脚本并发跑也能合并计数。
- 纯函数 `computeRateWait(timestamps, now, limit, windowMs): number`：`-1` 表示立即放行，
  否则返回需等待毫秒（滑到最旧请求出窗口）。
- `acquireRateLimit(baseUrl)` 进程内用 `chains` Map 串行化同 host 请求，保证计数不竞态。

**接线**：
- `openai-compatible.adapter.ts` 的 `postOnce`：`await acquireRateLimit(params.baseUrl)` 放在
  `this.fetchFn(...)` 之前（覆盖所有经 adapter 出网的 LLM 调用）。
- `author-task.ts` 的 `askAuthor`：解析出 `base` 后 `await acquireRateLimit(base)`（覆盖直连 NVIDIA）。

`computeRateWait` 被 `tests/llm-rate-limit.test.ts`（5 条）覆盖：窗口未满 / 刚满 / 过滤旧时间戳 /
`limit=1` / 空数组五种。

### 19.4 本轮验证

- 改 `propose-gaps.ts`（`gapType` 必填 + 提示词转向）、`author-task.ts`（`gapType`→`mode` 路由）、
  `auto-adopt.ts`（`routeAfterA3` + implement 分支）、新增 `rate-limit.ts`、`implement-task.ts`、
  `tests/llm-rate-limit.test.ts`、`tests/auto-adopt-route.test.ts`。
- `npm run typecheck` 零报错；`npx vitest run` 全绿（135 文件 / 1295 用例，含 11 条新增）。
- 未做：限速保护下的有界实跑（propose→author→adopt 让一条 defect 被采纳）——依赖真实 NVIDIA key，
  留待下一轮在线验证。

### 19.5 下一步

1. 限速保护下实跑 A 路径，确认一条 defect 提议能过 A1–A4 被采纳（闭环价值最高的一类）。
2. 选一条 capability 提议跑 B 路径，验证 `implement-first` 真能落地新 API 并让判据变绿。
3. 观察 `RSI_RATE_DIR` 跨进程计数在并发出题/采纳脚本下是否无竞态。

---

## 20. 让出题 Agent 真正变强：正例库 / 死题淘汰 / 围栏重试

§19 之后做了四轮在线协同迭代，闭环第一次真正跑通（`fs-delete-dir-requires-recursive`
从提议 → 自证红 → A1–A4 采纳 → 派单 41s 实现 → 围栏 PASS）。复盘时发现：
**每一轮失败都对应一个「它拿不到的信息」，而不是「它不够聪明」**。
本节记录据此做的三项供给侧改进。

### 20.1 短板 → 补给的对应关系

| 观察到的失败 | 真实短板 | 补给 |
| --- | --- | --- |
| 判据写 `error.matches`（TS2339） | 不知道返回值字段契约 | `TOOL_CONTRACT` 冻结契约（§19 已做） |
| 探针写 `operations:[...]`（invalid_args） | 不知道工具入参 schema | `schemaOf()` 注入真实 inputSchema（§19 已做） |
| 同类错连犯三次 | 没有跨轮记忆 | `rejections.jsonl` 错题本（§19 已做） |
| 把「现状就对」写成缺陷题 | 不会证伪自己 | 出题时自证基线红（§19 已做） |
| 读文件读到被截断 | 没有预算纪律 | 迭代 6→12 + 「读≤3 次必须作答」（§19 已做） |
| **连续三轮都写成「要新字段」** | **只被告诉「别怎么做」，没被展示「该怎么做」** | **正例库 `exemplars.jsonl`**（20.2） |
| **同一死题每轮重出、每轮作废** | **没有失败次数上限** | **`isExhausted()` 死题淘汰**（20.3） |
| **围栏偶发假红导致无谓重派** | **无法区分 infra 抖动与真回归** | **全量回归重试一次**（20.4） |

### 20.2 正例库：错题本的反面

错题本只说「这样写会被拒」，模型仍然不知道正确形状。实测最有效的输入是**一条真正被采纳过的提议**——
它同时展示了：靶子怎么选、证据怎么带到行号、可观察项怎么写、以及「现有参数在某输入下没被正确处理」
这个共同形状（而不是「加个新字段」）。

- `scripts/lib/agent-feedback.ts` 新增 `Exemplar` 类型、`appendExemplar` / `readExemplars` /
  `formatExemplars` / `recentExemplars`，默认落 `.self-upgrade/exemplars.jsonl`（`RSI_EXEMPLAR_FILE` 可配）。
- **自动沉淀**：`auto-adopt.ts` 在四闸全过、写入 `tasks.json` 之后，从 `proposalContext(id)` 取回
  原始 `evidence / observable`，追加一条正例。成功经验由管线自己积累，不靠人手写。
- **注入**：`propose-gaps.ts` 提示词在「历史错题」之后加「成功样例」，取最近 2 条。
  `formatExemplars` 会显式点出共同形状：*不是「加个新字段」，而是「现有参数在某个输入下没被正确处理」*。
- 单测 `tests/agent-exemplar.test.ts`（10 条）：空库兜底、字段完整、超长截断、坏行跳过、
  以及一条防回归断言——**仓库里的正例库不能被误清空，且必须带行号证据**。

### 20.3 死题淘汰：别把同一笔 token 烧两遍

出题失败时会把 `candidate.ts / probe.ts / spec.json` 删掉、只留 `draft.ts`，
于是 `author-task` 的幂等检查（「三件齐全才跳过」）永远拦不住它 ——
实测 `orphan-tool-gate` 连续两轮重出、两次作废，纯烧调用。

- `agent-feedback.ts` 新增 `authorFailures(id)`（只统计 `author-compile` / `author-baseline` 两个阶段）
  与 `isExhausted(id, max=2)`。
- `author-task.ts` 在幂等检查之后加：已失败 2 次 → 打印「判为死题，跳过（--force 可重试）」并 continue。
- 单测覆盖：只统计出题阶段（采纳阶段失败不算）、不同 id 不互相牵连、2 次判死、1 次不算。

### 20.4 围栏全量回归：重试一次以区分抖动与真回归

实测吃过的亏：同一份代码，循环内报 `FULL_SUITE_RED`，会话手动原样复跑同一条命令却全绿
（139 文件 / 1324 用例）。那次假红让循环白重派一轮，还挂起 9 分钟 —— 而墙钟是循环唯一的硬上限。

`check-self-upgrade.mjs` 改为：全量回归失败 → **重试一次**（同一组 `--exclude`）。
- 第二次绿：`PASS 全量回归通过（首次红不可复现、重试转绿 → 判为抖动，不计入能力账）`。
- 两次都红：`FAIL 全量回归连续两次红 —— 可复现，判为真回归`，并打印第二次的失败行。
- 真回归两次都红，重试成本（几分钟）远小于误判成本（重派 + 挂起）。

### 20.5 一个运维坑：改完尺子必须重打基线

围栏的受保护检查基于 `--baseline` 快照。会话修改 `scripts/`（出题/采纳/围栏本身）后，
**旧基线立刻失效**，手动跑围栏会报一堆「受保护文件被修改：scripts/...」，
看起来像 Agent 越权，实际是基线过期。自动循环每道题派单前会重打基线，所以只有手动跑才会踩到。
现在围栏在该分支直接打印这条指引，避免再次误判。

### 20.6 本轮验证

- `npm run typecheck` 零报错。
- `tests/agent-feedback.test.ts`（11）+ `tests/agent-exemplar.test.ts`（10）共 21 条通过。
- 围栏原样复跑（重打基线后）PASS，全量回归通过（未触发重试路径）。

### 20.7 下一步

1. 带正例库跑一轮完整闭环，对比「同一模型在有/无正例时提出的 defect 形状」。
2. 观察死题淘汰是否让每轮的有效提议密度上升（同样的墙钟内过闸数）。
3. 若正例库累积到 5 条以上，评估是否按 `targetFile` 分类注入（不同靶子给不同样例）。

### 20.8 多轮协同实录：一条闭环暴露的 6 个新短板

带着正例库跑第 5 轮，Agent 自己提出了 `fs-write-delete-recursive-missing-schema`——
**它是从上一轮已采纳题的修复里读出来的配套缺陷**：上一题加了「目录且非 recursive → invalid_args」
守卫，但 `inputSchema` 里根本没有 `recursive`（且 `additionalProperties: false`），
所以传 `recursive: true` 会被 schema 拒，目录永远删不掉。方向完全正确。

这条闭环随后连续暴露 6 个问题，逐一修掉：

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | 一条提议回灌时空响应 → `FATAL` → 整轮 25 分钟作废，排队提议全没轮到 | 编译失败回灌处 `await askAuthor()` 没有 try/catch，异常冒到 main 的 FATAL 出口 | 回灌处加 try/catch；**for 循环体整体加 try/catch**，单题异常只作废这一题 |
| 2 | 「出题人返回空内容」连试三次 | 推理模型的思考全在 `reasoning_content`，提示词变肥后 4096 token 被思考吃光，`content` 返回 `null` | `max_tokens` 4096→8192；解析 `finish_reason`，`length` 时给专门错误；加 `RSI_DEBUG_RAW` 打原始响应 |
| 3 | 判据明明有真红（`expected false to be true`）却被判「假红」作废 | `PREMATURE` 正则把 `TOOL_INVALID_ARGS` 一律当「没走到行为」，而本题缺陷**就是** schema 拒绝参数 | 分层判定：硬错误（`Cannot find module` / `is not a function` / `ENOENT` / `TOOL_SECURITY_DENIED`）无条件假红；软错误（`invalid_args`）只在「一条都没通过」时才算假红 |
| 4 | A2.6 拒：探针 `{content,operation,path}` vs 判据 `{operation,path,recursive}` | 题型是「某条分支被错误拒绝」，探针**不可能**合法走那条分支 | 加「部分一致」：同工具 + 共享 ≥2 键 + **两边各有独有键** → 视为测不同分支放行。子集式漏参数（金丝雀）仍拒 |
| 5 | 同一份探针第一次 `kind=ok`、第二次 `kind=invalid_args` | 探针在 `candidates/` 里跑，`create` 留下文件；重跑时「已存在」→ invalid_args | 探针放进 `server/.probe-run-<pid>-<ts>/` 一次性沙箱跑（与 candidates 同级，`../src/` 仍解析正确），跑完即删 |
| 6 | 判据通过、tsc 必挂（`TS2322`） | 判据断言 `kind: 'precondition_failed'`，**该值不在锁定的 10 值 `ToolErrorKind` 枚举里**；Agent 为满足判据把实现改成返回非法 kind | 修判据（`invalid_args`）+ 修实现；把 10 个合法值写进 `TOOL_CONTRACT`；`judgeLint` 加机械闸：断言非法 kind / 断言 `summary` 文案一律拒 |

第 6 条最值得记：**自证红闸无法区分「因缺陷而红」和「因判据写错而红」**。
判据断言一个不存在的枚举值，基线那侧当然红（现状返回 `invalid_args`），自证闸判「真红」放行；
接着 Agent 为了迎合判据，把实现改成返回非法 kind —— 判据把实现带进了沟里，
表现却是「类型检查不通过」，归因还会落到 Agent 头上。

顺带修掉一个**形同虚设的闸**：`judgeLint` 的业务模块 import 检查只认 `../src/`，
而判据最终放在 `tests/self-upgrade/`（`../../src/`），所以对真实形态的判据从来不生效。
写单测时才发现。现改为「相对路径且指向 `src/`」。

`tests/judge-lint.test.ts`（9 条）钉住这些约束，其中一条专门验证 `toBeTruthy` 不被误伤。

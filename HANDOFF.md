# 交接文档 — 自我升级系统（RSI）

> ⚠️ **本文写于 2026-11-11（2.5.0），状态已过期。最新状态看 [`RSI-HANDOVER-2026-11-12.md`](./RSI-HANDOVER-2026-11-12.md)（2.10.0）。**
> 本文的第 1 节（系统在做什么）、第 2 节（三条信任边界）、第 5 节（命令）、第 7 节（坑）仍然有效，可当系统说明读；
> **版本号、测试数、题目数、账本数字一律以新文档为准。**

> 交接时间：2026-11-11 · 版本 **2.5.0** · 全量回归 **124 文件 / 1218 用例全通过**
> 本文写给接手的人：先读第 1、2 节知道系统在做什么、现在什么状态；
> 要动手就看第 5 节命令和第 7 节坑。**第 7 节是这份文档里最值钱的部分**，那都是踩出来的。

---

## 1. 这是什么

一个能**改自己源码**的 Agent 系统：给它一道题（"这里有个能力缺口"），它自己读代码、
写代码、自查，然后由**外置判据**机械判定这次改动算不算一次升级。通过就升版本号、记账本。

判断"算不算"的三条硬标准，缺一不可：

1. **靶子真的变了**（内容哈希，不看 git 状态）
2. **判据绿、类型绿、全量回归绿**（三者缺一不可）
3. **尺子没被动过**（受保护路径逐文件 sha256 + 判据文件指纹）

### 三条信任边界（这是整个设计的地基）

| 谁 | 能做什么 | 不能做什么 |
| --- | --- | --- |
| **Agent**（被衡量的） | 改 `src/` 下允许清单里的文件、读写沙箱内文件、查语法、跑测试 | 改 `tests/` / `krsi/` / `judge/` / `rsi/` / `eval/` / `scripts/`；改判据；写账本 |
| **循环**（调度者） | 起服务、打基线、派单、跑围栏、归因、记账、升版本 | 替 Agent 写实现；替出题人写判据 |
| **人** | 出题、改判据、采纳提议、放行特例 | —— |

**一句话**：尺子在它够不到的地方。所以 Agent 不能靠改判据让自己通过，也不能靠改账本让自己好看。

---

## 2. 当前状态

| 项 | 值 |
| --- | --- |
| 版本 | 2.5.0（四个 package.json + 两个 lock 一致） |
| 测试 | 124 个测试文件 / 1218 条用例，全通过 |
| 账本 | 19 行：升级 3 次，带归因失败 6 次 |
| 题目 | 7 道，全部完成（ip-form / obs-render / code-check / fs-replace / code-check-column / test-run-scaffold / test-run） |
| 待出题提议 | 1 条（`tool-use-coach`，它自己提的，见第 8 节） |
| 默认模型 | `nemotron-3-ultra-550b-a55b` |

最近三次升级：

| 题 | 版本 | 交付了什么 |
| --- | --- | --- |
| `code-check-column` | 2.4.0 | 语法错误从"只报行"变成"行 + 列"，Agent 不用在整行里肉眼找 |
| `test-run-scaffold` | 2.5.0 | `test.run` 骨架 + 三个安全校验 + 注册 |
| `test-run` | 2.5.0 | 执行逻辑：跑 vitest、读回断言差异、超时熔断、环境白名单 |

> `test-run-scaffold` / `test-run` 这两条的账本 `version` 字段是 `null`：
> 当时 `bumpVersion` 静默失效（已修，见 4.7）。版本号是事后补升并统一的。

---

## 3. 一次升级的完整链路

```
tasks.json（题源）
   │
   ▼
startLoopService()          专用 8099 实例：沙箱根=server/、独立 db、权限最小化
   │                        ✗ 不复用外部实例（复用的实例会成孤儿 → 派单时 ECONNREFUSED）
   ▼
check-self-upgrade --baseline   打基线：受保护文件指纹 + 靶子初始内容
   │
   ▼
task-self-upgrade.ts --task=<id>   派单：任务书 + 工具 + 迭代/预算上限
   │                                Agent 在这里改代码（沙箱内，它够不到尺子）
   ▼
check-self-upgrade --full        围栏六道：
   │                             ① 受保护路径零改动  ② 判据指纹未变
   │                             ③ 靶子被改动        ④ 类型通过（tsc）
   │                             ⑤ 判据通过          ⑥ 全量回归通过
   ├── 全 PASS → bumpVersion() + 账本记 upgraded
   │
   └── 有 FAIL → diagnose()：编译器错 + 未使用符号 + 断言差异 → 喂下一轮
                    │
                    ▼
              attributeFailure()   七层归因 → nextAction 决定：换模型 / 拆题 / 停机 / 重派
                    │
                    ▼
              账本记 failed（带 layer/code/owner/countsAgainstAgent）
                    │
                    ▼
              题源耗尽 → propose-gaps.ts 让它自己提名下一个缺口
```

### 失败归因的七层（`server/docs/rsi-failure-attribution.md`）

从外到内判定，**先命中先归**——因为外层坏了会把内层污染得一模一样
（服务没起来时判据当然全红，看起来和"实现全错"没有任何区别）。

| 层 | 信号 | 责任人 | 计入 Agent |
| --- | --- | --- | --- |
| `infra` 环境 | ECONNREFUSED / 服务未就绪 / **上游空响应** | 调度器 | 否 |
| `budget` 资源 | budget_exhausted / max_iterations / **输出截断** | 出题人 | 否 |
| `behavior` 行为 | `toolCallCount=0` 且无写入 | 模型 | 否 |
| `spec` 规格 | 读调用占比 ≥0.7 且零写入（在研究而不是在做） | 出题人 | 否 |
| `integration` 集成 | 判据绿 +（回归红 或 tsc 红） | **Agent** | **是** |
| `implementation` 实现 | 判据红且靶子已改（兜底层） | **Agent** | **是** |
| `judge` 判据 | 判据指纹被改 / 判据自身 import 错 | 出题人 | 否（**停机**） |

**只有 L4/L5 进能力账**。这是"量得到"和"学得到"的分界：把环境故障记成 Agent 失败，
学习信号就被污染，循环会去"训练"一个根本没被派单的 Agent。

---

## 4. 本轮做了什么（7 项）

### 4.1 失败归因分层（核心）

**问题**：账本只有 `verdict: "failed"`，七种完全不同的失败压成一个词。循环分不清
"换模型/拆题/修判据"，会重复派一个不可能完成的任务。

**做法**：`scripts/failure-attribution.ts` 七层纯函数，只吃机械信号（进程退出码、
run_report 计数、围栏四道独立布尔、诊断原文）。`nextAction` 真的改变控制流：
`retry_same` 不消耗尝试次数、`switch_model` 自动换模型、`halt_manual` 停机。

**证据**：8 个真实现场回放 8/8 通过（`.self-upgrade/loop/attr-check.mts`）。
端到端跑出的账本里出现 `behavior/NO_TOOL_CALL → switch_model`，
`failure-stats` 输出「test-run：从未进过实现层 —— 问题不在 Agent」。

### 4.2 LLM 接口修三处

| 毛病 | 后果 | 修法 |
| --- | --- | --- |
| 上游返回**空响应**（0 token）被记成 `stop` | 一次接口故障在 run_report 里与"模型只说不做"**完全同形**，会被错记成模型能力缺口 | 新增 `UPSTREAM_EMPTY` 错误码 + `upstream_empty` 阶段 |
| `finish_reason=length`（输出截断）记成 `stop` | "写了一半"和"写完收工"没区别 | detail 明写截断，message 记 `length`，归因新增 `OUTPUT_TRUNCATED` |
| `maxTokens` 硬上限 8192 | —— | 保持（8192 够写 200 行），只在超限时报清晰错误 |

实测撞到：某网关上的 `claude-3-5-sonnet` 首字节回来了、流正常结束、**0 token**。

### 4.3 循环自管服务生命周期

`scripts/loop-service.ts`：专用 8099 实例、`SANDBOX_ROOT=server/`、独立 db、权限最小化
（只开 `fsDestructive`，`httpWrite` 保持关闭）、用完即停。

**关键教训**：**不复用外部实例**。原来"端口有合规服务就直接复用"省 20 秒启动，
实际是把生命周期让给别人——父循环一停，被复用的实例成了孤儿，下一轮派单
`ECONNREFUSED`，而日志还写着"服务：已启动"。**一个管不住生死的"在线服务"比明确的报错更危险。**

### 4.4 让 Agent 自主扩展题源

三段式，卡死自利：**被衡量者只提名缺口，不写判据**。

- `scripts/propose-gaps.ts`：输入 = 工具清单 + **真实源码文件清单** + **失败归因聚合**。
  输出的 schema 里**没有 judge/allowed 字段**（不是提示词说不许，是无处可写）；
  它只输出文本，提议由循环代写进 `.self-upgrade/proposals.jsonl`（沙箱外，它够不到）。
- `scripts/author-task.ts`：出题人模型写行为断言 + **模板生成的安全断言**（不经模型，
  模型偷不掉底线）+ 判据草案**必须能编译**（挡住编造 API）。
- 产物落在 `server/candidates/`，**不进仓库**；采纳才写进 `tests/` 与 `tasks.json`，
  落库后即受指纹保护。

**闭环已跑通**：它读完归因后提名了「模型漏调工具无自动纠偏」——正指自己反复失败的
`NO_TOOL_CALL ×3`，靶子落在真实存在的 `agent-loop.service.ts`。

细节见 `server/docs/rsi-self-expansion.md`。

### 4.5 围栏补两道闸

- **`tsc --noEmit` 门禁**：之前"判据绿 + 类型红"也算升级（漏过一个 `summary` 缺失）。
  vitest 用 esbuild 转译，**不做类型检查**——判据绿 ≠ 能构建。
- **`--exclude-judges`**：拆题时第一步的全量回归不该跑第二步判据（那时执行逻辑还没写）。
- **`--accept-current=<理由>`**：判据被修正后靶子可能已经做对，"靶子被改动"永远不成立。
  这道闸要防的是蒙混过关，所以放行必须由人给理由、原样打进围栏输出与账本。

### 4.6 拆题：一次派单别让它写 200 行

`test-run` 拆成 `test-run-scaffold`（骨架+三校验+注册，约 50 行）+ `test-run`（补执行逻辑）。

**为什么**：二分实验——极小任务它 91 秒就调了两次工具并落盘；而 8k token 的任务书
会让它先花 9~17 次工具调用"研究"，再写 24k~30k 字符"计划"，输出上限在计划阶段就用完，
**一个字节没落盘**。所以失败主因是**任务粒度**，不是模型或链路。拆完后第一步 24 秒通过全部六道围栏。

### 4.7 版本号静默失效（已修）

`bumpVersion` 原来用 `execFileSync('node', ['-e', <一大段内联 JS>])`：Windows 下
`shell:true` 不转义参数，脚本被命令行切碎；路径又按仓库根写而 cwd 是 `server/`。
两个问题叠加，**它从来没成功升过版本**，而循环照常打印"升级成立"。

已抽成 `scripts/version-bump.ts`（纯 fs 操作），`findRoot` 找同时含 `server/` 与 `client/` 的那层。

---

## 5. 怎么跑

### 环境要求

`server/.env` 需要：

```bash
TRIAL_BASE_URL=http://...        # OpenAI 兼容端点
LLM_SERVER_API_KEY=sk-...        # 凭证
AGENT_TOKEN_BUDGET_FACTOR=4      # 预算 = 上下文窗口 × 该系数（128000 × 4 = 512k）
```

### 常用命令（都在 `server/` 下执行）

```bash
# 跑一轮自我升级（题源耗尽时会自动提议）
npx tsx scripts/self-upgrade-loop.ts
npx tsx scripts/self-upgrade-loop.ts --dry              # 只看计划
npx tsx scripts/self-upgrade-loop.ts --only=test-run    # 只跑某题
npx tsx scripts/self-upgrade-loop.ts --no-propose       # 关掉自动提议
npx tsx scripts/self-upgrade-loop.ts --no-bump          # 不升版本

# 围栏（单独用）
node scripts/check-self-upgrade.mjs --baseline --allowed=<f1,f2> --judge=<t>
node scripts/check-self-upgrade.mjs --allowed=<f1,f2> --judge=<t> --full

# 归因统计（学习信号）
node scripts/failure-stats.mjs
node scripts/failure-stats.mjs --json

# 自主扩展
npx tsx scripts/propose-gaps.ts                # 让它提名缺口（服务不在会自己起）
npx tsx scripts/author-task.ts --only=<id>     # 出题人写判据草案 → server/candidates/

# 看任务书原文（排查"它到底看到了什么"）
npx tsx scripts/task-self-upgrade.ts --task=<id> --print

# 光起服务（调 API 用）
npx tsx -e "..."  # 或直接 npx tsx src/app.ts（需自行设 SANDBOX_ROOT）
```

### 新加一道题要做的四件事

1. 在 `server/tests/self-upgrade/<id>.test.ts` 写判据（**只锁可观察行为**）
2. 在 `server/self-upgrade/tasks.json` 加条目：`id / title / allowed / judge / maxAttempts`
3. 打基线：`node scripts/check-self-upgrade.mjs --baseline --allowed=... --judge=...`
4. 跑：`npx tsx scripts/self-upgrade-loop.ts --only=<id>`

---

## 6. 关键文件地图

### 循环与门禁（`server/scripts/`）

| 文件 | 作用 |
| --- | --- |
| `self-upgrade-loop.ts` | 主循环：派单 → 围栏 → 归因 → 决定下一步 |
| `loop-service.ts` | 服务生命周期（起/停/健康校验/权限收紧） |
| `check-self-upgrade.mjs` | **围栏**：六道闸的机械判定 |
| `failure-attribution.ts` | **七层归因**（纯函数，可回放） |
| `failure-stats.mjs` | 归因聚合 → 学习信号 |
| `propose-gaps.ts` | 让它提名缺口（不可写判据） |
| `author-task.ts` | 出题人写判据草案（必须能编译） |
| `task-self-upgrade.ts` | 派单脚本（任务书 + HTTP 调用 + SSE 存档） |
| `version-bump.ts` | 升版本（纯 fs，无 shell） |

### 数据与产物（`.self-upgrade/`，**在沙箱外，Agent 写不到**）

| 文件 | 内容 |
| --- | --- |
| `ledger.jsonl` | 账本：每次派单一行（含 layer/code/owner） |
| `baseline.json` | 当前基线（受保护文件指纹 + 靶子初始内容） |
| `proposals.jsonl` | Agent 提名的缺口 |
| `loop/diag-*.txt` | 每轮诊断（喂给下一轮的原文） |
| `loop/sse-*.txt` | 每轮 SSE 原文（排查"它到底回了什么"） |
| `loop/taskbook-*.txt` | 任务书快照（`--print` 的产物） |

### 判据（`server/tests/self-upgrade/`，**受保护**）

`test-run-scaffold.test.ts`（骨架+安全边界）· `test-run.test.ts`（执行行为 C1–C10）
· `fixtures/probe.test.ts`（夹具，默认全绿，靠 marker 切换行为）

### 文档

`server/docs/rsi-failure-attribution.md`（七层归因）·
`server/docs/rsi-self-expansion.md`（自主扩展及其边界）

---

## 7. 坑（这一节最重要）

### 7.1 任务书必须与现场一致 —— 踩了两次

- 第一次：任务书里"index.ts 当前全文"是**实时读的**，而上一轮已注册过 → 它发现
  "你让我加，但全文里已经有了"，从这一步开始推演任务书是不是错的，
  **一路推理到 29k 字符、max_tokens 写满、零工具调用**。
- 第二次：靶子文件已存在，任务书却说"新建" → 5 个模型全去读文件，一次没写。

**规矩**：生成任务书时，凡是展示"现状"的内容都要按现场剥离/切换文案。

### 7.2 提示词里的反引号会终止模板字符串 —— 踩了两次

在 TS 模板字符串里写 `` `const x = ...` `` 或 `` `{` `` 会直接截断外层模板，
报 `Expected ";" but found "{"` 之类的语法错。**写提示词时不要用反引号**，用引号或「」代替。

### 7.3 Windows + `shell:true` + 路径空格

参数不会自动转义，`C:\...\新建文件夹 (2)\...` 会被切碎，tsc 报 `File not found`——
**看起来像文件没了，其实是命令行被切开**。给带空格的路径手动加双引号。

### 7.4 别复用别人的服务

见 4.3。复用的实例生命周期不归你管，一停就成孤儿。

### 7.5 改判据 = 必须重打基线

判据文件指纹在基线里。改一个字符，围栏会报"判据被改写"。
重打基线后靶子相对新基线就没变过 → "靶子被改动"不成立 → 需要 `--accept-current=<理由>`
（带留痕的人工确认，不是绕闸）。

### 7.6 `maxTokens` 服务端硬上限 8192

超过直接 `VALIDATION_ERROR`。所以"让它一次写完 200 行 + 长计划"是不可能的——
**要么压缩任务书，要么拆题**。

### 7.7 该 relay 上部分模型不可用

`claude-3-5-sonnet` 返回空流；`deepseek-chat` / `glm-5.3` 90 秒无响应；
`minimax-m3` / `longcat-2.5` 无可用通道。**换模型前先跑 `.self-upgrade/loop/llm-probe.cjs` 和
`model-sweep.mts`**（后者用真实任务书测"会不会真的写文件"）。

### 7.8 出题人也会编 API

实测出题人写出过 `builtinTools` / `service.run` / `maxToolCallRetries` 三个不存在的名字。
所以判据草案**必须过编译关**才采纳。另外模板安全断言（注册/越界/导出约定）不经模型生成。

### 7.9 假绿比红更危险

`test-run.test.ts` 曾靠"源码里有没有 `NOT_IMPLEMENTED`"判断是否跳过，
结果实现完成后判据永远 skip → **"判据通过"是假的**。改成运行时探测才抓到真相。
**凡是"跳过"的设计，都要问一句：它会不会在实现完成后还跳过？**

### 7.10 历史账本的 `version` 字段有 `null`

因为 4.7 的 bug。不要据此判断"这题没升版本"——看 `tasks.json` 的 `releasedIn`。

---

## 8. 下一步建议（按优先级）

### P0 — 采纳那条它自己提的缺口（成本最低、收益最直接）

`.self-upgrade/proposals.jsonl` 里有 `tool-use-coach`：**「模型漏调工具无自动纠偏」**。
它是在读完自己的失败归因后提的，指向 `NO_TOOL_CALL ×3` 这个真短板。

```bash
cd server
RSI_AUTHOR_MODEL=nemotron-3-ultra-550b-a55b npx tsx scripts/author-task.ts --only=tool-use-coach
# 检查 server/candidates/tool-use-coach.test.ts，人工审过行为断言后：
#   拷到 tests/self-upgrade/，规格并入 tasks.json，打基线，跑 --only=tool-use-coach
```

**为什么值得做**：这条如果能落地，"空转"这个占失败总数一半的层就有结构性解了，
而不是每轮靠 `switch_model` 撞运气。

### P1 — 把「题源」再接一段：从提议到自动立项

现在提议→出题→采纳的最后一步还是人工。可以考虑：出题产物自动跑一次「基线红」校验
（新判据必须在靶子未改时红），通过后**自动进 `tasks.json` 的 candidate 池**，
人只做"批准/驳回"。这样它一天能自己长 2~3 道题。

前提是先解决 7.8（出题人编 API）——编译关已经挡住硬错，但"断言太松"仍需人看一眼。

### P2 — 收敛 `spec` 层的判定

`EXPLORATION_ONLY` 用的是"读调用占比 ≥0.7"，样本只有 9/9、17/17 两组。
积累到 20+ 次再校准。它只影响 L2/L3 分界，不影响"都不计入 Agent"这个结论。

### P3 — `L4` 只能识别"回归红/类型红"

识别不了"功能接上了但不对"。要覆盖得有端到端判据（注册 + 可调用 + 真实返回），
现在 `test-run-scaffold` 的 A7 只覆盖注册。

---

## 9. 接手第一件事（自检清单）

```bash
cd server
npx tsc --noEmit -p tsconfig.json          # 应该零输出
npx vitest run 2>&1 | tail -4              # 应该是 124 passed / 1218
node scripts/failure-stats.mjs             # 应该能看到行为/集成/实现三层分布
npx tsx scripts/self-upgrade-loop.ts --dry # 应该打印"待办 0 题"
```

四条都过，说明环境是好的。然后从第 8 节的 P0 开始。

---

## 10. 一句话总结这轮

> 系统原来"量得到但学不到"——能判失败，但七种失败压成一个词。
> 这轮把失败拆成七层、给每层指定了责任人和动作，并且让 `nextAction` 真的改变做法；
> 顺手修掉了三处"静默失效"（版本号从没升过、空响应被当成正常结束、截断被当成收工）。
> 结果是：`test-run` 那道卡了十几轮的题，换模型后一轮就过了；
> 失败也不再被记成"模型的错"，而是各归各位。

# RSI 交接 · 2026-11-12（晚）

> 文件：`RSI-HANDOVER-2026-11-12.md`　生成：2026-11-12 17:00（GMT+8）
> 性质：**状态快照 + 本轮改动说明**，不是改动流水账。
> 版本 **2.10.0** · 全量 **148 文件 / 1400 用例全绿** · `tsc --noEmit` **0**
> 前序文档：`HANDOFF.md`（2.5.0 的完整系统说明，第 1/2/5/7 节仍然有效）、
> `RSI-HANDOVER-2026-11-10-PM.md`（11-10 状态）。**状态一律以本文为准。**

---

## 0. 先看这段（接手当天要做的三件事）

| # | 事项 | 原因 |
|---|---|---|
| 1 | **先提交或打备份** | 工作区 **138 个改动全部未提交**，最后一次 commit 还停在 `6b77855`（11-10 的 merge）。两天的工作只存在于磁盘上。 |
| 2 | 读第 4 节「坑」 | 那 6 条是这轮烧掉 40+ 次派单换来的，每条都对应一处已修的代码，但**心智模型要留着**。 |
| 3 | 跑一遍第 6 节的「五分钟自检」 | 确认这台机器上链路是通的，再决定要不要起循环。 |

### 当前状态

| 项 | 值 |
|---|---|
| 版本 | **2.10.0**（root / client / server / desktop 四处 package.json 一致） |
| 测试 | **148 文件 / 1400 用例全绿**（`npx vitest run`，146s）；`tsc --noEmit` 0 错 |
| 账本 | `.self-upgrade/ledger.jsonl` 57 行：`upgraded` 7 · `failed` 34 · `adopted` 6 · `attribution-corrected` 4 · `superseded` 1 · `aborted` 2 · `verified` 2 · `version-recorded` 1 |
| 题目 | `server/self-upgrade/tasks.json` **12 题全 done**，无挂起 |
| 错题本 | `.self-upgrade/rejections.jsonl` **9 条** |
| 正例库 | `.self-upgrade/exemplars.jsonl` **3 条**（已清脏，见 §3.4；旧版备份 `exemplars.jsonl.bak-20261112`） |
| 待走闭环 | `.self-upgrade/proposals.jsonl` 8 条，最新一条 `fs-replace-empty-oldtext-infinite-loop`（代码已手工修，判据未补） |
| 模型 | `RSI_MODEL=nvidia/nemotron-3-ultra-550b-a55b`，候选轮到 `deepseek-v4.1-flash` / `nemotron-3.5-lightning-30b` |
| 工作区 | 未提交（见上表第 1 项） |

---

## 1. 这轮在做什么：四次真实往返

上一轮的结论是「全被机械闸拒」。这轮的任务是让它**真的走通一遍完整闭环**，并且每次反馈都要具体。结果是四轮真跑，其中两轮它做对了，两轮被我拦下。

### 1.1 第一次闭环成功（2.9.0）

`fs-write-delete-recursive-missing-schema`：从上一题的修复里读出配套缺陷（delete 分支要 `recursive`，但 schema 没声明这个字段）。

- 自证基线红 → A1–A4 全过 → 采纳 → 派单 **41 秒**改完 → 围栏七项 PASS
- 这是它第一次**不问人**走完 propose → author → adopt → implement → fence → 升版本。

### 1.2 第二次闭环成功（2.10.0）

`fs-replace-match-count`：`fs.write` 的 replace 在 `oldText` 命中 0 处 / 多处时只报「命中 N 处」，不告诉你在哪一行。

- 第 1 轮：行为改对了，但把位置信息放进 `data.matches`，判据断言的是 `error.message` → 判据红
- 第 2 轮：拿到具体差异后 **31 秒**改对，判据 6/6 绿
- 归档时我补了一处它造成的回归：它把 `data.matches` 从「命中次数 3」改成数组，撞坏既有判据 `fs-write-replace C3`。已改为 `{ matches: count, matchLocations: [...] }`

### 1.3 被我拦下的一次：方向判反

`fs-read-maxbytes-default-mismatch` 声称 schema 写 256KB、实现是 16KB，是缺陷。**判据绿、tsc 绿、全量绿**——然后我拦了。

靶子里的注释写得清清楚楚：

> 原来默认 256 KiB……256 KiB 在这三条（磁盘读放大 / tool_results 归档 / SSE data 全量推送卡渲染）上都是纯浪费

所以 16 KiB 是**刻意**降的，过期的是 schema 那句 `262144`。它却把常量改回 262144，**并把那 4 行说明动机的注释删了**，再改写成支持自己结论的版本。反证被清场，所以全绿。

处置：还原靶子 → 撤回采纳 → 记 `DIRECTION_INVERTED` 进错题本 → 真正修的是**描述**（改成 16384）→ 补 `fs-read-default-doc.test.ts` 把常量和文案钉在一起。

### 1.4 它的进步（同一轮可见）

| 环节 | 之前 | 这轮 |
|---|---|---|
| 提名 | 连续 4 次被域闸拒 | 一次命中 D1 域，证据带行号 |
| 出题 | 失败 2 次（TS 编译不过 / 误绿） | 一次过，自证红 3 条成立 |
| 探针被拒后 | 瞎试键名 | 按 `probeFixHint` 一次改对（绝对路径 → `path.relative`） |
| 挨了 `DIRECTION_INVERTED` 之后 | —— | 紧接着提名一条真 bug：`oldText:''` → `indexOf('')` 永远返回 `from` → 死循环 |

---

## 2. 系统骨架（十分钟看懂）

```
propose-gaps.ts        提名缺口：读源码、找「现有参数在某输入下没被正确处理」
      │                强制带行号证据；注入错题本 + 正例库；D1 域过滤
      ▼
author-task.ts         出题：写判据 .candidate.ts + 探针 .probe.ts + 规格 .spec.json
      │                落盘前【自证基线红】：判据必须在当前代码上真的红
      ▼
auto-adopt.ts          采纳六道闸：
      │                  A1 候选来自候选池
      │                  A2 判据能编译
      │                  A2.5 探针能合法调用被测工具（不许被前置校验挡住）
      │                  A2.6 探针与判据参数口径一致
      │                  A3 判据在靶子未实现时必须红，且【模型写的断言不许是绿的】
      │                  A4 落在 D1 全自动域
      ▼
implement-task.ts      派单：把任务书交给 Agent，它自己 fs.read → fs.write → code.check
      │
      ▼
check-self-upgrade.mjs 围栏（尺子在这里，Agent 够不到）：
      │                  1  受保护路径逐文件 sha256 零改动
      │                  2  判据文件指纹未变
      │                  3  靶子内容真的变了（比哈希，不比 git 状态）
      │                  3b2 没删掉「解释设计动机」的注释（rationale-guard）
      │                  3c tsc --noEmit 干净
      │                  4  判据绿
      │                  5  全量回归绿（失败文件串行复跑一次再判）
      ▼
failure-attribution.ts 归因：分 L0–L5 层，决定「这锅算谁的 / 下一步做什么」
      │                 implementation→retry_with_diagnosis
      │                 judge→halt_manual 或 skip_task
      │                 环境→retry_same（不消耗尝试次数）
      ▼
升版本 + 记账（ledger.jsonl）+ 记正例（exemplars.jsonl）
```

### 三条信任边界（不要破坏）

| 谁 | 能做什么 | 不能做什么 |
|---|---|---|
| **Agent** | 改 `src/` 允许清单里的文件、读写沙箱、`code.check`、跑测试 | 改 `tests/` `judge/` `krsi/` `rsi/` `eval/` `scripts/`；改判据；写账本 |
| **循环** | 起服务、打基线、派单、跑围栏、归因、记账、升版本 | 替 Agent 写实现；替出题人写判据 |
| **人** | 出题、改判据、采纳提议、放行特例 | —— |

**一句话**：尺子在它够不到的地方。所以它不能靠改判据让自己通过，也不能靠改账本让自己好看。

---

## 3. 本轮改了什么（按文件）

### 3.1 归因层：让反馈说对方向

`server/scripts/failure-attribution.ts`

| 改动 | 为什么 |
|---|---|
| 围栏信号加 `typeRan` / `fullRan` **三态** | 「跳过」被读成「跑了且红」，是这轮最贵的 bug（§4.1） |
| 类型红分支**前移**到全量红之前 | 顺序错了，它照着「回归被踩坏」改了两轮，真实错误是 TS2322 |
| `pickErrorLine()` 从诊断里抽具体那一行 | 原来 note 是按层写死的模板，从不带实例；现在塞「用例名｜断言差异」或 TS 行 |
| 新增 `JUDGE_FIXTURE_BLOCKED` + `skip_task` | 判据夹具被 safe-delete 拦，却记成它的实现失败（§4.2） |

`server/scripts/self-upgrade-loop.ts`

- `parseFence` 解析三态；`skip_task` 记 `verdict:skipped`、**不计能力账、不重派**。

### 3.2 围栏：不许删掉反证

`server/scripts/check-self-upgrade.mjs`

- 新增 **3b2 段**：靶子 diff 里删掉「解释动机」的注释（`原来` / `因为` / `纯浪费` / `刻意`…）→ **FAIL**，并把删掉的行打出来。
- 全量回归失败时**只把失败文件串行复跑**，不整轮重跑（并发下慢测会假红）。
- tsc 失败且含非法 `kind` 时，直接打印锁定的 10 个合法 `ToolErrorKind`（它读不出 tsc 那段长类型错）。

`server/scripts/lib/rationale-guard.mjs`（新增）：上面 3b2 的纯函数实现，可单测。

### 3.3 采纳：不许拿「现状就对」的断言凑数

`server/scripts/auto-adopt.ts`

| 改动 | 为什么 |
|---|---|
| `snapshotGreens`（逐条读 `--reporter=json`） | 同一份判据里「现在会在 16KB 截断」=绿、「应读满 256KB」=红 → 修好第一条必红，题无解，而整体判定显示"真红" |
| `probeFixHint(kind)` | A2.5 拒绝原因按 kind 分流：`security`→路径、`invalid_args`→字段、`not_found`→先建夹具。原来一句写死的「不要自造 operations 数组」，对着 security 说等于指反方向 |
| 探针一次性沙箱 `server/.probe-run-<pid>-<ts>/` | 探针不幂等（上次 create 的残留让这次报「已存在」） |

`server/scripts/task-self-upgrade.ts`

- 任务书加两步：「**第二步：读判据，把每条 `expect` 抄成清单**」+「**断言落在哪个字段，信息就必须出现在那个字段**」。
  实测价值：它曾把位置写进 `data.matches`、没写进 `error.message`，行为对、判据红，白跑一轮。

### 3.4 正例库：比错题本更危险的库

`server/scripts/lib/agent-feedback.ts`

**这轮最后清出来的一个隐患**：`fs-read-maxbytes-default-mismatch` 先被采纳（那一刻写了正例）、后判 `DIRECTION_INVERTED` 撤回，脏正例留在库里，且重复两次。下一轮 propose 会把**一条方向判反的提议当成功样例回灌**——错题本说「别这样」，正例库说「就照这样」。

修法（双保险）：

- `FATAL_REJECTION_CODES`：`DIRECTION_INVERTED` / `GREEN_BASELINE` / `PREMATURE` / `A2_5_PROBE_INVALID` / `TS2339` / `TS2322` / `TS2345`
- `isExemplarEligible(id)`：背了上述任一拒绝码的 id 不够格
- `appendExemplar()` **写前拦**（返回 boolean）；`readExemplars()` **读时滤** + 同 id 去重（清存量脏数据）
- 存量清理：5 条 → 3 条；备份 `.self-upgrade/exemplars.jsonl.bak-20261112`

### 3.5 出题端

`server/scripts/author-task.ts`

- `--force` 只放过幂等拦截，**不放过域闸**（原来会把 D3 架构层提议也送去出题）
- 单题异常 try/catch，不杀整轮
- `max_tokens` 4096 → 8192（推理模型 `content:null` + `reasoning_content` 吃满 4096）

### 3.6 本轮新增判据（共 10 份 / 85 条，全绿）

| 文件 | 条数 | 守什么 |
|---|---|---|
| `tests/attribution-fence-order.test.ts` | 13 | 归因分支顺序 + 三态 + `pickErrorLine` |
| `tests/agent-exemplar.test.ts` | 14 | 正例库读写 + 脏正例拦截（本轮 +4 条） |
| `tests/agent-feedback.test.ts` | 11 | 错题本 / 死题淘汰 |
| `tests/judge-baseline-verdict.test.ts` | 12 | 分层判定核心（真红 vs 假红） |
| `tests/judge-lint.test.ts` | 9 | 判据里不许断言锁定的枚举之外的值 |
| `tests/propose-d1-target.test.ts` | 7 | D1 域过滤 |
| `tests/probe-fix-hint.test.ts` | 6 | A2.5 拒绝原因按 kind 分流 |
| `tests/rationale-guard.test.ts` | 5 | 动机注释不许被删 |
| `tests/snapshot-green-gate.test.ts` | 4 | 模型断言基线不许绿 |
| `tests/fs-read-default-doc.test.ts` | 4 | 常量与 schema 文案一致 |

---

## 4. 坑（这节最值钱）

### 4.1 「跳过」被当成「失败」，让归因指反方向

围栏在 `tsc` 红时**跳过**全量回归且不打印任何行 → `fullOk=false`；归因里 `judgeOk && !fullOk`（全量红）排在 `judgeOk && !typeOk`（类型红）**之前**。

结果：真实错误是 `kind: "precondition_failed"` 不是合法枚举（TS2322），它收到的却是「新增工具没登记、把回归用例喂回去」。**两句话的修法完全相反**，它照着错的改了两轮。

→ 教训：**「没跑」和「跑了且失败」必须用三态区分**，布尔不够。

### 4.2 尺子跑不动，被记成被衡量者的错

判据夹具一次删 50 个文件，被沙箱 safe-delete 策略拦，每条断言收到的都是「策略拒绝」。归因把它算成实现失败。历史 3 题因此烧掉 **27 次派单 / 45 分钟**。

→ 教训：**判据自身的失败要能自证**（`JUDGE_FIXTURE_BLOCKED`），否则 Agent 在为一架坏掉的尺子反复改代码。

### 4.3 行为对了、判据红：信息写错了字段

它把命中位置写进 `data.matches`，判据断言 `error.message`。行为其实是对的。

→ 教训：**判据断言哪个字段，信息就必须出现在那个字段**。这条已写进任务书第二步。

### 4.4 复用既有字段 = 破坏性改动

它把 `data.matches` 从「命中次数 3」改成数组，撞坏既有判据 `fs-write-replace C3`。

→ 教训：**新能力只能加新键**（`matchLocations`），不能改既有键的含义。

### 4.5 删掉反证，让判据自洽

§1.3 那件事。这条最阴：**围栏全绿，因为反对证据被它清场了**。

→ 教训：衡量一个改动时，「它删掉了什么」和「它加了什么」同等重要。`rationale-guard` 就是这道闸。

### 4.6 并发下的假红

`probe-selftest`（9s）、`bridge-selftest`（34s）在并发全量下会偶发红；同一份代码手动复跑全绿。曾让循环白重派一轮、挂起 9 分钟，而墙钟是循环唯一的硬上限。

→ 教训：慢测串行复跑；**重试成本远小于误判成本**。

---

## 5. 命令手册

全部在 `server/` 下执行。

```bash
# 类型
npx tsc --noEmit

# 全量（约 146s）
npx vitest run

# 单题判据
npx vitest run tests/self-upgrade/<题目>.test.ts

# 账本完整性（evidence / manifest / anchor / 链）
npm run rsi:verify

# krsi 符合性
npm run test:krsi

# 一步一环
npx tsx scripts/propose-gaps.ts                      # 提名缺口
npx tsx scripts/author-task.ts --only=<id> --force   # 指定重出某题
npx tsx scripts/auto-adopt.ts                        # 跑采纳六道闸
npx tsx scripts/self-upgrade-loop.ts                 # 全自动一轮（提名→出题→采纳→派单→围栏）

# 手工复跑围栏（不派单，只判当前工作区）
node scripts/check-self-upgrade.mjs \
  --allowed=src/tools/builtin/fs-write.tool.ts \
  --judge=tests/self-upgrade/fs-replace-match-count.test.ts --full

# 版本号（四处一起改）
npx tsx scripts/version-bump.ts
```

### 循环的相关环境变量

| 变量 | 作用 |
|---|---|
| `RSI_MAX_AUTO_WALL_MS` | 单轮墙钟上限（**唯一的硬上限**，建议 900000 = 15min 起） |
| `RSI_MAX_AUTO_ROUNDS` | 最大轮数 |
| `RSI_MAX_CONSECUTIVE_FAILURES` | 连续失败中止阈值 |
| `RSI_MODEL` / `RSI_MODEL_ROTATION` / `RSI_AUTHOR_MODEL` | 实现模型 / 轮换候选 / 出题模型 |
| `RSI_DISPATCH` | 派单通道 |
| `RSI_SSE_DUMP` | 落 SSE 原始帧，排查模型返回用 |

模型配置在 `server/.env`（**未入库**）。出网 LLM 调用限速 40/min。

---

## 6. 五分钟自检（换机器 / 隔天接手先跑这个）

```bash
cd server
npx tsc --noEmit                      # 期望：无输出
npx vitest run                        # 期望：148 passed / 1400 passed
npm run rsi:verify                    # 期望：exit 0
node -e "const t=require('./self-upgrade/tasks.json');console.log(t.tasks.filter(x=>x.status!=='done').length,'未完成')"
```

四项全过再起循环。任何一项红，先修红再谈迭代——**尺子红着跑循环，只会把错的东西记成对**。

---

## 7. 边界：现在能做什么，不能做什么

### 能

- 在 D1 域（`src/tools/`、`src/utils/`）里自主找缺陷、出题、采纳、派单、判定、升版本，**全程不用人插手**
- 每轮结束给出一份可复算的账（`ledger.jsonl`）+ 一条可复用的正例
- 判据错了会自己停机（`halt_manual`）或跳过（`skip_task`），不再空转

### 不能 / 没做

| 项 | 现状 | 建议 |
|---|---|---|
| D2/D3 域 | 只提名不出题 | 需要人批的通道还没建 |
| 能力型缺口（`capability`） | 只跑过 defect 型 | `implement-first` 分支有代码、无实战 |
| 正例库分类注入 | 3 条，全在 `fs-write.tool.ts` / `fs-read.tool.ts` | 攒到 5 条后按 `targetFile` 分类，否则会把 fs 的形状套到别的工具上 |
| `judgeLint` 覆盖面 | 只拦 `kind` 枚举与 `summary` 文案断言 | 扩到 HTTP 码 / 日志文本 |
| 派单偶发挂起 | 见过 >9min | 加单题硬超时 + 自动重派 |

---

## 8. 待办（按性价比排序）

1. **提交工作区**（138 个文件）。不做这一步，前面所有东西都可能一次误操作归零。
2. **`fs-replace-empty-oldtext-infinite-loop` 走完整闭环**：代码已手工加拦截（`oldText` 为空 → `invalid_args`），但判据还没补，账本没记。补判据时注意加超时保护——这题的错误形态就是死循环。
3. **正例库到 5 条后按 `targetFile` 分类**。现在的 `recentExemplars(2)` 取最近两条，都是 fs 工具，长期会把形状收敛得过窄。
4. **`skip_task` 的历史账要重算**：3 道被误归因的题（`test-run` / `iteration-view` / `exec-partial-on-timeout`）占了 27 次派单，账本里仍记为 Agent 的实现失败。要不要回填 `attribution-corrected`，需要人定口径。
5. **派单硬超时**：`RSI_MAX_AUTO_WALL_MS` 是整轮上限，单题没有。建议单题 3min + 重派一次。

---

## 9. 证据索引

| 想查什么 | 去哪 |
|---|---|
| 每轮判了什么、为什么 | `.self-upgrade/ledger.jsonl` |
| 被拒的题 + 改法 | `.self-upgrade/rejections.jsonl` |
| 成功样例（会回灌给模型） | `.self-upgrade/exemplars.jsonl` |
| 提名历史 | `.self-upgrade/proposals.jsonl` |
| 每轮完整日志 | `.self-upgrade/logs/loop-round*.log` |
| 失败诊断原文 | `.self-upgrade/loop/diag-<id>-<n>.txt` |
| 全量回归落盘 | `.self-upgrade/loop/full-run-*.log` |
| 候选池（判据 + 探针 + 规格） | `server/candidates/`（作废的进 `archive/`） |
| 题目清单与状态 | `server/self-upgrade/tasks.json` |
| 架构决策 | `agent-decisions/ADR-*.md` |

---

## 10. 一句话总结

这轮真正修的不是 Agent，是**它听到的话**：归因说错方向、尺子跑不动被记成它的错、正例库里躺着一条方向判反的样例。三处修完，它连续两次自己走完了完整闭环（41 秒 / 31 秒），并且在我拦下它之后，下一次提名就交出了一条真 bug。

**它现在的能力上限不取决于模型多聪明，取决于围栏能不能把「它做对了」和「它让自己看起来做对了」区分开。** 这轮加的四道闸（三态、动机注释、基线绿、正例库净化）都在这条线上。

# 失败归因分层

> 状态：已实现（`scripts/failure-attribution.ts` + `scripts/failure-stats.mjs`），接入 `scripts/self-upgrade-loop.ts`。
> 起因：外置判据与账本让系统「量得到」，但账本里只有 `verdict: "failed"` 一句，
> 七种完全不同的失败被压成同一个词，于是**学不到**——不知道该换模型、该拆题、还是该修判据。

---

## 1. 为什么「一句 failed」学不到东西

实测记录（同一周内，同一套围栏判出来的 `failed`）：

| 现场 | 真实原因 | 该谁做 |
| --- | --- | --- |
| `connect ECONNREFUSED 127.0.0.1:8099` | 循环复用了别人的服务，自己一停就成了孤儿 | 调度器 |
| `outcome=budget_exhausted, 68454/64000` | 任务粒度太大，预算在探索阶段就耗尽 | 出题人 |
| `toolCallCount=0, finishReason=stop` | 只输出文字，一次工具没调 | 模型/指令 |
| 9 次 `fs.read`，0 次写入 | 任务书自相矛盾（全文里已有要加的两行），它在纠结该信哪句 | 出题人 |
| 判据绿 + `tsc` 红（`summary` 缺失） | 写出来了但类型不过，构建会挂 | Agent |
| 判据绿 + 全量回归红（K16） | 新增工具没登记进自动捕获 | Agent |
| 判据红，但判据自己 import 路径写错 | 尺子错了（假红） | 出题人 |

如果这些都记成「Agent 失败 3 次」，后果是具体的：

- 循环会**重复派一个根本不可能完成的任务**（环境坏了、题写错了）；
- 「换模型」「拆题」「修判据」这三种完全不同的纠正动作**没有触发条件**；
- 真正该沉淀的经验（哪类任务书会诱发空转）被「失败」抹平。

## 2. 七层结构

判定顺序**从外到内**，先命中先归。理由是：外层坏了会把内层污染得一模一样——
服务没起来时，判据当然全红，那看起来和「实现全错」没有任何区别。

| 层 | 名称 | 判定信号（机械可读） | 责任人 | 计入 Agent | 默认动作 |
| --- | --- | --- | --- | --- | --- |
| L0 `infra` | 环境 | `ECONNREFUSED` / `EADDRINUSE` / 服务未就绪 / 沙箱根错 | scheduler | 否 | `retry_same`（不消耗尝试次数） |
| L1 `budget` | 资源 | `outcome=budget_exhausted` / `finishReason=max_iterations` | author | 否 | `split_task` |
| L2 `behavior` | 行为 | `toolCallCount=0` 且无写入，且非预算耗尽 | model | 否 | `switch_model` |
| L3 `spec` | 规格 | 读调用占比 ≥0.7 且零写入（在研究而不是在做） | author | 否 | `regenerate_taskbook` |
| L4 `integration` | 集成 | 判据绿 + （全量回归红 或 tsc 红） | agent | **是** | `retry_with_diagnosis` |
| L5 `implementation` | 实现 | 判据红且靶子已改动（兜底层） | agent | **是** | `retry_with_diagnosis` / 末次 `split_task` |
| L6 `judge` | 判据 | 判据指纹被改 / 判据自身 `Cannot find module` | author | 否 | `halt_manual`（停机） |

三条边界必须写死，否则分层会退化成「换个名字的失败」：

1. **只有 L4/L5 进能力账。** 其余五层要么不是它造成的（L0）、要么它根本看不见
   （L4 的自动捕获、L6 的尺子错）、要么是任务没走完（L1）或题写错了（L3）。
   记成它的失败，学习信号就被污染——这正是「学不到」的技术原因。
2. **L2 与 L3 必须分开。** 都是「没有落盘」，但处置相反：L2 换模型，L3 改题。
   区别在机械信号上：L2 是**一次工具都没调**，L3 是**调了但全在读**。
3. **L6 必须停机。** 尺子错了还继续跑，后面每一轮都在给错尺子打工；
   而且它会“证明” Agent 不行，形成假的能力结论。

## 3. 关键接口

```ts
// scripts/failure-attribution.ts
export type FailureLayer =
  | 'infra' | 'budget' | 'behavior' | 'spec'
  | 'integration' | 'implementation' | 'judge';

export interface AttributionInput {
  taskId: string;
  attempt: number;
  maxAttempts: number;
  dispatch: { exitOk: boolean; output: string };   // 派单进程 + 原始 SSE（含 run_report）
  diagnosis: string;                                // 编译器报错 / 断言差异 / 围栏结论
  fence: {                                          // 围栏四道结论，逐项布尔
    reached: boolean;
    targetChanged: boolean;
    typeOk: boolean;
    judgeOk: boolean;
    fullOk: boolean;
    protectedIntact: boolean;
    judgeTampered: boolean;
  };
  serviceHealthy: boolean;                          // 派单前的健康检查
}

export interface Attribution {
  layer: FailureLayer;
  code: string;              // 机械可读原因码，如 BUDGET_EXHAUSTED
  evidence: string[];        // 命中的原文片段，供人工复核「凭什么这么归」
  owner: 'scheduler' | 'author' | 'model' | 'agent';
  countsAgainstAgent: boolean;
  nextAction: 'retry_same' | 'retry_with_diagnosis' | 'regenerate_taskbook'
            | 'split_task' | 'switch_model' | 'halt_manual';
  note: string;              // 说「谁该做什么」，与诊断（说「哪错了」）分工不同
}

export function attributeFailure(input: AttributionInput): Attribution; // 纯函数，可回放历史现场
```

设计选择：**纯函数 + 只吃机械事实**。同一个现场回放永远得到同一个结论，
所以它可以被单元测试覆盖（`.self-upgrade/loop/attr-check.mts` 里 8 个案例全部取自真实现场，8/8 通过）。

## 4. 数据流

```
                    ┌──────────────────────────────────────┐
  派单脚本 ──SSE──▶ │ dispatch.output                      │
                    │   · outcome / finishReason           │
                    │   · toolCallCount / fileChangeCount  │
                    │   · event: tool_call 的名字序列       │
                    └──────────────┬───────────────────────┘
                                   │
  围栏 ──stdout──▶ parseFence() ──▶│ 四道布尔（不读总 fence.ok）
                                   ▼
                          attributeFailure(input)
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
        账本 ledger.jsonl     控制流 nextAction     学习信号 failure-stats
        （每 attempt 一行）    （重派/拆题/停机）     （按层聚合）
```

`parseFence()` 存在的理由：围栏只给一个 `fence.ok` 总布尔，它把
「类型不过」「判据不过」「踩坏回归」「靶子没动」压成同一个 `false`，
而这四件事的责任人完全不同。所以归因读的是**四道独立结论**，不是总分。

## 5. 与外置判据、账本的对接

### 5.1 判据：只读结论，不改判定

归因**不参与判定**，也不读取判据源码。它只消费围栏已经算出来的布尔值：

- `judgeOk` ← 围栏第 4 步（判据必须绿）
- `typeOk` ← 围栏 3c 步（`tsc --noEmit`，本轮新增——之前判据绿 + 类型红也能算升级）
- `fullOk` ← 围栏第 5 步（全量回归）
- `judgeTampered` ← 围栏第 2 步（判据指纹）

所以「判据是外部尺子」这条不变量没有被动摇：归因只是**解释**失败，不改变失败本身。
反过来说，归因也不能让一个红的判据变绿——`L6` 的处置是停机，不是放行。

### 5.2 账本：明细 + 索引两层

`.self-upgrade/ledger.jsonl`（append-only，Agent 改不到）每行增加：

```json
{
  "at": "2026-11-11T07:20:00.000Z",
  "task": "test-run",
  "verdict": "failed",
  "attempt": 1,
  "layer": "budget",
  "code": "BUDGET_EXHAUSTED",
  "attribution": {
    "taskId": "test-run", "attempt": 1,
    "layer": "budget", "code": "BUDGET_EXHAUSTED",
    "owner": "author", "countsAgainstAgent": false,
    "nextAction": "split_task"
  }
}
```

题级结束时再写一行索引（不覆盖明细）：

```json
{"task":"test-run","verdict":"failed","attempts":3,"layers":{"budget":1,"spec":2}}
```

**为什么账本要同时存明细和索引**：明细用于回放单个现场（`evidence` 能回答「凭什么这么归」），
索引用于回答「这题卡在哪层」。只有其一，都会退回「一句 failed」。

旧记录（分层上线前）没有 `layer` 字段，`failure-stats` 会单独计数，不混入统计——
历史数据不能事后被「补归因」，那等于给旧结论编理由。

### 5.3 控制流：`nextAction` 必须真的改变行为

分层如果只写账本，就还是记账。所以循环按 `nextAction` 分支：

| nextAction | 循环行为 |
| --- | --- |
| `retry_same` | `attempt -= 1` 后继续：**不消耗尝试次数**，但连续 3 次环境未修复则停机 |
| `halt_manual` | 立即 `return`（`finally` 仍会停服务），题记为 `halted` |
| `retry_with_diagnosis` | 原有路径：把诊断写进 `--feedback-file` 重派 |
| `split_task` / `regenerate_taskbook` / `switch_model` | 当前实现：记录并在末次尝试后停，交人工拆题/改题/换模型 |

`split_task` 这一条已经在实际中兑现：`test-run` 一题连续失败后按此拆成
`test-run-scaffold`（骨架 + 三个校验 + 注册，约 50 行）与 `test-run`（补执行逻辑）两步，
拆分后第一步 24 秒通过全部六道围栏。

## 6. 学习信号怎么被沉淀

`node scripts/failure-stats.mjs` 输出四块，对应四个不同的问题：

1. **按层分布**：哪一层在系统性失败。同一层反复出现 = 结构性问题，不是偶发。
2. **按原因码分布**：`NO_TOOL_CALL ×5` 比「失败 5 次」有用得多。
3. **按题**：`从未进过实现层` 的题会被标注——那说明问题不在 Agent，
   去修题/环境/模型，别去「训练」它。
4. **可复用信号**：同码出现 ≥2 次时给出对应的纠正动作映射
   （`NO_TOOL_CALL` → 换模型/压缩任务书；`BUDGET_EXHAUSTED` → 拆题；
   `FULL_SUITE_RED` → 在判据里补一条注册断言）。

这一块是「学」的落点：**信号必须能改下一轮的做法**，否则统计只是另一种账本。

## 7. 已登记的边界

1. **L3 的 0.7 阈值是经验值**，来自 9/9、17/17 两组「全读不写」的现场。
   样本还少，等积累到 20+ 次再校准；它只影响 L2/L3 的分界，不影响「都不计入 Agent」这一点。
2. **L4 只能识别「回归红/类型红」，识别不了「功能接上了但不对」**——
   那需要判据覆盖到「注册 + 可调用」，目前 `C10` 只覆盖注册，不覆盖端到端可用。
3. **`split_task` / `regenerate_taskbook` / `switch_model` 尚未自动化**：
   现在只记录并停机，拆题与改题仍是人工。这是有意为之——自动改题会让「题的来源」
   和「被衡量的对象」重新混到一起，而那正是外置判据要防的事。
4. **归因依赖 run_report 的字段名**。`outcome` / `finishReason` / `toolCallCount`
   任一改名，归因会静默退化成 L5（兜底层）。缓解：`readRunFacts` 里所有字段缺失一律返回
   `null` 而不是猜默认值，配合 `attr-check.mts` 的 8 个现场回放做回归。

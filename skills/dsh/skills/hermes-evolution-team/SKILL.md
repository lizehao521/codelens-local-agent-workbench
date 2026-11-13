---
name: hermes-evolution-team
description: 异结构多Agent进化团队编排方法论。 核心能力：五模式异结构团队编排（并行发散/对抗互审/流水线串行/并行汇聚/融合DAG）、进化树谱系追踪、双Agent交叉审查、三Agent预测→审查→测试流水线、单轮meta融合（多轮压缩为一轮）。 用途：给任何需要多Agent分工协作的复杂工程任务（诊断→实施→审查→修复→测试全闭环）提供可复用的团队编排模式。 触发词：双智能体进行、异结构团队、组建Agent团队、进化树编排、多Agent并行、互审修复、预测审查测试、进化闭环、融合团队、meta编排、一轮闭环。 组合：结晶自进化策略引擎基因库 + 传话层降损（P1-P8）+ 工程熵治理（E1-E5）+ 落地验证闭环（V1-V5）+ 进化树（T1-T5）+ 进化推演增强（I1-I6：真相源收敛/验证塔收敛/信号入适应度/三方漂移对账/pre-mortem强制闸/适应度口径统一）。
metadata:
  cn: "异结构进化团队"
  version: "1.1.0"
  license: "MIT"
  geneType: null
  geneId: "hermes-evolution-team-v1.1"
  parentGeneId: "hermes-evolution-team-v1.0"
  branch: "graft:M4xM5"
  fitness: 94
  source: "进化结晶化"
  strategies: ["pattern-005~018","pattern-034","pattern-037~042","pattern-树"]
  triggers: [多agent, 多智能体, 双智能体, 团队编排, 并行, 互审, 进化树, 分工协作, multi-agent, 编排]
  dependencies: ["进化策略引擎","传话层工程降损","工程熵治理","落地即验证闭环","进化树","进化推演增强"]
  tags: ["多Agent编排","异结构团队","进化树","M5融合DAG","传话层降损","工程熵治理","验证闭环"]
---

# 🌳 Hermes 异结构进化团队

**第一性原理**：复杂工程优化的最高杠杆不是单一Agent的算力，而是**异结构多Agent的编排形态**。
不同形态（并行/互审/流水线/汇聚）对应不同问题类型，选对形态 = 信息流转零损耗。

核心闭环：`诊断 → 并行实施 → 互审修复 → 预测审查测试 → 修复并行+验证串行 → 进化树谱系闭合`

最高效率形态：**M5 融合 DAG** — 四轮压缩为一轮，5 Agent 单次 `team_create` 完成全部闭环。

> **宿主工具映射（重要，按宿主实际能力调用）**：本方法论原名中的 `team_create` / `task(...)` / `shutdown_request` / `team_delete` 是编排**意图**，不是一个宿主工具名。在当前 DSH 宿主上，请按下列真实工具落地：
>
> | 方法论动词 | 本 host 真实工具 |
> |---|---|
> | `team_create`（组队） | 无需显式创建；直接对同一批 `subagent` 调用即为一队 |
> | `task(name=…, team_name=…)`（派活） | `subagent`（独立上下文）/ `subagent_fork`（继承本对话上下文） |
> | `send_message`（传话） | `send_message`（同名，直接可用） |
> | 队列/查活 | `list_agents` |
> | `shutdown_request` / 中止 | `interrupt_agent`（中断该 Agent 当前回合） |
> | `team_delete`（清场） | 无显式删除；子代理会话保留在 storage，可后续 `send_message` 复用 |
> | 大规模扇出编排 | `workflow`（脚本化编排多子代理） |
> | 单目标多轮迭代 | `ralph`（每轮全新子代理） |
>
> 即：**"异结构团队"在本 host = 多个 `subagent`/`subagent_fork` 并行 + `send_message` 汇聚**；下文的 M1~M5 形态全部按此映射执行。

---

## 快速上手

| 你想做什么 | 怎么说 | 我做什么 |
|-----------|--------|----------|
| 分析+实施优化 | `双智能体进行` | 创建并行团队（M1: 2 Agent 分工落地） |
| 审查修复已有代码 | `双智能体相互进行审查质量修复` | 创建互审团队（M2: 双Agent交叉审查+修复） |
| 扫描+审查+测试闭环 | `异结构智能体进行预测审查测试` | 创建流水线团队（M3: 3 Agent 串行） |
| 修复多个bug+验证 | `异结构智能体进行修复P0+P1+质量测试` | 创建汇聚团队（M4: 修复并行→验证串行） |
| 一轮全闭环 | `四异结构团合成一个` 或 `融合团队一轮闭环` | 创建融合DAG团队（M5: 5 Agent 单轮完成） |
| 看进化谱系 | `进化树` | 输出ASCII/JSON进化树，标注fit趋势 |

---

## 五模式团队编排

### M1：并行发散（Parallel Divergence）

- **场景**：主任务可分解为互不依赖的独立子任务。
- **实例**：`hermes-speed-opt` — cache-agent 改缓存 + audit-agent 做审计埋点，无冲突文件。
- **做法**：
  1. `team_create` 创建团队
  2. `task(name="agent1", team_name=...)` + `task(name="agent2", team_name=...)` 同时 spawn
  3. 关键：**两个Agent操作不同文件**，避免合并冲突
  4. 等待双方 `send_message` 报告完成后 `shutdown_request` + `team_delete`
- **经验**：
  - 分文件隔离是并行生效的前提——同文件双写必然冲突
  - 给每个Agent `max_turns=20-30`，prompt 中写清楚"只改这些文件"
  - 双方完成后由主Agent汇总，不做中间干预

### M2：对抗互审（Adversarial Cross-Review）

- **场景**：已有代码改动需要质量审查，需从不同视角发现遗漏。
- **实例**：`hermes-cross-review` — review-cache 审 cache-agent 代码，review-audit 审 audit-agent 代码。
- **做法**：
  1. 互审双方各自以对方的代码为审查目标
  2. prompt 中写明审查要点清单（P0/P1/P2 分级）+ 预期修复行为
  3. 交付 = 审查报告 + 代码修复，不改动业务行为
- **经验**：
  - 审查方必须"比对真实签名"（V2），不能按假想的API签名判断对错
  - P0（高危）= 双重调用/未使用导入 → 必须修复；P1（中危）= 注释不准/变量名 → 建议修复；P2（低危）= 报告遗漏 → 记录
  - 互审比自审发现多 3-5 倍问题

### M3：流水线串行（Pipeline Sequential）

- **场景**：任务需要多个阶段顺序依赖（前一步输出是后一步输入）。
- **实例**：`hermes-evolution-orchestra` — draft-predict 扫描组件 → review-quality 审查草稿 → test-quality 测试+进化树。
- **做法**：
  1. 三个阶段 Agent 同时 spawn（它们异步运行）
  2. 阶段1完成后 `send_message` 给阶段2
  3. 阶段2可先做独立工作（import闭合审计），收到消息后补充审查
  4. 阶段3等两路消息到位后整合最终交付
- **经验**：
  - 不要让下游空等——下游Agent先做"独立发现"部分，收到上游消息后补充
  - 每个阶段产出独立文件（draft_report→review_report→final_delivery），可追溯
  - `max_turns` 应递增（25→30→30），下游需要更多上下文

### M4：并行汇聚（Parallel Converge）

- **场景**：多项修复可分头并行，最终由一个验证Agent统一验收。
- **实例**：`hermes-fix-orchestra` — fix-p0 + fix-p1-p2 并行修复 → test-all 统一验证。
- **做法**：
  1. 修复Agent并行 spawn，各自负责不重叠的文件/模块
  2. 验证Agent先做基线扫描（当前状态快照）
  3. 收集修复Agent的改动报告后，逐项验证 + 扩展smoke测试
  4. 全部通过后 `shutdown_request` + `team_delete`
- **经验**：
  - 验证Agent必须"先基线后验证"——知道改前状态才知道是否真的改了
  - 修复Agent用不同策略（直接落地 vs 模式驱动）形成异结构互补
  - 每项改动的验证输出应含"通过/失败/警告"三态，不只是通过/失败

### M5：融合 DAG（Meta Fusion）⭐ 最高效率

- **场景**：改动面明确、组件边界清晰、有可复用技能框架 → 四轮压缩为一轮。
- **实例**：`hermes-meta-orchestra` — 5 Agent 单次 `team_create` 完成诊断→实施→审查→测试全闭环。
- **结构**：

```
                    hermes-meta-orchestra (5 Agent)
                    
  draft-scan ──────────────────┐
  (扫描三组件热点)               │
                                ├─→ review ──→ test ──→ 闭环
  fix-p0 ──────────────────────┤   (互审三路     (汇聚验证
  (直接修复高危项)               │    交叉比对)     全部改动)
                                │
  fix-p1-p2 ───────────────────┘
  (模式驱动修复中低危项)
```

- **做法**：
  1. **一次 `team_create`** — 不再分四轮
  2. **三路并行产出端**（draft-scan / fix-p0 / fix-p1-p2）同时 spawn，各自负责不重叠的文件
  3. **一路汇聚审查端**（review）先做独立 `import` 闭合审计，收到三路消息后交叉比对（比 M2 覆盖更全）
  4. **一路汇聚验证端**（test）先做基线快照，收到 review 消息后一次验证全部改动 + 扩展 smoke 测试
  5. `max_turns`：draft/fix 各 25-30，review 35+，test 30+
- **经验**：
  - 融合版 review Agent 同时接收三路消息做交叉比对，覆盖面 > 两两互审
  - 融合版 test Agent 一次验证全部改动，无需等四轮汇总
  - **单轮失败 = 全流程重来**（主要风险）→ 每个 Agent 的 prompt 必须充分自包含，减少误解概率
  - 上下文压力：review 和 test 的 prompt 需包含全部改动点的审查清单
  - 适用条件：改动面 ≤ 15 项、组件 ≤ 3 个、文件无冲突

### 五模式选择决策树

```
任务性质
├─ 子任务独立且文件无冲突 → M1 并行发散 (2-3 Agent)
├─ 已有代码改完需审查    → M2 对抗互审 (2 Agent)
├─ 多阶段顺序依赖        → M3 流水线串行 (3 Agent)
├─ 多方修复交一份验证    → M4 并行汇聚 (2-3 Agent)
└─ 改动明确+组件清晰     → M5 融合DAG (5 Agent 单轮闭环)
    ↑ 效率最高但风险最高，适合有成熟技能框架的场景
```

---

## 四轮 vs 一轮 对比

| 维度 | 四轮拆开 | M5 一轮融合 |
|------|:--:|:--:|
| `team_create` | 4 次 | **1 次** |
| Agent 数 | 10（四轮累加） | **5** |
| 消息跳数 | 4 跳 | 2 跳 |
| 审查面 | 两两互审 | **三路交叉比对** |
| 单点风险 | 低（一轮失败不影响其他轮） | **高**（review 崩全链断） |
| 总耗时 | 4 × 对话轮 | **1 × 对话轮** |

---

## 四轮进化全链路（实战参考）

```
gen1: M1 并行发散          gen2: M2 对抗互审
  cache ─┐                   review-cache ⇄ review-audit
         ├─→ 汇总                 ↓ 交叉审查     ↓
  audit ─┘                   修复P0双重签名   修复导入/GIL

gen3: M3 流水线串行         gen4: M4 并行汇聚
  draft → review → test      fix-p0 ─┐
  预测扫描 闭合审计 谱系            ├─→ test-all → 28用例全过
                              fix-p1-p2┘

ROOT(95) → gen1(91) → gen2(93) → gen3(90) → gen4(92) ← FRONTIER
```

---

## 进化树追踪 SOP

每次团队闭环后写入进化树节点：

1. **节点定义**：`{id, label, fit, branch, parent}`
2. **适应度计算**：基于 `(通过数 - 失败数*2) / 总改动数 * 100`，下限 0，上限 100
3. **分支类型**：`seed`(根) / `frontier-grow`(从前沿生长) / `graft:AxB`(跨支嫁接) / `prune-recover`(剪枝恢复)
4. **树 JSON 格式**：`{nodes:[], edges:[], frontier:[], stale_count:0}`
5. **ASCII 可视化**：`ROOT(id,fit) → └─ child(id,fit) ← FRONTIER`

---

## 安全原则

1. **透明** — 每轮改动在报告中可追溯（draft/review/delivery 三级）
2. **可控** — 每个Agent `max_turns` 上限，超时自动终止
3. **可逆** — `team_delete` 清除所有临时状态，代码改动在 git 中可回滚
4. **渐进** — 先快赢（P0）→ 中周期（P1-P2）→ 长周期（P3），不一步到位
5. **fail-open 铁律** — 所有改动异常必须回退原行为，治理层不引入单点故障
6. **文件隔离** — 并行Agent必须操作不同文件，避免合并冲突

---

## 反模式（pitfall）

- **空转等待**：下游 Agent 阻塞等上游消息时无事可做 → 让下游先做独立发现工作
- **同文件冲突**：并行 Agent 改同一个文件 → 分任务时按文件隔离
- **假设签名**：审查时按"我以为的API"判断 → 必须 grep 真实代码签名（V2）
- **孤立 mock**：单测全绿但没跑真实激活入口 → 加 smoke 测试（V4）
- **跳过基线**：验证Agent直接验改动，不知道改前状态 → 先基线扫描后验证
- **过早关闭**：不等所有Agent完成就 team_delete → 等全部 shutdown_response 再删
- **导入一致性陷阱**：跨文件重命名只改一处 → 全仓 grep 同步 + import 闭合审计（pattern-019）

## 工具对齐（当前异结构工具面）

- team —— 跨预设任务市场：post/rollcall/debate 落五模式编排；只记录转发不代执行。
- workflow / subagent / ralph —— M1 并行发散、M3 流水线用 workflow+pipeline；委托用 subagent(fork/spawn)；单目标闭环用 ralph。
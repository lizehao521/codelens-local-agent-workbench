# AgentRsi 评测能力改进报告（2026-11-10）

> 任务：联网检索近期公开的智能体任务、配套评测基准及优化实践 → 筛选适用于 AgentRsi 的可落地改进 → 统一应用并验证无回归。
> 口径：沿用 `强化Agent.txt` C4「不外推」。来源分「一手核实」（直接抓取原文/官方页）与「二手汇编」（检索结果转述），后者不作为唯一依据。
> 检索日期：2026-11-10。

---

## 1. 检索到的关键信息

### 1.1 一手核实

| 来源 | 发布时间 | 核心结论 | 对 AgentRsi 的启示 |
|---|---|---|---|
| **RSI-Exam**（AIMING Lab / UNC-Chapel Hill，GitHub README + rsi-exam.ai） | 网站 2026-08-26；数据与代码 **2026-08-28** | 88 任务（35 公开 / 53 私有）；给一个「能跑但弱」的方法，agent 在**可见 split** 最多迭代 12h，提交的 artifact 在**密封 split 从零重放一次**，按 baseline=0 / reference=0.6 / upper=1 归一化。原文："An improvement that does not transfer earns nothing." | 项目已有的「公开用例 + 隐藏用例」是同构设计；缺的是**测量对象版本标识**与「改进必须迁移」的机器判据 |
| **Terminal-Bench 4.0**（tbench.ai 官方公告，Stanford / Laude Institute / Harbor） | **2026-08-28** | 转为连续基准 + 语义化版本；按资源余量校准，统一 8h 超时以**降低测量噪声**；移除 8 个任务（饱和 2 / 拒答 2 / 公开解 2 / 质量问题 2），修复 19 个；明确「资源规则与任务集变更是破坏性变更，需重跑，成绩不可跨版本比较」；每行报告 cost / token | 直接印证本项目「分母变了必须另起链」；也说明**超时/资源噪声必须被单独观测**，不能混进能力读数 |
| **Anthropic《Demystifying evals for AI agents》** | **2026-01-09** | 定义 task / trial / grader / transcript / outcome / harness；**outcome 是环境最终状态，不是模型声称的结果**；code-based / model-based / human 三类 grader 分工；capability eval 与 regression eval 分离，饱和的能力评测「毕业」为回归套件；pass@k vs pass^k；每个 trial 从干净隔离状态开始；CORE-Bench 分数 42%→95% 是 grader / 任务描述 / scaffold 修正所致 | 项目 `eval.run` 真跑夹具已符合 outcome 判定；缺**可靠性口径的诚实标注**与**失败分类**（否则归因只能靠模型自述） |
| Anthropic Engineering 索引（官方） | 2025-09-11《Writing effective tools for agents》、2025-11-26《Effective harnesses for long-running agents》、**2026-02-05《Quantifying infrastructure noise in agentic coding evals》**、2026-03-24《Harness design for long-running application development》 | 基础设施噪声需量化；harness 与模型共同决定评测结果 | 对应本项目 §9.10 把 600s 超时故障误判为策略问题的教训 |
| Code w/ Claude SF 2026（claude.com 官方） | 2026 年 | **Outcomes**：开发者定义 rubric，独立 grader 在独立上下文窗评估并让 agent 迭代，内部最难任务成功率最多 +10 分；**Dreaming**：定期回顾会话沉淀记忆 | 独立 grader / 独立上下文，与本项目 krsi 外部内核判决同向 |

> 注：`www.anthropic.com/engineering` 直接抓取失败（fetch failed），文章标题与日期取官方索引的搜索快照，并用第三方摘要交叉确认《Demystifying evals》的 2026-01-09 日期与内容。

### 1.2 二手汇编（仅作方向参考，未逐条核实原文）

| 来源 | 发布时间 | 核心结论 |
|---|---|---|
| **SelfImprove-Bench**（arXiv 2611.02797） | **2026-11-02** | G0–G4 泛化阶梯，区分「能力增益」与「场景拟合」，强调对进化轨迹的细粒度归因；现有 RSI 方法在不同泛化层级上增益不一致 |
| **AI4AI-Bench** | 2026-08-21 | 10 个冻结仓库、固定隐藏 evaluator 从零重放；0=无信息模型、0.1=仓库原算法、1.0=任务最优；多数提交根本没改变「怎么学」 |
| **ASPIRE / S³Gym / HarnessDev**（ByteDance Seed & TokenWave） | 2026 | 自评准确度**不能**可靠转化为后续增益；应按「经验对未来行动的效果」评估；HarnessDev 追踪新机制是否**真的在 run 中被调用**；权重更新会损害既有能力 |
| **SWE-bench Verified 退役** | 2026-02（转述 OpenAI 决定） | 审计称 59.4% 硬任务存在缺陷测试/描述与污染，推荐 SWE-bench Pro；基准会饱和、需版本化与定期审计 |
| **false-success 研究 / Agent-as-a-Judge / 三层 eval 栈**（多篇 2026 综述） | 2026 | 9,876 条 τ²-bench 与 1,879 条 AppWorld 轨迹中，false success 占失败 45–48%（自评 coding agent 75.8%），LLM judge AUROC < 0.65；outcome-only judge 只抓 45% silent faults；建议 deterministic grader + LLM judge + 生产监控三层、tiered CI gates、accuracy-vs-cost Pareto |
| **τ-bench / τ²-bench pass^k** | 2024-06 起，2026 广泛引用 | 80% 单次成功率下 pass@3=99.2% 而 pass^3=51.2%；打印哪个指标决定结论 |

---

## 2. 实际采纳的改进项（统一契约：评测运行元数据 `EvalRunMeta`）

| # | 改进 | 依据 | 实现 |
|---|---|---|---|
| 1 | **评测集指纹 + 版本化** | TB 4.0 语义化版本、SWE-bench Verified 退役、AI4AI-Bench 归一化锚点、RSI-Exam 密封重放 | `computeEvalSetFingerprint()` 对「套件 id + implPath + exportName + files + 全部用例」做规范化 SHA-256（16 位）；随 `runEvalBattery` → `judge_verdicts.data_json` → `/api/rsi/overview` → 前端逐级透传。指纹变化即测量对象变化，跨代不可比 |
| 2 | **机械失败分类** | Anthropic「outcome≠自述」、Agent-as-a-Judge 轨迹级、SelfImprove-Bench 细粒度归因、false-success 研究 | `failureKinds` 按套件机械分类：`public_fail`（公开就挂）/ `hidden_only`（公开全过、隐藏打红 = 过拟合信号）/ `suite_error`（实现缺失/加载失败）/ `passed`。归因器不再需要靠模型自述猜原因 |
| 3 | **采样数与可靠性诚实标注** | τ-bench pass^k、Anthropic 2026-01-09 | 读数带 `samples: 1` 与 `reliability: 'unmeasured'`，明示 pass^k 不可计算。**不改采样次数**，因此不改变代际读数口径 |
| 4 | **配置一致性自检 + 基础设施噪声可观测** | Anthropic 2026-02-05、TB 4.0 资源校准、本项目 §9.10 教训 | 新增 `scripts/check-eval-config.mjs`（`npm run check:config`）扫描 7 个源码/配置文件 + `server/.env`，远程上游地址不一致即 exit 1；`seed-agent-loop.ts` 新增 `streamNoise` 台账，汇总打印请求数/超时数/平均与最长耗时，把超时明确标为环境问题而非能力读数 |

**一致性设计**：1–3 共用一个 `EvalRunMeta` 契约，在 runner（产生）→ judge（落库）→ app（聚合，旧行给中性缺省）→ api.ts（类型）→ RsiDashboardModal（展示）五层**同步落地**；4 用同一个根 `package.json` 脚本与 seed 汇总出口，避免模块脱节。所有字段都是**可选新增**，不参与计分、不进 `RsiManifest`、不进 anchor 证据原像。

### 明确不采纳（附理由）

- **改分母 / 新增题型 / 淘汰饱和套件**：TB 4.0 明确这是破坏性变更、需重跑且成绩不可跨版本比较；会让现有 6 代 anchor 链与 `75/126=0.595` 失去可比性。
- **把 pass^k 多次采样设为默认**：改变代际读数口径，同样需另起链；本轮只做「诚实标注」。
- **引入 LLM-as-judge 替代/补充确定性 grader**：Anthropic 明确 decidable checks 应用 code-based grader；且 false-success 研究显示 judge 对静默失败 AUROC < 0.65。项目 `eval.run` 真跑夹具已是更强的 outcome 判定。
- **接入 SWE-bench Pro / Terminal-Bench 等外部基准**：需容器与重 harness，违背本地单机、零外部依赖的定位。
- **自动改写 π' 口吻**：#12 的因果结论已被 §9.10 证伪，风险高。

---

## 3. 受影响范围

**代码改动（10 个文件）**

| 文件 | 改动 |
|---|---|
| `server/src/services/eval/runner.ts` | 新增 `canonical` / `computeEvalSetFingerprint` / `classifySuite`；`EvalBatteryResult` 增 2 字段；`runEvalBattery` 计算指纹与失败分类 |
| `server/src/services/judge/eval-rate.ts` | 正常与 `unexec` 两个分支的 `data` 同步写入 4 个元数据字段 |
| `server/src/app.ts` | `buildEvalSummary` 透出元数据；旧行给 `null` / `{}` / `1` / `'unmeasured'` 中性缺省 |
| `client/src/services/api.ts` | `RsiEvalData` 增加 4 个可选字段 |
| `client/src/components/agent/RsiDashboardModal.tsx` | `DataVersionNotice` 展示指纹、失败分类、采样与可靠性 |
| `server/scripts/seed-agent-loop.ts` | 新增 `streamNoise` 台账与汇总行（此前已加 `RSI_SERVER_URL`、移除硬编码地址） |
| `scripts/check-eval-config.mjs` | **新增** 配置一致性自检 |
| `package.json` | 新增 `check:config` 脚本 |
| `server/tests/eval-suite.test.ts` | 新增 2 条元数据自证用例（指纹稳定/变化、失败分类可区分） |
| 其余既有改动 | 本轮之前已完成的上游地址统一、URL 直达、测试隔离修复等，保持不变 |

**未改动的边界**：分母仍 126（12 套件）、判据口径与 `criteria_sha256` 不变、`RsiManifest` 映射不变、anchor 证据原像不变、DB 历史行不回写、主链 6 代不动。

---

## 4. 最终改动结果

- 评测读数新增可机器判定的**版本标识**：下次判据运行起，`task.test_pass_rate` 的 `data_json` 会带 `evalSetFingerprint`，前端可与当前指纹对照，指纹变化即提示基线断裂。
- 归因输入从「模型自述」升级为**机械失败分类**：`hidden_only` 能直接暴露「只对公开用例打补丁」的过拟合，不必读 transcripts 猜。
- 可靠性口径**不再撒谎**：`samples=1 / reliability=unmeasured` 明确 pass^k 不可计算。
- 配置漂移与基础设施超时变成**可观测**：`npm run check:config` 是门禁，seed 汇总新增「基础设施噪声」行，直接防止 §9.10 那类误判重演。
- **历史数据兼容**：现有会话的新字段为中性缺省（`fingerprint=null`、`failureKinds={}`），前端显示「未标注（旧会话）」，绝不把缺失伪装成 0 或已测；不回写历史行以免篡改证据。

---

## 5. 验证结论

| 门禁 | 结果 |
|---|---|
| server `tsc --noEmit` | **exit 0** |
| client `tsc --noEmit` | **exit 0** |
| server 全量 vitest | **112 文件 / 1114 测试全通过**（含新增 2 条元数据自证） |
| client 全量 vitest | **13 文件 / 83 测试全通过** |
| krsi conformance | **10/10**（改判据 / 删指标 / 伪造哈希 / 改写历史仍被正确拒收） |
| `npm run check:config` | **exit 0**：`http://1.92.150.5:8787/v1` 在 7 个源码/配置文件 + `server/.env` 中一致 |
| `/api/health` | 200，DB 23/23 表、sandbox 可写 |
| `/api/rsi/overview` 契约 | 历史行返回中性缺省；`75/126 = 0.595`、`rsiRuns=6`、`judgeRuns=12` 未变 |
| `rsi:verify` 主链 | **exit 0**：5 行 v2 anchor、代数 `[2,3,4,5,6]`，evidence → manifest → anchor → 链 四层一致 |
| 前端渲染 | typecheck + 全量测试通过；预览面板可刷新查看 |

**结论**：4 项改进统一落地、契约跨 5 层一致、配置无漂移；分母、判据口径、anchor 链与全部既有读数保持不变，未发现功能回归。

**遗留边界**：新元数据字段只对**下一次判据运行**产生的行生效（历史行刻意不回写）；本轮未跑新的 RSI 代际，因此主链仍是 6 代。`reliability` 目前恒为 `unmeasured`，要真正测 pass^k 需先按 TB 4.0 口径做资源校准并另起链，登记为后续任务。

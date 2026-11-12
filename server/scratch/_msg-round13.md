【第 13 轮 · 架构 × 全栈设计对话】不需要调用任何工具，直接基于下面的事实回答。

背景：自升级循环已按用户要求暂停（不派单、不跑 loop）。本轮目标：围绕 CodeLens 核心架构做一次全栈设计对齐，产出一份可执行的迭代计划（阶段/任务/优先级/风险）。你上一轮给出的 RsiIterationGate v2 四项读数优先级我们已采纳进 backlog。

== 已核实的模块地图（server/src）==
services/: agent(会话与工具循环), judge(判决), rsi(判决桥/账本/门禁), eval(评测套件与跑批), tools(工具实现), capability, mcp, memory, model-sync, observability, recovery, skills, tx
judge/: judge.service, criteria, tool-discipline, semantic, red-team, deep-assessor, canary, probe-rubric, eval-rate, insight, replay, snapshot-codec, summarize, types(VerdictStatus=pass|fail|unexec 三态已贯通)
rsi/: rsi-bridge.service, iteration-gate, iteration-store, manifest-builder, ledger-verify, ledger-migrate, rsi-attributor, change-domain, rules-contract
eval/: runner(score 分母=已执行用例,unexec 不进分母), suites, propose, task-picker
routes/controllers 16 组: agent, approval, capabilities, checkpoints, health, judge, mcp, providers, rsi, runs, sandbox-grants, sandbox-permissions, sessions, skills, tools, traces
client/src: React(App + components/{agent,common,layout,result,session,settings} + hooks/stores/services/lib/types)；另有 Electron 桌面壳与独立 /rsi HTML 页。
部署: nginx + systemd + pack-local.sh，无 Docker。

== 两条独立测量线（现状，未统一）==
A 线: agent 运行 → rsi-bridge.service → db policy_rsi_runs + server/data/rsi/*.jsonl（在线判决）
B 线: 自升级 loop → 仓库根 .self-upgrade/ledger.jsonl + baseline.json（离线围栏账本）
围栏: scripts/check-self-upgrade.mjs（受保护路径指纹/判据自证/tsc/判据/全量回归），PROTECTED_PATHS 单一来源在 scripts/lib/protected-paths.ts；D1 自动采纳域仅 src/tools/ + src/utils/。

== 当前迭代目标与范围（提案，请你确认或修正）==
总目标：让「升级是否真实发生」这件事对人可见、对机器可验，然后再扩判据深度。
Phase A 测量可信: 破坏夹具(mutation fixtures)证明工具纪律门禁能被打红；D1 提名 fs-read-truncated-flag 走 author→implement→adopt 全链验证（循环恢复后第一件事）。
Phase B 门禁可见: RsiIterationGate v2 四读数（gate reason 全文 / baseline Δ pass-fail-unexec 三列 / 近 10 次 token-cost 趋势 / 采纳率趋势 <20%×3 红旗）。
Phase C 判据纵深: L2 语义判据、L3 红队判据的落地标准；tool-use-coach 重提名。

== 四个决策点，请逐一给出具体建议 ==
1. 数据流：A/B 两条测量线要不要统一？若统一，以哪条为 source of truth、迁移代价是什么？若保持独立，前端 gate 应该读哪条、如何避免两线读数打架误导人？
2. 接口设计：/api/v1/rsi 现有面之上，gate v2 需要哪些端点与 payload 形状？请给出具体 sketch（端点 + 关键字段），特别是三态 verdicts 与趋势数据怎么表达；实时更新用 REST 轮询还是复用现有 SSE？
3. 前后端协作：React client、独立 /rsi HTML、Electron 三套前端共存，RsiIterationGate v2 应该落在哪？共享组件/共享 API client 的策略是什么，避免三处各写一份？
4. 可扩展性：judge 的 L2/L3 判据如何做成可插拔（criteria 注册表？）而不破坏「尺子受保护」的围栏前提？eval 套件从 propose 晋升为固定套件的路径上，哪些环节必须人工、哪些可以机械？

输出要求：按 1-4 编号直接回答，每点给出明确立场 + 理由 + 风险；最后给一句你对 Phase A/B/C 顺序的确认或调整建议。不要复述事实表。
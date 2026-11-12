【第 14 轮 · 核验纠错 + 收敛】不需要调用任何工具，直接回答。

你第 13 轮的四个立场（两线独立/Gate 读 A 线、gate v2 落 React、注册表+受保护白名单、A→B→C）我们采纳。但按纪律对你引用的具体代码面做了机械核验，发现多处与事实不符——请基于下面的真实代码面修正你的方案，不要沿用虚构名字。

== 核验结果（虚构/误用）==
1. `/api/v1/rsi/overview` 不存在。真实 rsi 路由只有 6 条：GET /rsi/contract、GET /rsi/iterations、POST /rsi/iterations/plan、GET /rsi/decisions、GET /rsi/iterations/:id、POST /rsi/iterations/:id/decide。
2. `judge-audit.mjs --name=<name>` 不存在，该脚本只有 --strict 一个 flag。
3. `requiredJudges`、ledger 事件 `baseline-updated` 在代码里不存在。
4. `GREEN_BASELINE` 真实存在但语义被你误用：它是 author-task/agent-feedback 的反馈短码（判据在现状基线上就是绿的=不是真缺陷），不是「baseline 更新后生效的围栏闸」。
5. sse-writer 没有 `rsi:gate` 频道。SSE 事件是类型化联合：src/types/agent-events.ts 的 AgentEventMap/AgentEventName，emit<K extends AgentEventName>。新增 gate 事件必须扩展这个联合类型。
6. Gate 组件真实路径是 client/src/components/agent/RsiIterationGate.tsx（不是 components/ 根下）。

== 真实代码面（修正依据）==
- client/src/lib/iteration-gate-view.ts 已有三态 UI 词汇：statusLabel/statusClass('pass'|'fail'|'unexec')、filterIterations、decisionTone。Phase B 的视图层部分已就绪。
- client/src/types/ 只有一个 index.ts；仓库没有 shared/ 目录，也没有 .d.ts 同步机制。你的「shared/types + npm link」是全新基建。
- eval/propose.ts 已有变异验证机器：EvalProposal{reference,buggy,publicCases,hiddenCases,sourceUrls} + buildMutants/mutationScore/validateProposal(checks+mutation)/promoteProposal。没有 gapType/criterionName 字段。
- 围栏的判据是 --judge= 单文件传参 + --exclude-judges= 排除表，没有「requiredJudges 集合」概念。

== 请修正并回答（编号对应）==
1. 接口 sketch 修订：gate v2 的读数应该扩展 GET /rsi/iterations 的响应，还是新增 /rsi/gate 端点？给出基于真实 6 条路由的最小改动方案（含 payload 关键字段）。SSE 部分：给出要加进 AgentEventMap 的事件名与 payload 类型 sketch。
2. 共享类型：在没有 shared/ 基建的现状下，最小可行方案是什么（例如 client/src/types/index.ts 手工镜像 + 一条契约测试）？评估你原方案（tsc --declaration + npm link + pack-local 复制）的落地成本，给出取舍。
3. 晋升表修订：用真实的 propose.ts 机器（validateProposal/promoteProposal）重写「提名→审判据→围栏→固化」四步表，指明每步真实入口函数/脚本与人工点。judge-audit 只有 --strict，你的「按名审计」需要新增 flag 还是改用别的机械验收？
4. Phase A 的破坏夹具：propose.ts 已有 buildMutants/mutationScore（对 eval 提案），工具纪律门禁的破坏夹具应该复用这套机器还是独立写？给出理由。

最后一句话确认修订后的 Phase A/B/C 任务清单顺序。不要复述事实，直接给修正后的方案。
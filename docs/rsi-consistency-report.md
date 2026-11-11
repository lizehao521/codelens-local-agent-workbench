# RSI 规则契约一致性校验报告

> 校验日期：2026-11-10 深夜（追加 2026-11-11 00:0x 复跑）
> 执行：MVP开发专家团 QA（严过关）
> 依据：`docs/rsi-rules-alignment-spec.md`（§5 验收标准 AC-01..AC-11、§6 一致性校验清单 14 项）
> 结论：**一致，现有功能与文档语义未被破坏。**

---

## 1. 机械门禁（`npm run check:rsi-contract`）

脚本：`server/scripts/check-rsi-contract.mjs`（以 tsx 加载，直接 import 后端契约与前端兜底）。真实退出码 **0**，14 项全 PASS：

| # | 校验项 | 结果 | 证据锚点 |
|---|--------|------|----------|
| 1 | `version='rsi-rules-contract-v1'`、`authority='server/krsi/main.go'` | PASS | `rules-contract.ts:85-86` |
| 2 | `rules` 恰 6 条、id 集合 = R1..R6、`order` = 1..6、按 order 升序 = `R1,R2,R3,R4,R6,R5`、R6.order=5 / R5.order=6 | PASS | `main.go:463-495`（C5） |
| 3 | R1–R4/R6 `kind=rejection`、`resultsIn=[refused]`、`exitCodes=[2]`；R5 `kind=comparison`、`resultsIn=[improved,not_improved,undecidable]`、`exitCodes=[0,1,3]` | PASS | `main.go:74-77` |
| 4 | `states` 6 态 `exitCode` = 0/1/2/3/null/null、中文标签、tone 与锁定表一致 | PASS | `main.go:73-79`、`rsi-bridge.service.ts:33` |
| 5 | `judgeRunStates`（pass/fail/inconclusive）、`criterionStatuses`（pass/fail/unexec） | PASS | `judge/types.ts:19,22` |
| 6 | `basis` `requiredField` = null/null/null/source/why_absent；`label` = 实测/转述/估算/模型自述/**量不到** | PASS | `main.go:232-237`（C2） |
| 7 | `rules[].name` 六条长名逐字（结构与 schema 合法 / 判据集显式锚定 / 防删指标（防放水）/ 产物内容哈希可复核 / 同一代账本唯一 / 两代读数严格比较） | PASS | Spec §2:138 |
| 8 | `reasonRuleIdPattern='^(R[1-6]):'` | PASS | `main.go:510-535`（半角冒号） |
| 9 | **7a** 契约 `thresholds` == `DEFAULT_L0_THRESHOLDS` + `COVERAGE_THRESHOLD` 运行时值；`rules-contract.ts` 无硬编码小数 | PASS | `criteria.ts:23`、`types.ts:162` |
| 10 | **7b** `criteriaFingerprint() === 8d567e31d898304983333702028601466582a2b370d996e93643de8c92b4616d` | PASS | `manifest-builder.ts:192-215`（§0.8 红线） |
| 11 | **8①** 前端兜底 `FALLBACK_RULES_CONTRACT` 与后端契约逐项 JSON 深度相等（含字段顺序） | PASS | `client/src/lib/rsi-rules.ts:36` |
| 12 | C6 前端四文件无 `undecided` 幽灵值（0 命中） | PASS | `rsi-rules.ts` / `RsiDashboardModal.tsx` / `api.ts` / `rsi-dashboard.html` |
| 13 | C8 独立看板无硬编码规则排除列表、消费 `reasonRuleIdPattern` | PASS | `server/public/rsi-dashboard.html` |
| 14 | **8②/13** HTML 最小切片 label/tone/id/order + overview 失败三场景 | PASS | `client/tests/rsi-rules.test.ts`（运行时 stub） |

> 第 8②/13 项由前端 `client/tests/rsi-rules.test.ts` 的运行时断言（最小 DOM stub + fetch mock，三场景 RUNTIME_CHECK_PASS）覆盖，本报告以其测试通过为绿；门禁脚本对 HTML 做静态补充（无硬编码排除列表、消费 pattern）。

---

## 2. 全量回归（真实退出码）

| 项 | 命令 | 结果 |
|----|------|------|
| 后端类型检查 | `cd server && npx tsc --noEmit` | exit **0** |
| 后端定向测试 | `vitest run tests/rsi-rules-contract.test.ts tests/rsi-overview.test.ts` | 2 files / **17 passed**，exit **0** |
| 后端全量测试 | `npx vitest run` | **113 files / 1127 passed**，exit **0** |
| 前端类型检查 | `cd client && npx tsc --noEmit` | exit **0** |
| 前端全量测试 | `npx vitest run` | **14 files / 124 passed**，exit **0** |
| 内核 conformance | `cd server && npm run test:krsi` | **10/10 通过**，exit **0** |
| 证据链验证 | `npm run rsi:verify -- 23ae700c-…-b05579` | **5 行 v2 anchor，代数 [2,3,4,5,6]**，全链一致，exit **0** |
| 契约门禁 | `npm run check:rsi-contract` | **14 项 PASS**，exit **0** |

**未回归证明**：`server/krsi/main.go` 零改动（`git diff HEAD -- krsi/main.go` 为 0 行）；`rsi:verify` 复算 6 代 v2 anchor 原像全链通过；conformance 退出码 10/10 与契约编码一致。判定逻辑、退出码、报告文案模板、`METRIC_MAP` / `CRITERIA_FINGERPRINT` 运行逻辑均未被触碰。

---

## 3. 结论

1. **规则内容两端一致**：后端 `buildRsiRulesContract()`、前端 `FALLBACK_RULES_CONTRACT`、PM 准绳文档 `server/docs/rsi-rules-contract.md` §2.1 三处的 6 条规则 id / 名称 / order / 状态 / basis / 阈值逐值相等；前端兜底与后端契约 JSON 字节级（含字段顺序）相等。
2. **状态反馈与触发结果一致**：6 态中文标签与 tone 在 SPA、独立 HTML 看板、静态快照三处语义一致（静态快照按红线保留英文历史标签，tone 语义对齐）；`inconclusive→未定论`、`R2` 违规染色、eval 4 字段透传均已真修并有断言。
3. **现有功能与文档语义未破坏**：内核 conformance 10/10、证据链 6 代全链通过、双端 1246 个测试全绿。

---

## 4. 残留漂移点（诚实登记，非遗漏）

| 漂移点 | 性质 | 处置 |
|--------|------|------|
| `rsi-code-fix-dashboard.html` 静态快照 | 冻结历史数据，按 §0.6 不改写；英文历史标签与现行契约 tone 语义一致 | 说明落在 `server/docs/rsi-rules-contract.md` §3，HTML 保持 0 改动 |
| `tone → 视觉` 三处各自硬编码映射 | 契约只统一 tone 名，不统一渲染实现 | 三处 tone 键集相等已由门禁与测试守护 |
| 前端 `thresholds` 兜底需与后端常量同步 | 前端无法跨端 import，兜底锁死当前运行时值 0.6/0.5/0.9/0.6 | 后端常量受 §0.8 红线保护，改值时门禁 7a 会打红提示同步 |
| `extractMetrics` 全角/半角冒号失配（`main.go:582` 全角 vs 解析器半角） | 既存问题，非本轮引入，不影响历史链 | 只登记不修（见 ADR-026） |

---

## 5. 本轮 QA 侧改动文件

1. `server/scripts/check-rsi-contract.mjs`（新建，机械门禁）
2. `docs/rsi-consistency-report.md`（本文件）
3. `server/package.json`：`check:rsi-contract` 脚本值由 `node` 改为 `tsx`（使脚本可加载 `.ts` 契约，属必要接线）
4. `server/src/app.ts`：`/api/rsi/overview` 响应补 `Cache-Control: no-store`（经总监批准的双保险，消除 HTTP 缓存层两出口分叉）

> 其余实现文件由 PM / 架构师 / 后端 / 前端各自在 Spec §4 边界内交付，本报告不重复统计。

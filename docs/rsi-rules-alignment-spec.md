# Spec — AgentRsi 规则契约对齐 v1.0

> 生成日期：2026-11-10　状态：已锁定（本轮开发唯一依据）
> 基于：`server/krsi/main.go`（实现真相源）+ `server/docs/rsi-capability-sedimentation.md` §5 + `RSI-HANDOVER-2026-11-10-PM.md`
> 目标：**澄清与对齐，不是重写规则**。消除文档歧义/冲突/遗漏，前后端共用一份机器可读契约。

---

## 0. 红线（违反 = 退回重做）

以下一律**不准改**，改动会破坏现有功能或证据链语义：

1. `server/krsi/main.go` 的判定逻辑、退出码、报告文案模板。理由：6 代 v2 anchor 链、`rsi:verify`、krsi conformance 10/10 全部依赖其字节级稳定性。
2. `server/src/services/rsi/manifest-builder.ts` 的 `METRIC_MAP` / `CRITERIA_FINGERPRINT` **运行逻辑**（注释可修正）。理由：改了会让 R2 拒收历史链。
3. DB schema、既有 API 响应字段（**只增不删**）、历史账本 / anchor / `hash_version`。
4. `强化Agent.txt` 正文、`产品宪法补丁.md` 草案状态。理由：交接文档 §6.10 / §5 明确「草案，尚未拍板」，越权改动会伪造已生效结论。
5. `RSI-HANDOVER-2026-11-10-PM.md` **正文**（状态快照，历史不重写）。只允许在文末**追加**勘误登记。
6. `rsi-code-fix-dashboard.html` 的历史数据。该文件把「目标饱和」记为 `undecidable / exit 3`，**与 `main.go:524-530` 的 `atCeiling` 分支一致，是正确的**；交接文档 §9.6 的 `not_improved / exit 1` 是「目标没变好」的另一分支。两者都正确，不得"修正"。
7. P0 绝对规则：禁止 emoji 作功能图标（沿用 `lucide-react`）、禁止紫粉渐变、禁止新增硬编码 hex 颜色（用既有 CSS 变量 / Tailwind 语义 token）、禁止空洞占位文案。
8. `server/src/services/judge/criteria.ts:23` 的 `DEFAULT_L0_THRESHOLDS` 与 `server/src/services/judge/types.ts:162` 的 `COVERAGE_THRESHOLD` 的**取值**。注意：§0.2 只护住 `manifest-builder.ts` 的**运行逻辑**，不护住这两个常量的**值**。理由：两者是 `criteriaFingerprint()` 默认输入 → `criteria_sha256` → R2 判定的来源；取值一变，新代无 `criteria_diff` 被 R2 拒收，而历史 6 代账本因证据自带仍绿，`rsi:verify` 不报警、**所有门禁全绿却悄悄破坏语义**。改值须同步重跑 `npm run rsi:verify` 与 `npm run test:krsi` 复核 `criteria_sha256`。

---

## 1. 真相源裁定（消除"四套准绳"混乱）

| 层 | 裁定 | 依据 |
|---|---|---|
| **实现真相源** | `server/krsi/main.go` | 判决权在 Go 内核，不在模型、不在文档；`criteriaDeclared = "R1 R2 R3 R4 R5 R6"`（:78） |
| 文档准绳 | `server/docs/rsi-capability-sedimentation.md` §5 | R1–R6 与内核逐条一致 |
| **待修正文档** | `server/docs/rsi-loop.md` §2 / §3 / §4 | 编号错位、basis 口径错、外置"上游" |
| 状态枚举真相源 | `server/src/services/rsi/rsi-bridge.service.ts:33` `RsiVerdictState` + `server/src/services/judge/types.ts:19,22` | 6 态 / 3 态 / 3 态 |
| 不作判定依据 | `强化Agent.txt` C1–C4、`产品宪法补丁.md` | 草案/宣言，交接文档 §5 明示 |

**本 Spec 的 `docs/agent/spec.md` 无关**：README 的「唯一真相源」指 v2.0 产品定位与能力契约，不是 RSI 判据。

---

## 2. 冲突裁定表（必须按此裁定，不得两可）

| # | 冲突 | 错误侧 | **裁定（以内核为准）** | 证据 |
|---|---|---|---|---|
| C1 | R1–R6 编号含义 | `rsi-loop.md:106-113` 整节 | R1 schema 合法 / R2 判据集锚定 / R3 防删指标 / R4 产物哈希 / **R5 严格比较** / R6 同代唯一。R1–R4、R6 是 `refused` 前置拒收类，只有 R5 产出四态 | `main.go:214-337,344-435` |
| C2 | basis 必带字段 | `rsi-loop.md:69,108`、`RSI-HANDOVER:86`、`manifest-builder.ts:12` 写「relayed(2) 必带 source」 | **`basis=4 (model_says)` 必带 `source`；`basis=5 (absent)` 必带 `why_absent`；basis=2 无必带字段** | `main.go:232-237` |
| C3 | R6 举例 | `rsi-loop.md:113` 把 `budget_efficiency` 列为 direction=down 读数 | `budget.efficiency` **刻意不进 readings**（同文 §2:58 已写），举例须删除 | `rsi-loop.md:58`、`manifest-builder.ts:70-73` |
| C4 | 编号归属外置 | `rsi-loop.md:115-116`「以 `microkernel-rsi` 的 risk 包为准，冲突以上游为准」 | 仓库内**不存在**该包；真相源就是 `server/krsi/main.go`，措辞必须改为本地锚点 | 全仓检索 0 命中 |
| C5 | 执行顺序 | 文档按 R1–R6 顺序叙述 | 实际执行 **R1→R2→R3→R4→R6→R5**（R6 在 R5 前）。编号顺序 ≠ 执行顺序 | `main.go:463-495` |
| C6 | 前端幽灵状态 | `RsiDashboardModal.tsx:96` 判断 `undecided` | 后端**从不产生**该值；真实值是 `inconclusive` / `undecidable` 等 | `types.ts:22`、`rsi-bridge.service.ts:33` |
| C7 | eval 元数据断点 | `api.ts:1014-1038` 丢弃 4 字段 | 后端 `app.ts:255-262` 已下发，前端映射层必须透传 | `app.ts:255-262` |
| C8 | 规则染色漏 R2 | `server/public/rsi-dashboard.html:369` 排除列表无 R2 | 六条规则编号一律按契约派生，不再硬编码枚举 | `main.go:78` |

### 2.1 模糊表述 → 明确化（用户要求「适用条件 / 判断标准 / 响应要求」）

| 原文 | 明确化 |
|---|---|
| `undecidable「补证据，或降级为 skipped」 | 触发：`len(metrics)==0` / `objectiveCount==0` / `atCeiling`；补足标准 = 至少 1 个可比 objective 指标且未顶 1.0；**不自动重跑**，由下一轮 Act 自然产生 |
| refused「修 manifest / 判据，不重试」 | 触发：R1/R2/R3/R4/R6 任一；响应 = 点名 `R*:` 前缀的原因；**同一代不重跑**，修完由下一代以新 generation 进入；失败不阻断主流程 |
| `产品宪法补丁.md`「待确认」「落地动作建议」 | 保持草案状态，**不作为机械判定依据**；在本契约 `outOfScope` 显式声明 |
| `强化Agent.txt`「同一问题第二次出现」「答不出就不许删」 | 属宣言层，未落机械闸；本契约标为「未实现，不作判定」，不伪造状态枚举 |

### 2.2 遗漏项 → 补齐（只补描述，不新增判定逻辑）

- `RsiVerdictState` 6 态中 `skipped` / `error` 在文档 §3 缺表 → 补
- `RULES_VERSION = 'criterion-set-v2'`（`judge/replay.ts:39`）无文档描述 → 在契约文档标注其为判据集版本，与本次契约版本区分
- `LayerUnavailableReason` 三值无机器触发条件 → 记为 OPEN（不伪造触发条件），见 §8 未决登记

---

## 2. 规则契约数据结构（**锁定，前后端逐字段一致**）

新文件 `server/src/services/rsi/rules-contract.ts`，导出 `buildRsiRulesContract()`：

```ts
export type RsiTone = 'success' | 'danger' | 'warning' | 'muted';
export type RsiVerdictState =
  | 'improved' | 'not_improved' | 'refused' | 'undecidable' | 'skipped' | 'error';

export interface RsiRuleDefinition {
  id: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';
  name: string;                    // 中文名
  kind: 'rejection' | 'comparison';
  appliesWhen: string;             // 适用条件
  criterion: string;              // 判断标准
  onHit: string;                  // 响应 / 动作要求
  resultsIn: RsiVerdictState[];
  exitCodes: Array<number | null>;
  order: number;                  // 执行顺序 1..6（R6=5, R5=6）
  anchor: string;                 // 源码锚点，如 'server/krsi/main.go:215-243'
}

export interface RsiStateDefinition {
  state: RsiVerdictState;
  exitCode: number | null;
  label: string;                  // 中文标签
  tone: RsiTone;
  meaning: string;
  action: string;                  // 处置要求
  origin: 'krsi' | 'bridge';
}

export interface RsiLabeledState<S extends string> {
  state: S; label: string; tone: RsiTone;
}

export interface RsiBasisDefinition {
  value: 1 | 2 | 3 | 4 | 5;
  name: string; label: string;
  requiredField: string | null;   // 4 -> 'source'，5 -> 'why_absent'，其余 null
  note: string;
}

export interface RsiRulesContract {
  version: 'rsi-rules-contract-v1';
  authority: string;              // 'server/krsi/main.go'
  rules: RsiRuleDefinition[];      // 6 条，按 order 升序
  states: RsiStateDefinition[];    // 6 态
  judgeRunStates: Array<RsiLabeledState<'pass'|'fail'|'inconclusive'>>;
  criterionStatuses: Array<RsiLabeledState<'pass'|'fail'|'unexec'>>;
  basis: RsiBasisDefinition[];     // 5 条
  roles: Array<{ role: 'objective'|'guard'; label: string; requirement: string }>;
  thresholds: {                   // 从代码 import，禁止复制硬编码
    minToolSuccessRate: number;
    maxApprovalRejectionRate: number;
    maxBudgetUsageRate: number;
    coverageThreshold: number;
  };
  reasonRuleIdPattern: '^(R[1-6]):';
  outOfScope: string[];
}
```

**取值锁定**（不得自由发挥）：

| 项目 | 值 |
|---|---|
| `states` | improved/0/「已改进」/success；not_improved/1/「未改进」/warning；refused/2/「拒收」/danger；undecidable/3/「无法判定」/warning；skipped/null/「跳过」/muted；error/null/「桥接故障」/danger |
| `judgeRunStates` | pass「通过」success / fail「未通过」danger / inconclusive「未定论」warning |
| `criterionStatuses` | pass「通过」success / fail「未通过」danger / unexec「未执行」muted |
| `basis`（value/name/label/requiredField） | 1/measured/实测/null；2/relayed/转述/null；3/estimated/估算/null；4/model_says/模型自述/`source`；5/absent/**量不到**/`why_absent`。中文 label 以既有 `rsi-loop.md` §2 basis 表为准，不得写成「缺失」（避免与 `data_json` 缺失混淆） |
| `rules[].name`（以后端 `buildRsiRulesContract()` 为唯一权威） | R1 结构与 schema 合法 / R2 判据集显式锚定 / R3 防删指标（防放水）/ R4 产物内容哈希可复核 / R6 同一代账本唯一 / R5 两代读数严格比较。前端兜底与 PM 契约文档 §2.1「名称」列必须逐字一致，不得另用简称 |
| `roles` | objective「目标」= 必须严格变好；guard「护栏」= 不得变差，持平可以 |
| `thresholds` | `DEFAULT_L0_THRESHOLDS`（`judge/criteria.ts:23`）+ `COVERAGE_THRESHOLD`（`judge/types.ts:162`），**运行时 import** |

---

## 3. API 增量（锁定，既有字段一个不删）

| Method | Path | 行为 |
|---|---|---|
| `GET` | `/api/rsi/rules` | **新增**。无需 session，返回 `RsiRulesContract`（`Cache-Control: no-store`）。供独立看板与一致性校验脚本消费 |
| `GET` | `/api/rsi/overview?session=` | 响应**新增顶层 `rules` 字段**，其余 `session/judgeRuns/verdictsByRun/rsiRuns/attributions/eval` 原样保留 |

两者调用同一个 `buildRsiRulesContract()`，保证同源。

---

## 4. 文件边界（**严格遵守，禁止越界**）

| 成员 | 允许改动的文件 | 禁止 |
|---|---|---|
| PM | `server/docs/rsi-rules-contract.md`（新）、`server/docs/rsi-loop.md`、`RSI-HANDOVER-2026-11-10-PM.md`（**仅文末追加**）、`server/src/services/rsi/manifest-builder.ts`（**仅注释**） | 任何运行逻辑 |
| 架构师 | `agent-decisions/ADR-026.md`（新）、`agent-decisions/DECISION-LOG.md`（追加一行） | 产品代码 |
| 后端 | `server/src/services/rsi/rules-contract.ts`（新）、`server/src/app.ts`、`server/package.json`（加脚本）、`server/tests/rsi-rules-contract.test.ts`（新） | `client/**`、`server/public/**`、`server/docs/**` |
| 前端 | `client/src/services/api.ts`、`client/src/lib/rsi-rules.ts`（新）、`client/src/components/agent/RsiDashboardModal.tsx`、`client/tests/rsi-*.test.ts`、`server/public/rsi-dashboard.html` | `server/src/**`、`server/docs/**` |
| QA | `server/scripts/check-rsi-contract.mjs`（新）、`docs/rsi-consistency-report.md`（新） | 产品代码（只报告缺陷，不自行修） |

---

## 5. 验收标准（EARS，QA 以此打红）

| 编号 | EARS 验收标准 | P |
|---|---|---|
| AC-01 | When 请求 `GET /api/rsi/rules`，系统**必须**返回 `version` + 6 条 `rules`（id 不重复、order 恰为 1..6、R6.order=5、R5.order=6）+ 6 个 `states` | P0 |
| AC-02 | When 请求 `/api/rsi/overview`，系统**必须**保留全部 6 个既有顶层字段且值不变，并附加 `rules` | P0 |
| AC-03 | While 契约声明 `basis=4 → source`、`basis=5 → why_absent`，校验脚本**必须**与 `main.go:232-237` 逐项比对，不一致即 exit 1 | P0 |
| AC-04 | If 后端返回 `verdict='inconclusive'`，前端**必须**显示「未定论」，不得显示英文原串 | P0 |
| AC-05 | If 后端返回 6 态中任一 RSI verdict，前端**必须**显示对应中文标签并采用对应 tone | P0 |
| AC-06 | If `reasons[]` 含 `R2:`，独立看板**必须**判为违规染色，不得漏 | P0 |
| AC-07 | When `eval` 含 4 个元数据字段，前端映射层**必须**透传，组件不得恒显示「未标注 / 未测」 | P0 |
| AC-08 | If 响应无 `rules`（旧后端），前端**必须**用兜底契约正常渲染，不得白屏 | P0 |
| AC-09 | 双端 `tsc --noEmit` exit 0、既有 client/server 测试全绿、`krsi conformance` 10/10、`rsi:verify` 仍 exit 0（环境可读时）、**`npm run check:rsi-contract` exit 0** | P0 |
| AC-10 | 所有产出**不得**出现 emoji 功能图标、紫粉渐变、新增硬编码 hex 颜色 | P0 |
| AC-11 | When `GET /api/rsi/overview` 返回 400（缺 session）/ 404（坏 session）/ 网络失败 / 非 JSON，独立看板**必须**仍能渲染规则清单且不白屏（契约优先级 overview.rules → 独立端点 `/api/rsi/rules` → 内置切片）；规则清单展示不得依赖 overview 成功 | P0 |

---

## 6. 一致性校验清单（QA 机械执行）

1. 契约 `rules[].id` 集合 == `main.go:78` `criteriaDeclared` 的 6 条
2. 契约 `rules[].order` == `main.go:463-495` 实际调用顺序
3. 契约 `basis[].requiredField` == `main.go:232-237`
4. 契约 `states[].state` == `rsi-bridge.service.ts:33` 的 `RsiVerdictState` 联合类型
5. 契约 `states[].exitCode` == `main.go:74-77` 常量
6. 契约 `judgeRunStates` / `criterionStatuses` == `judge/types.ts:19,22`
7. 阈值校验拆两层，**不得混为一条**：
   - 7a 契约 `thresholds` == `criteria.ts:23`（`DEFAULT_L0_THRESHOLDS`）+ `types.ts:162`（`COVERAGE_THRESHOLD`）的**运行时 import 值**。应随常量合法调整而通过，**不得硬编码** 0.6/0.5/0.9/0.6（否则常量一调即假红）。
   - 7b `criteriaFingerprint()`（`manifest-builder.ts`）的**固定输出** == `8d567e31d898304983333702028601466582a2b370d996e93643de8c92b4616d`（恒定）。常量取值受 §0.8 红线保护，此断言钉死其现值，防静默改动。
8. 前端兜底契约有两份，门禁分层：① `client/src/lib/rsi-rules.ts` 的全量镜像须与后端 `buildRsiRulesContract()` **逐项 JSON 深度相等**（含字段顺序）；② `server/public/rsi-dashboard.html` 的内置最小切片是降级数据（无 basis/roles/thresholds/outOfScope/anchor/长文案），**只比** 6 态 label/tone 集合 + `reasonRuleIdPattern` + 6 个 `id` 集合，且切片的 `order` 派生须 == `R1,R2,R3,R4,R6,R5`（R6.order=5、R5.order=6）；对其整体逐项 JSON 相等门禁**不可执行、须豁免**。
9. `api.ts` 映射后 `eval` 4 字段非 undefined
10. 三处前端（SPA / 独立 HTML / 静态快照）对同一 verdict 的标签与 tone 一致（静态快照历史数据不动，仅补说明）
11. 后端契约 `basis[5].label === '量不到'`、前端兜底同值，且与 `rsi-loop.md` §2 basis 表一致；`rules[].name` 六条在「后端契约 / 前端兜底 / `rsi-rules-contract.md` §2.1 名称列」三处逐字相等
12. `rules[].anchor` 统一采用**函数定义行**起始：`R1:215-243 / R2:246-264 / R3:267-283 / R4:286-308 / R6:311-337 / R5:344-435,507-538`。PM 文档曾用的注释起始行（214/245/266/285/310）须对齐到此口径；两者指向同一段代码，QA **不得**把这一行偏移判为缺陷
13. overview 失败场景门禁（对应 AC-11）：用最小 DOM stub + fetch mock 实跑 `server/public/rsi-dashboard.html` 内嵌脚本，覆盖 3 场景——(a) overview 404 + `/api/rsi/rules` 200 → 独立端点调用 1 次、规则清单 6 条、顺序 `R1→R2→R3→R4→R6→R5`、错误横幅保留、`document.body` 未整页替换；(b) overview 404 + `/api/rsi/rules` 404 → 走内置切片、中性提示、不白屏；(c) overview 200 对照 → 规则清单 6 条。任一场景规则清单未渲染或白屏即 exit 1。（此场景已由前端 `client/tests/rsi-rules.test.ts` 的运行时断言覆盖，QA 以「该测试通过」为绿，不必重造。）
14. `criteriaFingerprint()` 固定输出断言（对应 7b）落入 `server/scripts/check-rsi-contract.mjs` 与既有 `tests/judge-criteria.test.ts` / `tests/rsi-manifest-builder.test.ts`，**不**落入 `tests/rsi-rules-contract.test.ts`（避免反向依赖 §0.2 冻结的 manifest-builder 运行逻辑）。

---

## 7. 端到端验证步骤

```bash
# 1. 双端类型检查
cd server && npx tsc --noEmit && cd ../client && npx tsc --noEmit

# 2. 契约一致性门禁
npm run check:rsi-contract

# 3. 定向测试
cd server && npx vitest run tests/rsi-rules-contract.test.ts tests/rsi-overview.test.ts
cd ../client && npx vitest run tests/rsi-dashboard.test.ts tests/rsi-series.test.ts

# 4. 内核与证据链不回归
cd server && npm run test:krsi && npm run rsi:verify -- <既有 sessionId>

# 5. 起服务后核对契约同源
curl -s http://127.0.0.1:8080/api/rsi/rules
curl -s 'http://127.0.0.1:8080/api/rsi/overview?session=<id>' | 取 .rules
# 断言：两者 JSON 深度相等，且 overview 既有字段齐全
```

---

## 8. 未决登记（OPEN，不伪造答案）

| 项 | 状态 | 说明 |
|---|---|---|
| `LayerUnavailableReason` 三值的机器触发条件 | OPEN | 现有枚举定义，触发条件未实现；本轮只登记不编造 |
| `产品宪法补丁.md` 是否拍板并入 | OPEN | 交接文档 §6.10 遗留，需用户决策 |
| `criterion-set-v2` 判据条目清单 | OPEN | 代码有版本标识，无文档；本轮只标注不定义 |
| `#13 lessonEffectiveness` 口径 / `#15` 隔离实例超时 | OPEN | 交接文档 §9.8/§9.10 遗留，与本次对齐无关 |

---

## 9. 变更记录

| 日期 | 内容 | 原因 |
|---|---|---|
| 2026-11-10 | 初版锁定 | 用户要求以现有 rsi 规则为准，梳理歧义/冲突/遗漏并对齐前后端 |

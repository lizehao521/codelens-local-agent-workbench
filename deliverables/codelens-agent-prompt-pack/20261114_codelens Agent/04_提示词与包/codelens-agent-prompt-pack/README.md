# CodeLens 专家级提示词包 · README

为 CodeLens Agent 生成 / 校验一套 16 份专家级提示词的技能包。三组并列：A 组日常软件开发 7 份、B 组 RSI 自我演进 7 份、S 组共享路由与交接 2 份。每份按统一 7 字段模板填空，跑 `scripts/validate_prompt_pack.py` 自检后交付。

## 包结构

```
codelens-agent-prompt-pack/
├── SKILL.md                       # 技能指令：角色 / 五条铁律 / 五阶段 SOP / 禁止项
├── README.md                      # 本文件：索引 / 路由 / 模板说明 / 规范差异 / 活读数声明 / 内建任务模式关系
├── prompts/                       # 16 份提示词正文（主编按下方固定文件名落盘）
│   ├── A01 … A07
│   ├── B01 … B07
│   └── S00 / S01
├── references/                    # 4 份知识库（已落盘，头部带信源声明块；本棒只建骨架、不写正文）
│   ├── 01-codelens-runtime-facts.md
│   ├── 02-governance-constraints.md
│   ├── 03-scenario-routing-matrix.md
│   └── 04-boundary-and-failure-modes.md
├── templates/
│   └── 统一提示词模板.md           # 元信息头 + 7 字段块，可直接填空
└── scripts/
    └── validate_prompt_pack.py    # 7 项自检，--help / --root / --self-test
```

## 16 份提示词索引

| 文件名 | 槽位 ID | 一句话职责 | 唯一产出物 | 对齐的内建 TaskKind（如有） |
|---|---|---|---|---|
| A01-requirement-clarification.md | A01 | 收拢模糊需求，逼出可验收输入与缺口 | 《需求边界卡》 | — |
| A02-solution-design.md | A02 | 给出实现路径、影响面与回滚点 | 《方案与影响面卡》 | — |
| A03-implementation.md | A03 | 按方案落地改动并逐文件注明 | 《实现改动单》 | — |
| A04-code-review.md | A04 | 按判据逐条核改动，分通过与打回 | 《评审报告》 | `analyze` |
| A05-test-acceptance.md | A05 | 实跑验收并回机器可读结果，未跑标 UNEXEC | 《验收读数表》 | `verify` |
| A06-debugging.md | A06 | 从证据定位根因，区分假红与真回归 | 《故障归因单》 | `debug` |
| A07-refactoring.md | A07 | 不改行为前提收窄结构并重跑验证 | 《重构等价性报告》 | `optimize` |
| B01-task-spec.md | B01 | 把能力缺口写成可执行题卡 | `<id>.spec.json` 题条目草案（含预算参数） | — |
| B02-act-execution.md | B02 | 在变更域内实施改动并留证据 | `run_report` + 改动清单（staging `server/candidates/<id>/`） | — |
| B03-judge-authoring.md | B03 | 写带反向断言的判据并自证判别力 | 判据草稿 + 自证清单（staging） | — |
| B04-verification-attribution.md | B04 | 跑围栏 / 全量回归并把失败归因到 infra / Agent / 人 | 验证诊断书（含逐命令读数表） | `verify` |
| B05-adoption-governance.md | B05 | D1 只写 staging、D4 由人 promote 并重锚基线 | 采纳记录（promote + 重锚 + 账本追加） | — |
| B06-tool-contract.md | B06 | 核对规范名 / 线上名唯一可逆、风险必填、清单一致 | 注册表 / 技能库条目变更清单 + 契约闸读数 | — |
| B07-runtime-diagnosis.md | B07 | 分辨超时、墙钟天花板、证据滞留并给停机或抬预算动作 | 运行态归因单（含类别、证据、处置顺序） | — |
| S00-router.md | S00 | 按场景判 A / B / S 组与槽位，派活三件套 | 《路由裁决单》 | — |
| S01-handoff.md | S01 | 把状态、验证命令、剩余顺序、踩坑边界压成单页 | 单页交接快照（HANDOFF 格式） | — |

> 文件名即契约：主编必须按上表逐字写盘，校验脚本按同一清单点名核对。
> 「唯一产出物」列取自各份正文的「唯一产出物」字段（省略句末句号），与索引互为契约；正文改产出物名时须同步本表。
> 标注了 TaskKind 的 5 个槽位（A04 / A05 / A06 / A07 / B04），其「⑤ 输出格式」按包内约定逐字采用该 TaskKind 的 `sections` 小节名与顺序、不另造名（源码标注为建议结构、非固定模板）；映射依据见《与 CodeLens 内建任务模式的关系》。

## A / B / S 路由速查

任何任务先过 S00，一次只定一个槽，写清上游、下游与禁止越权槽位。

| 组 | 判定场景 | 进入槽位 | 出口 |
|---|---|---|---|
| S 共享 | 任何任务先路由；跨组衔接、会话收尾 | S00 → S01 | 派单卡 / 交接快照 |
| A 日常开发 | 需求 → 设计 → 实现 → 评审 → 验收 → 排障 → 重构 | A01 → A07 | 逐槽唯一产出物 |
| B RSI 自演进 | 题集 → 执行 → 判据 → 归因 → 采纳 → 契约 → 运行态诊断 | B01 → B07 | 逐槽唯一产出物 |

边界：A 组不改判据与题集；B 组不替人 promote、不擅自重锚基线；S 组只做路由与交接，不写具体槽位正文。详见 references/03-scenario-routing-matrix.md。

## 7 字段统一结构说明

每份提示词 = 元信息头（6 项）+ 7 个字段块，顺序固定，缺一即不合格。

| 项 | 填什么 | 合格判据（摘要） |
|---|---|---|
| 元信息头 · 槽位 ID | A01 / B03 / S00 等 | 全局唯一，与文件名前缀一致 |
| 元信息头 · 适用口径 | A / B / S 三选一 | 与 S00 路由判定一致 |
| 元信息头 · 版本 | 语义化版本 | 非空 |
| 元信息头 · 上游槽位 | 前置槽位 ID 或「无」 | 指向真实槽位 |
| 元信息头 · 下游槽位 | 后继槽位 ID 或「无」 | 指向真实槽位 |
| 元信息头 · 禁止越权到 | 本份不得触碰的槽位 ID 列表 | 至少列全跨组槽位 |
| ① 角色定位 | 这份提示词以什么身份干活、凭什么专业 | 有定位与价值主张，不写空话 |
| ② 任务目标 | 一句话说死本槽要交付什么 | 可验收，指向唯一产出物 |
| ③ 上下文输入 | 必须拿到哪些输入才能开工 | 逐项列输入与来源，缺的进《待补清单》 |
| ④ 约束条件 | 硬约束与治理边界 | 含运行态事实口径、人所有目录、UNEXEC |
| ⑤ 输出格式 | 交付长什么样 | 给出结构、必含项、标注规则；对齐 TaskKind 时沿用 sections 原文 |
| ⑥ 边界情况 | 假红、超时、证据滞留、缺口等怎么判 | 每条给判定与动作，不编造证据 |
| ⑦ 质量要求 | 怎么算写到位 | 有逐条可验证判据，不用形容词 |

完整填写指引与逐块「合格判据」见 templates/统一提示词模板.md。

## 与 CodeLens 内建任务模式的关系

源码依据（本棒实读）：`server/src/services/agent/task-prompts.ts`。

- 内建任务模式常量：`TASK_KINDS = ['analyze','explain','debug','optimize','verify']`（5 个）。
- `TaskPromptSpec` 四字段：`label`（中文标签）/ `directive`（任务目标一句话）/ **`sections`（建议结构：内容需要时才用，可合并、省略或改名，不是固定模板；本包按包内约定逐字采用其小节名与顺序）** / `rules`（任务级补充规则）。
- 消费链：`AgentRequestSchema.taskKind → agent-loop.run → buildSystemPrompt(taskKind)`；`buildTaskSection(kind)` 把「任务目标 + 建议结构 + 任务规则」渲染成一段，追加到基座 system prompt 末尾。native 通道直接进 `buildSystemPrompt`，react 通道经 `buildReactSystemPrompt` 叠加**同一段** —— 两条通道缺一即开环。渲染出的段落为【建议结构】并明示「以下小节按内容取舍，不必逐条套用；可合并、省略或改名」。

**本提示词包不是要替换这 5 个内建 TaskKind。** 内建 TaskSpec 已覆盖「任务目标（directive）/ 输出格式（sections）/ 任务级规则（rules）」；本包做的是补齐它们没覆盖的四类字段 —— **上下文输入 / 约束条件 / 边界情况 / 质量要求** —— 并提供 A / B / S 三组 16 槽位路由与元信息头（上下游、禁止越权）。两者是叠加关系，不是替代关系。

### 5 个槽位与 TaskKind 的对齐（输出格式按包内约定逐字采用 sections 小节名）

| 槽位 | 对齐 TaskKind | 依据（该 TaskKind 的 directive） | 「输出格式」必须沿用的 sections 原文（按序） |
|---|---|---|---|
| A04 代码评审 | `analyze` | 逐行审读代码，找出正确性、安全性、边界条件与可维护性问题 | 问题清单 / 影响评估 / 改进建议 |
| A05 测试验收 | `verify` | 宣布改动完成前跑目标包声明的验证命令，用真实退出码证明没破坏既有行为 | 验证命令 / 实际读数 / 结论 |
| A06 调试排障 | `debug` | 定位缺陷根因，给出可落地的修复 | 问题定位 / 根因分析 / 修复建议 / 修复后代码 |
| A07 重构优化 | `optimize` | 在不改变外部行为前提下改进性能、可读性与健壮性 | 优化点清单 / 优化建议 / 优化后代码 / 权衡说明 |
| B04 验证归因 | `verify` | 同上；结论须引用通过 / 失败数量与失败脚本名 | 验证命令 / 实际读数 / 结论 |

- `explain`（一句话概述 / 逐段讲解 / 关键概念 / 运行示例）在本包 16 槽位中无对应槽位，不强行映射。
- 其余 11 个槽位无内建 TaskKind 对应，「输出格式」按 7 字段模板自拟，但不得与上述 5 个 TaskKind 的 sections 同名混用。
- 映射按 `directive` 语义就近对齐（实读 `TASK_PROMPTS` 得出），最终以主编终审为准；**不另造小节名**是包内约定（源码 `sections` 为建议结构，可合并 / 省略 / 改名，非固定模板）。

### 附：本包引用的已核实契约（实读 `server/src/types/tool.ts`）

| 类型 | 取值 |
|---|---|
| `ToolRisk` | `'low' \| 'medium' \| 'high'` |
| `ToolApprovalMode` | `'none' \| 'soft' \| 'hard' \| 'two_step'` |
| `ToolStatus` | 七态 `pending` / `running` / `success` / `failed` / `timeout` / `rejected` / `skipped` |

引用字段时按实际读到的写，未读全的一律标「待核实」。

## 如何复制使用

1. 把本包整目录放进 WorkBuddy 技能目录；或直接读 SKILL.md 与 templates/。
2. 复制 templates/统一提示词模板.md 到 prompts/<索引表里的固定文件名>.md，填元信息头与 7 字段。
3. 每写完一份跑一次 `python scripts/validate_prompt_pack.py --root "<包根>"`。
4. FAIL 修到零再交付；references/ 4 份与 prompts/ 16 份均已落盘，复跑 `scripts/validate_prompt_pack.py` 核对零 FAIL。
5. 任何凭据示例一律用 `${VAR}` 占位，禁止写入真实值。

自检脚本用法：

```
python scripts/validate_prompt_pack.py --help
python scripts/validate_prompt_pack.py --self-test
python scripts/validate_prompt_pack.py --root "<包根>"
```

逐项输出 PASS / FAIL / WARN 与总计；FAIL > 0 时 exit 非 0。七项检查：① 16 份齐全 ② 7 字段标题齐全 ③ 元信息头与槽位 ID 唯一 ④ frontmatter 8 必填字段可解析 ⑤ @references/ 引用文件存在 ⑥ 无硬编码密钥形态 ⑦ 活读数不写成规范（告警）。

## 规范差异点（以官方为准）

坊主 2026-11-14 用 WebFetch 交叉核实 https://open.workbuddy.cn/docs/skill，结论与工厂内置清单不一致，一律以官方页面为准：

- **官方**：SKILL.md frontmatter 必填 8 个 —— `name`、`display_name`、`display_name_en`、`description`（写清用途和触发词）、`description_zh`、`description_en`、`version`、`author`；选填 `allowed-tools`、`examples_zh`、`examples_en`。包结构 = `SKILL.md`（必填）+ `references/` + `scripts/` + `templates/`（后三者可选）；正文用 `@references/` 前缀加真实文件名引用知识库。
- **工厂内置 references/03-WorkBuddy官方规范对照清单.md 第二节**：把 `name` / `display_name` / `display_name_en` 标为「不必填」，并列出官方页面没有的 `category` / `disable-model-invocation` / `user-invocable` 三个字段。
- **本包处理**：frontmatter 恰好 8 个必填字段，不引入 `category` 等官方未列字段；不按 03 号清单的「必填 / 不必填」判定。该清单抬头亦写明「官方文档与本清单冲突时，以官方文档为准」。
- 依据 URL：https://open.workbuddy.cn/docs/skill

## 活读数裁定（不得写成规范）

**统一口径（坊主 2026-11-14 实读裁定）**：
**当前源码注册表实读 20 个工具（含 `agent.verify`）；此为活读数，以实跑为准，不得写成规范；手册 19 为上轮读数、17 为旧构建实例。**

工具数三层读数并列（层次不同、已有确定答案）：

| 读数 | 出处 | 层次 |
|---|---|---|
| 17 个工具 | 手册 §10「本地 8080 常驻旧实例」、§3 所列各表 | 旧构建进程，与源码注册表不是同一层 |
| 19 个工具 | 手册 §4 能力面、§12 的版本记录（上轮快照） | 上一轮运行态读数（`agent.verify` 落地前） |
| 20 个工具 | `server/src/tools/builtin/index.ts:25-46` 的 `BUILTIN_TOOLS` 数组 20 项；`HANDOFF §6` 的运行实例记录（20 个工具） | 与当前工作区源码注册表一致 |

工作区另有未提交新增 `server/src/tools/builtin/agent-verify.tool.ts`（`name: 'agent.verify'`、`wireName: 'agent_verify'`），是 20 与手册 §4 所列工具表（上轮读数）不一致的来源；它与手册 §4 不是同一时态，不构成矛盾。**工具名与计数的可核实来源是源码 `BUILTIN_TOOLS` 数组，手册 §4 仅为上轮读数快照，不作为工具名来源。** 手册 §10 与 HANDOFF §6 均说明：工具契约闸读的是运行中的服务，服务是旧构建时会报「注册表有、对外清单没有」的假红。

处理：凡涉及版本与计数，只写「以实跑为准 + 锚点命令」，不写绝对值，不据此下规范结论；不得把 19 当硬规范。校验脚本第 ⑦ 项会对把活读数写成绝对化断言或硬约束的句子告警（含「以实跑为准」「不得写成规范」的陈述句豁免）。

## 待核实项（本棒未决，交主编 / 审校终审）

1. references/ 4 份知识库正文 —— 已按固定文件名落盘，头部带信源声明块；本棒只建骨架、不写正文，内容终审由主编 / 审校完成。
2. prompts/ 16 份提示词正文 —— 已按索引表固定文件名落盘；本棒只建骨架、不写正文，内容终审由主编完成。
3. 5 个槽位（A04 / A05 / A06 / A07 / B04）与内建 TaskKind 的映射 —— 按 `directive` 语义就近对齐，最终以主编终审为准；「输出格式沿用 sections 原文」为硬约束。
4. 官方字段以 https://open.workbuddy.cn/docs/skill 为准；页面后续更新时以最新页面为准。

活读数口径已由坊主实读裁定（见上节），不再列为待核实。

> 口径说明（四层不混记，数字均为本机实读，截至 2026-11-14）：
> - 本小节 **4 项** = 包骨架层未决交接项，交主编 / 审校终审。
> - prompts/ **文件级** `> 待核实` 标注 = **3 处**（B01 / B05 / S01），是文件自身的待核实项。
> - prompts/ 正文里「标『待核实』」= **3 处**（A01 / A02 / S00），是《统一提示词模板》要求 Agent 在输入缺口时执行的**运行时动作**，不计入文件级。
> - references/ 4 份头部自述的信源级「待核实」= **01 为 6 处、02 / 03 / 04 各 5 处**（见各份文末《待核实清单》），属知识库内容，不计入本节。

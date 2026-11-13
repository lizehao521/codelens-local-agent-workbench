// RSI 规则契约的展示层 —— 真相源是 server/krsi/main.go 与
// server/src/services/rsi/rules-contract.ts。本文件只承担三件事：
//   1. 旧后端不下发 rules 时提供逐值相同的兜底契约（AC-08）；
//   2. 把三套不同枚举域（判据塔 run / RSI 代际 / 单条判据）分开分派（C6）；
//   3. 用契约派生规则 id，取代硬编码的 R 编号排除列表（C8）。
// 不做任何判定逻辑，不新增颜色值：tone 一律映射到 design-tokens.css 的语义类。

import type { RsiRulesContract, RsiTone } from '../services/api';

/** tone → 项目既有 Tailwind 语义类（design-tokens.css @theme inline 的 --color-*）。 */
const TONE_CLASS: Record<RsiTone, string> = {
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
  muted: 'text-text-tertiary',
};

export interface RsiPresentation {
  label: string;
  toneClass: string;
}

/** 契约外的状态：保留原串、不编造结论，用 muted 收敛视觉权重。 */
function unknownPresentation(state: string): RsiPresentation {
  return { label: state || '未知', toneClass: TONE_CLASS.muted };
}

function present(label: string, tone: RsiTone): RsiPresentation {
  return { label, toneClass: TONE_CLASS[tone] ?? TONE_CLASS.muted };
}

// ── 兜底契约：与 server buildRsiRulesContract() 逐值相同 ──────────────────
// 字段顺序也保持一致，便于 JSON 深度比对。thresholds 在后端是运行时 import
// （DEFAULT_L0_THRESHOLDS + COVERAGE_THRESHOLD），前端无法跨端 import，故按
// 当前运行时值逐值锁定：0.6 / 0.5 / 0.9 / 0.6。后端阈值若调整，此处需同步。
export const FALLBACK_RULES_CONTRACT: RsiRulesContract = {
  "version": "rsi-rules-contract-v1",
  "authority": "server/krsi/main.go",
  "rules": [
    {
      "id": "R1",
      "name": "结构与 schema 合法",
      "kind": "rejection",
      "appliesWhen": "上一代与这一代 manifest 各自载入后、进入跨代比对前，分别执行一次（main.go:466-473）",
      "criterion": "producer 非空、generation ≥ 0；每条 reading 的 metric 非空、basis 在 1–5、direction 为 up/down；basis=4 必须带 source，basis=5 必须带 why_absent；denominator 若提供必须为正；JSON 必须可解（main.go:455-461, 215-243）",
      "onHit": "整代拒收，理由以 `R1:` 前缀点名具体字段，退出码 2；同一代不重跑，修好 schema 后由下一代以新 generation 进入",
      "resultsIn": [
        "refused"
      ],
      "exitCodes": [
        2
      ],
      "order": 1,
      "anchor": "server/krsi/main.go:215-243"
    },
    {
      "id": "R2",
      "name": "判据集显式锚定",
      "kind": "rejection",
      "appliesWhen": "两代 criteria_sha256 不一致时（判据集指纹发生变化）；指纹一致直接放行",
      "criterion": "指纹变了必须提供非空 criteria_diff 声明；每条 diff 的 id 非空、change ∈ {tightened, loosened, added, removed}（main.go:246-264）",
      "onHit": "整代拒收，`R2:` 前缀点名「静默改判据」，退出码 2；须显式声明判据变更并让指纹与声明一致",
      "resultsIn": [
        "refused"
      ],
      "exitCodes": [
        2
      ],
      "order": 2,
      "anchor": "server/krsi/main.go:246-264"
    },
    {
      "id": "R3",
      "name": "防删指标（防放水）",
      "kind": "rejection",
      "appliesWhen": "每一代都对两代 readings 的 metric 集合做一次差集检查（main.go:479-483）",
      "criterion": "上一代出现过的 metric 在这一代必须仍存在；消失的指标排序后列出即拒收 —— 删指标不等于变好（main.go:267-283）",
      "onHit": "整代拒收，`R3:` 前缀列出被删指标，退出码 2；量不到应写 basis=5(absent) 保留该行，而不是删掉它",
      "resultsIn": [
        "refused"
      ],
      "exitCodes": [
        2
      ],
      "order": 3,
      "anchor": "server/krsi/main.go:267-283"
    },
    {
      "id": "R4",
      "name": "产物内容哈希可复核",
      "kind": "rejection",
      "appliesWhen": "这一代 manifest 的每个 artifact 声明（main.go:485-488 调用 checkR4(next)）",
      "criterion": "sha256 必须是 64 位十六进制、bytes 不得为负；声明了 path 且本机文件存在时，实际内容哈希与字节数必须与声明一致；文件不存在只校验格式（main.go:286-308）",
      "onHit": "整代拒收，`R4:` 前缀点名产物，退出码 2；产物必须能被内容哈希复核，不接受占位串",
      "resultsIn": [
        "refused"
      ],
      "exitCodes": [
        2
      ],
      "order": 4,
      "anchor": "server/krsi/main.go:286-308"
    },
    {
      "id": "R6",
      "name": "同一代账本唯一",
      "kind": "rejection",
      "appliesWhen": "账本可读时，扫描与这一代同 producer、同 generation 的历史 rsi_generation 行（main.go:489-493）",
      "criterion": "同一代不得在链上出现两份不同 manifest：内容哈希不一致即拒收；账本读不到时不因此拒收（main.go:311-337）",
      "onHit": "整代拒收，`R6:` 前缀点名第 N 代重记，退出码 2；修完由下一代以新 generation 进入",
      "resultsIn": [
        "refused"
      ],
      "exitCodes": [
        2
      ],
      "order": 5,
      "anchor": "server/krsi/main.go:311-337"
    },
    {
      "id": "R5",
      "name": "两代读数严格比较",
      "kind": "comparison",
      "appliesWhen": "R1/R2/R3/R4/R6 全部放行后（refuse 为空），对两代可比读数做严格比较（main.go:495, 507-538）",
      "criterion": "objective 必须严格变好（up: n 增大 / down: n 减小）；guard 不得变差（持平可以）；方向不一致或两代都 basis=5 的指标跳过；无可比指标 / 只有护栏 / 目标顶到 1.0 饱和 → undecidable；任一目标没变好或护栏变差 → not_improved；全部目标变好且护栏不退化 → improved（main.go:344-435, 507-538）",
      "onHit": "产出改进判定并写 `R5:` 前缀理由：improved=0 / not_improved=1 / undecidable=3；undecidable 不自动重跑，由下一轮 Act 补足至少 1 个可比 objective 指标且未顶 1.0",
      "resultsIn": [
        "improved",
        "not_improved",
        "undecidable"
      ],
      "exitCodes": [
        0,
        1,
        3
      ],
      "order": 6,
      "anchor": "server/krsi/main.go:344-435,507-538"
    }
  ],
  "states": [
    {
      "state": "improved",
      "exitCode": 0,
      "label": "已改进",
      "tone": "success",
      "meaning": "所有目标指标严格变好，且护栏指标未变差（main.go:9, 504-538）",
      "action": "本代改进成立，正常进入下一轮 Act；不自动重跑",
      "origin": "krsi"
    },
    {
      "state": "not_improved",
      "exitCode": 1,
      "label": "未改进",
      "tone": "warning",
      "meaning": "有目标指标没变好，或护栏指标变差（main.go:10, 517-537）",
      "action": "按 `R5:` 前缀理由定位没变好的目标 / 变差的护栏并改进；不自动重跑，由下一轮 Act 自然产生新读数",
      "origin": "krsi"
    },
    {
      "state": "refused",
      "exitCode": 2,
      "label": "拒收",
      "tone": "danger",
      "meaning": "R1/R2/R3/R4/R6 任一前置校验不通过：schema、判据锚定、指标完整性、产物哈希、同代唯一（main.go:11, 463-493）",
      "action": "点名 `R*:` 前缀的原因修 manifest / 判据；同一代不重跑，修完由下一代以新 generation 进入；失败不阻断主流程",
      "origin": "krsi"
    },
    {
      "state": "undecidable",
      "exitCode": 3,
      "label": "无法判定",
      "tone": "warning",
      "meaning": "没有可比目标指标：两代无可比指标、只有护栏没目标、或目标已顶到 1.0 饱和（main.go:511-516, 524-530）",
      "action": "补足标准 = 至少 1 个可比 objective 指标且未顶 1.0；不自动重跑，由下一轮 Act 自然产生",
      "origin": "krsi"
    },
    {
      "state": "skipped",
      "exitCode": null,
      "label": "跳过",
      "tone": "muted",
      "meaning": "首次运行无上一代成功判决可重建 prev manifest，桥接层不调用 krsi（rsi-bridge.service.ts:12）",
      "action": "无需处置；待产生上一代成功判决后，下一代自然进入跨代对账",
      "origin": "bridge"
    },
    {
      "state": "error",
      "exitCode": null,
      "label": "桥接故障",
      "tone": "danger",
      "meaning": "krsi 返回 0/1/2/3 之外的退出码，或可执行文件缺失 / 构建失败 / 调用超时（rsi-bridge.service.ts:21）",
      "action": "排查 krsi 安装路径与超时配置；桥接失败不阻断主流程，但本代不产出对账结论",
      "origin": "bridge"
    }
  ],
  "judgeRunStates": [
    {
      "state": "pass",
      "label": "通过",
      "tone": "success"
    },
    {
      "state": "fail",
      "label": "未通过",
      "tone": "danger"
    },
    {
      "state": "inconclusive",
      "label": "未定论",
      "tone": "warning"
    }
  ],
  "criterionStatuses": [
    {
      "state": "pass",
      "label": "通过",
      "tone": "success"
    },
    {
      "state": "fail",
      "label": "未通过",
      "tone": "danger"
    },
    {
      "state": "unexec",
      "label": "未执行",
      "tone": "muted"
    }
  ],
  "basis": [
    {
      "value": 1,
      "name": "measured",
      "label": "实测",
      "requiredField": null,
      "note": "工具调用 / 审批 / token 消耗 / 运行期信号直接算出的读数；countMeasured 只统计 basis 1–3（main.go:603-610）"
    },
    {
      "value": 2,
      "name": "relayed",
      "label": "转述",
      "requiredField": null,
      "note": "转述外部判据结论（如固定 prompt + 固定模型的 L2 深判，manifest-builder.ts:124-130）；C2 裁定 basis=2 无必带字段，manifest-builder.ts:12 旧注释「relayed 必须带 source」为错误侧"
    },
    {
      "value": 3,
      "name": "estimated",
      "label": "估算",
      "requiredField": null,
      "note": "估算读数；内核 R1 只校验 basis 落在 1–5，无额外必带字段（main.go:226-228）"
    },
    {
      "value": 4,
      "name": "model_says",
      "label": "模型自述",
      "requiredField": "source",
      "note": "模型自述读数必须带 source，缺失即被 R1 拒收（main.go:232-233）"
    },
    {
      "value": 5,
      "name": "absent",
      "label": "量不到",
      "requiredField": "why_absent",
      "note": "量不到的读数必须带 why_absent（main.go:235-236）；两代都 absent 的指标对不参与 R5 比较（main.go:374-376）"
    }
  ],
  "roles": [
    {
      "role": "objective",
      "label": "目标",
      "requirement": "必须严格变好：up 方向 n 增大 / down 方向 n 减小；reading 缺省 role 即按目标处理（main.go:377-403）"
    },
    {
      "role": "guard",
      "label": "护栏",
      "requirement": "不得变差，持平可以：up 方向 n≥prev / down 方向 n≤prev；变差计入 guardRegressed（main.go:388-397）"
    }
  ],
  "thresholds": {
    "minToolSuccessRate": 0.6,
    "maxApprovalRejectionRate": 0.5,
    "maxBudgetUsageRate": 0.9,
    "coverageThreshold": 0.6
  },
  "reasonRuleIdPattern": "^(R[1-6]):",
  "domains": [
    {
      "id": "D4",
      "label": "判据层（禁止自动改）",
      "requiresHumanApproval": true,
      "maxFiles": 0,
      "autoAllowedBy": [],
      "rationale": "改判据等于给自己发通行证。这一层只能由人提交，任何自动迭代都不得触碰。"
    },
    {
      "id": "D3",
      "label": "架构层（每次需人批）",
      "requiresHumanApproval": true,
      "maxFiles": 12,
      "autoAllowedBy": [],
      "rationale": "目录、依赖、类型契约、路由汇总一旦改动，影响面超出单个能力；无人值守不该碰。"
    },
    {
      "id": "D2",
      "label": "服务层（首次需人批）",
      "requiresHumanApproval": true,
      "maxFiles": 8,
      "autoAllowedBy": [
        "manual"
      ],
      "rationale": "服务层承载业务语义，改错会让多个工具同时失效；首次改动要人确认方向，之后同类改动可自动。"
    },
    {
      "id": "D1",
      "label": "工具层（可全自动）",
      "requiresHumanApproval": false,
      "maxFiles": 6,
      "autoAllowedBy": [
        "manual",
        "schedule",
        "failure-accumulation",
        "threshold-breach",
        "charter-drift"
      ],
      "rationale": "叶子能力：影响面被单个工具的判据框住，判据 + 围栏能兜住，可以全自动。"
    },
    {
      "id": "D0",
      "label": "只读（不改任何文件）",
      "requiresHumanApproval": false,
      "maxFiles": 0,
      "autoAllowedBy": [
        "manual",
        "schedule",
        "failure-accumulation",
        "threshold-breach",
        "charter-drift"
      ],
      "rationale": "纯评估轮：只跑判据、只落读数，不产生任何写操作。"
    }
  ],
  "decisions": [
    {
      "decision": "continue",
      "label": "达标继续",
      "tone": "success",
      "action": "升版本、进入下一代 Act"
    },
    {
      "decision": "retry",
      "label": "重试",
      "tone": "warning",
      "action": "带诊断重派同一题（域与题不变）"
    },
    {
      "decision": "rollback",
      "label": "回滚",
      "tone": "danger",
      "action": "还原到本轮回滚点，账本记 rolled_back"
    },
    {
      "decision": "escalate",
      "label": "待人审",
      "tone": "warning",
      "action": "暂停自动迭代，等待人工批准或补足依据"
    },
    {
      "decision": "halt",
      "label": "停机",
      "tone": "danger",
      "action": "停止自动迭代，交人工排查"
    }
  ],
  "iterationCriteria": [
    {
      "id": "G1",
      "name": "跨代判定为 improved",
      "threshold": "verdict = improved",
      "onFail": "retry"
    },
    {
      "id": "G2",
      "name": "护栏指标不回退",
      "threshold": "guardRegressed = 0",
      "onFail": "rollback"
    },
    {
      "id": "G3",
      "name": "围栏全部通过（无 fail、无 unexec）",
      "threshold": "fail = 0 且 unexec = 0",
      "onFail": "retry"
    },
    {
      "id": "G4",
      "name": "改动全部在授权域内",
      "threshold": "outOfScopeChanges = 0",
      "onFail": "rollback"
    },
    {
      "id": "G5",
      "name": "判据执行覆盖率",
      "threshold": "coverage ≥ 0.6",
      "onFail": "retry"
    },
    {
      "id": "G6",
      "name": "尝试次数未耗尽",
      "threshold": "attempts < maxAttempts",
      "onFail": "rollback"
    }
  ],
  "outOfScope": [
    "budget.efficiency 刻意不进 RSI readings：成本是 L0 闸（用量超预算上限即判 fail），不是「越低越好」的目标；把它当目标会让「越学越贵」被误判成「越学越差」（manifest-builder.ts:70-73，C3）",
    "强化Agent.txt 的 C1–C4 已落地为 domains / decisions / iterationCriteria 三组可选字段（权限分级、去留决策、量化判据），但**判定仍由 R1–R6 与围栏执行**：这三组只描述\"允许改到哪、达标线在哪、不达标怎么处置\"，不新增驱逐规则、不改 6 态语义",
    "criteria_sha256 判据集内容指纹由 manifest-builder.ts 的 criteriaFingerprint() / CRITERIA_FINGERPRINT 计算；本契约只描述 R2 如何校验它，不参与计算也不复制其值（manifest-builder.ts:192-215）",
    "judge/replay.ts:39 的 RULES_VERSION = criterion-set-v2 是判据集版本标识，与本契约版本 rsi-rules-contract-v1 分属不同维度；本轮只登记，不定义其判据条目清单（Spec §2.2、§8 OPEN）"
  ]
};

function nonEmpty<T>(value: T[] | undefined, fallback: T[]): T[] {
  return Array.isArray(value) && value.length > 0 ? value : fallback;
}

/**
 * 旧后端 / 脏数据没有 rules 时用兜底契约接管，不白屏（AC-08）。
 * 有契约但字段残缺时逐字段回退，避免半截 JSON 让分派拿到 undefined。
 */
export function resolveContract(rules: RsiRulesContract | null | undefined): RsiRulesContract {
  if (!rules) return FALLBACK_RULES_CONTRACT;
  const f = FALLBACK_RULES_CONTRACT;
  return {
    ...f,
    ...rules,
    rules: nonEmpty(rules.rules, f.rules),
    states: nonEmpty(rules.states, f.states),
    judgeRunStates: nonEmpty(rules.judgeRunStates, f.judgeRunStates),
    criterionStatuses: nonEmpty(rules.criterionStatuses, f.criterionStatuses),
    basis: nonEmpty(rules.basis, f.basis),
    roles: nonEmpty(rules.roles, f.roles),
    outOfScope: nonEmpty(rules.outOfScope, f.outOfScope),
    reasonRuleIdPattern: rules.reasonRuleIdPattern || f.reasonRuleIdPattern,
    authority: rules.authority || f.authority,
    version: rules.version || f.version,
    thresholds: { ...f.thresholds, ...(rules.thresholds ?? {}) },
  };
}

/** 判据塔 run 级 3 态（JudgeRunVerdict）：pass / fail / inconclusive。 */
export function judgeRunPresentation(state: string, contract: RsiRulesContract): RsiPresentation {
  const found = contract.judgeRunStates.find((item) => item.state === state);
  return found ? present(found.label, found.tone) : unknownPresentation(state);
}

/** RSI 代际 6 态（RsiVerdictState）；不要拿判据塔映射套到这里。 */
export function rsiStatePresentation(state: string, contract: RsiRulesContract): RsiPresentation {
  const found = contract.states.find((item) => item.state === state);
  return found ? present(found.label, found.tone) : unknownPresentation(state);
}

/** 单条判据 3 态（JudgeVerdictStatus）：pass / fail / unexec。 */
export function criterionStatusPresentation(state: string, contract: RsiRulesContract): RsiPresentation {
  const found = contract.criterionStatuses.find((item) => item.state === state);
  return found ? present(found.label, found.tone) : unknownPresentation(state);
}

/** 该 RSI 状态的处置要求（代际原因列的副文本）；契约外状态不编造动作。 */
export function rsiStateAction(state: string, contract: RsiRulesContract): string {
  return contract.states.find((item) => item.state === state)?.action ?? '';
}

/**
 * 从 "R5: ..." / "R2: ..." 形态的原因里提取规则 id —— 用契约下发的正则，
 * 不再硬编码 R 编号列表（C8 漏 R2 的根因正是硬编码排除列表）。
 * 只认契约里真实存在的 id，避免把 "RX:" 之类的噪声当成规则命中。
 */
export function ruleIdFromReason(reason: string, contract: RsiRulesContract): string | null {
  let re: RegExp;
  try {
    re = new RegExp(contract.reasonRuleIdPattern);
  } catch {
    return null;
  }
  const id = re.exec(reason)?.[1] ?? null;
  return id && contract.rules.some((rule) => rule.id === id) ? id : null;
}

/** 该原因是否命中任一契约规则 —— SPA 与独立看板共用的违规染色口径。 */
export function isRuleViolation(reason: string, contract: RsiRulesContract): boolean {
  return ruleIdFromReason(reason, contract) !== null;
}

/**
 * RSI 规则契约 —— 前后端共用的机器可读单一事实源。
 *
 * 真相源：server/krsi/main.go（R1–R6 判定逻辑、执行顺序、退出码）
 *        + server/src/services/rsi/rsi-bridge.service.ts:33（6 态）
 *        + server/src/services/judge/types.ts:19,22（三态 / 总判决）。
 * 裁定依据：docs/rsi-rules-alignment-spec.md §2（C1–C8 冲突裁定表 + 取值锁定表）。
 *
 * 本模块只「描述」不「判定」：纯函数、无 DB、无文件 IO、无副作用。
 * 阈值从判据代码运行时 import，杜绝复制数字字面量造成的口径漂移。
 */

import { DEFAULT_L0_THRESHOLDS } from '../judge/criteria.js';
import { COVERAGE_THRESHOLD } from '../judge/types.js';

// ── 类型契约（Spec §2 锁定，前后端逐字段一致）────────────────────────────

export type RsiTone = 'success' | 'danger' | 'warning' | 'muted';

export type RsiVerdictState =
  | 'improved' | 'not_improved' | 'refused' | 'undecidable' | 'skipped' | 'error';

export interface RsiRuleDefinition {
  id: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';
  name: string;
  kind: 'rejection' | 'comparison';
  appliesWhen: string;
  criterion: string;
  onHit: string;
  resultsIn: RsiVerdictState[];
  exitCodes: Array<number | null>;
  order: number;
  anchor: string;
}

export interface RsiStateDefinition {
  state: RsiVerdictState;
  exitCode: number | null;
  label: string;
  tone: RsiTone;
  meaning: string;
  action: string;
  origin: 'krsi' | 'bridge';
}

export interface RsiLabeledState<S extends string> {
  state: S;
  label: string;
  tone: RsiTone;
}

export interface RsiBasisDefinition {
  value: 1 | 2 | 3 | 4 | 5;
  name: string;
  label: string;
  requiredField: string | null;
  note: string;
}

export interface RsiRulesContract {
  version: 'rsi-rules-contract-v1';
  authority: string;
  rules: RsiRuleDefinition[];
  states: RsiStateDefinition[];
  judgeRunStates: Array<RsiLabeledState<'pass' | 'fail' | 'inconclusive'>>;
  criterionStatuses: Array<RsiLabeledState<'pass' | 'fail' | 'unexec'>>;
  basis: RsiBasisDefinition[];
  roles: Array<{ role: 'objective' | 'guard'; label: string; requirement: string }>;
  thresholds: {
    minToolSuccessRate: number;
    maxApprovalRejectionRate: number;
    maxBudgetUsageRate: number;
    coverageThreshold: number;
  };
  reasonRuleIdPattern: '^(R[1-6]):';
  outOfScope: string[];
}

/**
 * 构建 RSI 规则契约。每次调用返回全新对象，调用方改动不会污染后续调用。
 * 所有数值取自运行时 import，文本逐条对应 main.go 的真实逻辑。
 */
export function buildRsiRulesContract(): RsiRulesContract {
  return {
    version: 'rsi-rules-contract-v1',
    authority: 'server/krsi/main.go',

    // 按 order 升序 = main.go:463-495 真实执行顺序 R1→R2→R3→R4→R6→R5（C5）。
    rules: [
      {
        id: 'R1',
        name: '结构与 schema 合法',
        kind: 'rejection',
        appliesWhen: '上一代与这一代 manifest 各自载入后、进入跨代比对前，分别执行一次（main.go:466-473）',
        criterion: 'producer 非空、generation ≥ 0；每条 reading 的 metric 非空、basis 在 1–5、direction 为 up/down；basis=4 必须带 source，basis=5 必须带 why_absent；denominator 若提供必须为正；JSON 必须可解（main.go:455-461, 215-243）',
        onHit: '整代拒收，理由以 `R1:` 前缀点名具体字段，退出码 2；同一代不重跑，修好 schema 后由下一代以新 generation 进入',
        resultsIn: ['refused'],
        exitCodes: [2],
        order: 1,
        anchor: 'server/krsi/main.go:215-243',
      },
      {
        id: 'R2',
        name: '判据集显式锚定',
        kind: 'rejection',
        appliesWhen: '两代 criteria_sha256 不一致时（判据集指纹发生变化）；指纹一致直接放行',
        criterion: '指纹变了必须提供非空 criteria_diff 声明；每条 diff 的 id 非空、change ∈ {tightened, loosened, added, removed}（main.go:246-264）',
        onHit: '整代拒收，`R2:` 前缀点名「静默改判据」，退出码 2；须显式声明判据变更并让指纹与声明一致',
        resultsIn: ['refused'],
        exitCodes: [2],
        order: 2,
        anchor: 'server/krsi/main.go:246-264',
      },
      {
        id: 'R3',
        name: '防删指标（防放水）',
        kind: 'rejection',
        appliesWhen: '每一代都对两代 readings 的 metric 集合做一次差集检查（main.go:479-483）',
        criterion: '上一代出现过的 metric 在这一代必须仍存在；消失的指标排序后列出即拒收 —— 删指标不等于变好（main.go:267-283）',
        onHit: '整代拒收，`R3:` 前缀列出被删指标，退出码 2；量不到应写 basis=5(absent) 保留该行，而不是删掉它',
        resultsIn: ['refused'],
        exitCodes: [2],
        order: 3,
        anchor: 'server/krsi/main.go:267-283',
      },
      {
        id: 'R4',
        name: '产物内容哈希可复核',
        kind: 'rejection',
        appliesWhen: '这一代 manifest 的每个 artifact 声明（main.go:485-488 调用 checkR4(next)）',
        criterion: 'sha256 必须是 64 位十六进制、bytes 不得为负；声明了 path 且本机文件存在时，实际内容哈希与字节数必须与声明一致；文件不存在只校验格式（main.go:286-308）',
        onHit: '整代拒收，`R4:` 前缀点名产物，退出码 2；产物必须能被内容哈希复核，不接受占位串',
        resultsIn: ['refused'],
        exitCodes: [2],
        order: 4,
        anchor: 'server/krsi/main.go:286-308',
      },
      {
        id: 'R6',
        name: '同一代账本唯一',
        kind: 'rejection',
        appliesWhen: '账本可读时，扫描与这一代同 producer、同 generation 的历史 rsi_generation 行（main.go:489-493）',
        criterion: '同一代不得在链上出现两份不同 manifest：内容哈希不一致即拒收；账本读不到时不因此拒收（main.go:311-337）',
        onHit: '整代拒收，`R6:` 前缀点名第 N 代重记，退出码 2；修完由下一代以新 generation 进入',
        resultsIn: ['refused'],
        exitCodes: [2],
        order: 5,
        anchor: 'server/krsi/main.go:311-337',
      },
      {
        id: 'R5',
        name: '两代读数严格比较',
        kind: 'comparison',
        appliesWhen: 'R1/R2/R3/R4/R6 全部放行后（refuse 为空），对两代可比读数做严格比较（main.go:495, 507-538）',
        criterion: 'objective 必须严格变好（up: n 增大 / down: n 减小）；guard 不得变差（持平可以）；方向不一致或两代都 basis=5 的指标跳过；无可比指标 / 只有护栏 / 目标顶到 1.0 饱和 → undecidable；任一目标没变好或护栏变差 → not_improved；全部目标变好且护栏不退化 → improved（main.go:344-435, 507-538）',
        onHit: '产出改进判定并写 `R5:` 前缀理由：improved=0 / not_improved=1 / undecidable=3；undecidable 不自动重跑，由下一轮 Act 补足至少 1 个可比 objective 指标且未顶 1.0',
        resultsIn: ['improved', 'not_improved', 'undecidable'],
        exitCodes: [0, 1, 3],
        order: 6,
        anchor: 'server/krsi/main.go:344-435,507-538',
      },
    ],

    // 6 态取值锁定：Spec §2 表；exitCode 对齐 main.go:74-77；origin 区分内核/桥接。
    states: [
      {
        state: 'improved', exitCode: 0, label: '已改进', tone: 'success',
        meaning: '所有目标指标严格变好，且护栏指标未变差（main.go:9, 504-538）',
        action: '本代改进成立，正常进入下一轮 Act；不自动重跑',
        origin: 'krsi',
      },
      {
        state: 'not_improved', exitCode: 1, label: '未改进', tone: 'warning',
        meaning: '有目标指标没变好，或护栏指标变差（main.go:10, 517-537）',
        action: '按 `R5:` 前缀理由定位没变好的目标 / 变差的护栏并改进；不自动重跑，由下一轮 Act 自然产生新读数',
        origin: 'krsi',
      },
      {
        state: 'refused', exitCode: 2, label: '拒收', tone: 'danger',
        meaning: 'R1/R2/R3/R4/R6 任一前置校验不通过：schema、判据锚定、指标完整性、产物哈希、同代唯一（main.go:11, 463-493）',
        action: '点名 `R*:` 前缀的原因修 manifest / 判据；同一代不重跑，修完由下一代以新 generation 进入；失败不阻断主流程',
        origin: 'krsi',
      },
      {
        state: 'undecidable', exitCode: 3, label: '无法判定', tone: 'warning',
        meaning: '没有可比目标指标：两代无可比指标、只有护栏没目标、或目标已顶到 1.0 饱和（main.go:511-516, 524-530）',
        action: '补足标准 = 至少 1 个可比 objective 指标且未顶 1.0；不自动重跑，由下一轮 Act 自然产生',
        origin: 'krsi',
      },
      {
        state: 'skipped', exitCode: null, label: '跳过', tone: 'muted',
        meaning: '首次运行无上一代成功判决可重建 prev manifest，桥接层不调用 krsi（rsi-bridge.service.ts:12）',
        action: '无需处置；待产生上一代成功判决后，下一代自然进入跨代对账',
        origin: 'bridge',
      },
      {
        state: 'error', exitCode: null, label: '桥接故障', tone: 'danger',
        meaning: 'krsi 返回 0/1/2/3 之外的退出码，或可执行文件缺失 / 构建失败 / 调用超时（rsi-bridge.service.ts:21）',
        action: '排查 krsi 安装路径与超时配置；桥接失败不阻断主流程，但本代不产出对账结论',
        origin: 'bridge',
      },
    ],

    // judge/types.ts:22 RunVerdict（总判决）；:19 VerdictStatus（单条判据）。
    judgeRunStates: [
      { state: 'pass', label: '通过', tone: 'success' },
      { state: 'fail', label: '未通过', tone: 'danger' },
      { state: 'inconclusive', label: '未定论', tone: 'warning' },
    ],
    criterionStatuses: [
      { state: 'pass', label: '通过', tone: 'success' },
      { state: 'fail', label: '未通过', tone: 'danger' },
      { state: 'unexec', label: '未执行', tone: 'muted' },
    ],

    // C2 裁定：只有 basis=4 必带 source、basis=5 必带 why_absent（main.go:232-237）。
    basis: [
      {
        value: 1, name: 'measured', label: '实测', requiredField: null,
        note: '工具调用 / 审批 / token 消耗 / 运行期信号直接算出的读数；countMeasured 只统计 basis 1–3（main.go:603-610）',
      },
      {
        value: 2, name: 'relayed', label: '转述', requiredField: null,
        note: '转述外部判据结论（如固定 prompt + 固定模型的 L2 深判，manifest-builder.ts:124-130）；C2 裁定 basis=2 无必带字段，manifest-builder.ts:12 旧注释「relayed 必须带 source」为错误侧',
      },
      {
        value: 3, name: 'estimated', label: '估算', requiredField: null,
        note: '估算读数；内核 R1 只校验 basis 落在 1–5，无额外必带字段（main.go:226-228）',
      },
      {
        value: 4, name: 'model_says', label: '模型自述', requiredField: 'source',
        note: '模型自述读数必须带 source，缺失即被 R1 拒收（main.go:232-233）',
      },
      {
        value: 5, name: 'absent', label: '量不到', requiredField: 'why_absent',
        note: '量不到的读数必须带 why_absent（main.go:235-236）；两代都 absent 的指标对不参与 R5 比较（main.go:374-376）',
      },
    ],

    roles: [
      {
        role: 'objective', label: '目标',
        requirement: '必须严格变好：up 方向 n 增大 / down 方向 n 减小；reading 缺省 role 即按目标处理（main.go:377-403）',
      },
      {
        role: 'guard', label: '护栏',
        requirement: '不得变差，持平可以：up 方向 n≥prev / down 方向 n≤prev；变差计入 guardRegressed（main.go:388-397）',
      },
    ],

    // 运行时 import，禁止复制数字字面量（criteria.ts:23 + types.ts:162）。
    thresholds: {
      minToolSuccessRate: DEFAULT_L0_THRESHOLDS.minToolSuccessRate,
      maxApprovalRejectionRate: DEFAULT_L0_THRESHOLDS.maxApprovalRejectionRate,
      maxBudgetUsageRate: DEFAULT_L0_THRESHOLDS.maxBudgetUsageRate,
      coverageThreshold: COVERAGE_THRESHOLD,
    },

    reasonRuleIdPattern: '^(R[1-6]):',

    outOfScope: [
      'budget.efficiency 刻意不进 RSI readings：成本是 L0 闸（用量超预算上限即判 fail），不是「越低越好」的目标；把它当目标会让「越学越贵」被误判成「越学越差」（manifest-builder.ts:70-73，C3）',
      '强化Agent.txt 的 C1–C4 与 产品宪法补丁.md 仍是宣言 / 草案，尚未拍板，不作机械判定依据；本契约不据其新增规则、状态或触发条件（Spec §0.4、§5、§2.1）',
      'criteria_sha256 判据集内容指纹由 manifest-builder.ts 的 criteriaFingerprint() / CRITERIA_FINGERPRINT 计算；本契约只描述 R2 如何校验它，不参与计算也不复制其值（manifest-builder.ts:192-215）',
      'judge/replay.ts:39 的 RULES_VERSION = criterion-set-v2 是判据集版本标识，与本契约版本 rsi-rules-contract-v1 分属不同维度；本轮只登记，不定义其判据条目清单（Spec §2.2、§8 OPEN）',
    ],
  };
}

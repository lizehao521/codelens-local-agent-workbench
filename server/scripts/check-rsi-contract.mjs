#!/usr/bin/env node
/**
 * 一致性门禁：机械执行 docs/rsi-rules-alignment-spec.md §6 的契约级校验。
 *
 * 运行：npm run check:rsi-contract（package.json 以 tsx 加载，故可直接 import .ts）
 * 任一不符 -> exit 1；全过 -> exit 0。
 *
 * 覆盖范围：
 *   §6-1/2  rules id 集合、order 升序（R6=5、R5=6）、kind/resultsIn/exitCodes
 *   §6-3/11 basis requiredField 与中文标签、rules[].name 六条长名
 *   §6-4/5  states 6 态 exitCode / 中文标签 / tone
 *   §6-6    judgeRunStates / criterionStatuses
 *   §6-7a   thresholds == DEFAULT_L0_THRESHOLDS + COVERAGE_THRESHOLD 运行时值（不得硬编码）
 *   §6-7b   criteriaFingerprint() 固定输出（常量取值受 §0.8 红线保护）
 *   §6-8①  前端兜底契约与后端 buildRsiRulesContract() 逐项 JSON 深度相等
 *   C6/C8   前端无 undecided 幽灵值、独立看板无硬编码规则排除列表
 * 第 8②/13 项（HTML 最小切片的 label/tone/id/order）由 client/tests/rsi-rules.test.ts
 * 的运行时 stub 断言覆盖，本脚本以静态检查做补充。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRsiRulesContract } from '../src/services/rsi/rules-contract.ts';
import { criteriaFingerprint } from '../src/services/rsi/manifest-builder.ts';
import { DEFAULT_L0_THRESHOLDS } from '../src/services/judge/criteria.ts';
import { COVERAGE_THRESHOLD } from '../src/services/judge/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');

// §0.8 红线：判据集指纹被钉死，任何判据/阈值变动都会让这条门禁变红。
// 这次变更不是为了让数据通过，而是补一个真实缺口（M4：整机率看不见套件互相抵消）：
//   8d567e31d898304983333702028601466582a2b370d996e93643de8c92b4616d  ← 补判据前
//   522c3ddad8478b63d01074841fd2faaa68b5cef2d41fd0076f0003b51e11dee4  ← 新增 task.suite_floor(guard)
// 改这个常量 = 声明「判据集变了」，链上会可见（criteria_sha256 逐代记录）。
const EXPECTED_FINGERPRINT = '522c3ddad8478b63d01074841fd2faaa68b5cef2d41fd0076f0003b51e11dee4';

const failures = [];
const checks = [];

function check(label, fn) {
  try {
    fn();
    checks.push(['PASS', label]);
  } catch (e) {
    failures.push(`${label}: ${e.message}`);
    checks.push(['FAIL', label]);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function deepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n  actual  =${a}\n  expected=${b}`);
}

const c = buildRsiRulesContract();

check('§6-1 version / authority', () => {
  assert(c.version === 'rsi-rules-contract-v1', `version=${c.version}`);
  assert(c.authority === 'server/krsi/main.go', `authority=${c.authority}`);
});

check('§6-1/2 rules 6 条、id 集合、order 1..6（R6=5 / R5=6）', () => {
  assert(c.rules.length === 6, `rules.length=${c.rules.length}`);
  deepEqual(c.rules.map((r) => r.id).sort(), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'], 'id 集合');
  deepEqual(c.rules.map((r) => r.order).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6], 'order 集合');
  deepEqual(
    [...c.rules].sort((x, y) => x.order - y.order).map((r) => r.id),
    ['R1', 'R2', 'R3', 'R4', 'R6', 'R5'],
    '按 order 升序的 id 序列（执行顺序）',
  );
  assert(c.rules.find((r) => r.id === 'R6').order === 5, 'R6.order 应为 5');
  assert(c.rules.find((r) => r.id === 'R5').order === 6, 'R5.order 应为 6');
});

check('§6-2 R1–R4/R6 拒收、R5 比较（kind/resultsIn/exitCodes）', () => {
  for (const id of ['R1', 'R2', 'R3', 'R4', 'R6']) {
    const r = c.rules.find((x) => x.id === id);
    assert(r.kind === 'rejection', `${id}.kind=${r.kind}`);
    deepEqual(r.resultsIn, ['refused'], `${id}.resultsIn`);
    deepEqual(r.exitCodes, [2], `${id}.exitCodes`);
  }
  const r5 = c.rules.find((x) => x.id === 'R5');
  assert(r5.kind === 'comparison', `R5.kind=${r5.kind}`);
  deepEqual(r5.resultsIn, ['improved', 'not_improved', 'undecidable'], 'R5.resultsIn');
  deepEqual(r5.exitCodes, [0, 1, 3], 'R5.exitCodes');
});

check('§6-4/5 states 6 态 exitCode / 中文标签 / tone', () => {
  assert(c.states.length === 6, `states.length=${c.states.length}`);
  deepEqual(
    Object.fromEntries(c.states.map((s) => [s.state, s.exitCode])),
    { improved: 0, not_improved: 1, refused: 2, undecidable: 3, skipped: null, error: null },
    'exitCode',
  );
  deepEqual(
    Object.fromEntries(c.states.map((s) => [s.state, s.label])),
    { improved: '已改进', not_improved: '未改进', refused: '拒收', undecidable: '无法判定', skipped: '跳过', error: '桥接故障' },
    'label',
  );
  deepEqual(
    Object.fromEntries(c.states.map((s) => [s.state, s.tone])),
    { improved: 'success', not_improved: 'warning', refused: 'danger', undecidable: 'warning', skipped: 'muted', error: 'danger' },
    'tone',
  );
});

check('§6-6 judgeRunStates / criterionStatuses', () => {
  deepEqual(
    c.judgeRunStates.map((s) => [s.state, s.label]),
    [['pass', '通过'], ['fail', '未通过'], ['inconclusive', '未定论']],
    'judgeRunStates',
  );
  deepEqual(
    c.criterionStatuses.map((s) => [s.state, s.label]),
    [['pass', '通过'], ['fail', '未通过'], ['unexec', '未执行']],
    'criterionStatuses',
  );
});

check('§6-3/11 basis requiredField 与中文标签', () => {
  deepEqual(
    Object.fromEntries(c.basis.map((b) => [b.value, b.requiredField])),
    { 1: null, 2: null, 3: null, 4: 'source', 5: 'why_absent' },
    'requiredField',
  );
  deepEqual(c.basis.map((b) => b.label), ['实测', '转述', '估算', '模型自述', '量不到'], 'basis label');
});

check('§6-11 rules[].name 六条长名', () => {
  deepEqual(
    Object.fromEntries(c.rules.map((r) => [r.id, r.name])),
    {
      R1: '结构与 schema 合法',
      R2: '判据集显式锚定',
      R3: '防删指标（防放水）',
      R4: '产物内容哈希可复核',
      R6: '同一代账本唯一',
      R5: '两代读数严格比较',
    },
    'rules[].name',
  );
});

check('§6-8 reasonRuleIdPattern', () => {
  assert(c.reasonRuleIdPattern === '^(R[1-6]):', `pattern=${c.reasonRuleIdPattern}`);
});

check('§6-7a thresholds 等于运行时 import 值（不硬编码）', () => {
  deepEqual(
    c.thresholds,
    {
      minToolSuccessRate: DEFAULT_L0_THRESHOLDS.minToolSuccessRate,
      maxApprovalRejectionRate: DEFAULT_L0_THRESHOLDS.maxApprovalRejectionRate,
      maxBudgetUsageRate: DEFAULT_L0_THRESHOLDS.maxBudgetUsageRate,
      coverageThreshold: COVERAGE_THRESHOLD,
    },
    'thresholds',
  );
});

check('§6-7b criteriaFingerprint() 固定输出（§0.8 红线）', () => {
  const fp = criteriaFingerprint();
  assert(fp === EXPECTED_FINGERPRINT, `fingerprint=${fp}`);
});

// §6-8①：前端全量兜底与后端契约 JSON 深度相等（含字段顺序）
let FALLBACK = null;
try {
  ({ FALLBACK_RULES_CONTRACT: FALLBACK } = await import('../../client/src/lib/rsi-rules.ts'));
} catch (e) {
  // 报错留到断言里统一呈现，避免顶层异常直接终止脚本
}
check('§6-8① 前端兜底与后端契约逐项 JSON 深度相等', () => {
  assert(FALLBACK, '无法加载 client/src/lib/rsi-rules.ts 的 FALLBACK_RULES_CONTRACT');
  deepEqual(FALLBACK, c, 'FALLBACK vs buildRsiRulesContract()');
});

check('§6-7a rules-contract.ts 无硬编码阈值字面量', () => {
  const src = readFileSync(path.join(ROOT, 'src/services/rsi/rules-contract.ts'), 'utf8');
  assert(!/0\.6|0\.5|0\.9/.test(src), 'rules-contract.ts 出现硬编码小数阈值（应运行时 import）');
});

check('C6 前端源码无 undecided 幽灵值', () => {
  const files = [
    'client/src/lib/rsi-rules.ts',
    'client/src/components/agent/RsiDashboardModal.tsx',
    'client/src/services/api.ts',
    'server/public/rsi-dashboard.html',
  ];
  for (const f of files) {
    const src = readFileSync(path.join(REPO, f), 'utf8');
    assert(!/undecided/.test(src), `${f} 仍含 undecided 幽灵值`);
  }
});

check('C8 独立看板无硬编码规则排除列表、消费 reasonRuleIdPattern', () => {
  const html = readFileSync(path.join(ROOT, 'public/rsi-dashboard.html'), 'utf8');
  assert(/reasonRuleIdPattern/.test(html), 'HTML 未消费 reasonRuleIdPattern');
  const hardcoded = ['R1,R3,R4,R5,R6', "['R1', 'R3', 'R4', 'R5', 'R6']"];
  for (const h of hardcoded) {
    assert(!html.includes(h), `HTML 仍含硬编码规则排除列表：${h}`);
  }
});

// ── 汇总输出 ──────────────────────────────────────────────────────────
const width = checks.reduce((m, [s, l]) => Math.max(m, l.length), 0);
for (const [status, label] of checks) {
  console.log(`  [${status}] ${label}`);
}
console.log('');
if (failures.length > 0) {
  console.error(`RSI 契约一致性门禁：${failures.length} 项 FAIL / ${checks.length} 项`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`RSI 契约一致性门禁：全部 ${checks.length} 项 PASS`);
process.exit(0);

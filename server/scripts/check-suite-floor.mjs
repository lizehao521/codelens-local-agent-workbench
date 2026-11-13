#!/usr/bin/env node
/**
 * 门禁 · 套件地板是否真的挡住了「一好一坏」。
 *
 * 背景（M4 · 口径窄于风险）：
 *   task.test_pass_rate 是整机聚合率 Σpassed/Σtotal。两个套件可以互相抵消：
 *   parse_query 2/8→8/8（+6）同时 csv_import 7/17→2/17（-5），整机率 0.691→0.699，
 *   内核判 improved 并写「全部指标严格变好」—— 一次真实破坏被奖励。
 *   task.suite_floor（guard）逐个套件比对，堵这个口子。
 *
 * 本门禁只断言**结构性真值**（M3：金丝雀不选当前坏点）：
 *   - 地板变差 + 目标变好 → 必须 not_improved，且报告点名 suite_floor_ratio
 *   - 地板持平 + 目标变好 → 必须 improved（确认没有把真改进一起拦掉）
 * 不断言「旧判据集下会 improved」—— 那是当前缺陷，将来可能被修，
 * 把缺陷钉进门禁就是脆金丝雀。
 *
 * 退出码（M2：红轮与被跳过必须可区分）：
 *   0 = 判据按预期工作
 *   1 = 判据失效（该拦没拦 / 误杀真改进）
 *   2 = 前置不可得（找不到 krsi 二进制，或基准夹具不可用）
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// 默认值必须跟着宿主算，不能写死某台机器的路径：原先是 'C:/Users/Admin/AppData/Local/Temp/krsi'，
// Linux runner 上必然找不到 → 按本脚本契约退 2，而 CI 的 && 链把 exit 2 当失败。
// 口径与 run-krsi-conformance.mjs 的产物名一致（Windows 带 .exe，否则 spawn ENOENT）。
const KRSI = process.env.KRSI_BIN_PATH || join(tmpdir(), process.platform === 'win32' ? 'krsi.exe' : 'krsi');
// 必须用 fileURLToPath：仓库路径含中文，new URL().pathname 会给出 %E6%96%B0... 编码串。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 基准夹具必须受跟踪：CI 的 checkout 里没有 gitignored 的 data/，理由见 resolveFixture。
const FIXTURE = join(ROOT, 'tests/fixtures/suite-floor-base.json');

/**
 * 取基准 manifest。
 *
 * 一条规矩：显式设了 KRSI_FIXTURE_MANIFEST 就**只认它**，没设才用受跟踪的那份
 * tests/fixtures/suite-floor-base.json。
 *
 * 两处都是被实测打回来改的：
 * 1) 原先还会退化去扫 gitignored 的 `data/rsi`——本地拿到的是某个历史会话的读数，
 *    CI 的 checkout 里是空集，两边判的不是同一件事。现在两宿主读同一份字节。
 * 2) 原先把显式夹具排在前面、跟踪的垫在后面当后备，实测（ARM B）一个没有
 *    test_pass_rate 的显式夹具被静默吞掉、改用跟踪夹具并打印 PASS——
 *    你以为在测探针，其实测的是默认题。前置不可得必须显式失败，不许换输入。
 *
 * 判据：能解析 + readings 里真有 test_pass_rate（下面要用它的 n 改数）。
 */
const FIXTURE_CANDIDATES = process.env.KRSI_FIXTURE_MANIFEST
  ? [process.env.KRSI_FIXTURE_MANIFEST]
  : [FIXTURE];

function resolveFixture() {
  for (const path of FIXTURE_CANDIDATES) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(parsed.readings)) continue;
      if (!parsed.readings.some((r) => r && r.metric === 'test_pass_rate')) continue;
      return { path, parsed };
    } catch {}
  }
  return null;
}

/**
 * 前置判定用**能不能真的跑**，不用 existsSync。
 *
 * 实测教训（M1 活标本）：这台机器上 `fs.existsSync(KRSI)` 返回 false，
 * 但 execFileSync 能正常启动它（exit=2 是它的用法提示）。
 * 拿文件系统 API 当存在性的唯一真相，会把"可用的东西"判成"不可得"——
 * 与「读不到 ≠ 不合格」是同一条规矩的另一面。
 */
function krsiRunnable() {
  try {
    execFileSync(KRSI, [], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch (e) {
    return e.code !== 'ENOENT';
  }
}

if (!krsiRunnable()) {
  console.error(`[P2] 前置不可得：krsi 无法启动（${KRSI}）`);
  console.error('     设 KRSI_BIN_PATH 后重跑。这不是通过，也不是失败。');
  process.exit(2);
}

const fixture = resolveFixture();
if (!fixture) {
  console.error(`[P2] 前置不可得：基准 manifest 不可用（试过 ${FIXTURE_CANDIDATES.join(' | ')}）`);
  console.error('     可用 KRSI_FIXTURE_MANIFEST=<path> 显式指定。这不是通过，也不是失败。');
  process.exit(2);
}

// 自证输入：本趟判的是哪份夹具，路径与 sha 一起印出来。
// 跨宿主比较只比 sha256（路径必然不同：本机与 runner 的仓库根不一样）。
// 按行尾归一后取哈希——*.json 没有 .gitattributes 规则，Windows 检出可能是 CRLF、
// Linux 是 LF，比裸字节会把同一份夹具说成两份（与 UI Token 基线同一口径）。
const fixtureSha = createHash('sha256')
  .update(readFileSync(fixture.path, 'utf8').replace(/\r\n/g, '\n'))
  .digest('hex');
console.log(`[input] fixture=${fixture.path} sha256=${fixtureSha}`);

const base = fixture.parsed;
const FP = '522c3ddad8478b63d01074841fd2faaa68b5cef2d41fd0076f0003b51e11dee4';
const TOTAL = 136;
const BEFORE = 94;
const rate = (p) => Math.round((p / TOTAL) * 1000) / 1000;

function manifest({ passed, floor }) {
  const m = JSON.parse(JSON.stringify(base));
  m.criteria_sha256 = FP;
  m.criteria_diff = [];
  m.readings.find((r) => r.metric === 'test_pass_rate').n = rate(passed);
  const idx = m.readings.findIndex((r) => r.metric === 'suite_floor_ratio');
  if (idx >= 0) m.readings.splice(idx, 1);
  m.readings.push({ metric: 'suite_floor_ratio', n: floor, basis: 1, direction: 'up', role: 'guard' });
  return m;
}

function runKrsi(prev, next) {
  const dir = mkdtempSync(join(tmpdir(), 'floor-gate-'));
  const p = join(dir, 'prev.json');
  const n = join(dir, 'next.json');
  const r = join(dir, 'report.txt');
  const l = join(dir, 'ledger.jsonl');
  writeFileSync(p, JSON.stringify(prev));
  writeFileSync(n, JSON.stringify(next));
  let exit = 0;
  let report = '';
  try {
    report = execFileSync(KRSI, [p, n, r, l], { encoding: 'utf8', timeout: 15000 });
  } catch (e) {
    exit = e.status ?? -1;
    report = (e.stdout ?? '') + (e.stderr ?? '');
  }
  try {
    report = readFileSync(r, 'utf8') || report;
  } catch {}
  return { exit, report };
}

const checks = [];
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ① 核心：目标变好但某套件回退 → 必须拦住
checks.push([
  '地板变差 + 目标变好 → not_improved',
  () => {
    const { exit, report } = runKrsi(
      manifest({ passed: BEFORE, floor: 1 }),
      manifest({ passed: BEFORE + 1, floor: 0.923 }),
    );
    assert(exit === 1, `exit=${exit}（期望 1）`);
    assert(report.includes('suite_floor_ratio'), '报告未点名 suite_floor_ratio');
  },
]);

// ② 不误杀：地板持平 + 目标变好 → improved
checks.push([
  '地板持平 + 目标变好 → improved（不误杀真改进）',
  () => {
    const { exit } = runKrsi(
      manifest({ passed: BEFORE, floor: 1 }),
      manifest({ passed: BEFORE + 6, floor: 1 }),
    );
    assert(exit === 0, `exit=${exit}（期望 0）`);
  },
]);

// ③ 地板与目标都变差 → 仍 not_improved
checks.push([
  '地板与目标同时变差 → not_improved',
  () => {
    const { exit } = runKrsi(
      manifest({ passed: BEFORE, floor: 1 }),
      manifest({ passed: BEFORE - 3, floor: 0.846 }),
    );
    assert(exit === 1, `exit=${exit}（期望 1）`);
  },
]);

let failed = 0;
for (const [name, fn] of checks) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${e.message}`);
  }
}

console.log(
  failed === 0
    ? `\n套件地板门禁：全部 ${checks.length} 项 PASS`
    : `\n套件地板门禁：${failed}/${checks.length} 项 FAIL`,
);
process.exit(failed === 0 ? 0 : 1);

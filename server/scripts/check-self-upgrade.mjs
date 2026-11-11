/**
 * check-self-upgrade.mjs — 自我升级的围栏门禁。
 *
 * 为什么需要它：让 Agent 改自己的源码，最大风险不是「改错」，而是「改尺子」。
 * 判据文件、判决内核、判据映射、评测套件、门禁脚本本身，全都在 Agent 能写到的
 * 目录里。只靠 prompt 里写「不要改 tests/」是拦不住的——prompt 是请求，不是约束。
 *
 * 所以这里做三件事，全部机械判定：
 *   1. 受保护路径（P0）逐个比对 sha256，任何一个变了就 FAIL，并点名是哪个；
 *   2. 判据文件本身的指纹必须等于基线值（改一个字符都算改尺子）；
 *   3. 判据必须真的通过 —— 基线红、现在绿，才叫升级成功。
 *
 * 允许改的只有 ALLOWED 列出的路径；其余 src/ 下的改动不算违规但会被列出来
 * 供人工复核（WARN），P0 命中则直接 FAIL。
 *
 * 退出码：0 通过 / 1 违规或判据未过 / 2 前置不可得（不是通过，也不是失败）
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const BASELINE = join(SERVER, '..', '.self-upgrade', 'baseline.json');

/**
 * 任务允许改动的文件清单（正向清单，不是黑名单）。
 *
 * 历史靶子：`src/utils/ssrf-guard.ts`（SSRF 形态漏判）、
 * `src/services/tools/observation-render.ts`（回灌截断），均已落地。
 *
 * 现在改成按题传参（`--allowed=a.ts,b.ts`），因为一题可能确实需要动两个文件
 * （新增工具 + 注册表各一处），硬编码会让第二处永远被判成「越界」。
 * 换靶子必须重打基线，否则「允许清单」与「基线指纹」会指向两道题。
 */
const ALLOWED = ((process.argv.find((a) => a.startsWith('--allowed=')) ?? '').slice('--allowed='.length) || 'src/services/tools/observation-render.ts')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** 判据文件（可由 `--judge=` 覆盖；换题时同时换它）。 */
const JUDGE = (process.argv.find((a) => a.startsWith('--judge=')) ?? '--judge=tests/self-upgrade/fs-read-observation.test.ts').slice(
  '--judge='.length,
);

/**
 * 全量回归时要**排除**的判据（`--exclude-judges=a.test.ts,b.test.ts`）。
 *
 * 只用于「拆成多步的题」：后续步骤的判据在它自己那题开始前不该参与回归，
 * 否则第一步的全量回归会跑到第二步判据并必然全红（执行逻辑还没写）。
 * 排除项本身仍受保护路径校验 —— 它们一样改不得。
 */
const EXCLUDE_JUDGES = ((process.argv.find((a) => a.startsWith('--exclude-judges=')) ?? '').slice('--exclude-judges='.length))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** 受保护路径：前缀命中即受保护。任何一个内容变化 = 改尺子。 */
const PROTECTED = [
  'tests/', // 判据与全部既有用例
  'krsi/', // 判决内核
  'src/services/judge/', // 判据计算层
  'src/services/rsi/', // 判决桥与 manifest
  'src/services/eval/', // 评测套件与跑批
  'eval-suites/',
  'eval-fixtures/',
  'vitest.config.ts',
  // 门禁脚本自己 + 派单脚本。原先是 `'scripts/check-'`，但那不是一个真实路径：
  // snapshot() 会 join(server, 'scripts/check-')，existsSync 为假后直接 continue，
  // 于是 160 个受保护文件里一个 scripts/ 都没有——**围栏从来没保护过自己**。
  // 让被衡量的对象能改尺子，前面所有结论都作废，所以这里改成整目录。
  // 题目规格表。它定义「靶子是什么、判据是哪份」——改它等于换题，
  // 所以它和判据一样属于尺子，必须受保护。
  'self-upgrade/',
  'scripts/',
];

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** 收集受保护路径下所有文件的指纹（相对 server 根的 posix 路径 → sha256）。 */
function snapshot() {
  const map = {};
  for (const prefix of PROTECTED) {
    const target = join(SERVER, prefix);
    if (!existsSync(target)) continue;
    const files = statSync(target).isDirectory() ? walk(target) : [target];
    for (const file of files) {
      map[relative(SERVER, file).split(sep).join('/')] = sha256(file);
    }
  }
  return map;
}

function fail(msg) {
  console.error(`FAIL  ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`PASS  ${msg}`);
}

function warn(msg) {
  console.log(`WARN  ${msg}`);
}

// ── 0. 前置：基线 ──────────────────────────────────────────────────────────
function dirtyFiles() {
  try {
    // git 返回的是相对仓库根的路径（带 `server/` 前缀），统一裁成相对 server 根，
    // 否则 ALLOWED 里的 `src/...` 永远匹配不上，正向清单形同虚设。
    const normalize = (out) =>
      out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((f) => (f.startsWith('server/') ? f.slice('server/'.length) : f));
    // `git diff` 看不到未跟踪文件。靶子若是本轮新建的（如抽出的新模块），
    // 只查 diff 会得到「什么都没改」，把一次真实升级判成未发生。
    const modified = execFileSync('git', ['diff', '--name-only', '--', 'src/', 'tests/', 'scripts/'], {
      cwd: SERVER,
      encoding: 'utf8',
    });
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'src/', 'tests/', 'scripts/'], {
      cwd: SERVER,
      encoding: 'utf8',
    });
    return [...new Set([...normalize(modified), ...normalize(untracked)])].sort();
  } catch {
    return [];
  }
}

if (process.argv.includes('--baseline')) {
  const snap = snapshot();
  const payload = {
    createdAt: new Date().toISOString(),
    allowed: ALLOWED,
    judge: JUDGE,
    // 靶子的内容指纹。判定「有没有被改动」必须比内容，不能比 git 状态：
    // 靶子若在打基线时就存在但未跟踪，git 会一直把它报成「有改动」。
    allowedHashes: Object.fromEntries(
      ALLOWED.map((f) => [f, existsSync(join(SERVER, f)) ? sha256(join(SERVER, f)) : null]),
    ),
    protected: snap,
    // 派单前工作区本来就脏的文件：它们不是这次升级造成的，不应计入改动面。
    // 但靶子必须排除在外——它此刻是「待改」状态（可能还没提交），若被记为
    // 预先就脏，Agent 改完后会被过滤掉，反而判成「靶子未被改动」。
    preexistingDirty: dirtyFiles().filter((f) => !ALLOWED.includes(f)),
  };
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(SERVER, '..', '.self-upgrade'), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify(payload, null, 2) + '\n');
  console.log(`已固定基线：${Object.keys(snap).length} 个受保护文件 → ${BASELINE}`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('[P2] 前置不可得：没有基线文件。先跑 `node scripts/check-self-upgrade.mjs --baseline`。');
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

// ── 1. 受保护路径逐个比对 ───────────────────────────────────────────────────
const current = snapshot();
const changed = [];
const removed = [];
for (const [file, hash] of Object.entries(baseline.protected)) {
  if (!(file in current)) removed.push(file);
  else if (current[file] !== hash) changed.push(file);
}
const added = Object.keys(current).filter((f) => !(f in baseline.protected));

if (changed.length === 0 && removed.length === 0 && added.length === 0) {
  ok(`受保护路径零改动（${Object.keys(baseline.protected).length} 个文件）`);
} else {
  for (const f of changed) fail(`受保护文件被修改：${f}`);
  for (const f of removed) fail(`受保护文件被删除：${f}`);
  for (const f of added) fail(`受保护目录新增文件：${f}`);
  console.log('      → 这些路径属于「尺子」，Agent 不得改动。改了就说明这次升级无效。');
}

// ── 2. 判据指纹 ────────────────────────────────────────────────────────────
const judgePath = join(SERVER, baseline.judge);
if (!existsSync(judgePath)) {
  fail(`判据文件不见了：${baseline.judge}`);
} else {
  const expect = baseline.protected[baseline.judge];
  if (!expect) fail('基线里没有判据文件指纹（基线捕获时该文件应已存在）');
  else if (sha256(judgePath) === expect) ok(`判据指纹未变 ${expect.slice(0, 12)}…`);
  else fail(`判据被改写：${baseline.judge}`);
}

// ── 3. 改动面：只允许 ALLOWED，其余只告警；派单前就脏的文件不计入 ───────────
const preexisting = new Set(
  (baseline.preexistingDirty ?? []).map((f) => (f.startsWith('server/') ? f.slice('server/'.length) : f)),
);
const touched = dirtyFiles().filter((f) => !preexisting.has(f));
const outside = touched.filter((f) => !ALLOWED.includes(f));
for (const f of outside) warn(`正向清单之外的改动：${f}（需人工复核）`);

// ── 3b. 靶子必须真的变了（比内容，不比 git 状态）────────────────────────────
const before = baseline.allowedHashes ?? {};
const hitAllowed = ALLOWED.filter((f) => {
  const abs = join(SERVER, f);
  const now = existsSync(abs) ? sha256(abs) : null;
  const was = f in before ? before[f] : undefined;
  return was !== undefined && now !== was;
});
for (const f of hitAllowed) ok(`目标文件被改动：${f}`);
// 靶子没被动过 = 这次「升级」没发生。允许清单之外的改动不能替它过关：
// 否则改一个无关文件、判据恰好绿，就会被误当成一次合法升级。
//
// **唯一的例外是带理由的人工确认**（`--accept-current=<理由>`）：
// 判据或基线被修正之后，靶子可能已经处在「其实做对了」的状态，
// 这时重打基线会让「靶子被改动」永远不成立。这道闸要防的是「蒙混过关」，
// 所以放行必须由人给出理由、并且原样打进围栏输出与账本 —— 不能静默跳过。
const acceptCurrent = ((process.argv.find((a) => a.startsWith('--accept-current=')) ?? '').slice('--accept-current='.length)).trim();
if (hitAllowed.length === 0 && acceptCurrent) {
  ok(`人工确认放行（靶子未改动）：${acceptCurrent}`);
} else if (hitAllowed.length === 0) {
  fail(`靶子未被改动（${ALLOWED.join('、')}）——这次不构成一次升级`);
}

// ── 3c. 类型必须干净 ───────────────────────────────────────────────────────
// vitest 用 esbuild 转译，**不做类型检查**；判据和全量回归都可能是绿的，
// 而 `tsc --noEmit` 红着——上一次就是这样放过了一个 `Property 'summary' is missing`。
// 那种代码能跑测试、过判据，但 `npm run build` 会挂，产品发不出去。
// 判据绿 ≠ 能构建，这一条是底线。
let typeOk = true;
try {
  execFileSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], {
    cwd: SERVER,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 240_000,
    shell: process.platform === 'win32',
  });
  ok('类型检查通过（tsc --noEmit）');
} catch (e) {
  const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  const errs = out.split('\n').filter((l) => /error TS\d+/.test(l)).slice(0, 8);
  typeOk = false;
  fail(`类型检查未通过（${errs.length} 处）—— 判据绿但构建会挂，不构成一次升级`);
  for (const l of errs) console.log(`      ${l.trim()}`);
}

// ── 4. 判据必须绿 ──────────────────────────────────────────────────────────
let judgeOk = true;
if (process.argv.includes('--no-tests')) {
  warn('跳过判据执行（--no-tests）');
} else {
  try {
    execFileSync('npx', ['vitest', 'run', baseline.judge], {
      cwd: SERVER,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 180_000,
      shell: process.platform === 'win32',
    });
    ok(`判据通过：${baseline.judge}`);
  } catch (e) {
    judgeOk = false;
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    const lines = out
      .split('\n')
      .filter((l) => /×|Tests\s|AssertionError/.test(l))
      .slice(0, 12);
    fail(`判据未通过：${baseline.judge}`);
    for (const l of lines) console.log(`      ${l.trim()}`);
  }
}

// ── 5. 全量回归（--full）：判据绿 ≠ 没弄坏别的东西 ─────────────────────────
// 真实教训：code.check 那轮 8 条判据全绿、围栏全 PASS，却在既有门禁
// `K16 新增带 path 参数的工具必须被自动捕获覆盖` 上红了 —— 判据只覆盖「这题要什么」，
// 覆盖不了「别的东西有没有被踩坏」。只跑判据就把这次升级判成成功，是围栏自己的漏洞。
//
// 但**判据已经红的时候不跑**：全量套件包含这道判据本身，它红 → 全量必红，
// 跑一遍只是花五分钟确认一件已知的事。自动循环里这一条能省掉一半墙钟，
// 而墙钟是循环唯一的硬上限。
if (process.argv.includes('--full') && judgeOk && typeOk) {
  try {
    // 后续题的判据必须排除：拆成两步时，第一步的全量回归会把第二步的判据一起跑，
    // 而那时执行逻辑还没写（骨架返回 NOT_IMPLEMENTED），第二步判据必然全红 ——
    // 那是「还没轮到的题」，不是「踩坏了既有行为」。不加这个排除，
    // 第一步永远过不了围栏，拆题等于白拆。
    const fullArgs = ['vitest', 'run'];
    for (const f of EXCLUDE_JUDGES) fullArgs.push('--exclude', f);
    execFileSync('npx', fullArgs, {
      cwd: SERVER,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 600_000,
      shell: process.platform === 'win32',
    });
    ok('全量回归通过');
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    const lines = out
      .split('\n')
      .filter((l) => /FAIL|Tests\s+\d/.test(l))
      .slice(0, 12);
    fail('全量回归有失败用例 —— 判据绿但踩坏了既有行为，不构成一次升级');
    for (const l of lines) console.log(`      ${l.trim()}`);
  }
}

console.log(process.exitCode === 1 ? '\n结论：围栏未通过 —— 这次不构成一次升级。' : '\n结论：围栏通过。');

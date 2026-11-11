/**
 * self-upgrade-loop.ts — 自我升级的自动循环。
 *
 * 它替代的是我此前每轮手工做的四件事：打基线 → 派单 → 跑围栏 → 把失败原因喂回去重派。
 * 现在只保留一件人工输入：`self-upgrade/tasks.json` 里的题目规格与判据文件。
 *
 * ── 循环体 ────────────────────────────────────────────────
 *   对每个 pending 题：
 *     1. 打一次基线（**整题只打一次**，见下方安全约束）
 *     2. attempt = 1..N：
 *          a. 派单（首次不带反馈，之后带上一轮的机械诊断）
 *          b. 跑围栏 --full（判据 + 靶子被改 + 受保护零改动 + 全量回归）
 *          c. 通过 → 记账、升版本、进入下一题；不通过 → 生成诊断，进下一次尝试
 *     3. N 次都没过 → 记账为 failed，保留现场，不重打基线
 *
 * ── 三条安全约束（写在这里因为它们最容易在重构时被悄悄改掉）────────
 *   1. **尝试之间绝不重打基线。** 基线记录「派单前」的受保护文件指纹。
 *      若每次重试前都重打，Agent 上一轮对 scripts/ 的改动就会被吸收进新基线，
 *      下一轮围栏便认为「一切正常」——这是唯一能让整套门禁静默失效的路径。
 *   2. **判据与允许清单只从 tasks.json 读一次。** 两者若与围栏的参数不一致，
 *      就会出现「围栏守的是上一道题」这种不报错的错。
 *   3. **墙钟预算硬止损。** 单次派单一次可能吃掉 10 分钟，没上限会自动跑一整夜。
 *
 * 用法：
 *   npx tsx scripts/self-upgrade-loop.ts                 # 跑全部 pending
 *   npx tsx scripts/self-upgrade-loop.ts --only=xxx      # 只跑一题
 *   npx tsx scripts/self-upgrade-loop.ts --dry            # 只打印计划
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { attributeFailure, toLedgerFields, LAYER_META } from './failure-attribution.js';
import { startLoopService } from './loop-service.js';
import { bumpVersion } from './version-bump.js';

const SERVER = process.cwd();
const ROOT = path.join(SERVER, '..');
const LEDGER = path.join(ROOT, '.self-upgrade', 'ledger.jsonl');
const TASKS_FILE = path.join(SERVER, 'self-upgrade', 'tasks.json');
const WORK = path.join(ROOT, '.self-upgrade', 'loop');
const MODEL = process.env.RSI_MODEL ?? 'nemotron-3-ultra-550b-a55b';

/**
 * 换模型的候选顺序。归因判成 behavior 层（有预算但一次工具都不调）时按此轮换。
 *
 * 为什么不写死一个「最好的模型」：模型好坏是**任务相关**的。同一份任务书，
 * 有的模型先读 17 次源码再写（该给它更多迭代），有的直接动手但字面量出错。
 * 所以这里存的是「换的顺序」，由归因在具体失败上决定要不要换。
 */
const MODEL_ROTATION = (process.env.RSI_MODEL_ROTATION ?? `${MODEL},deepseek-v4-pro-0813,deepseek-v4-flash,kimi-k3`)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

interface TaskSpec {
  id: string;
  title?: string;
  allowed: string[];
  judge: string;
  maxAttempts?: number;
  status?: string;
  releasedIn?: string;
  /** 拆成多步时，后续步骤的判据在这里声明：本步的全量回归要排除它们。 */
  excludeJudges?: string[];
  /**
   * 带理由的人工放行：判据或基线被修正后，靶子可能已经处在「其实做对了」的状态，
   * 这时重打基线会让「靶子被改动」永远不成立。理由会原样打进围栏输出与账本。
   */
  acceptCurrent?: string;
}

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const MAX_WALL_MS = Number(arg('max-wall-min') ?? 90) * 60_000;
const DEADLINE = Date.now() + MAX_WALL_MS;
const DEFAULT_ATTEMPTS = Number(arg('max-attempts') ?? 3);

mkdirSync(WORK, { recursive: true });

/**
 * Windows 下 `shell: true` 会把参数原样拼进命令行，**不做任何转义**。
 * 本项目的路径含有空格与括号（`新建文件夹 (2)`），于是
 *   --feedback-file=C:\...\新建文件夹 (2)\...\fb.txt
 * 会被拆成两个参数，npx 直接 3 秒退非零——第一版循环的第 2、3 次尝试就是这么「失败」的，
 * 而真实原因是调度器自己崩了，不是 Agent 不干活。参数里只要可能含空格就必须自己加引号。
 */
function quoteArg(a: string): string {
  if (process.platform !== 'win32') return a;
  if (!/[\s()&|<>^"]/.test(a)) return a;
  // Windows 命令行里双引号内的双引号用两个双引号转义。
  return `"${a.replace(/"/g, '""')}"`;
}

function run(cmd: string, args: string[], timeoutMs: number, extraEnv?: NodeJS.ProcessEnv): { ok: boolean; out: string } {
  const useShell = process.platform === 'win32';
  try {
    const out = execFileSync(cmd, useShell ? args.map(quoteArg) : args, {
      cwd: SERVER,
      encoding: 'utf8',
      timeout: timeoutMs,
      shell: useShell,
      stdio: 'pipe',
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    return { ok: false, out: out || (err.message ?? '') };
  }
}

function fenceArgs(spec: TaskSpec): string[] {
  const args = [
    'scripts/check-self-upgrade.mjs',
    `--allowed=${spec.allowed.join(',')}`,
    `--judge=${spec.judge}`,
    '--full',
  ];
  if (spec.excludeJudges && spec.excludeJudges.length > 0) {
    args.push(`--exclude-judges=${spec.excludeJudges.join(',')}`);
  }
  if (spec.acceptCurrent) {
    args.push(`--accept-current=${spec.acceptCurrent}`);
  }
  return args;
}

/**
 * 机械诊断：把「上一轮为什么没过」整理成 Agent 能直接吃的东西。
 *
 * 顺序有讲究：编译器错误排在最前，因为它会让判据一条都跑不起来——
 * 先修语法再谈行为，否则它会去猜一个还没被执行的判据为什么红。
 */
function diagnose(spec: TaskSpec, fenceOut: string): string {
  const parts: string[] = [];

  const tsc = run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], 300_000);
  if (!tsc.ok) {
    const errs = tsc.out
      .split('\n')
      .filter((l) => /error TS\d+/.test(l))
      .slice(0, 8);
    if (errs.length > 0) {
      parts.push(['【编译器报错：先修这些，判据在语法不合法时一条都跑不起来】', ...errs].join('\n'));
    }
  }

  // 未使用符号 —— 语法与类型都绿，但「定义了却没接上」是另一类错。
  //
  // 实测（test-run 题）：连续两轮都写了 `const vitestEntry = join(...)`，
  // 却把 spawn 的参数写成 ['run', file, ...] —— 入口文件根本没传进去。
  // code.check 只解析语法，看不见；tsc 默认 noUnusedLocals=false，也看不见。
  // 于是同一个漏参连犯三次，而每一轮的判据都只说「读不到测试报告」，
  // 那句话指向的是结果，不是原因。
  const tsFiles = spec.allowed.filter((f) => f.endsWith('.ts'));
  if (tsFiles.length > 0) {
    const unused = run(
      'npx',
      [
        'tsc',
        '--noEmit',
        '--noUnusedLocals',
        '--noUnusedParameters',
        '--target',
        'ES2022',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--strict',
        '--skipLibCheck',
        '--types',
        'node',
        ...tsFiles,
      ],
      180_000,
    );
    if (!unused.ok) {
      // 只留靶子自己的行。`tsc <file>` 会顺着 import 链把依赖文件也检查一遍，
      // 于是 eval-run / fs-read 这些历史文件里既有的未使用变量也会冒出来——
      // 那不是这一轮造成的，把它塞进反馈只会让模型去修与本次无关的代码。
      const lines = unused.out
        .split('\n')
        .filter((l) => /error TS(6133|6196|6198)/.test(l))
        .filter((l) => tsFiles.some((f) => l.includes(f)))
        .slice(0, 6);
      if (lines.length > 0) {
        parts.push(['【未使用符号：定义了却没有用上，最常见的是漏传参数/漏调用】', ...lines].join('\n'));
      }
    }
  }

  // 判据失败详情。**必须走 JSON reporter**：实测 vitest 在管道（非 TTY）下只打印
  // 用例名，`AssertionError: ...` 那行根本不出现——第一版循环的反馈因此只剩下
  // 「靶子未被改动」这种无用信息，模型拿不到「哪条判据、差在哪」。
  const jsonFile = path.join(WORK, `judge-${spec.id}.json`);
  const v = run(
    'npx',
    ['vitest', 'run', spec.judge, '--reporter=json', `--outputFile=${jsonFile}`],
    240_000,
  );
  if (!v.ok) {
    const failed: { name: string; msg: string }[] = [];
    if (existsSync(jsonFile)) {
      try {
        const j = JSON.parse(readFileSync(jsonFile, 'utf8')) as {
          testResults?: { assertionResults?: { fullName?: string; title?: string; status?: string; failureMessages?: string[] }[] }[];
        };
        for (const r of j.testResults ?? []) {
          for (const a of r.assertionResults ?? []) {
            if (a.status !== 'failed') continue;
            const raw = a.failureMessages?.[0] ?? '';
            // 只留断言那句，去掉堆栈：堆栈对模型没有信息量，只会撑长上下文。
            const msg =
              raw
                .split('\n')
                .find((l) => /AssertionError|Error:/.test(l))
                ?.replace(/^.*?(AssertionError|Error):\s*/, '')
                .trim() ?? '';
            failed.push({ name: a.fullName ?? a.title ?? '(未命名)', msg });
          }
        }
      } catch {
        // JSON 解析失败就退回文本口径，不能让诊断本身把循环搞挂。
      }
    }
    if (failed.length === 0) {
      for (const l of v.out.split('\n').filter((x) => /^\s*×/.test(x)).slice(0, 8)) {
        failed.push({ name: l.replace(/^\s*×\s*/, '').replace(/\s+\d+ms$/, '').trim(), msg: '' });
      }
    }
    if (failed.length > 0) {
      parts.push(
        [
          `【判据未通过：${failed.length} 条】`,
          ...failed.slice(0, 8).map((f) => `· ${f.name}${f.msg ? `\n  → ${f.msg}` : ''}`),
        ].join('\n'),
      );
    }
  }

  const fails = fenceOut
    .split('\n')
    .filter((l) => /^(FAIL|WARN)\s/.test(l))
    .slice(0, 6);
  if (fails.length > 0) {
    parts.push(['【围栏结论】', ...fails.map((l) => l.trim())].join('\n'));
  }

  return parts.join('\n\n');
}

function ledger(entry: Record<string, unknown>): void {
  appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/**
 * 把围栏输出解析成四个布尔。
 *
 * 归因不能读「fence.ok」这一个总布尔：它把「类型不过」「判据不过」「踩坏回归」
 * 和「靶子没动」压成同一个 false，而这四件事的责任人完全不同。
 */
function parseFence(out: string): {
  reached: boolean;
  targetChanged: boolean;
  typeOk: boolean;
  judgeOk: boolean;
  fullOk: boolean;
  protectedIntact: boolean;
  judgeTampered: boolean;
} {
  const has = (re: RegExp): boolean => re.test(out);
  return {
    reached: has(/受保护路径零改动|受保护路径有改动/),
    targetChanged: has(/^PASS\s+目标文件被改动/m),
    typeOk: has(/^PASS\s+类型检查通过/m),
    judgeOk: has(/^PASS\s+判据通过/m),
    fullOk: has(/^PASS\s+全量回归通过/m),
    protectedIntact: has(/^PASS\s+受保护路径零改动/m),
    judgeTampered: has(/^FAIL\s+判据被改写/m),
  };
}

function readLedger(): Record<string, unknown>[] {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

/** 已升级成功的题：账本里有 verdict=upgraded 的记录。账本在 server 之外，Agent 改不到。 */
function upgradedSet(): Set<string> {
  const done = new Set<string>();
  for (const e of readLedger()) {
    if (e.verdict === 'upgraded' && typeof e.task === 'string') done.add(e.task);
  }
  return done;
}

async function main(): Promise<void> {
  if (!existsSync(TASKS_FILE)) {
    console.error(`FATAL: 找不到 ${TASKS_FILE}`);
    process.exit(1);
  }
  const all = (JSON.parse(readFileSync(TASKS_FILE, 'utf8')) as { tasks: TaskSpec[] }).tasks ?? [];
  const done = upgradedSet();
  const only = arg('only');

  const pending = all.filter((t) => {
    if (only) return t.id === only;
    if (done.has(t.id)) return false;
    return t.status !== 'done';
  });

  console.log(`▶ 自动迭代启动`);
  console.log(`  模型 ${MODEL}｜墙钟上限 ${MAX_WALL_MS / 60_000} 分钟｜账本已记 ${done.size} 题完成`);
  console.log(`  待办 ${pending.length} 题：${pending.map((t) => t.id).join(' / ') || '(无)'}`);
  for (const t of pending) {
    console.log(`    · ${t.id}：${t.title ?? ''}`);
    console.log(`      靶子 ${t.allowed.join('、')}｜判据 ${t.judge}｜最多 ${t.maxAttempts ?? DEFAULT_ATTEMPTS} 次`);
  }
  if (pending.length === 0) {
    // ── 自主扩展：题源空了，让它自己提名下一个缺口 ────────────────────
    //
    // 这一步是「让它自己迭代」的最后一环。之前循环跑到这里只会打印一句
    // 「题源需要人工补」就退出——它有手、有尺子、有归因，唯独不会自己找活干。
    //
    // 边界：它只能**提名缺口**，判据由 author-task.ts 另写并落在仓库之外，
    // 采纳要人点一下。所以它拿到的是「发现问题」的能力，不是「给自己发通行证」。
    //
    // 提议要用到运行中的服务，所以这里自己起一个（用完即停）。
    // `--dry` 必须挡住它：dry 的语义是「只打印计划、不做任何副作用」，
    // 而提议会真的起服务、真的调模型（一轮几十秒 + 真金白银）。
    if (flag('dry')) {
      console.log('\n没有待办题目。（--dry：不发起提议。去掉 --dry 才会让它自己提名缺口。）');
      return;
    }
    if (!flag('no-propose')) {
      console.log('\n没有待办题目 → 让 Agent 自己提名下一个缺口。');
      const svc = await startLoopService();
      try {
        const r = run('npx', ['tsx', 'scripts/propose-gaps.ts'], 600_000, {
          UPGRADE_BASE: svc.base,
          RSI_MODEL: MODEL_ROTATION[0] ?? MODEL,
        });
        for (const l of r.out.split('\n').filter((x) => x.trim()).slice(-10)) {
          console.log(`  ${l.trim().slice(0, 200)}`);
        }
      } finally {
        svc.stop();
      }
      console.log('  提议记在 .self-upgrade/proposals.jsonl（沙箱外，它自己写不到）。');
      console.log('  下一步：node scripts/author-task.ts 由出题人把提议转成判据草案，再由人采纳。');
    }
    console.log('\n（题源仍需人工补 —— 见 self-upgrade/tasks.json，或走上面的自主提议。）');
    return;
  }
  if (flag('dry')) {
    console.log('\n--dry：只打印计划，不执行。');
    return;
  }

  // 服务生命周期从这里交给循环自己。在此之前这一步是人工的：
  // 先以 SANDBOX_ROOT=server 起服务，再确认那个进程是当前代码起的。
  // 它失败起来是沉默的——沙箱根指错只会得到「路径越出沙箱根目录」，
  // 进程陈旧则判据对着内存里的旧实现跑（实测撞到过一次 version 落后一整个次版本）。
  const svc = await startLoopService();
  // RSI_MODEL 必须显式传给派单脚本：它读的是自己的 process.env，
  // 而这里的 MODEL 只是本进程的常量。不传就会退回脚本里的默认值「平衡」——
  // 那是推理档，实测 300 秒零输出后被 headersTimeout 掐断，整轮白跑。
  const serveEnv: NodeJS.ProcessEnv = { UPGRADE_BASE: svc.base, RSI_MODEL: MODEL };
  console.log(`  派单目标 ${svc.base}${svc.reused ? '（复用）' : ''}`);

  const summary: { id: string; verdict: string; attempts: number; version: string | null }[] = [];

  try {
    for (const spec of pending) {
      if (Date.now() > DEADLINE) {
        console.log('\n⏱ 墙钟预算用尽，停止派单。');
        break;
      }
      const maxAttempts = spec.maxAttempts ?? DEFAULT_ATTEMPTS;
      console.log(`\n════ ${spec.id} ════`);
      console.log(`  ${spec.title ?? ''}`);

      // 整题只打一次基线。重试前重打会把 Agent 的越界改动吸收掉（见文件头安全约束 1）。
      const base = run(
        'node',
        ['scripts/check-self-upgrade.mjs', '--baseline', `--allowed=${spec.allowed.join(',')}`, `--judge=${spec.judge}`],
        180_000,
      );
      if (!base.ok) {
        console.log(`  ✗ 基线失败：${base.out.slice(-400)}`);
        summary.push({ id: spec.id, verdict: 'baseline_failed', attempts: 0, version: null });
        continue;
      }
      console.log(`  ✔ 基线已固定`);

      let feedback = '';
      let upgraded = false;
      let attemptsUsed = 0;
      // 环境类失败不消耗尝试次数，但不能无限重试：同一个坏环境重试三次还没好，
      // 说明不是偶发，继续派单只是把同一个错误刷进账本。
      let infraRetries = 0;
      const layersSeen: string[] = [];
      // 题级的模型游标：只有归因判成 behavior 层才前进，并且每个模型最多试一次。
      let modelIdx = 0;
      let currentModel = MODEL_ROTATION[0] ?? MODEL;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (Date.now() > DEADLINE) break;
        attemptsUsed = attempt;
        const startedAt = Date.now();
        console.log(`\n  ── 第 ${attempt}/${maxAttempts} 次（模型 ${currentModel}）──`);

        const fbFile = path.join(WORK, `fb-${spec.id}.txt`);
        const args = ['tsx', 'scripts/task-self-upgrade.ts', `--task=${spec.id}`];
        if (feedback) {
          writeFileSync(fbFile, feedback, 'utf8');
          args.push(`--feedback-file=${fbFile}`);
        }

        // serveEnv 只带 UPGRADE_BASE：派单脚本由此知道该打哪个端口，
        // 不必再在代码里写死 8080（那是开发实例，不一定是本轮的服务）。
        const sent = run('npx', args, 700_000, {
          ...serveEnv,
          // 模型按题级游标传：归因可能已经在本题内换过模型。
          RSI_MODEL: currentModel,
          RSI_SSE_DUMP: path.join(WORK, `sse-${spec.id}-${attempt}.txt`),
        });
        const sendSec = ((Date.now() - startedAt) / 1000).toFixed(0);
        console.log(`  派单完成（${sendSec}s），${sent.ok ? '进程正常退出' : '进程异常退出'}`);
        if (!sent.ok) {
          for (const l of sent.out.split('\n').filter(Boolean).slice(-6)) {
            console.log(`    ! ${l.trim().slice(0, 200)}`);
          }
        }
        // 「只说不做」是真实失败模式：第一版循环的首轮，它回了一句
        // 「I'll fix the extractErrorInfo function…」就结束，0 次工具调用。
        // 这种情况围栏只会说「靶子未被改动」，模型看不出是自己的问题，必须点名。
        const calls = Number((/"toolCallCount":(\d+)/.exec(sent.out) ?? [])[1] ?? 0);
        if (calls === 0) {
          console.log(`    ! 本轮 0 次工具调用（只回了文字，没有动文件）`);
        }

        const fence = run('node', fenceArgs(spec), 700_000);
        console.log(`  围栏：${fence.ok ? 'PASS' : 'FAIL'}`);
        for (const l of fence.out.split('\n').filter((x) => /^(PASS|FAIL|WARN)\s/.test(x))) {
          console.log(`    ${l.trim()}`);
        }

        if (fence.ok) {
          const version = flag('no-bump') ? null : bumpVersion();
          ledger({ task: spec.id, verdict: 'upgraded', attempt, sendSec: Number(sendSec), version });
          console.log(`  ✔ 升级成立${version ? ` → 版本 ${version}` : ''}`);
          summary.push({ id: spec.id, verdict: 'upgraded', attempts: attempt, version });
          upgraded = true;
          break;
        }

        // 失败：生成诊断给下一轮。诊断本身也可能为空（比如上游空转），
        // 那就把围栏末尾原文带上，至少让它知道「什么都没发生」。
        feedback = diagnose(spec, fence.out) || `上一轮没有任何有效产出。围栏原文末尾：\n${fence.out.slice(-1500)}`;
        if (calls === 0) {
          feedback =
            '【事实】上一轮你没有调用任何工具，只输出了文字，目标文件一个字节都没变。\n' +
            '描述你的修复计划不算完成任务——这一轮必须真正调用 fs.write 把改动落盘。\n\n' +
            feedback;
        }
        writeFileSync(path.join(WORK, `diag-${spec.id}-${attempt}.txt`), feedback, 'utf8');
        console.log(`  诊断已存 ${path.join(WORK, `diag-${spec.id}-${attempt}.txt`)}`);

        // ── 归因：把「失败」拆成七层里的一层，并据此决定下一步做什么 ──────
        //
        // 判定的输入全是机械事实（进程退出、run_report 计数、围栏四道布尔、诊断原文），
        // 所以同一个现场回放永远得到同一个结论；责任边界也据此划死：
        // 只有 integration / implementation 计入 Agent 的能力账。
        const fa = parseFence(fence.out);
        const attr = attributeFailure({
          taskId: spec.id,
          attempt,
          maxAttempts,
          dispatch: { exitOk: sent.ok, output: sent.out },
          diagnosis: feedback,
          fence: fa,
          // 服务是本次循环自己起的、就绪后才派单；中途挂掉会由 ECONNREFUSED 在
          // dispatch.output 里现形，走 infra 分支。
          serviceHealthy: true,
        });
        layersSeen.push(attr.layer);
        console.log(
          `  归因：${LAYER_META[attr.layer].label}层｜${attr.code}｜责任 ${attr.owner}｜` +
            `${attr.countsAgainstAgent ? '计入' : '不计入'}Agent`,
        );
        console.log(`    → ${attr.nextAction}：${attr.note}`);
        ledger({
          task: spec.id,
          verdict: 'failed',
          attempt,
          layer: attr.layer,
          code: attr.code,
          sendSec: Number(sendSec),
          attribution: toLedgerFields(attr, spec.id, attempt),
        });

        // 判据层必须停机：尺子错了，后面的每一轮都在给错尺子打工。
        if (attr.nextAction === 'halt_manual') {
          console.log('  ⛔ 判据层失败，停机等人工修尺子。');
          summary.push({ id: spec.id, verdict: 'halted', attempts: attempt, version: null });
          return;
        }
        // 环境层不消耗尝试次数：Agent 根本没被真正派单。
        if (attr.nextAction === 'retry_same') {
          if (infraRetries >= 2) {
            console.log('  ⛔ 环境问题连续 3 次未修复，停机（继续派单只会把同一个错误刷进账本）。');
            summary.push({ id: spec.id, verdict: 'halted', attempts: attempt, version: null });
            return;
          }
          infraRetries += 1;
          attempt -= 1; // for 的 ++ 会把它还原，等价于重跑同一轮
          continue;
        }
        // 行为层（有预算却一次工具都不调）：换模型重来，同样不消耗尝试次数。
        // 这一条让「学到的结论」真的改变做法——否则分层只是换了个名字记账。
        if (attr.nextAction === 'switch_model') {
          const next = MODEL_ROTATION[modelIdx + 1];
          if (!next) {
            console.log(`  ⛔ 候选模型已轮完（${MODEL_ROTATION.join(' → ')}），停机等人工定夺。`);
            summary.push({ id: spec.id, verdict: 'halted', attempts: attempt, version: null });
            return;
          }
          modelIdx += 1;
          const from = currentModel;
          currentModel = next;
          console.log(`  ↻ 按归因换模型：${from} → ${next}（不消耗尝试次数）`);
          attempt -= 1;
          continue;
        }
      }

      if (!upgraded) {
        // 汇总一行：attempts + 每一层出现的次数。账本单行仍是明细，这一行是索引。
        const layerCount = layersSeen.reduce<Record<string, number>>((acc, l) => {
          acc[l] = (acc[l] ?? 0) + 1;
          return acc;
        }, {});
        ledger({ task: spec.id, verdict: 'failed', attempts: attemptsUsed, layers: layerCount });
        console.log(`  ✗ ${attemptsUsed} 次未成立，归因分布 ${JSON.stringify(layerCount)}`);
        summary.push({ id: spec.id, verdict: 'failed', attempts: attemptsUsed, version: null });
      }
    }
  } finally {
    // 无论正常收尾还是抛异常，都不留孤儿服务：它占着端口，下一轮会撞 EADDRINUSE，
    // 而那个错误看起来像是「服务起不来」，实际是上一轮没收拾干净。
    svc.stop();
  }

  console.log('\n════ 汇总 ════');
  for (const s of summary) {
    console.log(
      `  ${s.verdict === 'upgraded' ? '✔' : '✗'} ${s.id}｜${s.verdict}｜尝试 ${s.attempts} 次${s.version ? `｜版本 ${s.version}` : ''}`,
    );
  }
}

main().catch((e: unknown) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});


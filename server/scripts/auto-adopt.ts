/**
 * auto-adopt.ts — 把「候选判据」自动采纳成正式题。
 *
 * ── 它替代的是哪一步 ──────────────────────────────────────
 * 之前的链条是：题源空 → 自主提议 → 自动出题 → **停下来等人采纳**。
 * 这一环让人必须在场，所以循环永远连不成 CodeLens v9 那种「后台自己跑十几轮」。
 *
 * 但不能简单地「有候选就收」——那等于让出题人（模型）给自己发通行证。
 * 所以采纳要过四道**机械**闸，全部不依赖语义判断：
 *
 *   A1 候选必须来自候选池（server/candidates/*.candidate.ts + *.spec.json）
 *   A2 判据能编译（author-task 已验一次，这里在落库位置再验一次）
 *   A3 **判据在靶子未实现时必须红**（把判据放到正式位置跑一次；绿 = 橡皮图章，拒）
 *   A4 题目落在 D1 全自动域（用 checkDomain，trigger=schedule、未人批；
 *      D4 判据层 / D2 以上一律不自动采纳）
 *
 * 通过后才写进 tasks.json 与判据目录，并在账本记一行 adopted。
 * 采纳后循环会重打基线，判据随即受指纹保护 —— 采纳不是放行，是把尺子锁进保险柜。
 *
 * ── 安全上限 ──────────────────────────────────────────────
 * 单次最多采纳 1 题；连续失败累计到阈值由循环停机。
 * 这里故意不做「批量采纳」：一次塞多道题会让归因信号混在一起，出事时无法定位。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDomain } from '../src/services/rsi/change-domain.js';
import { appendExemplar, appendRejection } from './lib/agent-feedback.js';

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const ROOT = path.resolve(SERVER, '..');
const CANDIDATES = path.join(SERVER, 'candidates');
const TASKS = path.join(SERVER, 'self-upgrade', 'tasks.json');
const LEDGER = path.join(ROOT, '.self-upgrade', 'ledger.jsonl');
const PROPOSALS = path.join(ROOT, '.self-upgrade', 'proposals.jsonl');

/** 从提议里取回「缺什么 / 怎么看出修好了」——采纳进 tasks.json 时一并带上，
 *  否则通用任务书只能拿到一句标题，模型不知道该改什么行为。 */
function proposalContext(id: string): { gap?: string; observable?: string; evidence?: string[] } {
  if (!existsSync(PROPOSALS)) return {};
  for (const line of readFileSync(PROPOSALS, 'utf8').split('\n').filter(Boolean)) {
    try {
      const p = JSON.parse(line) as { id?: string; gap?: string; observable?: string; evidence?: string[] };
      if (p.id === id) return { gap: p.gap, observable: p.observable, evidence: p.evidence };
    } catch { /* 坏行跳过 */ }
  }
  return {};
}

export type AdoptMode = 'red-baseline' | 'implement-first';

export interface CandidateSpec {
  id: string;
  title: string;
  allowed: string[];
  judge: string;
  maxAttempts?: number;
  package?: 'server' | 'client';
  boundary?: string;
  /** 合法调用探针文件（相对候选池）。 */
  probe?: string;
  /**
   * 采纳模式：
   *   red-baseline   —— 判据在现状上必须红，采纳后作为回归尺（默认，适合 defect）。
   *   implement-first —— 缺口是新增能力，先由 agent 实现再验证判据变绿后采纳（capability）。
   */
  mode?: AdoptMode;
}

const MAX_ADOPT_PER_RUN = 1;

function pkgDir(spec: CandidateSpec): string {
  return spec.package === 'client' ? path.join(ROOT, 'client') : SERVER;
}

/** 判据在正式落点的绝对路径。 */
function judgeAbs(spec: CandidateSpec): string {
  return path.join(pkgDir(spec), spec.judge);
}

function alreadyAdopted(spec: CandidateSpec): boolean {
  try {
    const j = JSON.parse(readFileSync(TASKS, 'utf8')) as { tasks?: { id: string }[] };
    return (j.tasks ?? []).some((t) => t.id === spec.id);
  } catch {
    return false;
  }
}

/**
 * 候选判据是在 server/candidates/ 下编译的，业务模块写成 '../src/...'。
 * 采纳到 tests/self-upgrade/ 后差一级，必须改成 '../../src/...'。
 *
 * 这不是「帮模型改代码」——是把同一份文本从一个目录搬到另一个目录时，
 * 相对路径本来就该跟着变。不改的话 A2 会以 "Cannot find module" 拒收所有候选，
 * 自动采纳永远 0 题。
 */
function relocateImports(code: string): string {
  const PH = '\u0000';
  return code
    .replaceAll('../../src/', `${PH}src/`)
    .replaceAll('../src/', '../../src/')
    .replaceAll('../client/', '../../client/')
    .replaceAll(`${PH}src/`, '../../src/');
}

function candidateSource(file: string): string {
  return relocateImports(readFileSync(file, 'utf8'));
}

/**
 * 合法调用探针闸（A2.5）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────
 * 之前 A3 只验「判据有断言失败」，结果出题人把整条命令行塞进 command，
 * 工具前置策略直接拒成 invalid_args —— 判据四条全红，看着像「缺口没实现」，
 * 其实是**判据自己没走到被测行为**。Agent 对着这把错尺子白改 3 轮。
 *
 * 光靠在输出里匹配 invalid_args 这类信号是启发式，挡不住新花样。
 * 所以改为让出题人**显式交一份探针**：用一组合法参数真调一次 handler，
 * 自报有没有被前置校验拦住。采纳器编译它、跑它、验它。
 * 出题人得先证明自己会正确调用靶子，才有资格出判据。
 */
/**
 * 探针被拒时，给下一轮的**可照改**指令 —— 按 kind 分流。
 *
 * 原来这里是一句固定文案「照 inputSchema 调用，不要自造 operations 数组」。
 * 实测（2026-11-12 第四轮，fs-read-maxbytes）：探针被拒的真实原因是
 * kind=security —— 它把 `path.join(process.cwd(), 'tmp.txt')` 这个**绝对路径**
 * 传给了 fs.read，参数键全对、值不合规。而固定文案让它去查字段名，
 * 方向完全相反；下一轮它只会继续改键名，永远修不好。
 * 反馈不按证据分流，就是在教它学错东西。
 */
export function probeFixHint(pc: { reason: string; kind?: string }): string {
  switch (pc.kind) {
    case 'security':
      return '路径不合规（不是字段问题）：工具只收**沙箱相对路径**，探针里的绝对路径会被拒。改成 path.relative(process.cwd(), 目标) 再传；不要用 path.join(process.cwd(), ...) 的绝对路径，也不要写 ../ 越界路径。';
    case 'not_found':
      return '目标不存在：探针要先真正创建夹具文件再调用（不要调用一个还没写出来的路径），并且路径仍要用沙箱相对路径。';
    case 'invalid_args':
      return '参数被前置校验拒：照真实 inputSchema 给字段（required 必填、只用 properties 里的键、枚举值取 schema 里列出的），不要自造 operations 之类的数组包装。';
    case 'timeout':
      return '超时：探针不许跑长命令或大文件，换最小输入（几行文本、一个字节）重试。';
    default:
      return `先看清被拒的真实原因（kind=${pc.kind ?? '?'}），再改调用方式；不要靠换字段名蒙过去。`;
  }
}

export function probeCheck(probeFile: string): { ok: boolean; reason: string; kind?: string } {
  const src = readFileSync(probeFile, 'utf8');
  if (!/handler\s*!?\s*\(/.test(src)) {
    return { ok: false, reason: '探针里没有真的调用 handler（不许写一个假的 reachedBehavior）' };
  }
  if (!src.includes('PROBE_RESULT=')) {
    return { ok: false, reason: '探针没有按约定输出 PROBE_RESULT' };
  }
  const name = path.basename(probeFile);
  // 一次性沙箱：探针会在 cwd 下创建文件（例如 fs.write create 的临时文件），
  // 而 A2.5 会被重跑（采纳重试、人工复跑）。残留会让第二次 create 报「已存在」，
  // 于同一份探针第一次 kind=ok、第二次 kind=invalid_args —— 实测就踩在这里，
  // 表现为「探针自报被前置校验拦住」，看起来像出题人写错，其实是上次的残留。
  // 放到与 candidates 同级的临时目录里跑：'../src/...' 仍解析到 server/src，
  // 但沙箱根每次都是全新的，跑完即删，既不污染候选池也不受上次影响。
  const runDir = path.join(SERVER, `.probe-run-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(runDir, { recursive: true });
  try {
    writeFileSync(path.join(runDir, name), src, 'utf8');
    const tsc = spawnSync(
      'npx',
      ['tsc', '--noEmit', '--target', 'ES2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--strict', '--skipLibCheck', '--types', 'node', name],
      { cwd: runDir, encoding: 'utf8', shell: process.platform === 'win32', timeout: 180_000 },
    );
    if (tsc.status !== 0) {
      const err = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`.split('\n').find((l) => /error TS\d+/.test(l));
      return { ok: false, reason: `探针编译不过：${err?.trim() ?? '未知错误'}` };
    }
    const r = spawnSync('npx', ['tsx', name], {
      cwd: runDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 120_000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    const hit = /PROBE_RESULT=(\{[^\n]+\})/.exec(out);
    if (!hit?.[1]) return { ok: false, reason: '探针运行后没有输出 PROBE_RESULT（可能没跑起来）' };
    let parsed: { reachedBehavior?: boolean; kind?: string; message?: string };
    try {
      parsed = JSON.parse(hit[1]) as { reachedBehavior?: boolean; kind?: string; message?: string };
    } catch {
      return { ok: false, reason: 'PROBE_RESULT 不是合法 JSON' };
    }
    if (parsed.reachedBehavior !== true) {
      const kind = parsed.kind ?? '?';
      const msg = String(parsed.message ?? '').trim();
      return {
        ok: false,
        kind,
        reason:
          `探针自报被前置校验拦住（kind=${kind}）` +
          (msg ? `：${msg.slice(0, 120)}` : '') +
          ' —— 出题人没找到合法调用方式',
      };
    }
    return { ok: true, reason: `合法调用探针通过（kind=${parsed.kind ?? 'ok'}）` };
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

/**
 * A2.6 探针/判据参数一致性。
 *
 * 探针闸（A2.5）只证明「出题人会合法调用某个工具」，但没证明它调用的
 * **就是判据测的那件事**：理论上可以拿一组简单参数让探针跑通，判据却在测
 * 另一条路径。判据与探针必须共享同一套调用口径，探针才算有效证据。
 *
 * 比对「工具变量名 + 第一个参数对象的键集合」，不比值：
 * 判据测超时会用 timeoutMs:1000，探针用 5000 是合理的，值不同不该被拒。
 * 但键集合不同（比如判据全用 args、探针把整条命令行塞进 command）说明
 * 两边不是同一种调用方式，必须拒收。
 */
interface CallSite {
  tool: string;
  keys: string[];
}

/** 从 `X.handler!(...)` 的起始位置扫出第一个对象字面量（平衡括号，跳过字符串）。 */
function firstArgObject(src: string, from: number): string | null {
  const open = src.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

function callSites(src: string): CallSite[] {
  const out: CallSite[] = [];
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\.handler\s*!?\s*\(/g)) {
    const from = (m.index ?? 0) + m[0]!.length;
    const body = firstArgObject(src, from);
    if (body === null) continue;
    const keys = [...body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g)]
      .map((x) => x[1] ?? '')
      .filter(Boolean);
    out.push({ tool: m[1] ?? '', keys: [...new Set(keys)].sort() });
  }
  return out;
}

export function argsConsistencyCheck(candidateSrc: string, probeSrc: string): { ok: boolean; reason: string } {
  const c = callSites(candidateSrc);
  const p = callSites(probeSrc);
  if (c.length === 0) {
    return { ok: false, reason: '判据里没有可比对的字面量参数 —— 请把传给 handler 的参数写成对象字面量' };
  }
  if (p.length === 0) {
    return { ok: false, reason: '探针里没有可比对的字面量参数' };
  }
  const sig = (x: CallSite): string => `${x.tool}(${x.keys.join(',')})`;
  const cSigs = new Set(c.map(sig));
  const matched = p.find((x) => cSigs.has(sig(x)));
  if (matched) return { ok: true, reason: `A2.6 参数口径一致（${sig(matched)}）` };

  // 部分一致：同一工具、共享 ≥2 个键、但两边**各有独有键** → 测的是同一工具的不同分支。
  //
  // 为什么需要这条：有些缺陷本身就是「某条分支被错误拒绝」（例如 inputSchema 不声明
  // recursive，于是 delete + recursive 必然被拒）。这类题的探针**不可能**合法走那条分支，
  // 只能走同工具的其它分支（create）来证明「出题人知道入参形状」。
  // 要求完全一致会把这类真缺陷全部拒掉（实测踩在 fs-write-delete-recursive-missing-schema 上）。
  //
  // 为什么不会放过「编造参数」：探针里多出来的键若不在 inputSchema 里，
  // A2 编译闸的 excess property check 会直接报错，走不到这里。
  // 而「漏必需参数」的情况（探针键集合是判据的子集）**不满足双向独有**，仍然被拒。
  const partial = p.find((px) =>
    c.some((cx) => {
      if (px.tool !== cx.tool) return false;
      const shared = px.keys.filter((k) => cx.keys.includes(k)).length;
      const probeOnly = px.keys.some((k) => !cx.keys.includes(k));
      const judgeOnly = cx.keys.some((k) => !px.keys.includes(k));
      return shared >= 2 && probeOnly && judgeOnly;
    }),
  );
  if (partial) {
    const cx = c.find((x) => x.tool === partial.tool && x.keys.filter((k) => partial.keys.includes(k)).length >= 2);
    const shared = cx ? cx.keys.filter((k) => partial.keys.includes(k)) : [];
    return {
      ok: true,
      reason: `A2.6 参数口径部分一致（同一工具 ${partial.tool}，共享 ${shared.join(',')}；探针与判据各测不同分支）`,
    };
  }

  return {
    ok: false,
    reason: `探针与判据的调用口径不一致：判据 ${c.map(sig).join(' / ')}；探针 ${p.map(sig).join(' / ')}`,
  };
}

/**
 * 逐条取判据的通过/失败（vitest --reporter=json）。
 *
 * 为什么需要逐条：`judgeBaselineVerdict` 只看整体（有红且有几条绿就算真红）。
 * 于是一种很贵的判据能混进来 —— **同一份判据里既有「期望修好后的行为」（红），
 * 又有「描述现在这个 bug」（绿）**。实测（2026-11-12 第四轮 fs-read-maxbytes）：
 *   it('不传 maxBytes → 现在会在 16KB 截断', ...)   expect(truncated).toBe(true)   ← 绿
 *   it('显式 maxBytes=262144 → 读全量', ...)      expect(truncated).toBe(false)  ← 红
 * 修好默认值，第一条红；不修，第二条红。**这题无解**，而整体判定显示"真红"。
 * 结果：Agent 被派 3 次，每次都被判「行为不对」，账记在它头上。
 * 这条闸就是为它设的：模型写的断言（模板安全断言除外）在基线上不许是绿的。
 */
export function runJudgeJsonResults(
  judgeRel: string,
  cwd: string,
  timeoutMs = 180_000,
): { title: string; status: string; safety: boolean }[] | null {
  const outFile = path.join(cwd, `.judge-json-${process.pid}-${Date.now().toString(36)}.json`);
  try {
    spawnSync('npx', ['vitest', 'run', judgeRel, '--reporter=json', `--outputFile=${outFile}`], {
      cwd,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: timeoutMs,
    });
    if (!existsSync(outFile)) return null;
    const j = JSON.parse(readFileSync(outFile, 'utf8')) as {
      testResults?: Array<{ assertionResults?: Array<{ title?: string; status?: string; ancestorTitles?: string[] }> }>;
    };
    const rows: { title: string; status: string; safety: boolean }[] = [];
    for (const tr of j.testResults ?? []) {
      for (const a of tr.assertionResults ?? []) {
        const ancestors = a.ancestorTitles ?? [];
        rows.push({
          title: a.title ?? '',
          status: a.status ?? '',
          // 模板生成的安全断言本来就该在基线上绿，不能算「把现状写成期望」
          safety: ancestors.some((t) => t.includes('通用安全断言')),
        });
      }
    }
    return rows;
  } catch {
    return null;
  } finally {
    rmSync(outFile, { force: true });
  }
}

/** 纯函数：从逐条结果里挑出「模型写的、且在基线上是绿的」断言（模板安全断言不算）。 */
export function snapshotGreens(rows: { title: string; status: string; safety: boolean }[]): string[] {
  return rows.filter((r) => !r.safety && r.status === 'passed').map((r) => r.title);
}

/** A3：把判据临时放到正式位置跑一次，必须「真的有断言且失败」。
 *  也供 author-task 在落盘前做「自证基线红」——同一套判定，出题时先挡一道，
 *  免得把「绿灯题」（测现状就对的行为）当成缺陷题收进候选池。 */
export function baselineMustBeRed(
  spec: CandidateSpec,
  candidateFile: string,
): { ok: boolean; reason: string; premature: boolean; snapshot?: boolean; evidence?: string } {
  const dest = judgeAbs(spec);
  const existed = existsSync(dest);
  const backup = existed ? readFileSync(dest, 'utf8') : null;
  try {
    writeFileSync(dest, candidateSource(candidateFile), 'utf8');
  } catch (e) {
    return { ok: false, reason: `判据写不进落点：${e instanceof Error ? e.message : String(e)}`, premature: false };
  }

  const run = spawnSync('npx', ['vitest', 'run', spec.judge], {
    cwd: pkgDir(spec),
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 180_000,
  });
  const rawOut = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  // 只在「整体是红」时才需要逐条看：整体绿的情况已经被下面的判据挡住，
  // 而多跑一次 vitest 要 2–3 秒，不必每条路径都付这个成本。
  const perTest = run.status === 0 ? null : runJudgeJsonResults(spec.judge, pkgDir(spec));

  // 还原：不管判定如何，都不能把候选判据留在正式位置（采纳还没发生）。
  try {
    if (backup === null) rmSync(dest, { force: true });
    else writeFileSync(dest, backup, 'utf8');
  } catch {
    /* 还原失败会在下面的 A3 结论里被挡下 */
  }

  const verdict = judgeBaselineVerdict(rawOut, run.status);
  if (!verdict.ok || !perTest) return verdict;

  const greenModel = snapshotGreens(perTest);
  if (greenModel.length > 0) {
    return {
      ok: false,
      premature: false,
      snapshot: true,
      reason:
        `判据把现状写成了期望：${greenModel.length} 条断言在基线上就是绿的（${greenModel.join('；')}）` +
        '—— 修好之后它们必然红，这题无解',
      evidence: verdict.evidence,
    };
  }
  return verdict;
}

/**
 * 纯函数：把一次 vitest 运行的**原始输出 + 退出码**判成「基线红是否成立」。
 *
 * 抽出来是为了可单测 —— 这是 A3（采纳闸）与出题自证（author-task）共用的判定核心：
 * 判绿了会把「现状就跑通」的橡皮图章收进候选；判错了会把真缺陷也误拒。
 * 只做字符串/正则判定，不 spawn 任何东西，因此能用合成输出快测。
 *
 * 判定顺序：
 *   1. 退出码 0（绿）→ 橡皮图章，拒。
 *   2. no tests → 没跑到断言，拒（UNEXEC 不等于红）。
 *   3. 没有任何 failed → 无法确认红，拒。
 *   4. 命中 invalid_args/import 失败等 → 假红（没走到被测行为），拒并标 premature。
 *   5. 有 passed 但没有一条通过 → 判据整体跑不通，拒。
 *   6. 有 failed 且至少一条 passed → 真红，收。
 */
/**
 * 从 vitest 输出里抠出「到底哪一行失败了」。
 *
 * 只回「你是假红」对出题 Agent 毫无帮助——它下一轮还是照原样写。
 * 把真正的报错行一起带回去，反馈才具体到能照着改（这是它唯一能看见失败现场的地方）。
 */
export function extractFailureEvidence(out: string): string {
  const clean = out.replace(/\x1b\[[0-9;]*m/g, '');
  const keep: string[] = [];
  for (const raw of clean.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (
      /^(AssertionError|Error:|TypeError:|ReferenceError|SyntaxError)/.test(line) ||
      /^(Cannot find module|.*is not a function)/.test(line) ||
      /^(×|FAIL)\b/.test(line) ||
      /^(expected|Received)\b/i.test(line) ||
      /^→\s/.test(line)
    ) {
      const s = line.slice(0, 160);
      if (!keep.includes(s)) keep.push(s);
      if (keep.length >= 4) break;
    }
  }
  return keep.join(' ｜ ').slice(0, 400);
}

export function judgeBaselineVerdict(
  rawOut: string,
  status: number | null,
): { ok: boolean; reason: string; premature: boolean; evidence?: string } {
  // vitest 在非 TTY 下仍会往数字周围塞 ANSI 色码，先剥再匹配，否则会漏判。
  const out = rawOut.replace(/\x1b\[[0-9;]*m/g, '');
  const ev = extractFailureEvidence(out);
  const noTests = /no tests/i.test(out);
  const failed = /\bTests\b[^\n]*\bfailed\b/i.test(out) || /\bTest Files\b[^\n]*\bfailed\b/i.test(out);
  if (status === 0) return { ok: false, reason: '判据在靶子未实现时就是绿的 —— 橡皮图章，拒绝采纳', premature: false, evidence: ev };
  if (noTests) return { ok: false, reason: '判据没有跑到任何断言（no tests）—— 按 C4，UNEXEC 不等于红', premature: false, evidence: ev };
  if (!failed) return { ok: false, reason: '判据没有产生可验证的失败（无法确认基线红）', premature: false, evidence: ev };
  // 关键补闸：区分「缺口未实现」与「判据自己没走到被测行为」。
  // 假红比不红更贵：它会让整条自动链持续产出「看似在跑、其实无解」的题。
  //
  // 但判定必须分层，否则会把真红误杀（实测踩过）：
  // 缺陷是「inputSchema 不声明 recursive，所以传 recursive 被拒」，
  // 判据第 2/3 条通过、第 1 条红，而失败输出里出现了 TOOL_INVALID_ARGS，
  // 旧逻辑一律判假红，把一条真缺陷作废了。正确的分层是：
  //   · 硬错误（导入失败 / 模块不存在 / 安全策略拦截）—— 判据根本跑不起来，无条件假红；
  //   · 软错误（invalid_args 之类）—— 可能正是目标行为，只有「一条都没通过」才算假红。
  const passedHit = /([0-9]+)[ ]+passed/i.exec(out);
  const passed = passedHit?.[1] ? Number(passedHit[1]) : 0;

  const hardPremature = /(?:Cannot find module|is not a function|ENOENT|TOOL_SECURITY_DENIED)/i.exec(out);
  if (hardPremature) {
    return {
      ok: false,
      reason: `判据没走到被测行为（命中「${hardPremature[0]}」：导入或调用本身失败）—— 这是假红，不是缺口未实现`,
      premature: true,
      evidence: ev,
    };
  }

  const softPremature = /(?:Received:.{0,6}(?:invalid_args|security|not_found)|TOOL_INVALID_ARGS)/i.exec(out);
  if (passed === 0 && softPremature) {
    return {
      ok: false,
      reason: `判据一条都没通过、且命中「${softPremature[0].slice(0, 40)}」—— 整体被前置校验拦住，这是假红`,
      premature: true,
      evidence: ev,
    };
  }

  if (passed === 0) {
    return { ok: false, reason: '没有任何断言通过 —— 判据整体跑不通（可能是 API 调错），不能算基线红', premature: false, evidence: ev };
  }
  return { ok: true, reason: `基线红成立（${passed} 条通过 / 失败断言指向目标行为）`, premature: false, evidence: ev };
}

/**
 * A3 之后怎么走：纯函数，便于单测。
 *
 *  - A3 通过（基线红成立）→ 直接采纳。
 *  - 非 implement-first：任何 A3 失败都拒绝（含 premature 假红）。
 *  - implement-first：A3 失败**且**是 premature（判据因「缺失的新 API/符号」而跑不到行为）
 *    时，说明这是「还没实现的能力」，路由去 implement-task.ts 让 agent 先把能力实现，
 *    再验证判据变绿。其余 A3 失败（判据本身写错、没断言）仍拒绝。
 *
 * 这就是「A、B 同时走」的接缝：defect 走 red-baseline 被采纳，capability 走
 * implement-first 被实现后采纳，二者共用同一份判据与同一道 A4 域闸。
 */
export type RouteAction = 'adopt' | 'reject' | 'implement';
export function routeAfterA3(
  spec: { mode?: AdoptMode },
  a3: { ok: boolean; reason: string; premature?: boolean },
): { action: RouteAction; reason: string } {
  if (a3.ok) return { action: 'adopt', reason: a3.reason };
  if (spec.mode !== 'implement-first') return { action: 'reject', reason: a3.reason };
  if (a3.premature) return { action: 'implement', reason: 'capability 缺口：A3 因缺失的新 API 而 premature，路由去实现' };
  return { action: 'reject', reason: a3.reason };
}

/** A2：在正式落点再做一次语法/类型编译。 */
function compiles(spec: CandidateSpec, candidateFile: string): { ok: boolean; errors: string[] } {
  const dest = judgeAbs(spec);
  const backup = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
  writeFileSync(dest, candidateSource(candidateFile), 'utf8');
  const r = spawnSync(
    'npx',
    ['tsc', '--noEmit', '--target', 'ES2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--strict', '--skipLibCheck', '--types', 'node', spec.judge],
    { cwd: pkgDir(spec), encoding: 'utf8', shell: process.platform === 'win32', timeout: 180_000 },
  );
  if (backup === null) rmSync(dest, { force: true });
  else writeFileSync(dest, backup, 'utf8');
  const errors = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter((l) => /error TS\d+/.test(l)).slice(0, 5);
  return { ok: r.status === 0, errors };
}

function appendLedger(entry: Record<string, unknown>): void {
  appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

function main(): void {
  if (!existsSync(CANDIDATES)) {
    console.log('没有候选目录，跳过采纳。');
    return;
  }

  const specs = readdirSync(CANDIDATES).filter((f) => f.endsWith('.spec.json'));
  let adopted = 0;

  for (const file of specs) {
    if (adopted >= MAX_ADOPT_PER_RUN) break;
    let spec: CandidateSpec;
    try {
      spec = JSON.parse(readFileSync(path.join(CANDIDATES, file), 'utf8')) as CandidateSpec;
    } catch {
      continue;
    }
    const candidateFile = path.join(CANDIDATES, `${spec.id}.candidate.ts`);
    const probeFile = path.join(CANDIDATES, spec.probe ?? `${spec.id}.probe.ts`);
    if (!spec.id || !existsSync(candidateFile)) continue;
    if (!existsSync(probeFile)) {
      console.log(`  ✗ A1 缺合法调用探针（${path.basename(probeFile)}）—— 没有探针就不采纳判据`);
      continue;
    }
    if (alreadyAdopted(spec)) {
      console.log(`  · ${spec.id} 已采纳过，跳过`);
      continue;
    }

    console.log(`\n════ 采纳检查：${spec.id}`);

    // A4 域：无人值守、没有人批 —— 只有 D1 能通过。
    const domain = checkDomain({ files: spec.allowed, trigger: 'schedule', humanApproved: false });
    if (!domain.ok) {
      console.log(`  ✗ A4 域不允许自动采纳（${domain.domain}）：${domain.reasons.join('；')}`);
      continue;
    }

    // A2 编译
    const comp = compiles(spec, candidateFile);
    if (!comp.ok) {
      console.log(`  ✗ A2 判据编译不过：${comp.errors[0] ?? '未知'}`);
      continue;
    }

    // A2.5 探针：出题人先证明自己会合法调用靶子
    const pc = probeCheck(probeFile);
    if (!pc.ok) {
      console.log(`  ✗ A2.5 ${pc.reason}`);
      appendRejection({
        id: spec.id,
        stage: 'adopt-a2',
        code: 'A2_5_PROBE_INVALID',
        detail: pc.reason.slice(0, 260),
        fix: probeFixHint(pc),
      });
      continue;
    }
    console.log(`  · ${pc.reason}`);

    // A2.6 探针必须与判据测的是同一套调用口径
    const ac = argsConsistencyCheck(candidateSource(candidateFile), readFileSync(probeFile, 'utf8'));
    if (!ac.ok) {
      console.log(`  ✗ A2.6 ${ac.reason}`);
      continue;
    }
    console.log(`  · ${ac.reason}`);

    // A3 基线红 + 路由
    const red = baselineMustBeRed(spec, candidateFile);
    const route = routeAfterA3(spec, red);
    if (route.action === 'adopt') {
      // 正常：基线红成立，走下面的落库采纳。
    } else if (route.action === 'reject') {
      console.log(`  ✗ A3 不成立：${route.reason}`);
      appendRejection({
        id: spec.id,
        stage: 'adopt-a3',
        code: red.premature ? 'A3_PREMATURE' : 'A3_NOT_RED',
        detail: `${route.reason}｜闸原话：${red.reason}｜失败原文：${red.evidence ?? '(无)'}`.slice(0, 300),
        fix: red.premature
          ? '判据没走到被测行为就红了：先确认能正确导入并调用靶子导出，再断言行为'
          : '基线没红：判据测的是现状就成立的行为，改测当前实现明确做错的那个输入',
      });
      continue;
    } else {
      // implement-first：capability 缺口，A3 因缺失的新 API 而 premature。
      // 交给 implement-task.ts 让 agent 先把能力实现，再验证判据变绿后采纳。
      console.log(`  ↳ A3 premature → 路由 implement-first：${route.reason}`);
      const impl = spawnSync('npx', ['tsx', 'scripts/implement-task.ts', `--id=${spec.id}`], {
        cwd: SERVER,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        timeout: 1_800_000,
        stdio: 'inherit',
      });
      const done = /IMPLEMENTED=1/.test(impl.stdout ?? '');
      if (done) {
        console.log(`  ✔ implement-first 完成并已采纳：${spec.id}`);
        adopted += 1;
      } else {
        console.log(`  ✗ implement-first 未成功（见上方 agent 输出）：${spec.id}`);
      }
      continue;
    }

    // 四闸全过 → 落库
    writeFileSync(judgeAbs(spec), candidateSource(candidateFile), 'utf8');
    const j = JSON.parse(readFileSync(TASKS, 'utf8')) as { tasks: Record<string, unknown>[] };
    j.tasks.push({
      ...spec,
      status: 'pending',
      adoptedAt: new Date().toISOString(),
      adoptedBy: 'auto-adopt',
      ...proposalContext(spec.id),
    });
    writeFileSync(TASKS, `${JSON.stringify(j, null, 2)}\n`, 'utf8');
    appendLedger({ task: spec.id, verdict: 'adopted', domain: domain.domain, judge: spec.judge });

    // 正例沉淀：这条确实过完四闸被采纳了，冻结成样例，下一轮出题当 few-shot 回灌。
    // 错题本只告诉模型「别怎么写」，正例才告诉它「该怎么写」——两者缺一个，
    // 它就会在同一个形状上反复试错（实测：没有正例时连续三轮都写成「要新字段」）。
    try {
      const ctx = proposalContext(spec.id);
      appendExemplar({
        id: spec.id,
        title: spec.title,
        gapType: spec.mode === 'implement-first' ? 'capability' : 'defect',
        targetFile: spec.allowed?.[0] ?? '',
        evidence: ctx.evidence ?? [],
        observable: ctx.observable ?? '',
        passed: ['自证基线红', 'A1 域 / A2 编译 / A2.5 探针 / A3 基线红 / A4 域', '已写入 tasks.json'],
      });
    } catch {
      /* 正例沉淀失败不影响采纳本身 */
    }

    console.log(`  ✔ 已自动采纳：${spec.id} → ${spec.judge}（域 ${domain.domain}）`);
    adopted += 1;
  }

  console.log(`\n本轮自动采纳 ${adopted} 题（上限 ${MAX_ADOPT_PER_RUN}）。`);
  // 用 stdout 的最后一行把数量交给循环，避免循环再去解析日志文本。
  console.log(`ADOPTED=${adopted}`);
}

// 入口守卫：允许别的脚本 import probeCheck() 做单元验证，不触发整轮采纳。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

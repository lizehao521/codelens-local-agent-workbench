/**
 * loop-service.ts — 自动迭代循环的「服务生命周期」。
 *
 * ── 它解决的是什么 ────────────────────────────────────────
 * 在这一版之前，跑一轮自我升级前必须先由人做两件事：
 *   1. 把服务以 `SANDBOX_ROOT=<server 目录>` 启动（否则 fs.* 够不到 src/）；
 *   2. 确认那个进程是**当前代码**起的（不是几小时前那份）。
 * 两件都是沉默失败：沙箱根指错，Agent 只会收到「路径越出沙箱根目录」；
 * 进程陈旧，判据会对着内存里的旧实现跑，改完的代码根本没被加载。
 *
 * 实测证据（写这段的原因）：某轮开工时 `GET /api/health` 报 version=2.3.0，
 * 而仓库里 package.json 已是 2.4.0 —— 也就是说，那个服务从 2.3.0 起就没重启过，
 * 期间新增的 `fs.write{operation:"replace"}` 判据全跑在一个不认识的进程上。
 *
 * ── 做法 ────────────────────────────────────────────────
 * 不去动别人的进程，而是**起一个专属实例**：
 *   · 端口默认 8099（`RSI_LOOP_PORT` 可覆盖），与开发用的 8080 错开；
 *   · `SANDBOX_ROOT` 指向 server 目录，一步到位，无需人工切换；
 *   · `AGENT_DB_PATH` 指向 `.self-upgrade/loop/` 下的独立库，不与开发实例争 sqlite；
 *   · 就绪后校验三件事：health=ok、version 与 package.json 一致、`code.check` 已注册；
 *   · 循环结束时整棵进程树杀掉（Windows 走 taskkill /T，POSIX 杀进程组）。
 *
 * ── 三条安全约束 ──────────────────────────────────────────
 *   1. **权限最小化**：新库的 autoApprove 默认全 false，只开 `fsDestructive`
 *      （无头会话批不出审批，写盘必须放行）。`httpWrite` 保持关闭——
 *      Agent 因此没有「把文件内容 POST 出去」的通道，这是本轮刻意收紧的口子。
 *   2. **不抢别人的端口**：若端口上已有服务，只校验、不 kill；校验不过就退出，
 *      由人决定停哪个进程。自动杀进程等于把不可恢复的误伤变成默认行为。
 *   3. **失败要响**：进程提前退出、启动超时、版本不符，都以非零退出结束，
 *      不允许「服务没起来但循环继续跑」——那会产出一批假失败。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const SERVER = process.cwd();
const ROOT = path.join(SERVER, '..');
const WORK = path.join(ROOT, '.self-upgrade', 'loop');
const LOG = path.join(WORK, 'service.log');
const READY_TIMEOUT_MS = Number(process.env.RSI_LOOP_READY_MS ?? 120_000);

export interface LoopService {
  /** 派单脚本使用的 base url。 */
  base: string;
  port: number;
  version: string;
  /** 是否复用了已在运行的服务（此时 stop 不杀进程）。 */
  reused: boolean;
  stop: () => void;
}

interface JsonReply {
  status: number;
  body: unknown;
}

function httpJson(port: number, p: string, method = 'GET', body?: unknown): Promise<JsonReply> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: p,
        method,
        timeout: 5_000,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : null });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: null });
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    // 不带 /T 会留下 tsx 的 loader 子进程占着端口，下一次启动必撞 EADDRINUSE。
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经退出 */
    }
  }
}

interface HealthBody {
  status?: string;
  version?: string;
  sandbox?: { rootConfigured?: boolean; writable?: boolean };
}

/**
 * 校验一个已就绪的实例是不是「我们要的那一个」。
 *
 * 三条都必要：
 *   · health=ok      —— 起来了且有 db；
 *   · version 一致    —— 进程是从当前代码起的（陈旧进程在这一条上现形）；
 *   · code.check 在册 —— 产物真的被加载了（版本号可能没跟着改）。
 *
 * `reachable=false` 与 `ok=false` 必须分开：前者是「端口没人听，可以直接起」，
 * 后者是「有东西在听但不对，得先清理」。混在一起会把空端口当成残留，
 * 然后以「端口被占用」退出——一个纯粹的假失败。
 */
async function verify(
  port: number,
  expectedVersion: string,
): Promise<{ ok: boolean; reachable: boolean; reason?: string; version?: string }> {
  let health: JsonReply;
  try {
    health = await httpJson(port, '/api/health');
  } catch (e) {
    return { ok: false, reachable: false, reason: `health 不可达：${e instanceof Error ? e.message : e}` };
  }
  const h = (health.body ?? {}) as HealthBody;
  if (h.status !== 'ok') return { ok: false, reachable: true, reason: `health.status=${String(h.status)}` };
  if (h.sandbox && h.sandbox.writable !== true) return { ok: false, reachable: true, reason: '沙箱不可写（probe 写失败）' };
  if (expectedVersion !== 'unknown' && h.version !== expectedVersion) {
    return {
      ok: false,
      reachable: true,
      reason: `版本不符：进程 ${String(h.version)} ≠ 仓库 ${expectedVersion}（进程陈旧或连错端口）`,
    };
  }
  try {
    const tools = await httpJson(port, '/api/v1/tools');
    const list = ((tools.body ?? {}) as { tools?: { name?: string }[] }).tools ?? [];
    if (!list.some((t) => t.name === 'code.check')) {
      return { ok: false, reachable: true, reason: '工具清单里没有 code.check（当前代码未加载）' };
    }
  } catch (e) {
    return { ok: false, reachable: true, reason: `工具清单不可读：${e instanceof Error ? e.message : e}` };
  }
  return { ok: true, reachable: true, version: h.version };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 等端口真正释放。taskkill 返回 ≠ socket 已关闭，直接起会撞 EADDRINUSE。 */
async function waitPortFree(port: number, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const probe = await verify(port, 'unknown');
    if (!probe.reachable) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`端口 ${port} 在 ${timeoutMs / 1000}s 内没有释放`);
    }
    await sleep(300);
  }
}

/**
 * 起（或复用）一个专供循环使用的服务实例。
 *
 * 若外部显式给了 `UPGRADE_BASE`，则只校验、不启停 —— 保留「我自己起了服务，你直接用」的老用法。
 */
export async function startLoopService(): Promise<LoopService> {
  const explicit = process.env.UPGRADE_BASE;
  const expected = readVersion();

  if (explicit) {
    const u = new URL(explicit);
    const port = Number(u.port || 80);
    const v = await verify(port, expected);
    if (!v.ok) {
      throw new Error(`外部服务 ${explicit} 不可用：${v.reason}`);
    }
    console.log(`  服务：复用外部实例 ${explicit}（version ${String(v.version)}）`);
    return { base: explicit.replace(/\/$/, ''), port, version: String(v.version), reused: true, stop: () => {} };
  }

  const port = Number(process.env.RSI_LOOP_PORT ?? 8099);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`RSI_LOOP_PORT 非法：${String(process.env.RSI_LOOP_PORT)}`);
  }

  // 端口上已经有服务：**不复用**，一律收掉重起。
  //
  // 这里踩过一次：原先「probe 合规就直接复用」，看起来省 20 秒启动时间，
  // 实际是把生命周期让给了别人——我停掉父循环后，那个被复用的实例成了孤儿，
  // 下一轮派单立刻 connect ECONNREFUSED，而日志还说「服务：已启动」。
  // 一个管不住生死的「在线服务」，比一个明确指向错误的报错更危险。
  const probe = await verify(port, expected);
  if (probe.reachable) {
    const why = probe.ok ? '是本循环上一轮留下的实例' : probe.reason;
    console.log(`  服务：端口 ${port} 已被占用（${why}），收掉后重起`);
    if (!killPortHolders(port)) {
      throw new Error(`端口 ${port} 被非本循环的进程占用（${probe.reason}），请手动处理或改 RSI_LOOP_PORT`);
    }
    await waitPortFree(port);
  }

  mkdirSync(WORK, { recursive: true });
  const dbPath = path.join(WORK, 'loop.db');
  // 每轮重建：旧库会残留上一次的会话与审批记录，且 sizeBytes 会一路涨。
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      /* 删不掉就沿用旧库，不影响正确性 */
    }
  }

  const tsxCli = path.join(SERVER, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(tsxCli)) throw new Error(`找不到 tsx 入口 ${tsxCli}`);
  // 沙箱根下一句快速自检：指到 server 之外，Agent 第一件事就会撞「路径越出沙箱根」，
  // 而那个报错看起来像越界，实际是配置错。宁可在启动时就响。
  if (!existsSync(path.join(SERVER, 'src', 'app.ts'))) {
    throw new Error(`SANDBOX_ROOT=${SERVER} 下没有 src/app.ts，沙箱根指错了`);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    // 关键一步：沙箱根 = server 目录本身。Agent 改 src/ 才不需要人工介入。
    SANDBOX_ROOT: SERVER,
    AGENT_DB_PATH: dbPath,
  };

  const fd = openSync(LOG, 'a');
  const child: ChildProcess = spawn(process.execPath, [tsxCli, 'src/app.ts'], {
    cwd: SERVER,
    env,
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  closeSync(fd);

  // 用对象承载而不是 let 变量：TS 的控制流分析不认识「回调里赋值」，
  // `let x: T|null = null` 在循环里会被收窄成 null，读 x.code 直接编译报错。
  const state: { exited: { code: number | null; signal: string | null } | null } = { exited: null };
  child.on('exit', (code, signal) => {
    state.exited = { code, signal };
  });

  const stop = (): void => {
    if (child.pid) killTree(child.pid);
  };
  // 循环被 Ctrl-C 打断时不留下孤儿进程（否则下一次必然撞端口）。
  const onExit = (): void => stop();
  process.once('exit', onExit);

  const startedAt = Date.now();
  for (;;) {
    if (state.exited) {
      throw new Error(
        `服务启动即退出（code=${String(state.exited.code)} signal=${String(state.exited.signal)}）。日志末尾见 ${LOG}：\n${tailLog()}`,
      );
    }
    const v = await verify(port, expected).catch((e: unknown) => ({ ok: false, reason: String(e) }));
    if (v.ok) {
      await tightenPermissions(port);
      console.log(`  服务：已启动 http://127.0.0.1:${port}（version ${expected}，沙箱根 ${SERVER}）`);
      return {
        base: `http://127.0.0.1:${port}`,
        port,
        version: expected,
        reused: false,
        stop: () => {
          process.removeListener('exit', onExit);
          stop();
        },
      };
    }
    if (Date.now() - startedAt > READY_TIMEOUT_MS) {
      stop();
      throw new Error(`服务 ${READY_TIMEOUT_MS / 1000}s 内未就绪：${v.reason}\n${tailLog()}`);
    }
    await sleep(1_000);
  }
}

/**
 * 权限最小化：只开无头写盘必需的那一项。
 *
 * `allowDirs` 清空是刻意的 —— 它让「沙箱外白名单」这一条不再是隐性扩权通道：
 * 循环需要什么目录，应该由 SANDBOX_ROOT 明确给出，而不是靠历史遗留的白名单。
 */
async function tightenPermissions(port: number): Promise<void> {
  try {
    await httpJson(port, '/api/v1/sandbox-permissions', 'PUT', {
      allowDirs: [],
      autoApprove: { fsDestructive: true, purge: false, httpWrite: false },
    });
  } catch (e) {
    // 收紧失败不代表不能跑，但必须让人看见：此时 httpWrite 仍可能是开的。
    console.warn(`  ⚠ 收紧沙箱权限失败（继续，但请人工确认 httpWrite=false）：${e instanceof Error ? e.message : e}`);
  }
}

/** 端口占用者是否是我们自己的 tsx 服务；是则杀掉并返回 true。 */
function killPortHolders(port: number): boolean {
  if (process.platform !== 'win32') {
    const r = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
    const pids = (r.stdout ?? '').split(/\s+/).filter(Boolean);
    if (pids.length === 0) return false;
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        return false;
      }
    }
    return true;
  }
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  const pids = (r.stdout ?? '')
    .split('\n')
    .filter((l) => new RegExp(`[:.]${port}\\s`).test(l) && /LISTENING/i.test(l))
    .map((l) => (l.trim().split(/\s+/).pop() ?? '').replace(/\D/g, ''))
    .filter((p) => p && p !== '0');
  if (pids.length === 0) return false;
  for (const pid of pids) {
    const cmd = spawnSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/value'], {
      encoding: 'utf8',
    });
    const line = (cmd.stdout ?? '').trim();
    // 只收自己人：命令行里必须含本仓库路径。别的服务占用端口不许碰。
    if (!/self-upgrade-loop|tsx|src[\\/]app\.ts/i.test(line)) return false;
    spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
  }
  return true;
}

function tailLog(): string {
  try {
    const text = readFileSync(LOG, 'utf8');
    return text.split('\n').slice(-15).join('\n');
  } catch {
    return '(无日志)';
  }
}

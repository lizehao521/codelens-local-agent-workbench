/**
 * 判据 · 外层派单超时必须跟着墙钟旋钮走，且「被掐断」必须留痕（Judge / 尺子侧 / D4）
 *
 * 现场（2026-11-14，code-search 三次真实派单，账本 sendSec 全是 700）：
 * 服务端墙钟调到 660s，预算检查在**每轮 LLM 调用之前**，所以第 20 轮整体过冲到
 * 701723ms 才触发；外层写死的 700s 同时把子进程掐了。第 1 次的 SSE 落盘了
 * （run_report 明写 outcome=budget_exhausted / RUN_BUDGET_WALL_CLOCK），
 * 但 `console.log(buildDispatchTail(sse))` 没来得及执行 —— 归因唯一的机械证据源
 * 是 stdout，不是磁盘上的 SSE。于是三轮里两轮记成 implementation/BEHAVIOR_WRONG
 * 并 countsAgainstAgent=true。尺子替被衡量者说了谎。
 *
 * 两处独立缺陷合成这次漏判，缺一不可复现：
 *   1. 外层超时是与服务端旋钮**互不知情**的常数（700_000）。旋钮拧大它不让路。
 *   2. run() 的 catch 只回 stdout，把 ETIMEDOUT / SIGTERM 丢了。
 *      「没让它做完」和「它不会做」在归因眼里长得一模一样。
 *
 * 本判据钉住两侧，并留金丝雀防止「把真正的能力失败也一并洗白」：
 * 掐断但尾部已打印（竞态）必须仍归 budget；正常收工判据红必须仍归 implementation。
 *
 * C3：把 dispatchTimeoutMs 改回写死常数、去掉 HEADROOM、或让 timeoutMarker 恒返空串，
 * 本判据必须转红。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attributeFailure, type AttributionInput } from '../../scripts/failure-attribution.js';
import { buildDispatchTail } from '../../scripts/lib/sse-tail.mjs';
import { DISPATCH_HEADROOM_MS, dispatchTimeoutMs, taskBudgetMs, timeoutMarker } from '../../scripts/lib/dispatch-timeout.mjs';

const SERVER = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(SERVER, rel), 'utf8');

/** 实测过冲：墙钟 660000ms，第 20 轮在 701723ms 才触发。 */
const MEASURED_OVERSHOOT_MS = 701723;

const base: AttributionInput = {
  taskId: 'timeout-probe',
  attempt: 1,
  maxAttempts: 3,
  dispatch: { exitOk: false, output: '' },
  diagnosis: 'FAIL  判据未通过：tests/self-upgrade/x.test.ts',
  fence: {
    reached: true,
    targetChanged: true,
    typeOk: false,
    judgeOk: false,
    fullOk: false,
    protectedIntact: true,
    judgeTampered: false,
  },
  serviceHealthy: true,
};

/** 逐字取自 sse-code-search-1.txt：墙钟耗尽但子进程正常收尾时的真实尾部。 */
const WALL_SSE =
  'event: meta\ndata: {"iteration":1,"maxIterations":25,"tokenBudget":512000,"contextWindow":128000}\n\n' +
  // 真实流 112KB，原始尾部窗口只有 1200 字符；垫够 delta，meta 才真的是「靠 KEY_EVENTS 保住的」
  'event: delta\ndata: {"text":"x"}\n\n'.repeat(400) +
  'event: run_report\ndata: {"outcome":"budget_exhausted","statusCode":"RUN_BUDGET_WALL_CLOCK",' +
  '"reason":"墙钟预算在第 20 步触发（701723/660000 ms）","finishReason":"budget_exhausted",' +
  '"fileChangeCount":2,"toolCallCount":24,"promptTokens":374820}\n\n' +
  'event: done\ndata: {"finishReason":"budget_exhausted","iteration":20,"toolCallCount":25,"tokenBudget":512000}\n\n';

describe('外层超时必须跟着服务端墙钟旋钮走', () => {
  it('旋钮拧到 660s，外层必须让过实测过冲点 701723ms（现场就是死在这一步）', () => {
    const t = dispatchTimeoutMs({ AGENT_TASK_BUDGET_MS: '660000' });
    expect(t).toBeGreaterThan(MEASURED_OVERSHOOT_MS);
    expect(t).toBe(660000 + DISPATCH_HEADROOM_MS);
  });

  it('旋钮拧大，外层单调跟着变大（不许是常数）', () => {
    const a = dispatchTimeoutMs({ AGENT_TASK_BUDGET_MS: '180000' });
    const b = dispatchTimeoutMs({ AGENT_TASK_BUDGET_MS: '660000' });
    const c = dispatchTimeoutMs({ AGENT_TASK_BUDGET_MS: '1800000' });
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(c - b).toBe(1800000 - 660000);
  });

  it('没设旋钮时用服务端默认 180s，不是 700s', () => {
    expect(taskBudgetMs({})).toBe(180000);
    expect(dispatchTimeoutMs({})).toBe(180000 + DISPATCH_HEADROOM_MS);
  });

  it('余量必须够一次单轮过冲 + 收尾（实测单轮 35–57s）', () => {
    expect(DISPATCH_HEADROOM_MS).toBeGreaterThanOrEqual(120000);
  });

  it('非法值一律回默认，绝不回 NaN —— timeout=NaN 等于外层守卫静默消失', () => {
    for (const bad of ['', 'abc', '0', '-5', '999', '3600001', 'Infinity', '1e9']) {
      const t = dispatchTimeoutMs({ AGENT_TASK_BUDGET_MS: bad });
      expect(Number.isFinite(t), `非法值 ${bad} 产出了 ${t}`).toBe(true);
      expect(t).toBe(180000 + DISPATCH_HEADROOM_MS);
    }
    expect(Number.isFinite(dispatchTimeoutMs({ AGENT_TASK_BUDGET_MS: undefined }))).toBe(true);
  });

  it('取值范围与 env.ts 的 AGENT_TASK_BUDGET_MS 同口径（同源，不是自己拍的）', () => {
    const src = read('src/config/env.ts');
    const line = src.split('\n').find((l) => l.includes('AGENT_TASK_BUDGET_MS:')) ?? '';
    expect(line).toContain('.min(1000)');
    expect(line).toContain('.max(3_600_000)');
    expect(line).toContain('.default(180_000)');
    expect(taskBudgetMs({ AGENT_TASK_BUDGET_MS: '1000' })).toBe(1000);
    expect(taskBudgetMs({ AGENT_TASK_BUDGET_MS: '3600000' })).toBe(3600000);
  });
});

describe('掐断信号：真超时探针（行为，不是文本扫描）', () => {
  /**
   * 复刻 run() 的调用形状（win32 + shell + timeout），让子进程真的被掐断，
   * 再把捕获到的错误喂给**真实的** timeoutMarker。平台语义靠实测，不靠假设。
   */
  const captureRealTimeout = (): { err: unknown; stdout: string; timeoutMs: number } => {
    const file = path.join(tmpdir(), `cl-timeout-probe-${process.pid}-${Date.now()}.cjs`);
    writeFileSync(file, "console.log('EARLY_STDOUT_LINE');setTimeout(()=>console.log('LATE'),2000);\n", 'utf8');
    const timeoutMs = 700;
    try {
      execFileSync('node', [file], {
        encoding: 'utf8',
        timeout: timeoutMs,
        shell: process.platform === 'win32',
        stdio: 'pipe',
      });
      throw new Error('探针子进程竟然没被掐断 —— 平台语义变了，本判据的前提失效');
    } catch (e) {
      const err = e as { stdout?: string; code?: string; signal?: string; message?: string };
      if (err.message?.includes('探针子进程')) throw e;
      return { err, stdout: err.stdout ?? '', timeoutMs };
    } finally {
      rmSync(file, { force: true });
    }
  };

  it('真被掐断时 timeoutMarker 必须留下信号，且早期 stdout 不丢', () => {
    const { err, stdout, timeoutMs } = captureRealTimeout();
    const marker = timeoutMarker(err as { code?: string; signal?: string }, timeoutMs);
    expect(marker).toContain(`DISPATCH_TIMEOUT=${timeoutMs}ms`);
    expect(marker).toContain('kill=');
    expect(stdout).toContain('EARLY_STDOUT_LINE');
    expect(stdout).not.toContain('LATE');
  });

  it('端到端：掐断 + 无 run_report ⇒ infra / DISPATCH_TIMEOUT_NO_REPORT / 不计入 Agent', () => {
    const { err, stdout, timeoutMs } = captureRealTimeout();
    const output = stdout + timeoutMarker(err as { code?: string; signal?: string }, timeoutMs);
    const a = attributeFailure({ ...base, dispatch: { exitOk: false, output } });
    expect(a.layer).toBe('infra');
    expect(a.code).toBe('DISPATCH_TIMEOUT_NO_REPORT');
    expect(a.countsAgainstAgent).toBe(false);
    expect(a.owner).toBe('scheduler');
    expect(a.nextAction).toBe('retry_same');
    expect(a.note).toContain('AGENT_TASK_BUDGET_MS');
  });

  it('非超时错误一律不留痕（反向：不许把别的失败洗成超时）', () => {
    expect(timeoutMarker({ code: 'ENOENT' }, 700)).toBe('');
    expect(timeoutMarker({ code: 1, signal: null } as unknown as { code?: string }, 700)).toBe('');
    expect(timeoutMarker({}, 700)).toBe('');
    expect(timeoutMarker(null, 700)).toBe('');
    expect(timeoutMarker(undefined, 700)).toBe('');
  });
});

describe('金丝雀：不许把真正的能力失败一并洗白（反向）', () => {
  it('掐断了但尾部已打印（竞态）⇒ 仍归 budget / WALL_CLOCK_CEILING，不被 infra 抢走', () => {
    const output = `${buildDispatchTail(WALL_SSE)}\nDISPATCH_TIMEOUT=840000ms kill=SIGTERM\n`;
    const a = attributeFailure({ ...base, dispatch: { exitOk: false, output } });
    expect(a.layer).toBe('budget');
    expect(a.code).toBe('WALL_CLOCK_CEILING');
    expect(a.layer === 'infra').toBe(false);
    expect(a.countsAgainstAgent).toBe(false);
  });

  it('正常收工 + 判据红 + 没有掐断信号 ⇒ 仍是 implementation 且计入 Agent', () => {
    const a = attributeFailure({
      ...base,
      dispatch: {
        exitOk: true,
        output: 'event: done\ndata: {"finishReason":"stop","outcome":"completed","toolCallCount":9,"fileChangeCount":2}\n\n',
      },
    });
    expect(a.layer).toBe('implementation');
    expect(a.countsAgainstAgent).toBe(true);
  });

  it('只有掐断信号、服务本身不健康 ⇒ 仍走 L0 环境层，不被 L0a5 抢走', () => {
    const a = attributeFailure({
      ...base,
      serviceHealthy: false,
      dispatch: { exitOk: false, output: 'DISPATCH_TIMEOUT=840000ms kill=SIGTERM\n' },
    });
    expect(a.code).toBe('INFRA_UNHEALTHY');
  });

  it('上游 503 掐断 ⇒ 仍归上游错误，不许洗成调度器超时', () => {
    // 逐字取自 sse-code-search-3.txt：真实 stdout 里是 JSON 的 code 字段，不是散文。
    const a = attributeFailure({
      ...base,
      dispatch: {
        exitOk: false,
        output:
          'event: error\ndata: {"code":"UPSTREAM_ERROR","message":"上游服务返回错误 (HTTP 503): ' +
          'Service temporarily overloaded","retryable":false}\n\nDISPATCH_TIMEOUT=840000ms kill=SIGTERM\n',
      },
    });
    expect(a.code).toBe('UPSTREAM_ERROR');
    expect(a.layer).toBe('infra');
  });

  it('掐断信号本身不得被读成「上游不可达」（ETIMEDOUT 是同名不同因的陷阱）', () => {
    // execFileSync 的超时码与 undici 的连接超时码同名。标记里若照抄裸词 ETIMEDOUT，
    // 就会命中 upstreamSig 而被判 halt_manual —— 明明是我们自己掐的，却喊上游故障。
    for (const err of [{ code: 'ETIMEDOUT' }, { signal: 'SIGTERM' }, { code: 'ETIMEDOUT', signal: 'SIGTERM' }]) {
      const marker = timeoutMarker(err, 840000);
      expect(marker).not.toContain('ETIMEDOUT');
      const a = attributeFailure({ ...base, dispatch: { exitOk: false, output: marker } });
      expect(a.code, `标记 ${JSON.stringify(marker)} 被误判成 ${a.code}`).toBe('DISPATCH_TIMEOUT_NO_REPORT');
      expect(a.nextAction).not.toBe('halt_manual');
    }
  });
});

describe('接线：循环真的用了这两个函数，不是各修各的', () => {
  const src = read('scripts/self-upgrade-loop.ts');

  it('派单调用点的超时不是数字字面量，而是 dispatchTimeoutMs 算出来的', () => {
    const m = /const sent = run\('npx', args, ([^,]+), dispatchEnv\)/.exec(src);
    expect(m, '找不到派单调用点').toBeTruthy();
    const arg = (m as RegExpExecArray)[1].trim();
    expect(/^\d/.test(arg), `超时又写死成常数了：${arg}`).toBe(false);
    expect(src).toContain(`const ${arg} = dispatchTimeoutMs(process.env)`);
  });

  it('run() 的 catch 真的把 timeoutMarker 拼进输出', () => {
    const at = src.indexOf('function run(');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('function fenceArgs(', at));
    expect(body).toContain('timeoutMarker(err, timeoutMs)');
    expect(body).toContain('${out}${marker}');
  });

  it('归因消费者与生产者同源：识别串就是 timeoutMarker 写出的那一行', () => {
    const marker = timeoutMarker({ code: 'ETIMEDOUT' }, 840000);
    const attr = read('scripts/failure-attribution.ts');
    expect(attr).toContain('DISPATCH_TIMEOUT=(\\d+)ms');
    expect(new RegExp('DISPATCH_TIMEOUT=(\\d+)ms').exec(marker)?.[1]).toBe('840000');
  });
});
/**
 * 桥接派单的自证判据。
 *
 * 桥接把「会话」接成 Actor，绕过了服务侧的 path-jail，所以必须证明四件事：
 *   1. 导出的任务书真的带可落盘的绝对路径（不是给一句标题让人猜）；
 *   2. 回执里自报的写入**不作数**，落盘事实由脚本自己 stat 决定；
 *   3. 串轮的旧回执必须被拒（一次性 nonce）；
 *   4. 产出的等价 run_report 能被归因读懂，不会被误判成环境故障。
 *
 * 第 2、3 条是金丝雀：桥接最危险的失效不是跑不动，而是「什么都没做却说做完了」。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { attributeFailure, type AttributionInput } from '../scripts/failure-attribution.js';

const SERVER = process.cwd();
const BRIDGE = path.join(SERVER, '..', '.self-upgrade', 'loop', 'bridge');
const INBOX = path.join(BRIDGE, 'inbox');
const OUTBOX = path.join(BRIDGE, 'outbox');
const TASK = 'exec-partial-on-timeout';

interface Box {
  nonce: string;
  task: string;
  taskbook: string;
  writeHere: string[];
  replyTo: string;
}

mkdirSync(INBOX, { recursive: true });
mkdirSync(OUTBOX, { recursive: true });
const created: string[] = [];

interface RunResult {
  code: number | null;
  out: string;
}

/** 起一次桥接脚本；可选地在 inbox 出现后替「会话」写回执。 */
function runBridge(extra: string[], reply?: (box: Box) => Record<string, unknown>): Promise<RunResult> {
  const before = new Set(readdirSync(INBOX));
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'scripts/dispatch-bridge.ts', `--task=${TASK}`, ...extra], {
      cwd: SERVER,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let replied = false;
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    const poll = setInterval(() => {
      const fresh = readdirSync(INBOX).filter((f) => f.endsWith('.json') && !before.has(f));
      for (const f of fresh) {
        const boxFile = path.join(INBOX, f);
        created.push(boxFile);
        if (replied || !reply) continue;
        let box: Box;
        try {
          box = JSON.parse(readFileSync(boxFile, 'utf8')) as Box;
        } catch {
          continue;
        }
        const replyFile = path.join(OUTBOX, `${box.nonce}.json`);
        created.push(replyFile);
        writeFileSync(replyFile, JSON.stringify(reply(box)));
        replied = true;
      }
    }, 300);
    const guard = setTimeout(() => child.kill(), 90_000);
    child.on('exit', (code) => {
      clearInterval(poll);
      clearTimeout(guard);
      resolve({ code, out });
    });
  });
}

afterAll(() => {
  for (const f of created) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
  }
  // 兜底：不带 --wait 的那次脚本瞬间退出，轮询可能一次都没赶上，
  // 于是 created 里没有它的文件名。按本测试专用的 attempt 号（91-94）扫一遍，
  // 否则残留 inbox 会被 --status 显示成「待办」，误导下一个会话。
  for (const f of readdirSync(INBOX)) {
    if (/-(9[1-4])-[0-9a-f]{8}\.json$/.test(f)) rmSync(path.join(INBOX, f), { force: true });
  }
  rmSync(path.join(BRIDGE, 'bridge-test-sse.txt'), { force: true });
});

describe('桥接派单', () => {
  it('任务书必须带可落盘的绝对路径与回执地址', async () => {
    const r = await runBridge(['--attempt=91']);
    expect(r.out).toContain('BRIDGE_INBOX=');
    // 不带 --wait 时脚本瞬间退出，轮询未必赶得上；直接从输出里取 inbox 路径更可靠。
    const hit = /BRIDGE_INBOX=(.+)/.exec(r.out);
    expect(hit?.[1]).toBeTruthy();
    const boxFile = hit![1]!.trim();
    created.push(boxFile);
    const box = JSON.parse(readFileSync(boxFile, 'utf8')) as Box;
    expect(box.task).toBe(TASK);
    expect(box.taskbook.length).toBeGreaterThan(80);
    expect(box.writeHere.length).toBeGreaterThan(0);
    for (const f of box.writeHere) expect(path.isAbsolute(f)).toBe(true);
    expect(existsSync(box.replyTo)).toBe(false);
  });

  it('金丝雀：回执自报「改了 99 个文件」但磁盘没变，必须如实报 0 次写入', async () => {
    const r = await runBridge(['--attempt=92', '--wait'], (box) => ({
      nonce: box.nonce,
      note: '谎报',
      writes: Array.from({ length: 99 }, (_, i) => `/fake/${i}.ts`),
    }));
    expect(r.out).toContain('BRIDGE_WRITES=0');
    expect(r.out).toContain('"hasMaterialChange":false');
    expect(r.out).toContain('BRIDGE_ACTOR=workbuddy-session');
  });

  it('金丝雀：nonce 不匹配的旧回执必须被拒（不许串轮）', async () => {
    const r = await runBridge(['--attempt=93', '--wait'], () => ({
      nonce: 'from-another-round',
      note: '上一轮回执',
    }));
    expect(r.out).toContain('BRIDGE_ABORTED=nonce-mismatch');
    expect(r.code).not.toBe(0);
  });

  it('等价 run_report 能被归因解析，且不被误判成环境故障', async () => {
    const r = await runBridge(['--attempt=94', '--wait', '--sse-dump=../.self-upgrade/loop/bridge/bridge-test-sse.txt'], (box) => ({
      nonce: box.nonce,
      note: '自证',
    }));
    const dump = path.join(BRIDGE, 'bridge-test-sse.txt');
    created.push(dump);
    const out = readFileSync(dump, 'utf8');
    expect(out).toContain('event: run_report');
    expect(out).toMatch(/"toolCallCount":\d+/);

    const input: AttributionInput = {
      taskId: TASK,
      attempt: 1,
      maxAttempts: 3,
      dispatch: { exitOk: r.code === 0, output: r.out + '\n' + out },
      diagnosis: '判据未通过',
      fence: {
        reached: true,
        targetChanged: false,
        typeOk: true,
        judgeOk: false,
        fullOk: false,
        protectedIntact: true,
        judgeTampered: false,
      },
      serviceHealthy: true,
    };
    const a = attributeFailure(input);
    expect(a.layer).not.toBe('infra');
    expect(a.code).not.toBe('UPSTREAM_UNREACHABLE');
  });
});

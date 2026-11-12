/**
 * fs.write replace + 空 oldText —— 「拒绝，并且立刻拒绝」的判据。
 *
 * ── 缺陷形态 ──────────────────────────────────────────────
 * replace 分支用 `indexOf(needle, from)` 遍历全部命中，命中后 `from = hit + needle.length`。
 * 当 `needle === ''` 时 indexOf 永远返回 `from`，而 `from` 永远不前进 → **死循环**，
 * 进程挂到工具超时（120s）才死。schema 只把 path/operation 设为必填，oldText 可为空串，
 * 所以这不是理论风险，是一次真实调用就能触发的挂死。
 *
 * ── 这条判据锁什么 ────────────────────────────────────────
 *   1. 空 oldText 当场返回 invalid_args，**带超时兜底**：回归了就是失败，不是挂住；
 *   2. 拒绝时不改文件（先拒后写，不能写一半再报错）；
 *   3. 空 oldText + 空 newText 也立即被拒（此时先撞上「两者相同」守卫，同样不进入遍历）。
 *
 * 超时兜底是本条的关键：死循环型缺陷如果只用 `await handler(...)`，回归时
 * 整个测试进程会挂到 vitest 超时，报出来的是「测试超时」而不是「空串没被拒」——
 * 结论模糊到无法定位。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fsWriteTool } from '../../src/tools/builtin/fs-write.tool.js';

const ctx = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: process.cwd(),
  signal: new AbortController().signal,
  reportProgress: () => {},
};

let testDir: string;

/** 超过这个时间就判定「没有立刻拒绝」，按死循环处理。 */
const GUARD_MS = 3000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<'TIMEOUT'>((resolve) => {
    timer = setTimeout(() => resolve('TIMEOUT'), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

beforeAll(async () => {
  testDir = await mkdtemp(join(process.cwd(), 'fs-write-empty-oldtext-'));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('fs.write replace：空 oldText 必须当场拒绝', () => {
  it('oldText="" → invalid_args，且在超时哨兵前返回（不是死循环挂住）', async () => {
    const filePath = join(testDir, 'a.txt');
    await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf-8');
    const relPath = relative(process.cwd(), filePath);

    const result = await withTimeout(
      fsWriteTool.handler({ path: relPath, operation: 'replace', oldText: '', newText: 'X' }, ctx),
      GUARD_MS,
    );

    expect(result, `空 oldText 未在 ${GUARD_MS}ms 内返回：死循环回归`).not.toBe('TIMEOUT');
    const out = result as Exclude<typeof result, 'TIMEOUT'>;
    expect(out.ok).toBe(false);
    expect(out.error?.kind).toBe('invalid_args');
    expect(out.error?.code).toBe('TOOL_INVALID_ARGS');
    expect(out.error?.message).toContain('oldText 不能为空');
  });

  it('拒绝时文件内容一字未动（先拒后写）', async () => {
    const filePath = join(testDir, 'b.txt');
    const original = 'alpha\nbeta\ngamma\n';
    await writeFile(filePath, original, 'utf-8');
    const relPath = relative(process.cwd(), filePath);

    await withTimeout(
      fsWriteTool.handler({ path: relPath, operation: 'replace', oldText: '', newText: 'X' }, ctx),
      GUARD_MS,
    );
    expect(await readFile(filePath, 'utf-8')).toBe(original);
  });

  it('oldText 与 newText 都为空 → 立即被拒（先命中「相同」守卫，同样不进遍历）', async () => {
    const filePath = join(testDir, 'c.txt');
    await writeFile(filePath, 'alpha\n', 'utf-8');
    const relPath = relative(process.cwd(), filePath);

    const result = await withTimeout(
      fsWriteTool.handler({ path: relPath, operation: 'replace', oldText: '', newText: '' }, ctx),
      GUARD_MS,
    );

    expect(result, `空 oldText/newText 未在 ${GUARD_MS}ms 内返回：死循环回归`).not.toBe('TIMEOUT');
    const out = result as Exclude<typeof result, 'TIMEOUT'>;
    expect(out.ok).toBe(false);
    expect(out.error?.kind).toBe('invalid_args');
    // 两条守卫都在遍历之前，谁先命中都算合格；这里只锁「拒了，且没进循环」。
    expect(['TOOL_INVALID_ARGS']).toContain(out.error?.code);
  });
});

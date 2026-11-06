// 沙箱可写探针的单测 —— 覆盖三件事：
//   1. 判定口径本身：可写目录 / 非目录路径 / 空路径；
//   2. TTL 缓存语义：窗口内复用上次结论，过期或显式重置后重新探测；
//   3. 缓存不得把「不可写」也缓存成「可写」这类反向错误。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PROBE_TTL_MS,
  probeSandboxWritable,
  resetSandboxProbeCache,
} from '../src/utils/sandbox-probe.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'codelens-probe-'));
  resetSandboxProbeCache();
});

afterEach(() => {
  resetSandboxProbeCache();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // 清理是 best-effort：残留目录由环境侧回收。
  }
});

describe('probeSandboxWritable', () => {
  it('可写目录 → true', () => {
    expect(probeSandboxWritable(root)).toBe(true);
  });

  it('路径指向文件而非目录 → false', () => {
    const file = path.join(root, 'not-a-dir.txt');
    writeFileSync(file, 'x', 'utf8');
    expect(probeSandboxWritable(file)).toBe(false);
  });

  it('空路径 → false（不探测、不入缓存）', () => {
    expect(probeSandboxWritable('')).toBe(false);
  });

  it('TTL 窗口内复用上次结论，不重复探测', () => {
    expect(probeSandboxWritable(root)).toBe(true);
    // 把目录换成一个文件：真实探测此时应得 false。
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, 'x', 'utf8');
    // 仍在 TTL 内 → 命中缓存 → 仍返回上次的 true。
    expect(probeSandboxWritable(root, 60_000)).toBe(true);
    // ttlMs = 0 → 强制重探 → 得到新结论 false。
    expect(probeSandboxWritable(root, 0)).toBe(false);
  });

  it('resetSandboxProbeCache 让下一次调用重新探测', () => {
    expect(probeSandboxWritable(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, 'x', 'utf8');
    expect(probeSandboxWritable(root, 60_000)).toBe(true);

    resetSandboxProbeCache();
    expect(probeSandboxWritable(root, 60_000)).toBe(false);
  });

  it('不可写的结论也会被缓存（不得把 false 悄悄变成 true）', () => {
    const file = path.join(root, 'file.txt');
    writeFileSync(file, 'x', 'utf8');
    expect(probeSandboxWritable(file)).toBe(false);
    // 换个可写目录，同一个 root 键不该复用上一个的结论。
    expect(probeSandboxWritable(root)).toBe(true);
  });

  it('默认 TTL 是一个有界窗口（不是 0，也不是无限）', () => {
    expect(PROBE_TTL_MS).toBeGreaterThan(0);
    expect(PROBE_TTL_MS).toBeLessThanOrEqual(60_000);
  });
});

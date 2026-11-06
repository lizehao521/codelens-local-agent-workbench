// path-jail 单测（AC-07）—— 绝对路径 / 穿越 / 保留设备名 / realpath 符号链接逃逸 / 写路径最近祖先

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveInSandbox, resolveInSandboxAsync, type JailFs, type JailVerdict } from '../src/tools/builtin/path-jail.js';

let sandbox: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'codelens-jail-'));
  sandbox = path.join(base, 'sandbox');
  outside = path.join(base, 'outside');
  mkdirSync(sandbox, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(sandbox, 'inside.txt'), 'ok');
  writeFileSync(path.join(outside, 'secret.txt'), 'no');
  // 沙箱内指向外部的符号链接（逃逸尝试）
  symlinkSync(outside, path.join(sandbox, 'escape'), 'junction');
});

afterAll(() => {
  // 沙箱守卫会给递归 rmSync 加数秒延迟（实测小树 ~4s，曾击穿 10s 钩子超时），
  // 故：先删 junction 缩小递归规模 + 60s 超时 + 清理失败不影响用例结论。
  try {
    const escape = path.join(sandbox, 'escape');
    if (existsSync(escape)) rmSync(escape); // junction：只删链接本身，不进目标目录
    rmSync(path.dirname(sandbox), { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响测试结果
  }
}, 60_000);

describe('path-jail', () => {
  it('接受沙箱内相对路径', () => {
    const verdict = resolveInSandbox(sandbox, 'inside.txt');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.absolutePath).toBe(path.join(sandbox, 'inside.txt'));
      expect(verdict.sandboxRelative).toBe('inside.txt');
    }
  });

  it('接受带子目录的相对路径', () => {
    const verdict = resolveInSandbox(sandbox, 'a/b/c.txt', true);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      // Regression: forWrite must PRESERVE intermediate new directories.
      // The old implementation re-attached only the basename to the nearest
      // existing ancestor, silently relocating `a/b/c.txt` to `<root>/c.txt`.
      expect(verdict.absolutePath).toBe(path.join(sandbox, 'a', 'b', 'c.txt'));
      expect(verdict.sandboxRelative).toBe(path.join('a', 'b', 'c.txt'));
    }
  });

  it('写路径保留多层新目录（最近祖先回退时不丢中间段）', () => {
    const verdict = resolveInSandbox(sandbox, 'deep/nested/new/leaf.bin', true);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.absolutePath).toBe(path.join(sandbox, 'deep', 'nested', 'new', 'leaf.bin'));
    }
  });

  it('写路径在已存在目录下仍正确解析', () => {
    mkdirSync(path.join(sandbox, 'exists'), { recursive: true });
    const verdict = resolveInSandbox(sandbox, 'exists/f.txt', true);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.absolutePath).toBe(path.join(sandbox, 'exists', 'f.txt'));
    }
  });

  it('拒绝绝对路径（Windows 盘符 / UNC / POSIX 根）', () => {
    expect(resolveInSandbox(sandbox, 'C:\\Windows\\x').ok).toBe(false);
    expect(resolveInSandbox(sandbox, '\\\\server\\share').ok).toBe(false);
    expect(resolveInSandbox(sandbox, '/etc/passwd').ok).toBe(false);
  });

  it('拒绝 .. 穿越段（两种分隔符）', () => {
    expect(resolveInSandbox(sandbox, '../outside/secret.txt').ok).toBe(false);
    expect(resolveInSandbox(sandbox, '..\\outside\\secret.txt').ok).toBe(false);
    expect(resolveInSandbox(sandbox, 'a/../../b').ok).toBe(false);
    const verdict = resolveInSandbox(sandbox, '../x');
    expect(verdict.ok === false && verdict.code).toBe('PATH_TRAVERSAL');
  });

  it('拒绝 Windows 保留设备名与尾空格点', () => {
    for (const name of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'con.txt']) {
      expect(resolveInSandbox(sandbox, name).ok).toBe(false);
    }
    expect(resolveInSandbox(sandbox, 'inside.txt ').ok).toBe(false);
  });

  it('符号链接逃逸在 realpath 步骤被拒', () => {
    const verdict = resolveInSandbox(sandbox, 'escape/secret.txt');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('PATH_OUTSIDE_SANDBOX');
  });

  it('空路径被拒', () => {
    expect(resolveInSandbox(sandbox, '').ok).toBe(false);
    expect(resolveInSandbox(sandbox, '   ').ok).toBe(false);
  });
});

describe('path-jail async（AUDIT-036）', () => {
  it('异步解析与同步结果一致（含写路径/绝对/穿越/符号链接逃逸）', async () => {
    const cases: Array<[string, boolean]> = [
      ['inside.txt', false],
      ['a/b/c.txt', true],
      ['deep/nested/new/leaf.bin', true],
      ['/etc/passwd', false],
      ['../outside/secret.txt', false],
      ['escape/secret.txt', false],
    ];
    // Windows 上 realpathSync 常返回 8.3 短名（如 ADMINI~1），异步 realpath 返回长名——
    // 二者指向同一文件，只比较 jail 语义核心（ok/code/sandboxRelative），不比较 absolutePath 字面值。
    const norm = (v: JailVerdict) => (v.ok
      ? { ok: true as const, sandboxRelative: v.sandboxRelative }
      : { ok: false as const, code: v.code, message: v.message });
    for (const [rel, forWrite] of cases) {
      const sync = resolveInSandbox(sandbox, rel, forWrite);
      const asyncV = await resolveInSandboxAsync(sandbox, rel, forWrite);
      expect(norm(asyncV), rel).toEqual(norm(sync));
      if (asyncV.ok) {
        // absolutePath 必须以解析后的 sandboxRelative 结尾（确认仍落在沙箱内同一目标）。
        expect(asyncV.absolutePath.endsWith(asyncV.sandboxRelative)).toBe(true);
      }
    }
  });

  it('破坏夹具：异步解析确实走注入的异步 fs（realpath/exists 被调用）', async () => {
    const realpathSpy = vi.fn(async (p: string) => p);
    const existsSpy = vi.fn(async () => true);
    const stub: JailFs = { realpath: realpathSpy, exists: existsSpy };
    const verdict = await resolveInSandboxAsync('root', 'inside.txt', false, stub);
    expect(verdict.ok).toBe(true);
    expect(realpathSpy).toHaveBeenCalled();
    expect(existsSpy).toHaveBeenCalled();
  });
});

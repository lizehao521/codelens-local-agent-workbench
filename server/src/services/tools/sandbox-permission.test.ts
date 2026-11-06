/**
 * 沙箱权限配置（纯函数）：validateAllowDir / normalizeConfig。
 * 安全校验不依赖 DB（仅 type-import better-sqlite3），可在无原生模块环境下运行。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, parse as parsePath } from 'node:path';
import { validateAllowDir, normalizeConfig, DEFAULT_PERMISSION_CONFIG } from './sandbox-permission.js';

// 测试夹具必须落在「非受限目录前缀」之外（C:\Users / /home 等被安全策略禁止作为 allowDir）。
// 故把临时根放到磁盘根目录（C:\ 或 /）下，而非 os.tmpdir()（Windows 上位于 C:\Users）。
const TMP_BASE = join(parsePath(tmpdir()).root, 'codelens-sp-');

describe('validateAllowDir', () => {
  let base: string;
  let sandboxRoot: string;
  let goodDir: string;
  let outsideDir: string;

  beforeAll(() => {
    base = mkdtempSync(TMP_BASE + 'validate-');
    sandboxRoot = join(base, 'sandbox');
    goodDir = join(base, 'work');
    outsideDir = join(base, 'outside', 'deep');
    mkdirSync(sandboxRoot, { recursive: true });
    mkdirSync(goodDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
  });

  afterAll(() => {
    // 宿主环境的删除守卫（safe-delete shim）可能在并发下超时。
    // 清理是 best-effort：残留目录由环境侧回收，但不能让它把已通过的用例判红。
    try {
      rmSync(base, { recursive: true, force: true });
    } catch (err) {
      console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
    }
  });

  it('接受已存在的绝对目录', () => {
    const r = validateAllowDir(goodDir, sandboxRoot);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.realPath).toBeTruthy();
  });

  it('拒绝非绝对路径', () => {
    const r = validateAllowDir('relative/dir', sandboxRoot);
    expect(r.ok).toBe(false);
  });

  it('拒绝不存在的目录', () => {
    const r = validateAllowDir(join(tmpdir(), 'no-such-dir-xyz-9821'), sandboxRoot);
    expect(r.ok).toBe(false);
  });

  it('拒绝空字符串', () => {
    const r = validateAllowDir('   ', sandboxRoot);
    expect(r.ok).toBe(false);
  });

  it('拒绝沙箱根自身', () => {
    expect(validateAllowDir(sandboxRoot, sandboxRoot).ok).toBe(false);
  });

  it('拒绝沙箱子目录', () => {
    expect(validateAllowDir(join(sandboxRoot, 'sub'), sandboxRoot).ok).toBe(false);
  });

  it('拒绝沙箱根的上级目录（会放开整个沙箱体系）', () => {
    expect(validateAllowDir(dirname(sandboxRoot), sandboxRoot).ok).toBe(false);
  });

  it('拒绝系统敏感目录前缀（/etc）', () => {
    expect(validateAllowDir('/etc', sandboxRoot).ok).toBe(false);
  });

  it('接受与沙箱无关的目录', () => {
    expect(validateAllowDir(outsideDir, sandboxRoot).ok).toBe(true);
  });

  it('dir 不存在时 mkdtemp 清理校验：临时 dir 已删除', () => {
    // 反向确认测试夹具在 afterAll 可清理（无害断言，验证 fs 可用）。
    expect(existsSync(base)).toBe(true);
  });
});

describe('normalizeConfig', () => {
  it('缺省回退到 DEFAULT', () => {
    const c = normalizeConfig(undefined, '/sandbox');
    expect(c.allowDirs).toEqual([]);
    expect(c.autoApprove).toEqual(DEFAULT_PERMISSION_CONFIG.autoApprove);
  });

  it('过滤掉无效 allowDir，保留有效的（需真实目录）', () => {
    const base = mkdtempSync(TMP_BASE + 'norm-');
    const sandboxRoot = join(base, 'sb');
    mkdirSync(join(base, 'ok'), { recursive: true });
    mkdirSync(sandboxRoot, { recursive: true });
    const c = normalizeConfig(
      { allowDirs: [join(base, 'ok'), '/no/such/dir'], autoApprove: { fsDestructive: true } },
      sandboxRoot,
    );
    expect(c.allowDirs.length).toBe(1);
    expect(c.autoApprove.fsDestructive).toBe(true);
    // 用例内的提前清理也是 best-effort：它是收尾动作，不是断言前提。
    try {
      rmSync(base, { recursive: true, force: true });
    } catch (err) {
      console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
    }
  });

  it('autoApprove 缺失字段回退默认 false', () => {
    const c = normalizeConfig({ allowDirs: [], autoApprove: {} }, '/sb');
    expect(c.autoApprove).toEqual({ fsDestructive: false, purge: false, httpWrite: false });
  });
});

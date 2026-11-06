/**
 * 沙箱三类攻击面 + 敏感路径运行时拦截（真实文件系统）。
 *
 * 1. `..` 穿越：词法层直接拒绝，永不进入授权流程；
 * 2. symlink 逃逸：软链接指到授权目录之外 → realpath 后拒绝；
 * 3. 跨盘符越界写：C 盘授权目录 ≠ D 盘可写；`path.relative` 返回绝对路径即拒绝；
 * 4. 敏感路径：即使父目录已加入白名单，`.ssh` / `*.pem` 仍被 gateway 拒绝。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInSandbox } from '../src/tools/builtin/path-jail.js';
import { runGateway } from '../src/services/tools/security-gateway.js';
import { isSensitivePath } from '../src/services/tools/sensitive-path.js';
import type { ToolDefinition } from '../src/types/tool.js';

let base: string;
let workspace: string;
let granted: string;

function fileDef(): ToolDefinition {
  return {
    name: 'fs.write',
    wireName: 'fs_write',
    displayName: '写文件',
    category: 'file',
    description: '',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        operation: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: true,
    },
    handler: async () => ({ ok: true, summary: 'x' }),
    timeoutMs: 1000,
    risk: 'medium',
    approvalMode: 'soft',
    enabled: () => true,
    source: 'builtin',
    idempotent: false,
    maxResultChars: 0,
  } as ToolDefinition;
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'codelens-attack-'));
  workspace = path.join(base, 'ws');
  granted = path.join(base, 'granted');
  await mkdir(workspace, { recursive: true });
  await mkdir(granted, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('沙箱攻击面', () => {
  it('`..` 穿越被词法层拒绝（PATH_TRAVERSAL）', () => {
    const v = resolveInSandbox(workspace, '..\\secret.txt', false);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('PATH_TRAVERSAL');
  });

  it('symlink 指到授权目录之外 → realpath 后拒绝逃逸', async () => {
    const secretDir = path.join(base, 'secret');
    await mkdir(secretDir, { recursive: true });
    await writeFile(path.join(secretDir, 'token'), 'x', 'utf8');
    const link = path.join(granted, 'link.txt');
    await symlink(path.join(secretDir, 'token'), link);

    // 授权的是 granted；link 的真实目标在 secret 之外 → 必须拒绝。
    const v = resolveInSandbox(workspace, link, false, [granted]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('PATH_OUTSIDE_SANDBOX');
  });

  it('跨盘符越界写：C 盘授权目录不能成为 D 盘写入跳板', () => {
    // 不依赖 D 盘真实存在：path-jail 用 path.relative 做最终判定，
    // 跨盘时 relative 返回绝对路径，必然被判越界。
    const v = resolveInSandbox('C:\\ws', 'D:\\evil.txt', true, ['C:\\granted']);
    if (process.platform === 'win32') {
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe('PATH_OUTSIDE_SANDBOX');
    }
  });

  it('敏感路径识别：.ssh / *.pem / 浏览器配置', () => {
    expect(isSensitivePath('C:\\Users\\a\\.ssh\\id_rsa')).toBe(true);
    expect(isSensitivePath('C:\\Users\\a\\server.pem')).toBe(true);
    expect(isSensitivePath('C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\User Data\\Default')).toBe(true);
    expect(isSensitivePath('C:\\ws\\src\\main.ts')).toBe(false);
    expect(isSensitivePath('C:\\ws\\.env.local')).toBe(true);
  });

  it('gateway：白名单目录里的 .ssh 仍被拒绝（授权 ≠ 交出秘密）', async () => {
    const ssh = path.join(granted, '.ssh');
    await mkdir(ssh, { recursive: true });
    await writeFile(path.join(ssh, 'id_rsa'), 'x', 'utf8');
    const gate = runGateway(fileDef(), { path: path.join(ssh, 'id_rsa'), operation: 'read' }, {
      sandboxRoot: workspace,
      allowedDirs: [granted],
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe('SECURITY_DENIED');
      expect(gate.message).toContain('敏感路径');
    }
  });
});

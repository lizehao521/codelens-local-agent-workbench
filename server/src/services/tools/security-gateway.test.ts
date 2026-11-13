/**
 * security-gateway 集成：沙箱权限（allowDirs + 豁免）的端到端行为。
 * - 豁免只降级 approvalMode，绝不绕过 jail/SSRF 硬拒绝；
 * - allowedDirs 在白名单内放开绝对路径，白名单外仍拒。
 * 不依赖 better-sqlite3（gateway 仅 type-import sandbox-permission）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGateway } from './security-gateway.js';
import type { ToolDefinition } from '../../types/tool.js';

// 临时根必须落在受限目录前缀之外（见 sandbox-permission.test.ts 注释）。
const TMP_BASE = join(tmpdir(), 'codelens-sp-');

function fsWriteDef(): ToolDefinition {
  return {
    name: 'fs.write',
    wireName: 'fs.write',
    displayName: '写文件',
    description: '',
    category: 'file',
    source: 'builtin',
    risk: 'medium',
    approvalMode: 'soft',
    idempotent: false,
    timeoutMs: 5000,
    enabled: () => true,
    maxResultChars: 3000,
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, operation: { type: 'string' } }, required: ['path', 'operation'] },
    handler: async () => ({ ok: true, summary: 'ok' }),
  };
}

function fsReadDef(): ToolDefinition {
  return {
    name: 'fs.read',
    wireName: 'fs.read',
    displayName: '读文件',
    description: '',
    category: 'file',
    source: 'builtin',
    risk: 'low',
    approvalMode: 'none',
    idempotent: true,
    timeoutMs: 5000,
    enabled: () => true,
    maxResultChars: 3000,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async () => ({ ok: true, summary: 'ok' }),
  };
}

function httpDef(): ToolDefinition {
  return {
    name: 'http.request',
    wireName: 'http.request',
    displayName: 'HTTP 请求',
    description: '',
    category: 'http',
    source: 'builtin',
    risk: 'low',
    approvalMode: 'none',
    idempotent: false,
    timeoutMs: 5000,
    enabled: () => true,
    maxResultChars: 3000,
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string' } }, required: ['url'] },
    handler: async () => ({ ok: true, summary: 'ok' }),
  };
}

describe('security-gateway 沙箱权限', () => {
  let base: string;
  let sandboxRoot: string;
  let allowDir: string;
  let allowFile: string;

  beforeAll(() => {
    base = mkdtempSync(TMP_BASE + 'gw-');
    sandboxRoot = join(base, 'sandbox');
    allowDir = join(base, 'work');
    mkdirSync(sandboxRoot, { recursive: true });
    mkdirSync(allowDir, { recursive: true });
    allowFile = join(allowDir, 'doc.txt');
    writeFileSync(allowFile, 'hello');
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


  // ── 豁免：降级 approvalMode ──────────────────────────────────────────────
  it('fs.write delete：fsDestructive 豁免时 approvalMode=none', () => {
    const g = runGateway(fsWriteDef(), { path: 'a.txt', operation: 'delete' }, {
      sandboxRoot,
      exemptions: { fsDestructive: true, purge: true, httpWrite: true },
    });
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.verdict.approvalMode).toBe('none');
  });

  it('fs.write delete：未豁免时 approvalMode=hard', () => {
    const g = runGateway(fsWriteDef(), { path: 'a.txt', operation: 'delete' }, { sandboxRoot });
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.verdict.approvalMode).toBe('hard');
  });

  it('fs.write purge：purge 豁免时 approvalMode=none；未豁免时 two_step', () => {
    const gExempt = runGateway(fsWriteDef(), { path: 'd', operation: 'purge' }, {
      sandboxRoot,
      exemptions: { fsDestructive: true, purge: true, httpWrite: true },
    });
    expect(gExempt.ok && gExempt.verdict.approvalMode).toBe('none');
    const gNo = runGateway(fsWriteDef(), { path: 'd', operation: 'purge' }, { sandboxRoot });
    expect(gNo.ok && gNo.verdict.approvalMode).toBe('two_step');
  });

  it('http.request POST：httpWrite 豁免时 approvalMode=none；未豁免时 hard', () => {
    const gExempt = runGateway(httpDef(), { url: 'https://example.com/api', method: 'POST' }, {
      sandboxRoot,
      exemptions: { fsDestructive: true, purge: true, httpWrite: true },
    });
    expect(gExempt.ok && gExempt.verdict.approvalMode).toBe('none');
    const gNo = runGateway(httpDef(), { url: 'https://example.com/api', method: 'POST' }, { sandboxRoot });
    expect(gNo.ok && gNo.verdict.approvalMode).toBe('hard');
  });

  // ── 豁免不能绕过硬拒绝（jail / SSRF） ─────────────────────────────────────
  it('豁免不绕过越界：沙箱外绝对路径仍 SECURITY_DENIED', () => {
    const g = runGateway(fsReadDef(), { path: '/etc/passwd' }, {
      sandboxRoot,
      exemptions: { fsDestructive: true, purge: true, httpWrite: true },
    });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe('SECURITY_DENIED');
  });

  it('SSRF 危险 URL 在豁免下仍被语法层拒绝（DISALLOWED/NON_HTTPS 等）', () => {
    // 169.254.169.254 为云元数据；语法层对 http 默认拒绝 NON_HTTPS，对 https 不解析 IP，
    // 但此处用 http 即可同时验证「豁免不生效」——仍被语法层拦下。
    const g = runGateway(httpDef(), { url: 'http://169.254.169.254/latest', method: 'GET' }, {
      sandboxRoot,
      exemptions: { fsDestructive: true, purge: true, httpWrite: true },
    });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe('SECURITY_DENIED');
  });

  // ── allowedDirs：白名单内放开，白名单外仍拒 ──────────────────────────────
  it('allowedDirs 内绝对路径可读（fs.read）', () => {
    const g = runGateway(fsReadDef(), { path: allowFile }, { sandboxRoot, allowedDirs: [allowDir] });
    expect(g.ok).toBe(true);
  });

  it('无 allowedDirs 时绝对路径被拒（PATH_ABSOLUTE）', () => {
    const g = runGateway(fsReadDef(), { path: allowFile }, { sandboxRoot });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe('SECURITY_DENIED');
  });

  it('allowedDirs 外的绝对路径仍被拒（不泄漏白名单范围）', () => {
    const g = runGateway(fsReadDef(), { path: '/etc/hostname' }, { sandboxRoot, allowedDirs: [allowDir] });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.code).toBe('SECURITY_DENIED');
  });
});

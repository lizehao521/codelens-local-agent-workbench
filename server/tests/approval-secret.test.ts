import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveApprovalSecret } from '../src/utils/approval-secret.js';
import {
  issueApprovalToken,
  setApprovalSecret,
  verifyApprovalToken,
} from '../src/utils/hmac.js';

describe('resolveApprovalSecret（C-04 持久化）', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'codelens-secret-'));
  });

  afterEach(() => {
    // 宿主环境的删除守卫（safe-delete shim）可能在并发下超时。
    // 清理是 best-effort：残留目录由环境侧回收，但不能让它把已通过的用例判红。
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
    }
  });

  it('显式 env 优先，且不落盘', () => {
    const r = resolveApprovalSecret('env-secret-abcdefghijklmnopqrstuvwxyz', dir);
    expect(r.source).toBe('env');
    expect(r.value).toBe('env-secret-abcdefghijklmnopqrstuvwxyz');
    expect(r.created).toBe(false);
    expect(existsSync(path.join(dir, 'approval-secret.key'))).toBe(false);
  });

  it('无 env 时生成并持久化，二次解析读回同一值（重启不换密钥）', () => {
    const first = resolveApprovalSecret('', dir);
    expect(first.source).toBe('generated');
    expect(first.created).toBe(true);
    expect(first.value).toHaveLength(64);
    const file = path.join(dir, 'approval-secret.key');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8').trim()).toBe(first.value);

    const second = resolveApprovalSecret('', dir);
    expect(second.source).toBe('file');
    expect(second.created).toBe(false);
    expect(second.value).toBe(first.value);
  });

  it('文件存在但过短/损坏时重建', () => {
    const file = path.join(dir, 'approval-secret.key');
    writeFileSync(file, 'short', { mode: 0o600 });
    const r = resolveApprovalSecret('', dir);
    expect(r.source).toBe('generated');
    expect(r.value).toHaveLength(64);
  });
});

describe('setApprovalSecret（hmac 消费运行时注入的密钥）', () => {
  afterEach(() => setApprovalSecret(''));

  it('注入后签发的令牌用注入密钥验签成功', () => {
    setApprovalSecret('runtime-injected-secret-value');
    const issued = issueApprovalToken({
      sessionId: 's1',
      toolCallId: 'c1',
      toolName: 'fs.write',
      argsDigestValue: 'digest',
      expiresAt: 0,
    });
    const verified = verifyApprovalToken(issued.token, {
      sessionId: 's1',
      toolCallId: 'c1',
      toolName: 'fs.write',
      argsDigestValue: 'digest',
    });
    expect(verified.ok).toBe(true);
  });

  it('清除注入后回退 env 路径（既有单测兼容）', () => {
    setApprovalSecret('');
    const original = process.env.AGENT_APPROVAL_SECRET;
    process.env.AGENT_APPROVAL_SECRET = 'env-only-secret-value';
    try {
      const issued = issueApprovalToken({
        sessionId: 's2',
        toolCallId: 'c2',
        toolName: 'fs.read',
        argsDigestValue: 'd2',
        expiresAt: 0,
      });
      const verified = verifyApprovalToken(issued.token, {
        sessionId: 's2',
        toolCallId: 'c2',
        toolName: 'fs.read',
        argsDigestValue: 'd2',
      });
      expect(verified.ok).toBe(true);
    } finally {
      if (original === undefined) delete process.env.AGENT_APPROVAL_SECRET;
      else process.env.AGENT_APPROVAL_SECRET = original;
    }
  });
});
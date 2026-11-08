/**
 * tests/tools-uuid-policy.test.ts
 *
 * 覆盖两块纯逻辑：
 *   1) uuid.generate 工具（uuid_generate）的输出格式与参数校验
 *   2) sys.exec 的静态白名单策略 evaluateExecCommand（只做判定，**不执行任何命令**）
 *
 * 注意：本文件不 spawn 任何进程，只调用纯函数 / handler。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { uuidGenerateTool } from '../src/tools/builtin/uuid-generate.tool.js';
import { evaluateExecCommand } from '../src/tools/builtin/sys-exec.policy.js';

/** uuid v4 的规范形态：版本位 4，变体位 8/9/a/b。 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 测试用白名单：只放行 git / node。 */
const ALLOWLIST = ['git', 'node'] as const;

// ---------------------------------------------------------------- uuid.generate

test('uuid_generate: 工具元信息符合约定', () => {
  assert.equal(uuidGenerateTool.name, 'uuid.generate');
  assert.equal(uuidGenerateTool.wireName, 'uuid_generate');
  assert.equal(uuidGenerateTool.source, 'builtin');
  assert.equal(uuidGenerateTool.risk, 'low');
  assert.equal(uuidGenerateTool.approvalMode, 'none');
});

test('uuid_generate: 缺省 count 生成 1 个合法 uuid v4', async () => {
  const res = await uuidGenerateTool.handler({});
  assert.equal(res.ok, true);
  assert.equal(res.data?.count, 1);
  const uuids = res.data?.uuids as string[];
  assert.equal(uuids.length, 1);
  assert.match(uuids[0], UUID_V4_RE);
  // 版本位与变体位单独再断言一次，避免正则写错时静默通过
  assert.equal(uuids[0][14], '4');
  assert.ok('89ab'.includes(uuids[0][19].toLowerCase()));
});

test('uuid_generate: count=5 生成 5 个互不相同的 uuid', async () => {
  const res = await uuidGenerateTool.handler({ count: 5 });
  assert.equal(res.ok, true);
  const uuids = res.data?.uuids as string[];
  assert.equal(uuids.length, 5);
  assert.equal(res.data?.count, 5);
  for (const u of uuids) assert.match(u, UUID_V4_RE);
  assert.equal(new Set(uuids).size, 5, 'uuid 不应重复');
});

test('uuid_generate: 边界值 1 与 100 均可用', async () => {
  const one = await uuidGenerateTool.handler({ count: 1 });
  assert.equal(one.ok, true);
  assert.equal((one.data?.uuids as string[]).length, 1);

  const hundred = await uuidGenerateTool.handler({ count: 100 });
  assert.equal(hundred.ok, true);
  assert.equal((hundred.data?.uuids as string[]).length, 100);
});

test('uuid_generate: 非法 count 返回 TOOL_INVALID_ARGS', async () => {
  for (const bad of [0, 101, -1, 1.5, Number.NaN]) {
    const res = await uuidGenerateTool.handler({ count: bad });
    assert.equal(res.ok, false, `count=${bad} 应被拒绝`);
    assert.equal(res.error?.code, 'TOOL_INVALID_ARGS');
    assert.equal(res.error?.kind, 'invalid_args');
  }
});

// ------------------------------------------------------------- sys.exec 白名单

test('sys_exec 白名单: 允许 git', () => {
  const verdict = evaluateExecCommand('git', ['status'], ALLOWLIST);
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.command, 'git');
    assert.equal(verdict.allowlistedAs, 'git');
  }
});

test('sys_exec 白名单: 允许 node', () => {
  const verdict = evaluateExecCommand('node', ['--version'], ALLOWLIST);
  assert.equal(verdict.ok, true);
  if (verdict.ok) assert.equal(verdict.allowlistedAs, 'node');
});

test('sys_exec 白名单: 大小写不敏感（GIT / Node）', () => {
  assert.equal(evaluateExecCommand('GIT', ['status'], ALLOWLIST).ok, true);
  assert.equal(evaluateExecCommand('Node', ['--version'], ALLOWLIST).ok, true);
});

test('sys_exec 白名单: 拒绝 rm -rf（不在白名单内）', () => {
  const verdict = evaluateExecCommand('rm', ['-rf', '/'], ALLOWLIST);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.code, 'SECURITY_DENIED');
    assert.match(verdict.message, /rm/);
  }
});

test('sys_exec 白名单: 空白名单 = 全拒（含 git）', () => {
  const verdict = evaluateExecCommand('git', ['status'], []);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.code, 'SECURITY_DENIED');
});

test('sys_exec 白名单: 解释器类命令即使被写进白名单也拒绝', () => {
  for (const cmd of ['bash', 'sh', 'sudo', 'curl']) {
    const verdict = evaluateExecCommand(cmd, ['-c', 'echo hi'], [cmd]);
    assert.equal(verdict.ok, false, `${cmd} 应被拒绝`);
    if (!verdict.ok) assert.equal(verdict.code, 'SECURITY_DENIED');
  }
});

test('sys_exec 白名单: 路径形态的 command 返回 INVALID_ARGS', () => {
  for (const bad of ['./git', '/usr/bin/git', 'C:\\tmp\\git.exe', '..\\git', '~/git']) {
    const verdict = evaluateExecCommand(bad, [], ALLOWLIST);
    assert.equal(verdict.ok, false, `${bad} 应被拒绝`);
    if (!verdict.ok) assert.equal(verdict.code, 'INVALID_ARGS');
  }
});

test('sys_exec 白名单: 空 command / 超长 command 返回 INVALID_ARGS', () => {
  const empty = evaluateExecCommand('   ', [], ALLOWLIST);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, 'INVALID_ARGS');

  const tooLong = evaluateExecCommand('g'.repeat(65), [], ALLOWLIST);
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.code, 'INVALID_ARGS');
});

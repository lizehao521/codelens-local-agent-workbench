'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildIcalcsArgs } = require('../lib/win-acl.cjs');

// 正常例（绿）：安全契约的全部要素都在。
test('win-acl: 命令结构 = 文件 + 移除继承 + 替换式授权当前用户', () => {
  const args = buildIcalcsArgs('C:\\data\\approval-secret.key', 'Alice');
  assert.strictEqual(args[0], 'C:\\data\\approval-secret.key');
  assert.deepStrictEqual(args.slice(1), ['/inheritance:r', '/grant:r', 'Alice:F']);
});

// 破坏夹具（红）：改为追加式 /grant 必须打红。
test('win-acl: 破坏夹具——追加式 /grant 会被拒绝', () => {
  const args = buildIcalcsArgs('C:\\data\\approval-secret.key', 'Alice');
  assert.ok(args.includes('/grant:r'), '必须为替换式 /grant:r（追加式会保留既有越权主体）');
  assert.ok(!args.includes('/grant'), '禁止无 :r 的追加式 /grant');
});

// 破坏夹具（红）：去掉继承移除必须打红。
test('win-acl: 破坏夹具——必须移除继承 ACE', () => {
  const args = buildIcalcsArgs('C:\\data\\approval-secret.key', 'Alice');
  assert.ok(args.includes('/inheritance:r'), '必须 /inheritance:r，否则目录级 Users 权限残留');
});

// 破坏夹具（红）：授给任意用户组必须打红。
test('win-acl: 破坏夹具——不得授给 Users/Everyone 等用户组', () => {
  const args = buildIcalcsArgs('C:\\data\\approval-secret.key', 'Alice');
  assert.ok(
    args.slice(1).every((a) => !/Users|Everyone|SYSTEM/i.test(a)),
    '禁止授给 BUILTIN\\Users / Everyone / SYSTEM',
  );
  assert.ok(args.includes('Alice:F'), '只授当前用户整权');
});

// 破坏夹具（红）：空参数必须抛错，防止静默跳过硬化。
test('win-acl: 破坏夹具——空文件路径或用户名必须抛错', () => {
  assert.throws(() => buildIcalcsArgs('', 'Alice'));
  assert.throws(() => buildIcalcsArgs('   ', 'Alice'));
  assert.throws(() => buildIcalcsArgs('C:\\f', ''));
  assert.throws(() => buildIcalcsArgs('C:\\f', '   '));
});
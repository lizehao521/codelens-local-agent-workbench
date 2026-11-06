'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateLegacyUserData, LEGACY_DIRNAME } = require('../lib/user-data-migration.cjs');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-migration-'));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

// 正常例（绿）：旧目录有库/密钥/配置/沙箱，全部搬进新目录。
test('user-data-migration: 旧 userData 数据完整搬迁到新目录', () => {
  const root = tmpRoot();
  const legacy = path.join(root, LEGACY_DIRNAME);
  const target = path.join(root, 'CodeLens');

  write(path.join(legacy, 'codelens.db'), 'db-bytes');
  write(path.join(legacy, 'codelens.db-wal'), 'wal-bytes');
  write(path.join(legacy, 'approval-secret.key'), 'secret');
  write(path.join(legacy, 'config', 'mcp-servers.json'), '{"servers":[]}');
  write(path.join(legacy, 'sandbox', 'run', 'out.txt'), 'artifact');

  const result = migrateLegacyUserData({ targetDir: target, legacyDir: legacy });

  assert.equal(result.migrated, true);
  assert.equal(result.reason, 'complete');
  assert.equal(result.copied, 5);
  assert.equal(fs.readFileSync(path.join(target, 'codelens.db'), 'utf8'), 'db-bytes');
  assert.equal(fs.readFileSync(path.join(target, 'codelens.db-wal'), 'utf8'), 'wal-bytes');
  assert.equal(fs.readFileSync(path.join(target, 'approval-secret.key'), 'utf8'), 'secret');
  assert.equal(fs.readFileSync(path.join(target, 'config', 'mcp-servers.json'), 'utf8'), '{"servers":[]}');
  assert.equal(fs.readFileSync(path.join(target, 'sandbox', 'run', 'out.txt'), 'utf8'), 'artifact');
  // 旧目录保留原样，可人工回滚
  assert.equal(fs.existsSync(path.join(legacy, 'codelens.db')), true);
});

// 破坏夹具（红）：新目录已有数据库时不得搬迁、不得覆盖。
test('user-data-migration: 破坏夹具——新目录已有数据必须原样保留', () => {
  const root = tmpRoot();
  const legacy = path.join(root, LEGACY_DIRNAME);
  const target = path.join(root, 'CodeLens');
  write(path.join(legacy, 'codelens.db'), 'old-db');
  write(path.join(legacy, 'approval-secret.key'), 'old-secret');
  write(path.join(target, 'codelens.db'), 'new-db');

  const result = migrateLegacyUserData({ targetDir: target, legacyDir: legacy });

  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'target-has-data');
  assert.equal(result.copied, 0);
  assert.equal(fs.readFileSync(path.join(target, 'codelens.db'), 'utf8'), 'new-db');
  assert.equal(fs.existsSync(path.join(target, 'approval-secret.key')), false);
});

// 破坏夹具（红）：旧目录无数据库时不得创建任何目标文件（防误把空目录当真）。
test('user-data-migration: 破坏夹具——旧目录无数据时不做任何写入', () => {
  const root = tmpRoot();
  const legacy = path.join(root, LEGACY_DIRNAME);
  const target = path.join(root, 'CodeLens');
  fs.mkdirSync(legacy, { recursive: true });
  write(path.join(legacy, 'approval-secret.key'), 'orphan-secret');

  const result = migrateLegacyUserData({ targetDir: target, legacyDir: legacy });

  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'no-legacy-data');
  assert.equal(fs.existsSync(target), false);
});

// 破坏夹具（红）：同一路径必须直接返回，不得自我复制。
test('user-data-migration: 破坏夹具——源与目标同路径必须 no-op', () => {
  const root = tmpRoot();
  const same = path.join(root, 'CodeLens');
  write(path.join(same, 'codelens.db'), 'db');
  const before = fs.readdirSync(same).sort();

  const result = migrateLegacyUserData({ targetDir: same, legacyDir: same });

  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'same-dir');
  assert.deepEqual(fs.readdirSync(same).sort(), before);
});

// 破坏夹具（红）：已存在的目标文件不能被旧文件覆盖。
test('user-data-migration: 破坏夹具——不覆盖目标目录已存在的同名文件', () => {
  const root = tmpRoot();
  const legacy = path.join(root, LEGACY_DIRNAME);
  const target = path.join(root, 'CodeLens');
  write(path.join(legacy, 'codelens.db'), 'old-db');
  write(path.join(legacy, 'config', 'mcp-servers.json'), '{"servers":["legacy"]}');
  write(path.join(target, 'config', 'mcp-servers.json'), '{"servers":["new"]}');

  const result = migrateLegacyUserData({ targetDir: target, legacyDir: legacy });

  assert.equal(result.migrated, true);
  assert.equal(
    fs.readFileSync(path.join(target, 'config', 'mcp-servers.json'), 'utf8'),
    '{"servers":["new"]}',
  );
});

// 参数校验：缺参数必须抛错（fail-closed，不猜路径）。
test('user-data-migration: 破坏夹具——缺参数必须抛错', () => {
  assert.throws(() => migrateLegacyUserData(), TypeError);
  assert.throws(() => migrateLegacyUserData({ targetDir: 'C:\\x' }), TypeError);
  assert.throws(() => migrateLegacyUserData({ legacyDir: 'C:\\x' }), TypeError);
});

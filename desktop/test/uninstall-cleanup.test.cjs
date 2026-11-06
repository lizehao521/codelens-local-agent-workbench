'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAppDataDir } = require('../scripts/uninstall-cleanup.cjs');

// 正常例（绿）：目标 = %APPDATA%/CodeLens。
test('uninstall-cleanup: 目标目录 = %APPDATA%\\CodeLens', () => {
  assert.strictEqual(
    resolveAppDataDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }),
    'C:\\Users\\u\\AppData\\Roaming\\CodeLens',
  );
});

// 破坏夹具（红）：APPDATA 缺失/空必须抛错（fail-closed，拒绝推断）。
test('uninstall-cleanup: 破坏夹具——APPDATA 缺失或空必须抛错', () => {
  assert.throws(() => resolveAppDataDir({}));
  assert.throws(() => resolveAppDataDir({ APPDATA: '' }));
  assert.throws(() => resolveAppDataDir({ APPDATA: '   ' }));
  assert.throws(() => resolveAppDataDir(null));
});
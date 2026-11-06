'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isSafeExternalUrl } = require('../lib/external-url.cjs');

// 正常例（绿）：http/https 放行。
test('external-url: http/https 放行', () => {
  assert.strictEqual(isSafeExternalUrl('http://example.com'), true);
  assert.strictEqual(isSafeExternalUrl('https://example.com/path?q=1#frag'), true);
});

// 破坏夹具（红）：自定义协议 codelens: 必须拒绝。
test('external-url: 破坏夹具——codelens: 拒绝', () => {
  assert.strictEqual(isSafeExternalUrl('codelens:open'), false);
});

// 破坏夹具（红）：本地文件协议必须拒绝（可触发本地文件执行）。
test('external-url: 破坏夹具——file: 拒绝', () => {
  assert.strictEqual(isSafeExternalUrl('file:///C:/Windows/system.ini'), false);
});

// 破坏夹具（红）：局域网共享协议必须拒绝。
test('external-url: 破坏夹具——smb: 拒绝', () => {
  assert.strictEqual(isSafeExternalUrl('smb://host/share'), false);
});

// 破坏夹具（红）：脚本类/数据类协议必须拒绝。
test('external-url: 破坏夹具——javascript:/vbscript:/data: 拒绝', () => {
  assert.strictEqual(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.strictEqual(isSafeExternalUrl('vbscript:msgbox(1)'), false);
  assert.strictEqual(isSafeExternalUrl('data:text/html,<script>1</script>'), false);
});

// 破坏夹具（红）：空值/非字符串/畸形 URL 必须拒绝（fail-closed）。
test('external-url: 破坏夹具——空值、非字符串、畸形 URL 拒绝', () => {
  assert.strictEqual(isSafeExternalUrl(''), false);
  assert.strictEqual(isSafeExternalUrl('   '), false);
  assert.strictEqual(isSafeExternalUrl(null), false);
  assert.strictEqual(isSafeExternalUrl(undefined), false);
  assert.strictEqual(isSafeExternalUrl('not a url'), false);
  assert.strictEqual(isSafeExternalUrl('//evil.com'), false);
});
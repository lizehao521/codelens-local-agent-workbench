'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildErrorPageHtml, escapeHtml } = require('../lib/error-page.cjs');

// 正常例（绿）：标题/详情/日志路径都出现在错误页里。
test('error-page: 包含标题、详情与日志路径', () => {
  const html = buildErrorPageHtml({
    title: 'CodeLens 加载失败',
    detail: 'ERR_CONNECTION_REFUSED',
    logPath: 'C:\\logs\\server.log',
  });
  assert.ok(html.includes('CodeLens 加载失败'));
  assert.ok(html.includes('ERR_CONNECTION_REFUSED'));
  assert.ok(html.includes('server.log'));
});

// 破坏夹具（红）：脚本注入必须被转义，不能原样出现在 HTML 中。
test('error-page: 破坏夹具——HTML 注入被转义', () => {
  const html = buildErrorPageHtml({ detail: '<script>alert(1)</script>' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

// 破坏夹具（红）：属性引号注入必须被转义。
test('error-page: 破坏夹具——引号与特殊字符转义', () => {
  assert.strictEqual(escapeHtml('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  assert.strictEqual(escapeHtml("it's"), 'it&#39;s');
  assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
});

// 破坏夹具（红）：缺省参数也不能产出含未定义字符串的页面。
test('error-page: 破坏夹具——缺省参数不产 undefined', () => {
  const html = buildErrorPageHtml();
  assert.ok(!html.includes('undefined'));
  assert.ok(html.includes('CodeLens 启动失败'));
});
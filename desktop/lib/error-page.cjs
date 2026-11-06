'use strict';

/**
 * D-08 桌面错误页 HTML（纯函数，便于对偶测试 + 静态闸）。
 *
 * 失败时需要展示错误详情与日志路径，同时必须 HTML 转义注入值——错误描述可能来自
 * Electron 的 err.message 或 did-fail-load 的 errorDescription，未经转义直接塞进
 * HTML 会被当成标记执行/注入。
 */

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildErrorPageHtml({ title = 'CodeLens 启动失败', detail = '', logPath = '' } = {}) {
  const safeTitle = escapeHtml(title);
  const safeDetail = escapeHtml(detail);
  const safeLog = escapeHtml(logPath);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>${safeTitle}</title>
<style>
  body { margin: 0; padding: 40px 24px; min-height: 100vh; box-sizing: border-box;
         background: #0E1526; color: #9FB3D1;
         font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
  .card { max-width: 620px; margin: 0 auto; border: 1px solid #2A3650;
          border-radius: 10px; background: #141E33; padding: 28px; }
  h1 { margin: 0 0 8px; font-size: 18px; color: #E6EDF8; }
  p { margin: 8px 0; font-size: 13px; line-height: 1.6; word-break: break-all; }
  code { font-family: "JetBrains Mono", Consolas, monospace; font-size: 12px;
         color: #7ED3A5; background: #0B1322; padding: 2px 6px; border-radius: 4px; }
  .muted { color: #6C7B98; font-size: 12px; }
  button { margin-top: 18px; padding: 8px 16px; border: 1px solid #197FE6; border-radius: 6px;
           background: #197FE6; color: #fff; cursor: pointer; }
</style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    ${safeDetail ? `<p>${safeDetail}</p>` : ''}
    ${safeLog ? `<p class="muted">日志：<code>${safeLog}</code></p>` : ''}
    <p><button onclick="location.reload()">重新加载</button></p>
  </div>
</body>
</html>`;
}

module.exports = { buildErrorPageHtml, escapeHtml };
#!/usr/bin/env node
/**
 * CodeLens 发布分发服务（本地静态文件服务器）
 * ----------------------------------------------------------------------------
 * 把 C:/codelens-build/release 通过 HTTP 暴露出来，方便把安装包下发到其他电脑。
 * 其他电脑在浏览器打开下载链接即可安装，无需 U 盘 / 网盘中转。
 *
 * 用法： node serve-release.mjs
 * 可选环境变量：
 *   RELEASE_DIR  目标目录（默认 C:/codelens-build/release）
 *   HOST         监听地址（默认 0.0.0.0，允许局域网其他机器访问）
 *   PORT         监听端口（默认 8088）
 *
 * 注意：若其他电脑无法访问，请确认本机防火墙放行该端口（如
 *       New-NetFirewallRule -DisplayName CodeLensRelease -Direction Inbound `
 *       -Protocol TCP -LocalPort 8088 -Action Allow）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(process.env.RELEASE_DIR || 'C:/codelens-build/release');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '8088', 10);

const MIME = {
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
  '.json': 'application/json',
  '.yml': 'text/yaml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/__list__';

  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(ROOT, safe);

  // 防目录穿越
  if (!full.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  if (urlPath === '/__list__') {
    listDir(res);
    return;
  }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${path.basename(full)}"`,
    });
    fs.createReadStream(full).pipe(res);
  });
});

function listDir(res) {
  let items = [];
  try {
    items = fs.readdirSync(ROOT).map((f) => {
      const st = fs.statSync(path.join(ROOT, f));
      return { f, dir: st.isDirectory(), size: st.size };
    });
  } catch (e) {
    res.writeHead(500);
    res.end('read dir error: ' + e.message);
    return;
  }
  const rows = items
    .map((x) => {
      const size = x.dir ? '—' : `${(x.size / 1024 / 1024).toFixed(1)} MB`;
      return `<tr><td>${x.dir ? '📁' : '📦'}</td><td><a href="/${encodeURIComponent(x.f)}">${x.f}</a></td><td>${size}</td></tr>`;
    })
    .join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>CodeLens Release</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem}table{border-collapse:collapse}td{padding:.35rem .9rem;border-bottom:1px solid #eee}a{color:#2563eb;text-decoration:none}</style>
<h2>CodeLens 发布目录</h2>
<table><thead><tr><td></td><td>文件</td><td>大小</td></tr></thead><tbody>${rows}</tbody></table>
<p style="color:#888">安装包右键/点击另存为，或复制下载链接到其他电脑浏览器打开。</p>`);
}

server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log(`✓ CodeLens 发布服务已启动`);
  console.log(`  本机访问:   http://localhost:${PORT}/`);
  for (const ip of ips) {
    console.log(`  其他电脑:   http://${ip}:${PORT}/`);
    console.log(`  安装包直链: http://${ip}:${PORT}/CodeLens-Setup-2.0.0.exe`);
  }
  console.log(`  (Ctrl+C 停止)`);
});

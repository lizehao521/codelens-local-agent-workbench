// 本地 mock：模拟「上游模型源」返回符合 ModelSourceSchema 的 JSON，
// 用于演示 CodeLens 的「自动获取模型 / Upstream Model Sync」功能。
//
// 运行：node scripts/mock-model-source.mjs        （默认端口 7788）
// 可选：PORT=9000 node scripts/mock-model-source.mjs
//
// 然后把应用的 MODEL_SOURCE_URL 指向 http://127.0.0.1:7788/catalog.json
// （本地地址需同时设 MODEL_SOURCE_ALLOW_INSECURE=true，见下方说明）。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAYLOAD_PATH = path.resolve(__dirname, '../config/modelsource-payload.example.json');
const PORT = Number(process.env.PORT) || 7788;

let payload;
try {
  payload = await readFile(PAYLOAD_PATH, 'utf8');
  JSON.parse(payload); // 启动即校验，确保示例本身合规
} catch (err) {
  console.error('无法读取/解析上游示例 JSON：', err.message);
  process.exit(1);
}

const server = createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/catalog.json' || url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(payload);
    return;
  }
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock upstream model source 已启动：`);
  console.log(`  GET http://127.0.0.1:${PORT}/catalog.json`);
  console.log(`将应用的 MODEL_SOURCE_URL 指向上面的地址即可演示自动获取模型。`);
});

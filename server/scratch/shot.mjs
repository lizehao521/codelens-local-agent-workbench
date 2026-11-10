/**
 * 通过已存在的 CDP 浏览器截图（无需 playwright / 本地 chrome）。
 * 用法: node scratch/shot.mjs <url> <out.png> [width] [height]
 */
const [, , url, out, w = '1440', h = '2400'] = process.argv;
const width = Number(w);
const height = Number(h);

const version = await (await fetch('http://127.0.0.1:8088/v1/cdp/json/version')).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const events = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method) {
    events.push(msg);
  }
});

await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

function send(method, params = {}, sessionId) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
await send('Page.navigate', { url }, sessionId);

// 等 load + 2s，让前端把 API 数据画出来
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  if (events.some((e) => e.sessionId === sessionId && e.method === 'Page.loadEventFired')) break;
  await new Promise((r) => setTimeout(r, 200));
}
await new Promise((r) => setTimeout(r, 2500));

const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(data, 'base64'));
await send('Target.closeTarget', { targetId });
ws.close();
console.log('saved', out, Buffer.from(data, 'base64').length, 'bytes');

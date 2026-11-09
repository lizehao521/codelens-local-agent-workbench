/**
 * 把本地自包含 HTML 用 data: URL 渲染成 PNG（绕开预览浏览器的私网出站限制）。
 * 用法: node scratch/shot-html.mjs <html> <out.png> [width] [height]
 */
const [, , htmlPath, out, w = '1440', h = '2400'] = process.argv;
const width = Number(w);
const height = Number(h);
const { readFileSync, writeFileSync } = await import('node:fs');

const html = readFileSync(htmlPath, 'utf8');
const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);

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
  } else if (msg.method) events.push(msg);
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
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, sessionId);
await send('Page.navigate', { url }, sessionId);
await new Promise((r) => setTimeout(r, 1200));

// 按内容真实高度裁切，避免大片空白
const metrics = await send('Page.getLayoutMetrics', {}, sessionId);
const contentH = Math.min(Math.ceil(metrics.cssContentSize?.height ?? height), 6000);
await send('Emulation.setDeviceMetricsOverride', { width, height: contentH, deviceScaleFactor: 2, mobile: false }, sessionId);
await new Promise((r) => setTimeout(r, 300));

const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
writeFileSync(out, Buffer.from(data, 'base64'));
await send('Target.closeTarget', { targetId });
ws.close();
console.log('saved', out, Buffer.from(data, 'base64').length, 'bytes', `${width}x${contentH}`);

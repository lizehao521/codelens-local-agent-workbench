/**
 * rsi-async-trigger.ts — 轻量异步触发 RSI 自升级循环，秒级返回。
 *
 * 背景：seed-agent-loop.ts / self-upgrade-loop.ts 是重脚本（含上游限流重试），
 * 直接放进 rsi.exec 的 60s 硬超时窗口会被掐断；连续失败 4 次还会触发工具熔断。
 * 本脚本只做一件事：POST /api/v1/rsi/scheduler/trigger-async，拿到受理回执即退出。
 * 真正的循环由服务端 scheduler 在后台跑，结果经 GET status 与 scheduler_runs 观测。
 *
 * 用法（rsi.exec, cwd=server）：
 *   node --import tsx scripts/rsi-async-trigger.ts [reason]
 * 退出码：0=受理成功或已在进行中；1=服务不可达/路由缺失。
 */

import http from 'node:http';

const BASE = process.env.RSI_SERVER_URL ?? 'http://127.0.0.1:8080';
const REASON = process.argv[2] || 'agent-async-trigger';
const url = new URL(BASE);

function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) });
          } catch {
            reject(new Error(`非 JSON 响应：${raw.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(8_000, () => req.destroy(new Error('请求超时 8s')));
    req.write(payload);
    req.end();
  });
}

try {
  const res = await post('/api/v1/rsi/scheduler/trigger-async', { reason: REASON });
  const j = res.json as Record<string, unknown>;
  if (j?.accepted === true) {
    console.log(`RSI 循环已受理并在后台运行：runId=${j.runId} reason=${j.reason}`);
    console.log(`观测：curl -sS ${BASE}/api/v1/rsi/scheduler/status | 看 lastRun / running`);
    process.exit(0);
  }
  if (j?.accepted === false) {
    console.log(`RSI 循环已在运行，本轮未重复启动：runId=${j.runId}`);
    process.exit(0); // 不是错误：幂等保护生效，别让 agent 重试到熔断
  }
  console.error(`未知响应：HTTP ${res.status} ${JSON.stringify(j).slice(0, 300)}`);
  process.exit(1);
} catch (e) {
  console.error(`触发失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

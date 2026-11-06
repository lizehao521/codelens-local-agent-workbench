// 演示「自动获取模型」全链路：把本地 mock (scripts/mock-model-source.mjs) 当作上游，
// 验证 fetch → zod 校验 → 合并进 registry → 暴露到 /providers 与 /sync-status。
//
// 注意：生产环境的 SSRF 防护会拒绝 127.0.0.1 / 私有网段。本演示通过注入 validateUrl
// 跳过该检查（与集成测试同一手法），仅用于本地验证「自动获取」逻辑本身。
// 真实部署请指向公网（非私有网段）的上游 URL。

// 必须在导入 runtime/app（其内部会解析 config）之前设置好环境变量。
process.env.NODE_ENV = 'test';
process.env.MODEL_SOURCE_URL = 'http://127.0.0.1:7788/catalog.json';

// 仅演示用：跳过 SSRF 的 IP/协议校验，直接允许连接到 mock。
const okValidate = async () => ({
  ok: true,
  url: new URL('http://127.0.0.1:7788/catalog.json'),
  hostname: '127.0.0.1',
  addresses: ['127.0.0.1'],
});

const { createRuntime } = await import('../server/dist/runtime.js');
const { createApp } = await import('../server/dist/app.js');

const runtime = createRuntime({
  dbPath: ':memory:',
  fetchImpl: globalThis.fetch,
  validateUrl: okValidate,
});
const app = createApp({ runtime });

await runtime.modelSync.fetchOnce();

const server = app.listen(8111, '127.0.0.1', () => {
  console.log('demo app listening on http://127.0.0.1:8111');
});

// 1.5s 后自动核验并退出（也可手动 curl 上述地址）
setTimeout(async () => {
  const status = runtime.modelSync.status();
  const { listProviders } = await import('../server/dist/providers/registry.js');
  const merged = listProviders();
  const demo = merged.find((p) => p.id === 'demo-models');

  console.log('\n== 自动核验 ==');
  console.log('sync-status:', JSON.stringify(status, null, 2));
  console.log('merged provider count:', merged.length);
  console.log('demo-models present:', !!demo);
  if (demo) {
    console.log('demo models:', demo.models.map((m) => m.id).join(', '));
  }

  server.close();
  await runtime.close();
  process.exit(demo ? 0 : 1);
}, 1500);

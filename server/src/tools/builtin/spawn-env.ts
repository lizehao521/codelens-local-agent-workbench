/**
 * 子进程的干净环境（test.run / type.check 共用）。
 *
 * ── 为什么要共用而不是各写一份 ─────────────────────────────
 * 这是一张**安全白名单**：只放行运行所需的系统变量，`*_API_KEY` / `*_TOKEN` /
 * 代理配置一律不继承。复制两份的代价不是啰嗦，而是它们会漂——
 * 一边补了 `HTTP_PROXY` 的封堵，另一边忘了，于是某个工具悄悄把密钥/代理传给了被检查的代码。
 * 安全相关的清单只有一个来源。
 */

const ALLOWED_ENV_KEYS = new Set([
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'ComSpec', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'OS',
]);

export function buildCleanEnv(nodeEnv: 'test' | 'development' = 'test'): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: nodeEnv };
  for (const key of ALLOWED_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  return env;
}

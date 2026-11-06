/**
 * 监听地址的安全默认（C1 强化 Act 的「可被滥用面」这一维；C3 判据可打红）。
 *
 * 为什么这是判据而不只是配置：服务带 `sys.exec`（命令执行）、`fs.write`
 * 与恢复码端点。绑 `0.0.0.0` 等于把审批面暴露给局域网。默认必须是仅本机，
 * 暴露是显式选择而不是启动副作用。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envSchema } from '../src/config/env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

describe('HOST 默认值：仅本机', () => {
  it('未设置 HOST 时默认 127.0.0.1（不得静默暴露到 0.0.0.0）', () => {
    const parsed = envSchema.parse({});
    expect(parsed.HOST).toBe('127.0.0.1');
  });

  it('显式设置后按设置值走（本地用以外的场景不被锁死）', () => {
    expect(envSchema.parse({ HOST: '0.0.0.0' }).HOST).toBe('0.0.0.0');
    expect(envSchema.parse({ HOST: '192.168.1.5' }).HOST).toBe('192.168.1.5');
  });

  it('app.listen 必须真的把 host 传进去（否则默认值是摆设）', () => {
    const appSrc = readFileSync(path.join(root, 'server/src/app.ts'), 'utf8');
    expect(appSrc, 'app.listen 未传 config.host，默认值不会生效').toMatch(
      /app\.listen\(config\.port,\s*config\.host,/,
    );
  });

  it('容器内必须显式放开（Dockerfile 里设 HOST=0.0.0.0，否则端口映射失效）', () => {
    const docker = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(docker, 'Dockerfile 未设 HOST=0.0.0.0，容器内端口映射将拿不到连接').toMatch(
      /^ENV HOST=0\.0\.0\.0$/m,
    );
  });

  it('README 环境变量表必须写明 HOST（CI 的 assert-env-docs 会据此对账）', () => {
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    const section = (readme.split('## 环境变量')[1] ?? '').split('\n## ')[0] ?? '';
    expect(section, 'README 环境变量表缺 HOST 行').toMatch(/\|\s*`HOST`\s*\|/);
  });
});

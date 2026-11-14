import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 浏览器级 e2e。
 *
 * 服务端用构建产物启动在独立端口；测试不依赖上游 Key（只验证输入/插件 UI）。
 * 本机若没有通过 `playwright install` 安装浏览器，可用
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定 Chrome/Chromium 可执行文件。
 */
const localChrome = path.join(
  process.env.USERPROFILE ?? '',
  'AppData/Local/ms-playwright/chromium-1255/chrome-win64/chrome.exe',
);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (existsSync(localChrome) ? localChrome : undefined);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8124',
    headless: true,
    viewport: { width: 1440, height: 900 },
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: 'node dist/app.js',
    cwd: path.resolve(HERE, '../server'),
    url: 'http://127.0.0.1:8124/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: '8124',
      LLM_SERVER_API_KEY: '',
      NODE_ENV: 'test',
    },
  },
});

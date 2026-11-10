import { defineConfig } from 'vitest/config';
import { loadEnv, type Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

type Next = () => void;

const RELAY_DEFAULT_BASE_URL = 'http://1.92.92.200:8787/v1';
const RELAY_DEFAULT_MODEL = '平衡';

/**
 * 本地模型中转配置（仅 dev / preview 进程内提供，绝不进入前端 bundle）。
 * 密钥只从 .env.local 读取（RELAY_API_KEY，无 VITE_ 前缀），通过运行时接口交给 SPA，
 * 因此不会被构建产物打包。静态部署下这两个接口 404，前端回退到内置模型快照 + 手动填写。
 */
function relayLocalPlugin(env: Record<string, string>): Plugin {
  const baseUrl = (env.RELAY_BASE_URL || RELAY_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiKey = (env.RELAY_API_KEY || '').trim();
  const model = (env.RELAY_MODEL || RELAY_DEFAULT_MODEL).trim();

  const handler = async (req: IncomingMessage, res: ServerResponse, next: Next): Promise<void> => {
    const path = (req.url || '').split('?')[0];
    if (path !== '/local-relay-config.json' && path !== '/local-relay-models.json') {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    // 配置接口会返回密钥：只允许本机访问，防止 --host 暴露到局域网时泄露。
    const remote = req.socket?.remoteAddress;
    const loopback =
      !remote ||
      remote === '127.0.0.1' ||
      remote === '::1' ||
      remote === '::ffff:127.0.0.1';
    if (!loopback) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: '本地中转配置仅允许本机访问' }));
      return;
    }

    if (path === '/local-relay-config.json') {
      res.statusCode = 200;
      res.end(JSON.stringify({ baseUrl, model, hasApiKey: Boolean(apiKey), apiKey }));
      return;
    }

    if (!apiKey) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: '未在 client/.env.local 配置 RELAY_API_KEY' }));
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const upstream = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      const text = await upstream.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: `中转服务返回格式异常（非 JSON，HTTP ${upstream.status}）` }));
        return;
      }
      const list = (parsed as { data?: unknown }).data;
      if (!upstream.ok) {
        const message = (parsed as { error?: { message?: string } }).error?.message;
        res.statusCode = 502;
        res.end(
          JSON.stringify({
            error: `中转服务返回 HTTP ${upstream.status}${message ? `：${message}` : ''}`,
          }),
        );
        return;
      }
      if (!Array.isArray(list)) {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: '中转服务返回格式异常：缺少 data[] 模型列表' }));
        return;
      }
      const models = list
        .map((item) => (item as { id?: unknown }).id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      res.statusCode = 200;
      res.end(JSON.stringify({ models }));
    } catch (err) {
      res.statusCode = 504;
      res.end(
        JSON.stringify({
          error: controller.signal.aborted
            ? '中转服务请求超时（10s）'
            : `无法连接中转服务：${err instanceof Error ? err.message : '未知网络错误'}`,
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    name: 'codelens-relay-local-config',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

// CodeLens 前端 SPA 构建配置
// - server.proxy: 开发态将 /api 代理到本地 Express 服务（同源部署，消除 CORS）
// - relayLocalPlugin: dev/preview 下按需读取 .env.local 的模型中转配置（密钥不进 bundle）
// - test: vitest + jsdom（storage / result-parser 单测依赖 localStorage）
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss(), relayLocalPlugin(env)],
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:8080',
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      // 实测基线（test-report-perf-security.md §1）：首页 JS 单文件 711KB，p95 1111ms。
      // 根因是 react-markdown / CodeMirror / 字体等重依赖与业务代码挤在同一 chunk，
      // 既无法长缓存、又阻塞首屏解析。改为按供应商切分，浏览器并行下载 + 跨版本长缓存。
      reportCompressedSize: true,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks(id: string): string | undefined {
            if (!id.includes('node_modules')) return undefined;
            // 编辑器栈（CodeMirror 6）
            if (
              id.includes('@codemirror') ||
              id.includes('codemirror') ||
              id.includes('@uiw') ||
              id.includes('@lezer') ||
              id.includes('@marijn')
            ) {
              return 'editor-vendor';
            }
            // Markdown 渲染栈（unified / mdast / hast / micromark 生态）
            if (
              id.includes('react-markdown') ||
              id.includes('rehype-highlight') ||
              id.includes('remark-gfm') ||
              id.includes('hast') ||
              id.includes('mdast') ||
              id.includes('micromark') ||
              id.includes('unist') ||
              id.includes('hastscript') ||
              id.includes('property-information') ||
              id.includes('vfile') ||
              id.includes('bail') ||
              id.includes('trough') ||
              id.includes('decode-named-character-reference') ||
              id.includes('character-entities') ||
              id.includes('github-slugger') ||
              id.includes('hast-util') ||
              id.includes('mdast-util') ||
              id.includes('micromark') ||
              id.includes('unified') ||
              id.includes('ccount') ||
              id.includes('escape-string-regexp')
            ) {
              return 'markdown-vendor';
            }
            // 字体（@fontsource 体积大且几乎不变）
            if (id.includes('@fontsource')) return 'font-vendor';
            // React 运行时（react / react-dom / scheduler / zustand 状态库）
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/scheduler/') ||
              id.includes('/zustand/') ||
              id.includes('react-router')
            ) {
              return 'react-vendor';
            }
            return 'vendor';
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      include: ['tests/**/*.test.ts'],
      // jsdom 环境创建很贵（本机 6 次创建耗时 176s，占整轮 59%）。
      // 默认的 forks 池按文件 spawn worker，每个 worker 都要重建 jsdom，
      // 机器负载高时会偶发「Timeout waiting for worker to respond」——
      // 报错指向"文件没跑起来"而非测试失败，易被误判为代码问题。
      // 改用 vmThreads 池：每个 worker 仅创建一次 jsdom 环境并复用于其下所有文件
      // （仍保持 per-file 隔离），既消除 worker 启动超时，又大幅缩短环境创建开销。
      pool: 'vmThreads',
      maxWorkers: 2,
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
});

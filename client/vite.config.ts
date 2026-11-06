import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// CodeLens 前端 SPA 构建配置
// - server.proxy: 开发态将 /api 代理到本地 Express 服务（同源部署，消除 CORS）
// - test: vitest + jsdom（storage / result-parser 单测依赖 localStorage）
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
});

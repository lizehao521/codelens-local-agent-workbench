/**
 * Application entry: middleware assembly, routes, static hosting, error handling,
 * listen. Assembly only — all wiring lives in runtime.ts.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express, { type Express, type Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { config } from './config/env.js';
import { createApiRouter } from './routes/index.js';
import { requestLogger } from './middlewares/request-log.js';
import { errorHandler, payloadTooLargeHandler, JSON_BODY_LIMIT } from './middlewares/error-handler.js';
import { notFoundHandler } from './middlewares/not-found.js';
import { agentConcurrency } from './middlewares/agent-concurrency.js';
import { rateLimit } from './middlewares/rate-limit.js';
import { createRuntime, type Runtime } from './runtime.js';
import { AppError, ErrorCode } from './utils/errors.js';

export interface AppOptions {
  runtime?: Runtime;
  /** Static client build directory override (tests inject a temp dir). */
  clientDistDir?: string;
  /**
   * 是否在 createApp 装配完成后自动启动上游模型同步（先 fetchOnce 一次，再 start 周期调度）。
   * 默认取 config.nodeEnv !== 'test'：桌面嵌入态/生产自动启动，测试态不自动拉取。
   * 桌面嵌入态（desktop/main.cjs 仅调用 createApp）依赖该默认值，否则 MODEL_SOURCE_* 不生效。
   */
  autoStartModelSync?: boolean;
}

const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  // RSI 看板用 CDN ECharts / Tailwind / Lucide —— 开发态看板，放行知名 CDN
  'script-src': ["'self'", 'cdn.jsdelivr.net', 'cdn.tailwindcss.com', 'unpkg.com'],
  'style-src': ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'fonts.googleapis.com'],
  'img-src': ["'self'", 'data:', 'cdn.jsdelivr.net'],
  'connect-src': ["'self'", 'cdn.jsdelivr.net'],
  'font-src': ["'self'", 'data:', 'fonts.gstatic.com'],
};

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  const runtime = options.runtime ?? createRuntime();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet({ contentSecurityPolicy: { directives: CSP_DIRECTIVES } }));

  if (config.allowedOrigins.length > 0) {
    app.use(cors({ origin: config.allowedOrigins, credentials: false }));
  }

  app.use(compression());
  // P2-11: 256kb (was 64kb) so the spec-legal 32000-char message survives
  // body parsing and reaches zod — a 21k-CJK-char message encodes past 64kb.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(payloadTooLargeHandler);
  app.use(requestLogger);

  // Concurrency guard applies to the SSE stream only (per-IP, default 3).
  app.use('/api/v1/agent/stream', agentConcurrency);

  // Rate limiting (P1-5): the limiter shipped fully implemented but was never
  // mounted, leaving every route except the SSE concurrency guard unlimited.
  // Per-IP budgets, configurable; 0 disables a limiter. The recovery endpoint
  // gets its own tighter budget against recovery-code brute force.
  if (config.apiRateLimitPerMin > 0) {
    app.use('/api', rateLimit(config.apiRateLimitPerMin, 'api'));
  }
  if (config.recoveryRateLimitPerMin > 0) {
    app.use('/api/v1/sessions/recover', rateLimit(config.recoveryRateLimitPerMin, 'recovery'));
  }

  app.use(
    '/api',
    createApiRouter({
      agent: runtime.agentController,
      approvals: runtime.approvalController,
      sessions: runtime.sessionsController,
      tools: runtime.toolsController,
      mcp: runtime.mcpController,
      providers: runtime.providersController,
      health: runtime.healthController,
      sandboxPermissions: runtime.sandboxPermissionsController,
      judge: runtime.judgeController,
      capabilities: runtime.capabilitiesController,
      traces: runtime.tracesController,
      skills: runtime.skillsController,
      checkpoints: runtime.checkpointsController,
      sandboxGrants: runtime.sandboxGrantsController,
      runs: runtime.runsController,
    }),
  );

  // ── RSI 看板专用路由 ── 开发态旁路，直接查 db，不走 controller 流程
  app.get('/api/rsi/overview', (req, res) => {
    try {
      const sessionId = typeof req.query.session === 'string' ? req.query.session : null;
      if (!sessionId) { res.status(400).json({ error: '?session=xxx required' }); return; }
      const db = runtime.db;

      const session = db.get(`SELECT id, title, provider, model, created_at FROM sessions WHERE id = ?`, [sessionId]);
      if (!session) { res.status(404).json({ error: 'session not found' }); return; }

      // 每代 judge_run 汇总 + 其 verdicts
      const judgeRuns = db.all(`SELECT id, verdict, score, coverage, executed, total, created_at
                                FROM judge_runs WHERE session_id = ? ORDER BY id ASC`, [sessionId]);
      const verdictsByRun = new Map<number, any[]>();
      const allVerdicts = db.all<any>(`SELECT run_id, layer, criterion, status, score, detail, data_json
                                  FROM judge_verdicts WHERE session_id = ? ORDER BY run_id, id ASC`, [sessionId]);
      for (const v of allVerdicts) {
        // data_json 是 007 迁移新增的列；旧行为 NULL，这里统一解成 data 字段，
        // 解不出来就当没有（绝不能让一条脏 JSON 把整个看板打成 500）。
        v.data = parseJsonColumn(v.data_json);
        delete v.data_json;
        if (!verdictsByRun.has(v.run_id)) verdictsByRun.set(v.run_id, []);
        verdictsByRun.get(v.run_id)!.push(v);
      }

      // 每代 RSI 对比（prev → next）
      const rsiRuns = db.all(`SELECT generation, prev_generation, verdict, exit_code,
                                     reasons_json, prev_readings_json, next_readings_json
                              FROM policy_rsi_runs WHERE session_id = ? ORDER BY generation ASC`, [sessionId]);

      // 归因经验（policy_injections）—— 每条 π' 的增量
      const attributions = db.all(`SELECT id, policy_version, lesson, created_at
                                   FROM policy_injections WHERE session_id = ?
                                   ORDER BY id DESC LIMIT 20`, [sessionId]);

      // Map 不能直接交给 res.json：JSON.stringify(new Map()) 是 {}，
      // 前端会拿到空对象，趋势图和指标条永远是空的。这里显式转成普通对象。
      const verdictsByRunJson: Record<string, any[]> = Object.fromEntries(verdictsByRun);

      // 结构化评测读数（新增字段，不改动既有字段）：前端此前只能正则解析
      // task.test_pass_rate 的 detail 文本拿分母，文案一改就断。
      res.json({
        session,
        judgeRuns,
        verdictsByRun: verdictsByRunJson,
        rsiRuns,
        attributions,
        eval: buildEvalSummary(allVerdicts, judgeRuns as Array<{ id: number; created_at: number }>),
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'rsi overview failed' });
    }
  });

  // RSI 看板静态页面 —— public/ 目录无论在 dist 还是 src 路径都能找到
  app.get('/rsi', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    // cwd 在 dev (tsx) 和 build (node dist/app.js) 都是 server 根目录
    const htmlPath = path.join(process.cwd(), 'public', 'rsi-dashboard.html');
    if (existsSync(htmlPath)) { res.sendFile(htmlPath); return; }
    res.status(404).send('rsi dashboard not found at ' + htmlPath);
  });

  app.use(notFoundHandler);

  const clientDir = options.clientDistDir ?? config.clientDistDir;
  if (existsSync(clientDir)) {
    // P2-12: maxAge 0 by default — the setHeaders callback is now the single
    // cache-policy point (immutable for hashed assets, no-cache otherwise).
    // The old maxAge '1y' froze every non-hashed root file for a year, so a
    // deploy could leave browsers on a stale shell.
    app.use(express.static(clientDir, { index: false, maxAge: 0, setHeaders: cacheImmutableAssets }));
    // SPA history fallback (Express 5: middleware form, not app.get('*')).
    // Serves the app shell for any non-API GET/HEAD so external probes and
    // deep links work regardless of the Accept header.
    app.use((req: Request, res: Response, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api/')) return next();
      // P2-12: the shell must revalidate on every load — otherwise a cached
      // index.html keeps pointing at deleted asset hashes (white screen).
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile('index.html', { root: clientDir }, (err) => {
        next(err ?? new AppError(ErrorCode.NOT_FOUND, '页面不存在'));
      });
    });
  }

  app.use(errorHandler);

  // 启动上游模型同步（自动获取模型）。
  // 关键背景：桌面嵌入态（desktop/main.cjs）只调用 createApp()，不会进入本文件底部
  // isMainModule() 的独立服务分支；且服务端被打成 CJS 单文件后 import.meta.url 为空、
  // isMainModule() 恒为 false，导致原先只在 isMainModule() 里的 fetchOnce()/start()
  // 在桌面态从不执行——配置了 MODEL_SOURCE_* 也不会自动拉取模型。
  // 故将启动逻辑上移到 createApp，对所有入口（桌面嵌入态 / 独立服务）生效；
  // 测试态默认不自动拉取，避免用例产生意外网络请求（可用 autoStartModelSync 显式覆盖）。
  const autoStartModelSync = options.autoStartModelSync ?? config.nodeEnv !== 'test';
  if (autoStartModelSync) {
    void runtime.modelSync.fetchOnce().then(() => runtime.modelSync.start());
  }

  return app;
}

/** 解析 judge_verdicts.data_json；旧行是 NULL、脏 JSON 也一律当成「没有」。 */
function parseJsonColumn(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const EVAL_CRITERION = 'task.test_pass_rate';

/**
 * 把 task.test_pass_rate 的判决行整理成看板可直接消费的形状。
 *
 * 兼容策略：优先用带结构化 data 的**最新**判决；如果该会话还没有任何结构化行
 * （007 迁移之前的旧数据），退回最新一行并标 `source: 'detail_only'`，
 * 此时数值字段为 null、suites 为空 —— 前端据此走旧路径，不会拿到假数字。
 */
function buildEvalSummary(
  verdicts: any[],
  judgeRuns: Array<{ id: number; created_at: number }>,
): Record<string, unknown> | null {
  let latest: any = null;
  let latestStructured: any = null;
  for (const v of verdicts) {
    if (v.criterion !== EVAL_CRITERION) continue;
    latest = v;
    if (v.data) latestStructured = v;
  }
  const chosen = latestStructured ?? latest;
  if (!chosen) return null;

  const data = (chosen.data ?? null) as Record<string, any> | null;
  const num = (key: string): number | null =>
    typeof data?.[key] === 'number' ? (data[key] as number) : null;
  const total = num('total');
  const run = judgeRuns.find((r) => r.id === chosen.run_id);

  return {
    runId: chosen.run_id,
    status: chosen.status,
    score: chosen.score ?? null,
    detail: chosen.detail ?? null,
    measuredAt: run?.created_at ?? null,
    passed: num('passed'),
    total,
    denominator: num('denominator') ?? total,
    suites: Array.isArray(data?.suites) ? data!.suites : [],
    source: data ? 'structured' : 'detail_only',
  };
}

function cacheImmutableAssets(res: Response, filePath: string): void {
  // Vite emits content-hashed filenames under /assets/ — those are safe to
  // freeze. Everything else at the client root (index.html is served by the
  // SPA fallback below, but favicon/manifest/etc. land here) must revalidate,
  // otherwise a stale shell survives a deploy (P2-12).
  if (/[/\\]assets[/\\]/.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'no-cache');
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  const runtime = createRuntime();
  const app = createApp({ runtime });
  const server = app.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(`codelens-server listening on ${config.host}:${config.port} (${config.nodeEnv})`);
  });
  // 上游模型同步已在 createApp() 内按 nodeEnv 自动启动（fetchOnce + 周期调度）；此处只做退出清理。
  // close() 会先 abort 服务关闭信号：在途 run（含能力探测/上游流）随进程退出一起取消，
  // 不等上游超时。close() 幂等，双信号重复触发安全。
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void runtime.close().finally(() => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
      });
    });
  }
}

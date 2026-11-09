/** Environment loading and validation. Exports a validated config singleton. */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * 加载包根目录下的 `.env`（Node ≥22 内置能力，无需 dotenv 依赖）。
 *
 * 为什么必须显式加载：`npm start` 是裸 `node dist/app.js`，Node 不会自动读 `.env`。
 * 之前没加载的直接后果是 `LLM_SERVER_API_KEY` / `DEEP_ASSESSOR_*` 全为空，
 * RSI 归因器判定 `hasCreds=false` 后静默跳过 —— 闭环里 r → Update 这一环实际上
 * 从未消费过 RSI 判决，写入 π 的全是规则模板经验（看起来在学，其实没学到点上）。
 *
 * 已存在的进程环境变量优先：部署时用真实环境变量覆盖 `.env` 是常规做法。
 */
function loadDotEnv(): void {
  const packageRoot = findPackageRoot(currentModuleDir());
  const envPath = path.join(packageRoot, '.env');
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch {
    // 解析失败不阻断启动：配置校验会在缺关键项时给出明确错误。
  }
}
loadDotEnv();

/** 导出以供测试钉住默认值（C3：默认值也是判据，必须可被打红）。 */
export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /**
   * 监听地址。默认 `127.0.0.1`（仅本机）—— 这是刻意的安全默认：
   * 服务带高危工具（`sys.exec`、`fs.write`）与恢复码端点，裸奔 `0.0.0.0`
   * 等于把审批面暴露给局域网。需要局域网/容器访问时显式设 `HOST=0.0.0.0`
   * （Dockerfile 已内置该设置，容器内端口映射不受影响）。
   */
  HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ALLOWED_ORIGINS: z.string().default(''),
  LLM_SERVER_API_KEY: z.string().default(''),
  // ── L2 深判专用（会话 provider/model 不命中时用这些兜底） ──
  DEEP_ASSESSOR_BASE_URL: z.string().default(''),
  DEEP_ASSESSOR_MODEL: z.string().default(''),
  DEEP_ASSESSOR_PROVIDER: z.string().default(''),
  TRUST_PROXY: z.string().default(''),
  CLIENT_DIST_DIR: z.string().default(''),
  // Agent platform additions
  AGENT_DB_PATH: z.string().default(''),
  SANDBOX_ROOT: z.string().default(''),
  AGENT_APPROVAL_SECRET: z.string().default(''),
  AGENT_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(3),
  // ── 四道任务预算（A）───────────────────────────────────────────────────
  /**
   * 单任务工具调用总次数上限（默认 40）。
   * 依据：默认 12 轮 × 平均 3 次调用 ≈ 36，留 4 次余量；再高通常意味着空转。
   */
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(200).default(40),
  /**
   * 单任务墙钟预算（ms，默认 180000）。
   * 依据：沿用既有 TASK_BUDGET_MS —— 本地/远端首字节常 5–20s，12 轮正常任务
   * 实测多在 60–150s；180s 是「明显异常」而非「正常偏慢」的分界。
   */
  AGENT_TASK_BUDGET_MS: z.coerce.number().int().min(1000).max(3_600_000).default(180_000),
  /**
   * token 硬顶 = 上下文窗口 × 该系数（默认 2）。
   * 依据：沿用既有 TOKEN_BUDGET_CONTEXT_FACTOR —— 允许跨多轮正常对话，
   * 同时防止单任务把上下文与费用无限放大。
   */
  AGENT_TOKEN_BUDGET_FACTOR: z.coerce.number().min(1).max(10).default(2),
  /**
   * 收敛判定：连续 N 轮无新增文件改动 / 证据 / 工具结果变化即停（默认 3）。
   * 依据：1 轮可能是模型在确认，2 轮仍可能重试；3 轮同签名基本可判空转。0 = 关闭。
   */
  AGENT_CONVERGENCE_ROUNDS: z.coerce.number().int().min(0).max(20).default(3),
  /** MCP servers JSON override (desktop packaging writes it under userData). */
  MCP_CONFIG_PATH: z.string().default(''),
  // ── Rate limiting (P1-5: limiter implemented but never mounted) ──
  /** /api 全局限速：每 IP 每分钟请求数；0 = 不限。 */
  API_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(300),
  /** 恢复码端点限额：每 IP 每分钟请求数（0 = 不限），防恢复码爆破。 */
  RECOVERY_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(10),
  // ── Upstream model sync (auto model fetch) ──
  MODEL_SOURCE_URL: z.string().default(''),
  MODEL_REFRESH_INTERVAL_MS: z.coerce.number().int().min(0).default(3600000),
  MODEL_SYNC_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),
  MODEL_SYNC_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(1000),
  MODEL_SOURCE_ALLOW_INSECURE: z.string().default(''),
  MODEL_SOURCE_ALLOW_PRIVATE: z.string().default(''),
  MODEL_SOURCE_FORMAT: z.enum(['native', 'openai']).default('native'),
  // ── HTTP 工具出网控制（P2-8：原为 ssrf-guard 裸读 process.env，未入校验面）──
  /** HTTP 工具域名白名单（逗号分隔，大小写不敏感）；空 = 不限制。 */
  HTTP_TOOL_ALLOWLIST: z.string().default(''),
  /** 允许 HTTP 工具访问 http（非 https）目标；默认 false（仅 https）。 */
  HTTP_ALLOW_INSECURE: z.string().default(''),
  // ── 兜底 Key 试用 + 三级预算闸（A-01 / A-02）──
  /** 试用模式开关；开启后无 BYOK Key 的用户可走兜底 Key，受试用量 + 预算闸限制。 */
  TRIAL_MODE_ENABLED: z.string().default(''),
  // ── 可观测面（能力洞察）：工作区快照 / 运行轨迹 / 技能库 ──
  /** 工作区快照与回滚开关；开启后每轮文件修改前自动捕获，可按 id 回滚。 */
  CHECKPOINT_ENABLED: z.string().default(''),
  /** 单次快照最多捕获的文件数；0 = 不限。 */
  CHECKPOINT_MAX_FILES: z.coerce.number().int().min(0).default(200),
  /** 单次快照最多捕获的总字节数（单位 MB）；0 = 不限。 */
  CHECKPOINT_MAX_BYTES: z.coerce.number().int().min(0).default(50),
  /** 证据链保留：最多保留多少个 run；0 = 不限。 */
  CHECKPOINT_MAX_RUNS: z.coerce.number().int().min(0).default(20),
  /** 证据链保留：最多保留多少 MB（run 级正文）；0 = 不限。 */
  CHECKPOINT_RETENTION_MB: z.coerce.number().int().min(0).default(200),
  /** 汇报卡：1 = 每轮必报；默认只在有实质变化时出。 */
  RUN_REPORT_EVERY: z.string().default(''),
  /** 独立复核开关；默认开启，设为 0 可整体关闭。 */
  REVIEW_ENABLED: z.string().default('1'),
  /** 运行轨迹埋点开关（Act/Judge/Update span 可回放）。 */
  OBSERVABILITY_ENABLED: z.string().default(''),
  /** 程序化技能库开关（技能列表与匹配）。 */
  SKILL_LIBRARY_ENABLED: z.string().default(''),
  /** 每 IP 每日试用次数（TRIAL_MODE_ENABLED=true 时生效）；0 = 不限。 */
  TRIAL_DAILY_LIMIT: z.coerce.number().int().min(0).default(5),
  /**
   * 试用锁定的上游 provider id（默认 nvidia）。
   * 未自带 Key 的请求会被强制改到这个上游——否则默认 provider + 服务端兜底 Key 会必然 401。
   */
  TRIAL_PROVIDER: z.string().default('nvidia'),
  /** 试用锁定的模型 id（与 TRIAL_PROVIDER 配套）。 */
  TRIAL_MODEL: z.string().default('nvidia/nemotron-3-ultra-550b-a55b'),
  /**
   * 试用锁定的上游 base URL（OpenAI 兼容）。空 = 用 provider 注册表内置地址。
   * 自建/未验证网关照这里配置，默认不启用；**源码不硬编码任何试用地址**。
   */
  TRIAL_BASE_URL: z.string().default(''),
  /** 上游首包超时（ms）：0/负 = 默认 60000；下限 1000，上限 600000。 */
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(0).default(60_000),
  /**
   * 上游连接失败重试次数（仅网络类失败重试；超时不重试，避免把等待翻倍）。
   * 0 = 不重试；上限 3。
   */
  UPSTREAM_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(0),
  /** 兜底 Key 全局日 token 预算（所有匿名用户合计）；0 = 不限。 */
  FALLBACK_GLOBAL_DAILY_TOKEN_LIMIT: z.coerce.number().int().min(0).default(0),
  /** 兜底 Key 每 IP 日 token 预算；0 = 不限。 */
  FALLBACK_PER_IP_DAILY_TOKEN_LIMIT: z.coerce.number().int().min(0).default(0),
  /** 兜底 Key 单任务 token 预算（覆盖上下文×2 软闸）；0 = 沿用软闸。 */
  FALLBACK_PER_TASK_TOKEN_LIMIT: z.coerce.number().int().min(0).default(0),
  // ── sys.exec 命令执行工具（默认关闭危险面：白名单越短越安全）──
  /**
   * sys.exec 命令白名单（逗号分隔的逻辑命令名，如 `git,node`）。
   * **空 = 全拒**（fail-closed）。此处故意背离「0 = 不限」的项目惯例：
   * 对 exec 场景，「不限」等于 RCE 零门槛，而空值最常见的来源是「用户忘了配」。
   */
  EXEC_TOOL_ALLOWLIST: z.string().default('git,node'),
  /** sys.exec 单次调用默认超时（ms）；0 = 取默认值（不给无界）。 */
  EXEC_TOOL_TIMEOUT_MS: z.coerce.number().int().min(0).default(60000),
  /** sys.exec 允许请求的最大超时（ms）；0 = 取默认值。硬上限，参数不得越过。 */
  EXEC_TOOL_MAX_TIMEOUT_MS: z.coerce.number().int().min(0).default(300000),
  // ── π 经验注入预算（存储 50 条，注入有上限）──
  /** 每轮最多注入几条经验；0 = 不限。 */
  POLICY_INJECT_MAX_LESSONS: z.coerce.number().int().min(0).default(8),
  /** 每轮注入文本的字符上限（含序号前缀）；0 = 不限。 */
  POLICY_INJECT_MAX_CHARS: z.coerce.number().int().min(0).default(480),
});

export interface AppConfig {
  port: number;
  /** 监听地址；默认 127.0.0.1（仅本机），需暴露时显式设 HOST=0.0.0.0。 */
  host: string;
  nodeEnv: 'development' | 'production' | 'test';
  allowedOrigins: string[];
  serverApiKey: string;
  /** L2 深判兜底 provider/model/baseUrl（会话不命中时用）。 */
  deepAssessorProvider: string;
  deepAssessorModel: string;
  deepAssessorBaseUrl: string;
  trustProxy: boolean;
  /** Static client build directory served by Express (SPA fallback). */
  clientDistDir: string;
  /** SQLite file for the agent platform (default: <server root>/data/codelens.db). */
  agentDbPath: string;
  /** Filesystem sandbox root for fs.* tools (default: <server root>/workspace). */
  sandboxRoot: string;
  /** HMAC secret for approval challenge tokens (empty = ephemeral dev secret). */
  approvalSecret: string;
  /** MCP servers JSON path override (empty = <server root>/config/mcp-servers.json). */
  mcpConfigPath: string;
  maxConcurrentAgents: number;
  /** 单任务工具调用总次数上限。 */
  agentMaxToolCalls: number;
  /** 单任务墙钟预算（ms）。 */
  agentTaskBudgetMs: number;
  /** token 硬顶系数（上下文窗口 × N）。 */
  agentTokenBudgetFactor: number;
  /** 连续 N 轮无变化即判收敛；0 = 关闭。 */
  agentConvergenceRounds: number;
  /** /api 全局限速（每 IP 每分钟）；0 = 不限。 */
  apiRateLimitPerMin: number;
  /** 恢复码端点限额（每 IP 每分钟）；0 = 不限。 */
  recoveryRateLimitPerMin: number;
  /** Upstream model-source URL; empty = 禁用自动拉取。 */
  modelSourceUrl: string;
  /** 周期刷新间隔（ms）；0/负 = 仅启动拉取一次。 */
  modelRefreshIntervalMs: number;
  modelSyncRetryMaxAttempts: number;
  modelSyncRetryBackoffMs: number;
  /** 允许 http（非 https）上游 URL。 */
  modelSourceAllowInsecure: boolean;
  /** 允许私有/回环网段上游（仅模型同步；默认 false，SSRF 仍拦截）。 */
  modelSourceAllowPrivate: boolean;
  /** 上游响应格式：native=ModelSourceSchema（自动探测 OpenAI 列表）| openai=显式 /v1/models 列表。 */
  modelSourceFormat: 'native' | 'openai';
  /** HTTP 工具域名白名单（小写域名）；空 = 不限制（P2-8 迁入校验面）。 */
  httpToolAllowlist: string[];
  /** 允许 HTTP 工具访问 http（非 https）目标；默认 false（P2-8 迁入校验面）。 */
  httpAllowInsecure: boolean;
  /** 是否启用兜底 Key 试用模式（无 BYOK Key 时可走兜底 Key）。 */
  trialModeEnabled: boolean;
  /** 是否启用工作区快照/回滚（每轮文件修改前捕获，失败可一键还原）。 */
  checkpointEnabled: boolean;
  /** 单次快照最多捕获的文件数；0 = 不限。 */
  checkpointMaxFiles: number;
  /** 单次快照最多捕获的总字节数；0 = 不限。 */
  checkpointMaxBytes: number;
  /** 证据链保留：最多保留多少个 run；0 = 不限。 */
  checkpointMaxRuns: number;
  /** 证据链保留：最多保留多少 MB；0 = 不限。 */
  checkpointRetentionMb: number;
  /** 汇报卡是否每轮必报。 */
  runReportEvery: boolean;
  /** 独立复核是否开启。 */
  reviewEnabled: boolean;
  /** 是否启用运行轨迹埋点（Act/Judge/Update span 可回放）。 */
  observabilityEnabled: boolean;
  /** 是否启用程序化技能库（技能列表与匹配）。 */
  skillLibraryEnabled: boolean;
  /** 每 IP 每日试用次数；0 = 不限。 */
  trialDailyLimit: number;
  /** 试用锁定的上游 provider id（未自带 Key 时强制使用）。 */
  trialProvider: string;
  /** 试用锁定的模型 id。 */
  trialModel: string;
  /** 试用锁定的上游 base URL；空 = 用 provider 注册表内置地址（默认不启用自建网关）。 */
  trialBaseUrl: string;
  /** 上游首包超时（ms）。 */
  upstreamTimeoutMs: number;
  /** 上游网络类失败的重试次数（超时不重试）。 */
  upstreamMaxRetries: number;
  /** 兜底 Key 全局日 token 预算；0 = 不限。 */
  fallbackGlobalDailyTokenLimit: number;
  /** 兜底 Key 每 IP 日 token 预算；0 = 不限。 */
  fallbackPerIpDailyTokenLimit: number;
  /** 兜底 Key 单任务 token 预算；0 = 不限（沿用上下文×2 软闸）。 */
  fallbackPerTaskTokenLimit: number;
  /** 每轮最多注入几条 π 经验；0 = 不限。 */
  policyInjectMaxLessons: number;
  /** 每轮注入文本的字符上限（含序号前缀）；0 = 不限。 */
  policyInjectMaxChars: number;
  /** sys.exec 命令白名单（逻辑命令名，小写）；**空数组 = 全拒**。 */
  execToolAllowlist: string[];
  /** sys.exec 默认超时（ms）。 */
  execToolTimeoutMs: number;
  /** sys.exec 允许的最大超时（ms）。 */
  execToolMaxTimeoutMs: number;
}

function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 逗号分隔域名清单，统一小写去空（与 ssrf-guard 原实现口径一致）。 */
function parseAllowlist(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

function parseBool(raw: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * 当前模块所在目录。打包态（esbuild cjs bundle）import.meta.url 为空，
 * fileURLToPath 会抛错——此时返回 cwd 兜底（桌面态所有默认路径均已由 env
 * 覆盖，这里只需保证不抛错）。
 */
function currentModuleDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/**
 * Locates the server package root: the nearest ancestor directory of `fromFile`
 * containing package.json. Independent of cwd and of where this module is
 * compiled to (dev: src/config/env.ts; prod: dist/config/env.js; Docker: any).
 */
function findPackageRoot(fromFile: string): string {
  let dir = path.dirname(fromFile);
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return dir; // filesystem root fallback
    dir = parent;
  }
}

/** Default static client dir: <server package root>/dist-client. */
function defaultClientDistDir(): string {
  return path.resolve(findPackageRoot(currentModuleDir()), 'dist-client');
}

/** 超时配置：0（或非法）回落默认值 —— 执行命令不接受「无界」这个选项。 */
function positiveOr(raw: number, fallback: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function buildConfig(source: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const env = parsed.data;
  const packageRoot = findPackageRoot(currentModuleDir());
  return {
    port: env.PORT,
    host: env.HOST.trim(),
    nodeEnv: env.NODE_ENV,
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    serverApiKey: env.LLM_SERVER_API_KEY.trim(),
    deepAssessorProvider: env.DEEP_ASSESSOR_PROVIDER.trim(),
    deepAssessorModel: env.DEEP_ASSESSOR_MODEL.trim(),
    deepAssessorBaseUrl: env.DEEP_ASSESSOR_BASE_URL.trim(),
    trustProxy: env.TRUST_PROXY.trim().toLowerCase() === 'true',
    clientDistDir: env.CLIENT_DIST_DIR ? path.resolve(env.CLIENT_DIST_DIR) : defaultClientDistDir(),
    agentDbPath: env.AGENT_DB_PATH
      ? path.resolve(env.AGENT_DB_PATH)
      : path.join(packageRoot, 'data', 'codelens.db'),
    // 默认工作目录刻意不叫 'sandbox'：那个目录名被 e2e/drill 测试占用（
    // server/sandbox 里全是 drill-r2-* / e2e-* 残留），默认指过去会让 Agent
    // 一进沙箱就看到一堆测试垃圾，却读不到任何项目文件。
    sandboxRoot: env.SANDBOX_ROOT ? path.resolve(env.SANDBOX_ROOT) : path.join(packageRoot, 'workspace'),
    approvalSecret: env.AGENT_APPROVAL_SECRET.trim(),
    mcpConfigPath: env.MCP_CONFIG_PATH ? path.resolve(env.MCP_CONFIG_PATH) : '',
    maxConcurrentAgents: env.AGENT_MAX_CONCURRENT,
    agentMaxToolCalls: env.AGENT_MAX_TOOL_CALLS,
    agentTaskBudgetMs: env.AGENT_TASK_BUDGET_MS,
    agentTokenBudgetFactor: env.AGENT_TOKEN_BUDGET_FACTOR,
    agentConvergenceRounds: env.AGENT_CONVERGENCE_ROUNDS,
    apiRateLimitPerMin: env.API_RATE_LIMIT_PER_MIN,
    recoveryRateLimitPerMin: env.RECOVERY_RATE_LIMIT_PER_MIN,
    modelSourceUrl: env.MODEL_SOURCE_URL.trim(),
    modelRefreshIntervalMs: env.MODEL_REFRESH_INTERVAL_MS,
    modelSyncRetryMaxAttempts: env.MODEL_SYNC_RETRY_MAX_ATTEMPTS,
    modelSyncRetryBackoffMs: env.MODEL_SYNC_RETRY_BACKOFF_MS,
    modelSourceAllowInsecure: parseBool(env.MODEL_SOURCE_ALLOW_INSECURE),
    modelSourceAllowPrivate: parseBool(env.MODEL_SOURCE_ALLOW_PRIVATE),
    modelSourceFormat: env.MODEL_SOURCE_FORMAT,
    httpToolAllowlist: parseAllowlist(env.HTTP_TOOL_ALLOWLIST),
    httpAllowInsecure: parseBool(env.HTTP_ALLOW_INSECURE),
    trialModeEnabled: parseBool(env.TRIAL_MODE_ENABLED),
    checkpointEnabled: parseBool(env.CHECKPOINT_ENABLED),
    checkpointMaxFiles: env.CHECKPOINT_MAX_FILES,
    checkpointMaxBytes: env.CHECKPOINT_MAX_BYTES,
    checkpointMaxRuns: env.CHECKPOINT_MAX_RUNS,
    checkpointRetentionMb: env.CHECKPOINT_RETENTION_MB,
    runReportEvery: parseBool(env.RUN_REPORT_EVERY),
    reviewEnabled: parseBool(env.REVIEW_ENABLED),
    observabilityEnabled: parseBool(env.OBSERVABILITY_ENABLED),
    skillLibraryEnabled: parseBool(env.SKILL_LIBRARY_ENABLED),
    trialDailyLimit: env.TRIAL_DAILY_LIMIT,
    trialProvider: env.TRIAL_PROVIDER.trim() || 'nvidia',
    trialModel: env.TRIAL_MODEL.trim() || 'nvidia/nemotron-3-ultra-550b-a55b',
    trialBaseUrl: env.TRIAL_BASE_URL.trim(),
    upstreamTimeoutMs: Math.min(600_000, Math.max(1_000, positiveOr(env.UPSTREAM_TIMEOUT_MS, 60_000))),
    upstreamMaxRetries: env.UPSTREAM_MAX_RETRIES,
    fallbackGlobalDailyTokenLimit: env.FALLBACK_GLOBAL_DAILY_TOKEN_LIMIT,
    fallbackPerIpDailyTokenLimit: env.FALLBACK_PER_IP_DAILY_TOKEN_LIMIT,
    fallbackPerTaskTokenLimit: env.FALLBACK_PER_TASK_TOKEN_LIMIT,
    policyInjectMaxLessons: env.POLICY_INJECT_MAX_LESSONS,
    policyInjectMaxChars: env.POLICY_INJECT_MAX_CHARS,
    // 命令白名单保持顺序、去空白、统一小写（Windows 路径/命令大小写不敏感）。
    execToolAllowlist: parseAllowlist(env.EXEC_TOOL_ALLOWLIST),
    execToolTimeoutMs: positiveOr(env.EXEC_TOOL_TIMEOUT_MS, 60000),
    execToolMaxTimeoutMs: positiveOr(env.EXEC_TOOL_MAX_TIMEOUT_MS, 300000),
  };
}

/** Config is loaded once per process; tests can override process.env before import. */
export const config: AppConfig = buildConfig(process.env);
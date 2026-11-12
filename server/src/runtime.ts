/**
 * Runtime wiring: DB + schema + repositories + tool registry + agent services.
 * Everything long-lived is built once here and injected downward
 * (routes → controllers → services); app.ts stays assembly-only.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createDb, type Db } from './repositories/db.js';
import { SCHEMA_SQL, applyMigrations } from './repositories/schema.js';
import { config } from './config/env.js';
import { SessionRepository } from './services/memory/session.repository.js';
import { MessageRepository } from './services/memory/message.repository.js';
import { ToolCallRepository } from './services/memory/tool-call.repository.js';
import { ToolResultRepository } from './services/memory/tool-result.repository.js';
import { ApprovalRepository } from './services/memory/approval.repository.js';
import { ProviderCapabilityRepository } from './services/memory/provider-capability.repository.js';
import { ProviderModelRepository, ModelSyncLogRepository } from './repositories/provider-model.repository.js';
import { ModelSyncService, type ValidateUrl } from './services/model-sync/model-sync.service.js';
import { ToolRegistry } from './services/tools/registry.service.js';
import { BUILTIN_TOOLS } from './tools/builtin/index.js';
import { AbortRegistry } from './services/agent/abort-registry.js';
import { AgentLoopService } from './services/agent/agent-loop.service.js';
import { UpdateService } from './services/agent/update.service.js';
import { JudgeService } from './services/judge/judge.service.js';
import { ruleSemanticAssessor } from './services/judge/semantic.js';
import { JudgeController } from './controllers/judge.controller.js';
import { RsiController } from './controllers/rsi.controller.js';
import { ApprovalService } from './services/agent/approval.service.js';
import { FallbackBudgetService } from './services/agent/fallback-budget.service.js';
import { TrialHealthService } from './services/agent/trial-health.service.js';
import { resolveApprovalSecret } from './utils/approval-secret.js';
import { setApprovalSecret } from './utils/hmac.js';
import { RecoveryService } from './services/recovery.service.js';
import { McpConfigStore } from './services/mcp/mcp-config.store.js';
import { McpManagerService } from './services/mcp/mcp-manager.service.js';
import { OpenAICompatibleAdapter } from './providers/openai-compatible.adapter.js';
import { resolveBaseUrl } from './providers/registry.js';
import { AgentController } from './controllers/agent.controller.js';
import { ApprovalController } from './controllers/approval.controller.js';
import { SessionsController } from './controllers/sessions.controller.js';
import { ToolsController } from './controllers/tools.controller.js';
import { McpController } from './controllers/mcp.controller.js';
import { ProvidersController } from './controllers/providers.controller.js';
import { HealthController } from './controllers/health.controller.js';
import { SandboxPermissionsController } from './controllers/sandbox-permissions.controller.js';
import { SandboxPermissionService } from './services/tools/sandbox-permission.service.js';
import { CapabilityRegistryService } from './services/capability/capability-registry.service.js';
import { CapabilitiesController } from './controllers/capabilities.controller.js';
import { TraceService } from './services/observability/trace.service.js';
import { TracesController } from './controllers/traces.controller.js';
import { SkillLibraryService } from './services/skills/skill-library.service.js';
import { SkillsController } from './controllers/skills.controller.js';
import { CheckpointService } from './services/tx/checkpoint.service.js';
import { CheckpointsController } from './controllers/checkpoints.controller.js';
import { ReviewService } from './services/agent/review.service.js';
import { RunStateService } from './services/agent/run-state.service.js';
import { RunResumeService } from './services/agent/run-resume.service.js';
import { SandboxGrantService } from './services/tools/sandbox-grant.service.js';
import { SandboxGrantsController } from './controllers/sandbox-grants.controller.js';
import { RunsController } from './controllers/runs.controller.js';
import { probeSandboxWritable } from './utils/sandbox-probe.js';
import { RsiBridgeService } from './services/rsi/rsi-bridge.service.js';

export interface Runtime {
  db: Db;
  sandboxRoot: string;
  loop: AgentLoopService;
  abortRegistry: AbortRegistry;
  approvals: ApprovalRepository;
  approvalService: ApprovalService;
  approvalController: ApprovalController;
  agentController: AgentController;
  sessionsController: SessionsController;
  toolsController: ToolsController;
  mcpController: McpController;
  providersController: ProvidersController;
  healthController: HealthController;
  sandboxPermissionsController: SandboxPermissionsController;
  judgeController: JudgeController;
  rsiController: RsiController;
  judge: JudgeService;
  policy: UpdateService;
  rsi?: RsiBridgeService;
  modelSync: ModelSyncService;
  /** 可观测面（只读）：能力开关目录 / 运行轨迹 / 技能库。 */
  capabilityRegistry: CapabilityRegistryService;
  capabilitiesController: CapabilitiesController;
  traceService: TraceService;
  tracesController: TracesController;
  skillLibrary: SkillLibraryService;
  skillsController: SkillsController;
  checkpointService: CheckpointService;
  checkpointsController: CheckpointsController;
  sandboxGrantsController: SandboxGrantsController;
  runsController: RunsController;
  close(): Promise<void>;
}

export interface CreateRuntimeOptions {
  dbPath?: string;
  fetchImpl?: typeof fetch;
  validateUrl?: ValidateUrl;
  /** 测试注入：覆盖上游超时（默认取 env UPSTREAM_TIMEOUT_MS）。 */
  upstreamTimeoutMs?: number;
  /** 测试注入：覆盖上游重试次数（默认取 env UPSTREAM_MAX_RETRIES）。 */
  upstreamMaxRetries?: number;
}

export function createRuntime(opts: CreateRuntimeOptions = {}): Runtime {
  // Sandbox root is created on demand (fs tools jail against it).
  mkdirSync(config.sandboxRoot, { recursive: true });

  const dbPath = opts.dbPath ?? config.agentDbPath;
  // C-04：审批令牌主密钥在 web/自托管路径也要持久化（桌面端已由 main.cjs 预注入 env）。
  // 内存库（:memory:）与测试模式不落盘——持久化单测在 approval-secret.test.ts 直测 resolveApprovalSecret。
  if (dbPath !== ':memory:' && config.nodeEnv !== 'test') {
    const approvalSecret = resolveApprovalSecret(config.approvalSecret, path.dirname(path.resolve(dbPath)));
    setApprovalSecret(approvalSecret.value);
    if (approvalSecret.created) {
      console.warn(
        `[codelens] 未配置 AGENT_APPROVAL_SECRET，已生成随机主密钥并持久化到 ${approvalSecret.path}（0600）。`,
      );
    }
  }
  const db = createDb(dbPath);
  db.exec(SCHEMA_SQL);
  // 增量迁移必须在任何仓储/服务构造前跑完：旧库（无 parent_run）在补列之前
  // 任何 `INSERT ... parent_run` 都会直接报 no such column。
  applyMigrations(db);

  const sessions = new SessionRepository(db);
  const messages = new MessageRepository(db);
  const toolCalls = new ToolCallRepository(db);
  const toolResults = new ToolResultRepository(db);
  const approvals = new ApprovalRepository(db);
  const capabilities = new ProviderCapabilityRepository(db);
  const providerModels = new ProviderModelRepository(db);
  const modelSyncLog = new ModelSyncLogRepository(db);

  const registry = new ToolRegistry();
  registry.registerAll(BUILTIN_TOOLS);

  const abortRegistry = new AbortRegistry();
  // 服务关闭信号：SIGTERM/SIGINT → close() 时取消所有在途 run（含能力探测/上游流），
  // 让进程退出不依赖上游超时。
  const shutdownController = new AbortController();
  // 超时/重试可配：自建网关实测有 >120s 无响应的情况，固定 60s 首包超时是必要的下限。
  const adapter = new OpenAICompatibleAdapter({
    timeoutMs: opts.upstreamTimeoutMs ?? config.upstreamTimeoutMs,
    retries: opts.upstreamMaxRetries ?? config.upstreamMaxRetries,
  });
  // 工作区快照服务：构造顺序上必须在 approvalService 之前 —— 审批的后果预览
  // 需要读 checkpoint.enabled 判断 overwrite 是否可恢复。
  const checkpointService = new CheckpointService({
    db,
    sandboxRoot: config.sandboxRoot,
    enabled: config.checkpointEnabled,
    maxFiles: config.checkpointMaxFiles,
    maxBytes: config.checkpointMaxBytes,
  });
  // 沙箱权限服务：单一实例，loop（运行时 gateway/executor 实时读取）与 API 控制器共用。
  const sandboxPermissions = new SandboxPermissionService(db, config.sandboxRoot);
  // 按目录授权：工作区外首次访问弹一次；决定由 HTTP 端点结算，持久化后可复用。
  const sandboxGrants = new SandboxGrantService(db, config.sandboxRoot);
  const approvalService = new ApprovalService(approvals, toolCalls, registry, () => ({
    sandboxRoot: config.sandboxRoot,
    allowedDirs: sandboxPermissions.allowDirs,
    checkpointEnabled: checkpointService.enabled,
  }));
  // 兜底 Key 试用 + 三级预算闸（A-01/A-02）：仅对 fallback 请求生效，计数落 DB。
  const fallbackBudget = new FallbackBudgetService(db, {
    trialEnabled: config.trialModeEnabled,
    trialDailyLimit: config.trialDailyLimit,
    globalDailyTokenLimit: config.fallbackGlobalDailyTokenLimit,
    perIpDailyTokenLimit: config.fallbackPerIpDailyTokenLimit,
    perTaskTokenLimit: config.fallbackPerTaskTokenLimit,
    serverKeyConfigured: config.serverApiKey.length > 0,
  });
  // 判据塔：先建 Judge，因为 Update 的「按有效性淘汰」需要读判决分布；
  // Judge 读 π 的 thresholds 则用延迟绑定反向接回，避免构造期成环。
  // L2 语义判据默认注入规则评估器（同步纯函数）—— 否则 L2 永远是不可用层，
  // 「语义判据」就只是一句注释。
  const judge = new JudgeService({
    db,
    toolCalls,
    semantic: ruleSemanticAssessor,
    // 事后深判拿不到当时的请求上下文，只能用服务端兜底凭证（客户端可在请求体里覆盖）。
    serverApiKey: config.serverApiKey,
    // L2 专用兜底：会话 provider/model 是 demo/placeholder 时直接用 env 配的网关。
    deepAssessorBaseUrl: config.deepAssessorBaseUrl,
    deepAssessorModel: config.deepAssessorModel,
    deepAssessorProvider: config.deepAssessorProvider,
  });
  const policy = new UpdateService(db, judge.repository);
  judge.setThresholdsProvider(() => policy.getPolicy().thresholds);
  // 注入预算与排序依据：存储侧最多 50 条，注入侧按预算裁剪并按有效性排序。
  // effectiveness() 返回 LessonEffectiveness（含 passRate 等展示字段），
  // 这里只取排序需要的原始计数 —— 排序用计数，不用平滑前的比率。
  policy.setInjectionBudget({
    maxLessons: config.policyInjectMaxLessons,
    maxChars: config.policyInjectMaxChars,
  });
  policy.setEffectivenessProvider(() =>
    judge.effectiveness().map((row) => ({
      lesson: row.lesson,
      passes: row.passes,
      fails: row.fails,
      injected: row.injected,
    })),
  );
  // RSI L1 旁路对账：从 agentDbPath 的目录推导账本存储位置。
  // 内存库（:memory:）无目录，RSI bridge 跳过 —— 它的账本文件本来就无处可放。
  const dbDir = path.dirname(dbPath);
  const rsi = dbPath !== ':memory:'
    ? new RsiBridgeService({ db, dbDir, krsiPath: process.env.KRSI_BIN_PATH })
    : undefined;
  // 运行轨迹服务（可观测面）：构造顺序上必须早于 loop —— loop 要往里写 span。
  const traceService = new TraceService({ db, enabled: config.observabilityEnabled });
  // 独立复核：不可逆调用同步等结论，可逆调用并行回填；每次调用记录真实 token/耗时。
  const reviewService = new ReviewService(db, { timeoutMs: 15_000 });
  // 保留策略：每次 run 收尾后按 20 run / 200 MB 淘汰最老的正文（pinned 永不淘汰）。
  const retention = {
    maxRuns: config.checkpointMaxRuns,
    maxBytes: config.checkpointRetentionMb * 1024 * 1024,
  };
  // RunState：run 级结构化状态 + 模板化汇报卡（默认仅实质变化时出）。
  const runStateService = new RunStateService(db, { everyRun: config.runReportEvery });
  // 证据链保留策略在 run 收尾后异步执行；保留配置到 runtime 上供后续 endpoint 调用。
  void retention;
  // 试用锁定：无 BYOK Key 的请求固定走服务端上游（默认 NVIDIA；TRIAL_BASE_URL 非空则走自建网关）。
  // 自建网关只作为可配置项存在，源码不写死地址；未配置时该上游不参与任何路径。
  const trialLock =
    config.trialModeEnabled && config.serverApiKey.length > 0
      ? {
          provider: config.trialBaseUrl ? 'custom' : config.trialProvider,
          model: config.trialModel,
          baseUrl: config.trialBaseUrl || undefined,
        }
      : null;
  const trialHealth = new TrialHealthService(
    trialLock
      ? {
          baseUrl: resolveBaseUrl(trialLock.provider, trialLock.baseUrl),
          apiKey: config.serverApiKey,
          model: trialLock.model,
        }
      : null,
  );
  // 启动自检异步跑，不阻断 listen；测试环境不发出网请求。
  // R4：真实最小生成探测（max_tokens=1），失败只 warn；结果缓存 5 分钟。
  if (config.nodeEnv !== 'test' && trialLock) void trialHealth.checkOnce();

  const loop = new AgentLoopService({
    sessions,
    messages,
    toolCalls,
    toolResults,
    approvals,
    approvalService,
    capabilities,
    registry,
    adapter,
    abortRegistry,
    shutdownSignal: shutdownController.signal,
    sandboxRoot: config.sandboxRoot,
    providerBaseUrl: (provider, customBaseUrl) => resolveBaseUrl(provider, customBaseUrl),
    serverApiKey: config.serverApiKey,
    fallbackBudget,
    trialLock,
    // 强化内核闭环：π（版本化策略）+ Judge（产 r）+ Update（r → π'）。
    policy,
    judge,
    // RSI 旁路对账（L1 机械桥）：消费同一批 verdicts，生成跨代四态 verdict；
    // 双轨并存，不阻断现有闭环。内存库时 rsi=undefined，loop 跳过。
    rsi,
    // RSI 归因器要直接写 policy_injections，必须把 db 传下去 ——
    // 之前没传，归因整段被 `&& db` 静默跳过（对账有结果、经验一条没沉淀）。
    db,
    // RSI 归因器 LLM 凭证：krsi 判 not_improved / refused 时触发 LLM 归因，
    // 归因经验直接写 policy_injections 作为 π'。未配凭证时只跑对账不跑归因。
    rsiAttributorApiKey: config.serverApiKey || undefined,
    rsiAttributorBaseUrl: config.deepAssessorBaseUrl || undefined,
    rsiAttributorModel: config.deepAssessorModel || undefined,
    // 沙箱权限：持久化配置（放开沙箱外目录 + 审批豁免），运行时实时读取。
    sandboxPermissions,
    // 运行轨迹：loop 在 act / judge / update 三处埋点；未启用时整条链路自动退化为不埋点。
    trace: traceService,
    // 工作区快照：loop 在每轮文件修改前捕获本轮将改动的文件；未启用时不捕获。
    checkpoint: checkpointService,
    // 工作区外目录授权：越界访问先弹一次，放行后并入 allowedDirs。
    grants: sandboxGrants,
    // 独立复核 + RunState：旁路能力，异常不阻断主流程。
    review: config.reviewEnabled ? reviewService : undefined,
    runState: runStateService,
  });

  const recovery = new RecoveryService(sessions);
  const approvalController = new ApprovalController(approvalService);
  const agentController = new AgentController(loop, abortRegistry, fallbackBudget, () => {
    if (!trialLock) return null;
    // 失败态超窗时顺带后台复探：上游恢复后不必等满 5 分钟缓存才转绿（单飞，不叠加请求）。
    trialHealth.refreshIfStaleFailure();
    return {
      provider: trialLock.provider,
      model: trialLock.model,
      baseUrl: trialLock.baseUrl ?? null,
      health: trialHealth.get(),
    };
  });
  const sessionsController = new SessionsController(
    sessions,
    messages,
    toolCalls,
    approvals,
    recovery,
    loop.router(),
  );
  const toolsController = new ToolsController(registry, config.sandboxRoot);

  const mcpStore = new McpConfigStore(config.mcpConfigPath || undefined);
  const mcpManager = new McpManagerService(mcpStore, registry);
  const mcpController = new McpController(mcpStore, mcpManager);

  // 上游模型同步：装配 service（载入 DB 快照预热，重启首拉前不丢数据）
  const modelSyncLogPath =
    dbPath && dbPath !== ':memory:'
      ? path.join(path.dirname(dbPath), 'logs', 'model-sync.log')
      : '';
  const modelSync = new ModelSyncService(
    providerModels,
    modelSyncLog,
    {
      sourceUrl: config.modelSourceUrl,
      refreshIntervalMs: config.modelRefreshIntervalMs,
      retryMaxAttempts: config.modelSyncRetryMaxAttempts,
      retryBackoffMs: config.modelSyncRetryBackoffMs,
      allowInsecure: config.modelSourceAllowInsecure,
      allowPrivate: config.modelSourceAllowPrivate,
      format: config.modelSourceFormat,
      timeoutMs: 60_000,
      logFilePath: modelSyncLogPath,
    },
    opts.fetchImpl ?? globalThis.fetch,
    opts.validateUrl,
  );
  modelSync.loadSnapshot();

  const providersController = new ProvidersController(capabilities, modelSync);
  const healthController = new HealthController(db, mcpManager, config.sandboxRoot, config.agentDbPath);
  const sandboxPermissionsController = new SandboxPermissionsController(sandboxPermissions);
  const judgeController = new JudgeController(judge, policy);
  // RSI 自我迭代视图：依赖 db —— 看板读数（overview）要查会话/判决/代际对比。
  const rsiController = new RsiController(db);

  // ── 可观测面（只读）─────────────────────────────────────────────────────────
  // 三者都不在执行路径上：轨迹 / 技能库是数据面，能力目录是状态面。
  //
  // 能力目录的每个事实都用 getter 求值，而不是在构造时拍一张快照 ——
  // 否则「刚禁用了一个工具，能力目录还写着已启用」就成了误导。
  const skillLibrary = new SkillLibraryService({ db, enabled: config.skillLibraryEnabled });
  // 工具启用的判定口径与 ToolsController 共用同一份 ToolEnableContext，  // 否则「工具管理里显示禁用、但能力目录算作可用」会两边打架。
  const toolEnableCtx = { sandboxRoot: config.sandboxRoot, mcpConnected: false };
  const capabilityRegistry = new CapabilityRegistryService({
    judge: { enabled: true },
    policy: { enabled: true },
    tools: {
      get count(): number {
        return registry.list().length;
      },
      get enabledCount(): number {
        return registry.listPublic(toolEnableCtx).filter((t) => t.enabled !== false).length;
      },
    },
    mcp: {
      get servers(): number {
        return mcpManager.health().servers;
      },
      get healthy(): number {
        return mcpManager.health().healthy;
      },
    },
    sandbox: {
      get writable(): boolean {
        return probeSandboxWritable(config.sandboxRoot);
      },
    },
    trial: { enabled: config.trialModeEnabled, serverKeyConfigured: config.serverApiKey.length > 0 },
    observabilityEnabled: config.observabilityEnabled,
    checkpointEnabled: config.checkpointEnabled,
    skillLibraryEnabled: config.skillLibraryEnabled,
    approval: { enabled: true },
    memory: { enabled: true },
    modelSync: { enabled: config.modelSourceUrl.length > 0 },
    // 接线状态覆盖：能力目录的默认口径是「开关打开 ≠ 服务已装配」（wired=false），
    // 用来防「把开关当接线」。这里由装配层显式纠正已经构造出来的服务。
    wired: { skills: true, observability: true, checkpoint: true },
  });
  const capabilitiesController = new CapabilitiesController(capabilityRegistry);
  const tracesController = new TracesController(traceService);
  const skillsController = new SkillsController(skillLibrary);
  const checkpointsController = new CheckpointsController(checkpointService);
  const sandboxGrantsController = new SandboxGrantsController(sandboxGrants);
  const runResumeService = new RunResumeService(runStateService, checkpointService);
  const runsController = new RunsController(runStateService, checkpointService, runResumeService);

  let closed = false;
  return {
    db,
    sandboxRoot: config.sandboxRoot,
    loop,
    abortRegistry,
    approvals,
    approvalService,
    approvalController,
    agentController,
    sessionsController,
    toolsController,
    mcpController,
    providersController,
    healthController,
    sandboxPermissionsController,
    judgeController,
    rsiController,
    judge,
    policy,
    rsi,
    modelSync,
    capabilityRegistry,
    capabilitiesController,
    traceService,
    tracesController,
    skillLibrary,
    skillsController,
    checkpointService,
    checkpointsController,
    sandboxGrantsController,
    runsController,
    close: async () => {
      if (closed) return;
      closed = true;
      // 先取消所有在途 run：之后才关 DB，避免 run 在拆库过程中继续写。
      shutdownController.abort();
      modelSync.stop();
      await mcpManager.closeAll();
      db.close();
    },
  };
}

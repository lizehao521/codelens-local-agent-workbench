/**
 * Schema DDL — single source of truth mirrored from docs/agent/schema.sql (7 tables).
 * Kept as one string so the running database and the reviewed document cannot drift.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id                     TEXT PRIMARY KEY,
  title                  TEXT    NOT NULL DEFAULT '新会话',
  provider               TEXT    NOT NULL,
  model                  TEXT    NOT NULL,
  channel_mode           TEXT    NOT NULL DEFAULT 'auto'
                                CHECK (channel_mode IN ('auto', 'native', 'react')),
  degraded               INTEGER NOT NULL DEFAULT 0,
  message_count          INTEGER NOT NULL DEFAULT 0,
  total_tokens           INTEGER NOT NULL DEFAULT 0,
  device_token_hash      TEXT,
  recovery_code_hash     TEXT,
  recovery_code_used_at  INTEGER,
  recovery_failed_count  INTEGER NOT NULL DEFAULT 0,
  recovery_locked_until  INTEGER,
  summary                TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_device   ON sessions(device_token_hash);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  session_id        TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  role              TEXT    NOT NULL
                          CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content           TEXT    NOT NULL DEFAULT '',
  segments_json     TEXT,
  reasoning_content TEXT,
  tool_calls_json   TEXT,
  tool_call_id      TEXT,
  finish_reason     TEXT,
  usage_json        TEXT,
  tokens            INTEGER NOT NULL DEFAULT 0,
  is_summary        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq    ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_session_seq ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS tool_calls (
  id             TEXT PRIMARY KEY,
  session_id     TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id     TEXT             REFERENCES messages(id) ON DELETE SET NULL,
  call_id        TEXT    NOT NULL,
  tool_name      TEXT    NOT NULL,
  tool_wire_name TEXT    NOT NULL,
  display_name   TEXT    NOT NULL,
  category       TEXT    NOT NULL CHECK (category IN ('http', 'file', 'compute', 'mcp')),
  source         TEXT    NOT NULL CHECK (source IN ('builtin', 'mcp')),
  risk           TEXT    NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  approval_mode  TEXT    NOT NULL CHECK (approval_mode IN ('none', 'soft', 'hard', 'two_step')),
  channel        TEXT    NOT NULL CHECK (channel IN ('native', 'react')),
  iteration      INTEGER NOT NULL DEFAULT 0,
  args_json      TEXT    NOT NULL DEFAULT '{}',
  args_digest    TEXT,
  status         TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'running', 'success',
                                          'failed', 'timeout', 'rejected', 'skipped')),
  error_kind     TEXT,
  error_msg      TEXT,
  result_ref     TEXT,
  result_summary TEXT,
  truncated      INTEGER NOT NULL DEFAULT 0,
  started_at     INTEGER,
  ended_at       INTEGER,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_toolcalls_session     ON tool_calls(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_toolcalls_message     ON tool_calls(message_id);
CREATE INDEX IF NOT EXISTS idx_toolcalls_name_status ON tool_calls(tool_name, status);
CREATE INDEX IF NOT EXISTS idx_toolcalls_digest      ON tool_calls(session_id, tool_name, args_digest);

CREATE TABLE IF NOT EXISTS tool_results (
  id             TEXT PRIMARY KEY,
  tool_call_id   TEXT    NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  inline_preview TEXT,
  artifact_path  TEXT,
  bytes          INTEGER NOT NULL DEFAULT 0,
  truncated      INTEGER NOT NULL DEFAULT 0,
  sha256         TEXT,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_toolresults_call ON tool_results(tool_call_id);

CREATE TABLE IF NOT EXISTS approvals (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT    NOT NULL REFERENCES sessions(id)   ON DELETE CASCADE,
  tool_call_id          TEXT    NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  tool_name             TEXT    NOT NULL,
  args_digest           TEXT    NOT NULL,
  challenge_token_hash  TEXT    NOT NULL,
  status                TEXT    NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'decided', 'expired',
                                                   'aborted', 'revised')),
  decision              TEXT             CHECK (decision IN ('allow_once', 'allow_session',
                                                            'reject', 'revised')),
  reason                TEXT,
  mismatch_count        INTEGER NOT NULL DEFAULT 0,
  last_mismatch_at      INTEGER,
  last_mismatch_detail  TEXT,
  revised_from_id       TEXT,
  revise_depth          INTEGER NOT NULL DEFAULT 0,
  expires_at            INTEGER NOT NULL,
  decided_at            INTEGER,
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_call    ON approvals(tool_call_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status  ON approvals(status, expires_at);

CREATE TRIGGER IF NOT EXISTS trg_approvals_decision_once
BEFORE UPDATE OF decision ON approvals
WHEN OLD.decision IS NOT NULL AND NEW.decision IS NOT OLD.decision
BEGIN
  SELECT RAISE(ABORT, 'APPROVAL_DECISION_IMMUTABLE');
END;

CREATE TABLE IF NOT EXISTS provider_capabilities (
  provider                     TEXT    NOT NULL,
  model                        TEXT    NOT NULL,
  supports_function_calling    INTEGER,
  probe_status                 TEXT    NOT NULL DEFAULT 'unknown'
                                       CHECK (probe_status IN ('unknown', 'supported',
                                                               'unsupported', 'failed')),
  context_window               INTEGER,
  lightweight_model            TEXT,
  tool_choice_values_json      TEXT,
  retain_reasoning_content     INTEGER NOT NULL DEFAULT 0,
  require_tool_stream_flag     INTEGER NOT NULL DEFAULT 0,
  explicit_parallel_tool_calls INTEGER NOT NULL DEFAULT 0,
  probed_at                    INTEGER,
  notes                        TEXT,
  PRIMARY KEY (provider, model)
);

CREATE INDEX IF NOT EXISTS idx_capabilities_probed ON provider_capabilities(probed_at DESC);

-- 上游模型同步：最近一次成功快照（重启后首拉前仍有上次数据作为兜底合并）
CREATE TABLE IF NOT EXISTS provider_models (
  provider          TEXT    NOT NULL,
  model             TEXT    NOT NULL,
  provider_name     TEXT    NOT NULL DEFAULT '',
  base_url          TEXT    NOT NULL DEFAULT '',
  default_model     TEXT    NOT NULL DEFAULT '',
  docs_url          TEXT    NOT NULL DEFAULT '',
  model_name        TEXT    NOT NULL DEFAULT '',
  capabilities_json TEXT,
  synced_at         INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);

-- 上游模型同步：每次同步尝试的状态/异常记录（成功/失败/禁用）
CREATE TABLE IF NOT EXISTS model_sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  status      TEXT    NOT NULL CHECK (status IN ('success', 'error', 'disabled')),
  attempt     INTEGER NOT NULL DEFAULT 1,
  message     TEXT    NOT NULL,
  detail      TEXT,
  source_url  TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_model_sync_log_occurred ON model_sync_log(occurred_at DESC);

-- 兜底 Key 用量记账（A-01/A-02）：按 scope+key+UTCDay 累计 token 与运行次数。
-- 预算/试用闸持久化到 DB，进程重启不丢计数（内存限流器无法满足财务级预算）。
CREATE TABLE IF NOT EXISTS fallback_usage (
  scope        TEXT    NOT NULL CHECK (scope IN ('global', 'ip')),
  key          TEXT    NOT NULL,
  period_start INTEGER NOT NULL,
  tokens       INTEGER NOT NULL DEFAULT 0,
  runs         INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (scope, key, period_start)
);

CREATE INDEX IF NOT EXISTS idx_fallback_usage_period ON fallback_usage(period_start, scope);

-- 强化内核 Update 闭环：版本化策略 π（自我修改的唯一表面，每次修改可回滚）。
-- 当前 π = version 最大的行；source_judgment 记录触发本次修改的判决 r（r 必须来自 Judge）。
CREATE TABLE IF NOT EXISTS policy_versions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  version           INTEGER NOT NULL UNIQUE,
  policy_json       TEXT    NOT NULL,
  parent_version    INTEGER,
  source_judgment   TEXT,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_policy_versions_version ON policy_versions(version DESC);

-- 沙箱权限配置（sandbox-permission）：单行（id=1）持久化 allowDirs + autoApprove。
-- allowDirs 仅存经服务端硬校验后的 realpath 绝对目录；autoApprove 控制高危操作是否免审批。
CREATE TABLE IF NOT EXISTS sandbox_permission_config (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ── 判据塔（Judge）───────────────────────────────────────────────────────────
-- 一次判决的汇总。verdict 语义：
--   pass         所有已执行判据均通过，且 coverage 达门槛
--   fail         存在任一 fail 判据（fail 优先于 coverage）
--   inconclusive 无 fail 但执行覆盖率不足 —— 这是「未验证」的一等表达，
--                绝不允许被折叠成 pass（强化内核 C4：未执行 ≠ 通过）
-- coverage = executed / total，用于区分「真的全绿」与「根本没测」。
CREATE TABLE IF NOT EXISTS judge_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT    NOT NULL,
  verdict      TEXT    NOT NULL CHECK (verdict IN ('pass', 'fail', 'inconclusive')),
  score        REAL    NOT NULL DEFAULT 0,
  coverage     REAL    NOT NULL DEFAULT 0,
  executed     INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  context_json TEXT,
  created_at   INTEGER NOT NULL,
  -- L2 LLM 深判的父判决：NULL = 规则判决，非 NULL = 由该行派生的深判。
  -- 建表时就带上，旧库由 runSchemaMigrations 补列（两条路径必须殊途同归）。
  parent_run   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_judge_runs_session ON judge_runs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_judge_runs_verdict ON judge_runs(verdict, created_at DESC);

-- 单条判据的判决（τ → r 的可追溯分离：r 必须能指回它读过的证据）。
-- status 三态中 unexec 是一等公民：没有证据时诚实的结果是「未执行」，
-- 既不是绿灯也不是红灯（C4）。
CREATE TABLE IF NOT EXISTS judge_verdicts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL,
  session_id TEXT    NOT NULL,
  layer      TEXT    NOT NULL CHECK (layer IN ('L0', 'L1', 'L2', 'L3')),
  criterion  TEXT    NOT NULL,
  status     TEXT    NOT NULL CHECK (status IN ('pass', 'fail', 'unexec')),
  score      REAL,
  detail     TEXT,
  -- 结构化读数（JSON）。detail 是给人看的文本，前端不该靠正则解析它拿分母；
  -- 新版判据把 { passed, total, denominator, suites[] } 写在这里，旧行为 NULL。
  data_json  TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_judge_verdicts_run     ON judge_verdicts(run_id);
CREATE INDEX IF NOT EXISTS idx_judge_verdicts_session ON judge_verdicts(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_judge_verdicts_crit    ON judge_verdicts(criterion, status);

-- Act 期注入记账：记录某次会话实际注入了哪些 π 经验。
-- 目的不是「记得多」，而是让「经验是否真的有效」可以被事后聚合出来：
-- policy_injections ⋈ judge_runs 即可算出某条经验注入后的判决分布。
CREATE TABLE IF NOT EXISTS policy_injections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT    NOT NULL,
  policy_version INTEGER NOT NULL,
  lesson         TEXT    NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_policy_injections_lesson  ON policy_injections(lesson, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_policy_injections_session ON policy_injections(session_id);

-- ── RSI 对账旁路（L1 机械桥）───────────────────────────────────────────────
-- Agent 的 Judge 判据塔 verdicts → RSI Manifest → krsi 跨代对比。
-- 双轨并存：UpdateService 照常写 π 增量，RSI verdict 只落审计表供事后复盘。
-- verdict 六态中 skipped 是「无可对比的上一代」，error 是桥接自身故障，
-- 两者都不是 RSI 的判定结果（improved/not_improved/refused/undecidable）。
CREATE TABLE IF NOT EXISTS policy_rsi_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  judge_run_id      INTEGER NOT NULL,
  session_id        TEXT    NOT NULL,
  generation        INTEGER NOT NULL,
  prev_generation   INTEGER,
  verdict           TEXT    NOT NULL
                              CHECK (verdict IN ('improved', 'not_improved', 'refused',
                                                  'undecidable', 'skipped', 'error')),
  exit_code         INTEGER,
  reasons_json      TEXT,
  metrics_json      TEXT,
  prev_readings_json  TEXT,
  next_readings_json  TEXT,
  -- 本代 manifest 的**原文**。下一代做 prev 时必须复用它，不能从 verdicts 重建：
  -- krsi 的 R6 会比对链上已记录的同一代 manifest，重建出的字节只要有一处不同
  -- 就会被判「同一代有两份 manifest」而整代拒收。
  next_manifest_json  TEXT,
  ledger_path       TEXT,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_policy_rsi_runs_session ON policy_rsi_runs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_policy_rsi_runs_generation ON policy_rsi_runs(session_id, generation DESC);
CREATE INDEX IF NOT EXISTS idx_policy_rsi_runs_judge ON policy_rsi_runs(judge_run_id);

-- ── 可观测面：工作区快照 / 运行轨迹 / 技能库 ──────────────────────────────
-- 三张表对应「能力洞察」观测层的三个支柱：可回滚（checkpoint）、可回放（trace）、
-- 可复用（skills）。全部默认关闭，由 env 开关控制；关闭时 API 返回 enabled:false。

-- 工作区快照：Agent 每轮文件修改前自动捕获，可按 id 回滚。
-- DB 只记清单与内容寻址（sha256 + blob 相对路径），文件正文落 data/checkpoints/<id>/。
-- 快照本身也要能被审计，因此不在 DB 里复制一份文件正文。
CREATE TABLE IF NOT EXISTS workspace_checkpoints (
  id                  TEXT    PRIMARY KEY,
  session_id          TEXT    NOT NULL,
  label               TEXT    NOT NULL DEFAULT '',
  root                TEXT    NOT NULL,
  file_count          INTEGER NOT NULL DEFAULT 0,
  total_bytes         INTEGER NOT NULL DEFAULT 0,
  manifest_json       TEXT    NOT NULL DEFAULT '[]',
  created_at          INTEGER NOT NULL,
  -- ── run 级证据链（R6）───────────────────────────────────────────────
  run_id              TEXT,
  step                INTEGER,
  tool_call_ids_json  TEXT    NOT NULL DEFAULT '[]',
  after_manifest_json TEXT,
  diff_json           TEXT,
  status              TEXT    NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'pruned')),
  restored_at         INTEGER,
  restore_json        TEXT,
  pinned              INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_workspace_checkpoints_session
  ON workspace_checkpoints(session_id, created_at DESC);
-- 注意：run_id/step 是 v4 才补的列，旧库在此刻还没有它们；该索引必须在
-- applyMigrations 补列之后再建，否则启动即 "no such column: run_id"。

-- ── RunState（run 级结构化状态）────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id      TEXT    PRIMARY KEY,
  session_id  TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'ok', 'error', 'aborted')),
  provider    TEXT    NOT NULL DEFAULT '',
  model       TEXT    NOT NULL DEFAULT '',
  channel     TEXT,
  state_json  TEXT    NOT NULL DEFAULT '{}',
  report_json TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);

-- ── 独立复核（只喂事实）────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_reviews (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT,
  session_id        TEXT    NOT NULL,
  call_id           TEXT    NOT NULL,
  mode              TEXT    NOT NULL CHECK (mode IN ('sync', 'async')),
  status            TEXT    NOT NULL CHECK (status IN ('confirmed', 'underestimated', 'unexec')),
  findings_json     TEXT    NOT NULL DEFAULT '[]',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  provider          TEXT    NOT NULL DEFAULT '',
  model             TEXT    NOT NULL DEFAULT '',
  reason            TEXT,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_reviews_run  ON agent_reviews(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_reviews_call ON agent_reviews(call_id);

-- ── 沙箱按目录授权（首次访问弹一次，记住后不再弹）────────────────────
CREATE TABLE IF NOT EXISTS sandbox_grants (
  id           TEXT    PRIMARY KEY,
  dir          TEXT    NOT NULL,
  real_path    TEXT    NOT NULL,
  sensitive    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sandbox_grants_dir  ON sandbox_grants(real_path);
CREATE INDEX IF NOT EXISTS idx_sandbox_grants_active ON sandbox_grants(revoked_at);

-- 运行轨迹：一次 Agent 运行 = 1 条 trace，其下若干 span。
-- span 的 kind 与判据塔闭环三段对齐：act（工具动作）/ judge（判决）/ update（策略更新）。
CREATE TABLE IF NOT EXISTS agent_traces (
  id         TEXT    PRIMARY KEY,
  session_id TEXT    NOT NULL,
  root_name  TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'ok', 'error')),
  span_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_traces_session ON agent_traces(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_traces_started ON agent_traces(started_at DESC);

CREATE TABLE IF NOT EXISTS agent_trace_spans (
  id          TEXT    PRIMARY KEY,
  trace_id    TEXT    NOT NULL REFERENCES agent_traces(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('act', 'judge', 'update')),
  name        TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  detail      TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_trace ON agent_trace_spans(trace_id, seq);

-- 程序化技能库：可复用的解题步骤，支持按描述/标签匹配。
CREATE TABLE IF NOT EXISTS skills (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  description TEXT    NOT NULL DEFAULT '',
  tags_json   TEXT    NOT NULL DEFAULT '[]',
  steps_json  TEXT    NOT NULL DEFAULT '[]',
  match_score REAL    NOT NULL DEFAULT 0.7,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);

-- 注：judge_* / policy_injections 刻意不建指向 sessions 的外键。
-- 它们是审计记录，价值在于「会话删了以后仍然能复盘当时的判决」，
-- 跟随级联删除会让证据链断掉。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES (1, '001-initial-agent-schema', 1761234567890);
`;

export const SCHEMA_VERSION = 5;

/**
 * 增量迁移（幂等）。`SCHEMA_SQL` 只管「从零建表」，已有库的列变更必须走这里 ——
 * `CREATE TABLE IF NOT EXISTS` 对已存在的表是 no-op，永远不会补列。
 *
 * 每条迁移都必须可重复执行：进程每次启动都会跑一遍，旧库、新库、半新库都会进来。
 * SQLite 的 `ADD COLUMN` 是元数据操作（不改既有行、不重写表），因此对既有
 * 判决行是零影响的 —— 这也是本迁移可以无条件执行的前提。
 *
 * @returns 本次真正新应用的版本号（便于启动日志与测试断言）
 */
export function applyMigrations(db: MigrationDb): number[] {
  const applied: number[] = [];

  // ── 002：judge_runs.parent_run —— L2 LLM 深判的父子关系 ────────────────
  // 深判不改写原判决（原行是不可变的证据），而是新增一行指向它的子判决。
  // 因此需要 parent_run：既用于「同一 run 的深判幂等复用」，也用于
  // 「统计时排除深判行、不污染原口径」。
  const columns = db.all<{ name: string }>('PRAGMA table_info(judge_runs)');
  if (!columns.some((c) => c.name === 'parent_run')) {
    db.exec('ALTER TABLE judge_runs ADD COLUMN parent_run INTEGER');
  }
  // 部分索引：绝大多数行（规则判决）parent_run IS NULL，不占索引空间。
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_judge_runs_parent
       ON judge_runs(parent_run) WHERE parent_run IS NOT NULL`,
  );
  const already = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 2');
  if ((already?.n ?? 0) === 0) {
    db.run(
      `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (2, '002-judge-deep-parent-run', ?)`,
      [Date.now()],
    );
    applied.push(2);
  }

  // ── 003：可观测面三表（workspace_checkpoints / agent_traces / skills）────
  // 这三张表对旧库是「表整体不存在」，不是「列缺失」，因此 `SCHEMA_SQL` 里的
  // `CREATE TABLE IF NOT EXISTS` 在每次启动时就已经把表补齐了（该语句幂等）。
  // 这里只做两件启动期必须保证的事：① 索引（SCHEMA_SQL 已含，同样幂等，
  // 但显式再声明一次可以让「索引属于本迁移」这件事在代码里可见）；
  // ② 版本记账 —— 否则老库升上来后无法区分「有这三张表」和「本来就有」。
  db.exec('CREATE INDEX IF NOT EXISTS idx_workspace_checkpoints_session ON workspace_checkpoints(session_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_traces_session ON agent_traces(session_id, started_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_trace ON agent_trace_spans(trace_id, seq)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name)');
  const v3 = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 3');
  if ((v3?.n ?? 0) === 0) {
    db.run(
      `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (3, '003-observability-surfaces', ?)`,
      [Date.now()],
    );
    applied.push(3);
  }

  // ── 004：run 级证据链 + RunState + 复核 + 目录授权 ───────────────────────
  // 旧库的 workspace_checkpoints 只有 9 列；新列必须逐列 ADD（CREATE IF NOT EXISTS 不会补列）。
  // 新表（agent_runs / agent_reviews / sandbox_grants）已由 SCHEMA_SQL 幂等建出。
  const ckptColumns = db.all<{ name: string }>('PRAGMA table_info(workspace_checkpoints)');
  const ckptNames = new Set(ckptColumns.map((c) => c.name));
  const addCkptColumn = (name: string, ddl: string): void => {
    if (!ckptNames.has(name)) db.exec(`ALTER TABLE workspace_checkpoints ADD COLUMN ${ddl}`);
  };
  addCkptColumn('run_id', 'run_id TEXT');
  addCkptColumn('step', 'step INTEGER');
  addCkptColumn('tool_call_ids_json', `tool_call_ids_json TEXT NOT NULL DEFAULT '[]'`);
  addCkptColumn('after_manifest_json', 'after_manifest_json TEXT');
  addCkptColumn('diff_json', 'diff_json TEXT');
  // 带 CHECK 的列在 ADD COLUMN 上不引入约束（SQLite 限制），用默认值 + 应用层校验兜底。
  addCkptColumn('status', `status TEXT NOT NULL DEFAULT 'active'`);
  addCkptColumn('restored_at', 'restored_at INTEGER');
  addCkptColumn('restore_json', 'restore_json TEXT');
  addCkptColumn('pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_workspace_checkpoints_run ON workspace_checkpoints(run_id, step)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, started_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_reviews_run ON agent_reviews(run_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_reviews_call ON agent_reviews(call_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sandbox_grants_dir ON sandbox_grants(real_path)');

  const v4 = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 4');
  if ((v4?.n ?? 0) === 0) {
    db.run(
      `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (4, '004-run-evidence-chain', ?)`,
      [Date.now()],
    );
    applied.push(4);
  }

  // ── 005：RSI 对账旁路（policy_rsi_runs）──────────────────────────────────
  // 新表已由 SCHEMA_SQL 里的 CREATE TABLE IF NOT EXISTS 幂等建出（L1 旁路审计）。
  // 这里显式保证索引 + 版本记账，旧库升上来后不会漏。
  db.exec('CREATE INDEX IF NOT EXISTS idx_policy_rsi_runs_session ON policy_rsi_runs(session_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_policy_rsi_runs_generation ON policy_rsi_runs(session_id, generation DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_policy_rsi_runs_judge ON policy_rsi_runs(judge_run_id)');
  // 006：policy_rsi_runs.next_manifest_json —— 复用上一代 manifest 原文
  // （CREATE IF NOT EXISTS 不会给旧表补列，必须显式 ADD）
  const rsiColumns = db.all<{ name: string }>('PRAGMA table_info(policy_rsi_runs)');
  if (rsiColumns.length > 0 && !rsiColumns.some((c) => c.name === 'next_manifest_json')) {
    db.exec('ALTER TABLE policy_rsi_runs ADD COLUMN next_manifest_json TEXT');
  }
  const v6 = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 6');
  if ((v6?.n ?? 0) === 0) {
    db.run(
      `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (6, '006-rsi-manifest-reuse', ?)`,
      [Date.now()],
    );
    applied.push(6);
  }
  const v5 = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 5');
  if ((v5?.n ?? 0) === 0) {
    db.run(
      `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (5, '005-rsi-bridge-l1', ?)`,
      [Date.now()],
    );
    applied.push(5);
  }

  // ── 007：judge_verdicts.data_json —— 判据的结构化读数 ────────────────────
  // 在此之前只有 detail 文本（如「固定评测套件 21/23 通过…」），看板要拿分母
  // 只能正则解析这句话，文案一改前端就断。结构化的分母/通过数/套件清单改走这一列。
  // 旧库补列后旧行是 NULL，读侧必须容忍（overview 会退化成 detail_only）。
  const verdictColumns = db.all<{ name: string }>('PRAGMA table_info(judge_verdicts)');
  if (verdictColumns.length > 0 && !verdictColumns.some((c) => c.name === 'data_json')) {
    db.exec('ALTER TABLE judge_verdicts ADD COLUMN data_json TEXT');
  }
  const v7 = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 7');
  if ((v7?.n ?? 0) === 0) {
    db.run(
      `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (7, '007-judge-verdict-data', ?)`,
      [Date.now()],
    );
    applied.push(7);
  }

  return applied;
}

/** `applyMigrations` 需要的最小 DB 表面（结构类型，避免 schema ↔ db 的导入环）。 */
export interface MigrationDb {
  exec(sql: string): void;
  run(sql: string, params?: unknown): unknown;
  get<T>(sql: string, params?: unknown): T | undefined;
  all<T>(sql: string, params?: unknown): T[];
}

/**
 * Number of application tables declared in SCHEMA_SQL. The health check uses
 * this instead of a hard-coded magic number so the "all tables present" gate
 * cannot silently drift when a migration adds a table (AUDIT-026: the check
 * used `>= 7` while the schema actually defines nine).
 */
export const EXPECTED_TABLE_COUNT = (SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length;

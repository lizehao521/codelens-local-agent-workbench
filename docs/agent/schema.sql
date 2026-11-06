-- =============================================================================
-- schema.sql —— CodeLens Agent 工具调用平台 v2.1
-- 7 张表（Spec §6 锁定口径）：
--   sessions / messages / tool_calls / tool_results /
--   approvals / provider_capabilities / schema_migrations
-- 不建：artifacts（由 tool_results.artifact_path 承载）、local_events（埋点走前端）
--
-- 目标：node:sqlite（DatabaseSync），可直接 db.exec() 执行；幂等（IF NOT EXISTS）
-- 对应文档：docs/agent/phase1-architecture.md §7.2
--            docs/agent/phase2-architecture-detail.md §2
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1/7  sessions —— 会话主记录 + 恢复凭证（只存哈希，ADR-022）
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sessions (
  id                     TEXT PRIMARY KEY,            -- uuid v4
  title                  TEXT    NOT NULL DEFAULT '新会话',
  provider               TEXT    NOT NULL,
  model                  TEXT    NOT NULL,
  channel_mode           TEXT    NOT NULL DEFAULT 'auto'
                                 CHECK (channel_mode IN ('auto', 'native', 'react')),
  degraded               INTEGER NOT NULL DEFAULT 0,  -- 0/1：是否已降级到 ReAct
  message_count          INTEGER NOT NULL DEFAULT 0,
  total_tokens           INTEGER NOT NULL DEFAULT 0,
  device_token_hash      TEXT,                        -- SHA-256，同浏览器自动关联
  recovery_code_hash     TEXT,                        -- SHA-256，8 位恢复码（单次使用）
  recovery_code_used_at  INTEGER,                     -- 非 NULL = 已用过，再次使用即拒绝
  recovery_failed_count  INTEGER NOT NULL DEFAULT 0,  -- 连续失败计数（成功归零）
  recovery_locked_until  INTEGER,                     -- 锁定截止 epoch ms（连错 5 次 → +15min）
  summary                TEXT,                        -- 锚点清单 JSON
  created_at             INTEGER NOT NULL,            -- epoch ms
  updated_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_device   ON sessions(device_token_hash);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2/7  messages —— content 纯文本 + segments_json 分段结构（跨文档裁决 C-6）
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,                 -- uuid v4
  session_id        TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,                 -- 会话内递增，从 1 开始
  role              TEXT    NOT NULL
                            CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content           TEXT    NOT NULL DEFAULT '',      -- 纯文本（检索/摘要用）
  segments_json     TEXT,                             -- [{type:'text',text}|{type:'tool',callId}]
  reasoning_content TEXT,                             -- 思维链（思考模式保留，DeepSeek/Kimi 必回填）
  tool_calls_json   TEXT,                             -- assistant 消息 tool_calls 原文
  tool_call_id      TEXT,                             -- role=tool 消息的关联 ID
  finish_reason     TEXT,                             -- stop|tool_calls|length|max_iterations|...
  usage_json        TEXT,                             -- {promptTokens, completionTokens}
  tokens            INTEGER NOT NULL DEFAULT 0,       -- token 估算（§7.4）
  is_summary        INTEGER NOT NULL DEFAULT 0,       -- 1 = 压缩摘要消息
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq    ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_session_seq ON messages(session_id, seq);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3/7  tool_calls —— 工具调用审计（一等公民，只追加）
--      status 七值：pending|running|success|failed|timeout|rejected|skipped
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tool_calls (
  id             TEXT PRIMARY KEY,                    -- uuid v4
  session_id     TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id     TEXT             REFERENCES messages(id) ON DELETE SET NULL,
  call_id        TEXT    NOT NULL,                    -- 传给 LLM 的 tool_call_id
  tool_name      TEXT    NOT NULL,                    -- 规范名（点号），落库/展示/检索口径
  tool_wire_name TEXT    NOT NULL,                    -- 线上名（下划线），回程反查核对用
  display_name   TEXT    NOT NULL,
  category       TEXT    NOT NULL CHECK (category IN ('http', 'file', 'compute', 'mcp')),
  source         TEXT    NOT NULL CHECK (source IN ('builtin', 'mcp')),
  risk           TEXT    NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  approval_mode  TEXT    NOT NULL CHECK (approval_mode IN ('none', 'soft', 'hard', 'two_step')),
  channel        TEXT    NOT NULL CHECK (channel IN ('native', 'react')),
  iteration      INTEGER NOT NULL DEFAULT 0,          -- 第几轮迭代（从 1 开始）
  args_json      TEXT    NOT NULL DEFAULT '{}',       -- 参数原文（脱敏后，截断到 8KB）
  args_digest    TEXT,                                -- 参数规范化 SHA-256（循环检测 + 审批绑定）
  status         TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'running', 'success',
                                            'failed', 'timeout', 'rejected', 'skipped')),
  error_kind     TEXT,                                -- invalid_args|not_found|security|timeout|rate_limit|network|upstream|mcp|circuit_open|internal|revised
                                                      -- 注：revised 仅用于「被改参数重提」的作废行，不出现在 SSE error 载荷
  error_msg      TEXT,                                -- 脱敏可读信息（不含堆栈/绝对路径/Key）
  result_ref     TEXT,                                -- → tool_results.id
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 4/7  tool_results —— 结果外置（artifacts 表不建，由本表 artifact_path 承载）
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tool_results (
  id             TEXT PRIMARY KEY,                    -- uuid v4（= tool_calls.result_ref）
  tool_call_id   TEXT    NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  inline_preview TEXT,                                -- 进上下文的预览片段（≤4000 字符）
  artifact_path  TEXT,                                -- 完整结果落盘路径（相对 SANDBOX_ROOT）
  bytes          INTEGER NOT NULL DEFAULT 0,
  truncated      INTEGER NOT NULL DEFAULT 0,          -- 1 = 预览被截断，完整内容在 artifact_path
  sha256         TEXT,                                -- 完整结果 SHA-256（回查校验）
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_toolresults_call ON tool_results(tool_call_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5/7  approvals —— 审批挑战 + 决定（AC-04 第三攻击场景 / AC-06 不可篡改）
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS approvals (
  id                    TEXT PRIMARY KEY,             -- 挑战 ID（事件里的 approvalId，前缀 ap_）
  session_id            TEXT    NOT NULL REFERENCES sessions(id)   ON DELETE CASCADE,
  tool_call_id          TEXT    NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  tool_name             TEXT    NOT NULL,             -- 规范名
  args_digest           TEXT    NOT NULL,             -- 参数规范化 SHA-256（与 tool_calls 一致）
  challenge_token_hash  TEXT    NOT NULL,             -- 签发令牌的 SHA-256（不存明文）
  status                TEXT    NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'decided', 'expired',
                                                   'aborted', 'revised')),
  decision              TEXT             CHECK (decision IN ('allow_once', 'allow_session',
                                                            'reject', 'revised')),
                                                   -- 'revised' = 被改参数重提（非用户决定，仅作审计终态）
  reason                TEXT,                         -- 拒绝原因（用户填写）
  mismatch_count        INTEGER NOT NULL DEFAULT 0,   -- 令牌/摘要不匹配的提交次数（异常审计）
  last_mismatch_at      INTEGER,
  last_mismatch_detail  TEXT,                         -- TOKEN_MISMATCH|ARGS_MISMATCH|EXPIRED|NOT_PENDING
  -- 「改参数重试」链：revise 后旧记录置 status='revised'（decision 保持 NULL），
  -- 新记录用 revised_from_id 指回上一版；revise_depth 用于 ≤3 次上限（防无限改参数）
  revised_from_id       TEXT,
  revise_depth          INTEGER NOT NULL DEFAULT 0,
  expires_at            INTEGER NOT NULL,             -- 令牌过期（签发 +300s）
  decided_at            INTEGER,
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_call    ON approvals(tool_call_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status  ON approvals(status, expires_at);

-- 决定一次性写入：decision 落定后不可改写（数据库级兜底，配合 repository 层的
-- `UPDATE ... WHERE id=? AND decision IS NULL` 影响行数断言）
CREATE TRIGGER IF NOT EXISTS trg_approvals_decision_once
BEFORE UPDATE OF decision ON approvals
WHEN OLD.decision IS NOT NULL AND NEW.decision IS NOT OLD.decision
BEGIN
  SELECT RAISE(ABORT, 'APPROVAL_DECISION_IMMUTABLE');
END;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6/9  provider_capabilities —— function calling 能力探测（按 (provider, model)）
--      三态：supported / unsupported / failed（网络或鉴权失败 ≠ 不支持）
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS provider_capabilities (
  provider                     TEXT    NOT NULL,
  model                        TEXT    NOT NULL,
  supports_function_calling    INTEGER,                -- 1 支持 / 0 不支持 / NULL 未知
  probe_status                 TEXT    NOT NULL DEFAULT 'unknown'
                                       CHECK (probe_status IN ('unknown', 'supported',
                                                               'unsupported', 'failed')),
  context_window               INTEGER,                -- 保守取值；NULL 用 provider 默认
  lightweight_model            TEXT,                   -- 压缩摘要用的便宜型号（OD-A3）
  tool_choice_values_json      TEXT,                   -- ["auto","none","required","named"]
  retain_reasoning_content     INTEGER NOT NULL DEFAULT 0,
  require_tool_stream_flag     INTEGER NOT NULL DEFAULT 0,
  explicit_parallel_tool_calls INTEGER NOT NULL DEFAULT 0,
  probed_at                    INTEGER,
  notes                        TEXT,                   -- 探测失败原因 / 官方文档注（脱敏）
  PRIMARY KEY (provider, model)
);

CREATE INDEX IF NOT EXISTS idx_capabilities_probed ON provider_capabilities(probed_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 7/9  provider_models —— 上游模型同步：最近一次成功快照
--      （重启后首拉前仍有上次数据作为兜底合并；来源 MODEL_SOURCE_URL）
-- ═══════════════════════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 8/9  model_sync_log —— 每次同步尝试的状态/异常记录（成功/失败/禁用）
-- ═══════════════════════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 9/9  schema_migrations —— 迁移版本（只增不改，失败即拒绝启动）
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
);

-- 初始迁移版本记录（幂等）
INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES (1, '001-initial-agent-schema', 1761234567890);

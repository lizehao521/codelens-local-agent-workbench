# Phase 2 架构细化文档：API 详细设计 + DB Schema + 模块文件级设计

> 版本：v2.1 / 2026-10-22
> 上游契约：`docs/agent/spec.md`（**唯一契约**）／`docs/agent/phase1-prd.md`（需求权威）／`docs/agent/phase1-architecture.md`（架构基线）
> 本文地位：Phase 2 开发唯一细粒度依据。与 Spec 冲突时**以 Spec 为准**并回报项目总监。
> 配套机器可读产出：`docs/agent/openapi.yaml`（API 契约）、`docs/agent/schema.sql`（可直接执行的建表 SQL）

---

## 0. 本文范围与三条硬约束

| 约束 | 内容 |
|------|------|
| 只写文档 | 本阶段**禁止改动** `client/` 与 `server/` 任何代码；禁止修改 `spec.md` / `phase1-prd.md` / `phase1-uiux.md` / `docs/` 下 v1.0 文档 |
| 图标 | 唯一图标库 lucide-react 1.60.0，**只用规范名**（`CircleCheck`/`CircleX`/`TriangleAlert`），禁止 emoji 作功能图标 |
| 代码组织 | 分层依赖只向下；单文件 ≤300 行；入口（`app.ts` / `main.tsx` / `App.tsx`）只装配零业务 |

---

## 1. 端点总表（含本期不实现标注）

Spec §5 表格共 20 行（`/mcp/servers/:id/connect` 与 `/disconnect` 合占一行），展开后 **21 个可调用端点**，本文逐个落定。

| # | Method | Path | 状态 | 本文章节 |
|---|--------|------|------|----------|
| 1 | GET | `/api/health` | 实现 | §3.3.1 |
| 2 | GET | `/api/v1/providers` | 实现 | §3.3.2 |
| 3 | GET | `/api/v1/providers/capabilities` | 实现 | §3.3.3 |
| 4 | GET | `/api/v1/sessions` | 实现 | §3.3.4 |
| 5 | POST | `/api/v1/sessions` | 实现 | §3.3.5 |
| 6 | POST | `/api/v1/sessions/recover` | 实现 | §3.3.6 |
| 7 | POST | `/api/v1/sessions/:id/recovery-code` | 实现 | §3.3.7 |
| 8 | GET | `/api/v1/sessions/:id` | 实现 | §3.3.8 |
| 9 | PATCH | `/api/v1/sessions/:id` | 实现 | §3.3.9 |
| 10 | DELETE | `/api/v1/sessions/:id` | 实现 | §3.3.10 |
| 11 | **POST** | **`/api/v1/agent/stream`**（SSE 主端点） | 实现 | §3.3.11 + §4 全章 |
| 12 | POST | `/api/v1/approvals/:id` | 实现 | §3.3.12 + §5 全章 |
| 13 | POST | `/api/v1/agent/abort` | 实现 | §3.3.13 |
| 14 | GET | `/api/v1/tools` | 实现 | §3.3.14 |
| 15 | PATCH | `/api/v1/tools/:name` | 实现 | §3.3.15 |
| 16 | GET | `/api/v1/mcp/servers` | 实现 | §3.3.16 |
| 17 | POST | `/api/v1/mcp/servers` | 实现 | §3.3.17 |
| 18 | PATCH | `/api/v1/mcp/servers/:id` | 实现 | §3.3.18 |
| 19 | DELETE | `/api/v1/mcp/servers/:id` | 实现 | §3.3.19 |
| 20 | POST | `/api/v1/mcp/servers/:id/connect` | 实现 | §3.3.20 |
| 21 | POST | `/api/v1/mcp/servers/:id/disconnect` | 实现 | §3.3.21 |
| — | POST | `/api/v1/events` | **本期不实现**（Spec §3：埋点沿用前端本地事件日志，服务端不落库；`local_events` 表不建） | §3.4 |
| — | GET | `/api/v1/events` | **本期不实现**（同上） | §3.4 |

> **端点总数 23**（Spec §5 锁定；2026-10-24 按 routes/index.ts 实际挂载校对：health 1 + agent 4 + sessions 7 + tools 2 + mcp 6 + providers 3，其中 `GET /api/v1/providers/sync-status` 为后补的上游同步状态端点）。AC-10 的「改参数重试」**不新增端点**的历史裁决已作废——现行实现是独立端点 `POST /api/v1/approvals/:id/revise`（见 §3.3.13）。

---

## 2. 数据库 Schema（9 张表）

**完整可执行 DDL 见 `docs/agent/schema.sql`**（本文不复制第二份，避免漂移）。架构文档 §7.2 为本节的叙述版。

| # | 表 | 主键 | 关键外键 | 索引 | 承载的验收标准 |
|---|----|------|----------|------|----------------|
| 1 | `sessions` | `id` (uuid) | — | `idx_sessions_updated(updated_at DESC)`、`idx_sessions_device(device_token_hash)` | AC-05（恢复码/锁定计数器） |
| 2 | `messages` | `id` (uuid) | `session_id`→sessions CASCADE | `idx_messages_session_seq`、`idx_messages_session_created`、`uq_messages_session_seq(session_id,seq)` | AC-05、AC-09（C-6 分段） |
| 3 | `tool_calls` | `id` (uuid) | `session_id` CASCADE；`message_id` SET NULL | `idx_toolcalls_session`、`idx_toolcalls_message`、`idx_toolcalls_name_status`、`idx_toolcalls_digest(session_id,tool_name,args_digest)` | AC-03、AC-06、AC-13 |
| 4 | `tool_results` | `id` (uuid) | `tool_call_id`→tool_calls CASCADE | `idx_toolresults_call` | AC-03（结果外置回查） |
| 5 | `approvals` | `id` (`ap_` 前缀) | `session_id` CASCADE；`tool_call_id` CASCADE | `idx_approvals_session`、`idx_approvals_call`、`idx_approvals_status(status,expires_at)`；触发器 `trg_approvals_decision_once` | **AC-04 第三场景、AC-06** |
| 6 | `provider_capabilities` | `(provider, model)` 复合主键 | — | `idx_capabilities_probed(probed_at DESC)` | AC-01 |
| 7 | `provider_models` | `(provider, model)` 复合主键 | — | 主键 | 上游模型同步快照（重启兜底） |
| 8 | `model_sync_log` | `id` 自增 | — | `idx_model_sync_log_occurred(occurred_at DESC)` | 同步状态可观测（providers/sync-status） |
| 9 | `schema_migrations` | `version` | — | 主键 | 启动自检 |

### 2.1 关键落库规则（逐条可验收）

1. **规范名落库**：`tool_calls.tool_name` 存**规范名（点号）**；`tool_wire_name` 存线上名仅供回程核对。卡片展示 = 审计检索 = DB 记录，三者同一口径（AC-13）。
2. **结果外置**：单次结果序列化后 > `4000 字符` 进上下文阈值时，完整内容写入 `SANDBOX_ROOT/.artifacts/<toolCallId>.json`，`tool_results.inline_preview` 只留前 4000 字符 + `truncated=1` + `sha256` + `bytes`；`tool_calls.result_ref` 指向 `tool_results.id`。`fs.read` 可按 `artifact_path` 直接回查（零新增工具）。
3. **审批不可篡改**：`approvals.decision` 只在 `decision IS NULL` 时写入；repository 用 `UPDATE approvals SET decision=?,... WHERE id=? AND decision IS NULL`，**影响行数 ≠ 1 即抛 `APPROVAL_ALREADY_DECIDED`**；数据库层由 `trg_approvals_decision_once` 触发器兜底（Spec AC-06）。
4. **令牌与参数只存哈希**：`challenge_token_hash`（令牌 SHA-256）、`args_digest`（参数规范化 SHA-256）。DB 文件泄露也伪造不出一次批准。
5. **恢复码只存哈希 + 恒定时间比较**：`crypto.timingSafeEqual`；连错 5 次写 `recovery_locked_until = now + 900000`，成功即 `recovery_failed_count = 0`。
6. **审计只追加**：`tool_calls` / `approvals` 不提供 UPDATE/DELETE 端点；用户只能整体清除 DB 文件。

---

## 3. API 详细设计

### 3.1 公共约定

**统一前缀**：`/api/v1`（`health` 除外）。

**成功响应**：直接返回业务对象（不包 `{code,data,message}` 信封——沿用 v1.0 既有前端消费方式；Spec §5 只锁定**错误**格式）。分页统一为 `{ items, total, limit, offset, hasMore }`。

**错误响应**（Spec §5 锁定）：
```json
{ "error": { "code": "SESSION_NOT_FOUND", "message": "会话不存在或已被删除" } }
```

**鉴权**：免登录。BYOK 的 `apiKey` 走 **body 字段**（`AgentRequest.apiKey`），服务端 `env.LLM_SERVER_API_KEY` 兜底；设备令牌走 `X-Device-Token` 请求头（可选，缺失则按「无设备关联」处理）。

**限流**：沿用 `middlewares/rate-limit.ts` 滑动窗口；`/api/v1/agent/stream` 另加 `middlewares/agent-concurrency.ts`（按 IP 并发 ≤ `AGENT_MAX_CONCURRENT=3`），超限返回 `429 AGENT_BUSY`。

**时间与 ID 口径**：所有时间戳为 **epoch 毫秒整数**；`id` 为 uuid v4； approvalId 前缀 `ap_`、callId 前缀 `call_`、resultId 前缀 `r_`、messageId 前缀 `m_`。

### 3.2 错误码总表（服务端 `utils/errors.ts` 扩展）

| code | HTTP | 触发 | 可重试 |
|------|------|------|--------|
| `VALIDATION_ERROR` | 400 | zod 校验失败（含字段级明细） | 否 |
| `PAYLOAD_TOO_LARGE` | 413 | body > 64KB / 单条 message > 32000 字符 | 否 |
| `MISSING_API_KEY` | 401（JSON 端点）／**200 + SSE `error` 事件**（`/agent/stream`） | body 与 env 均无 Key | 否 |
| `NOT_FOUND` | 404 | 通用资源不存在 | 否 |
| `SESSION_NOT_FOUND` | 404 | `sessionId` 不存在 | 否 |
| `RECOVERY_CODE_INVALID` | 404 | 恢复码哈希不匹配 / 已使用 / 已重新生成 | 否 |
| `RECOVERY_LOCKED` | 423 | 连续 5 次失败，锁定中 | 否（响应带 `retryAfterMs`） |
| `APPROVAL_NOT_FOUND` | 404 | `approvalId` 不存在 | 否 |
| `APPROVAL_EXPIRED` | 410 | `now > expires_at` | 否 |
| `APPROVAL_ALREADY_DECIDED` | 409 | 重复提交决定 | 否 |
| **`APPROVAL_TOKEN_MISMATCH`** | **409** | 令牌哈希不匹配（AC-04 第三攻击场景） | 否（**同时写异常审计**） |
| **`APPROVAL_ARGS_MISMATCH`** | **409** | 令牌匹配但参数摘要与服务端持有值不符 | 否（**同时写异常审计**） |
| `TOOL_NOT_FOUND` | 404 | 工具名（含反查失败）不在注册表 | 否 |
| `TOOL_DISABLED` | 409 | 工具已禁用 | 否 |
| `AGENT_BUSY` | 429 | 并发超限 | 是（稍后） |
| `UPSTREAM_*` | 502/504 | 见架构 §9.4 | 视具体 |
| `MCP_SERVER_NOT_FOUND` | 404 | MCP Server 配置不存在 | 否 |
| `MCP_COMMAND_INVALID` | 400 | command 含 shell 元字符 / cwd 不存在 | 否 |
| `MCP_CONNECT_FAILED` | 502 | stdio 连接失败 | 是 |
| `INTERNAL_ERROR` | 500 | 兜底 | 否 |

> **`MISSING_API_KEY` 的双形态（易错点 #1）**：Spec §12 第 6 步断言「SSE 含 `event: error` + `MISSING_API_KEY`」。因此 `/agent/stream` 的错误分两段：**写 SSE 响应头之前**的失败（body 非法 JSON、zod 校验失败、并发超限）走 HTTP 4xx JSON；**写头之后**的一切失败（含 Key 缺失、上游 401/502）一律走 SSE `error` 事件，HTTP 状态保持 200。其它 JSON 端点的 Key 缺失仍是 401。

### 3.3 端点逐个落定

#### 3.3.1 `GET /api/health`

**请求**：无。**响应 200**：
```json
{
  "status": "ok",
  "uptime": 128374,
  "version": "2.1.0",
  "db": { "ok": true, "sizeBytes": 2097152, "degraded": false, "tables": 7 },
  "mcp": { "servers": 2, "healthy": 1 },
  "sandbox": { "rootConfigured": true, "writable": true }
}
```
**zod**：无入参。DB 不可用时 `status="degraded"`、`db.ok=false`，HTTP 仍 200（架构 §9.6：不静默降级，但也不因此拒绝启动）。

#### 3.3.2 `GET /api/v1/providers`

**响应 200**：
```json
{
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "baseUrl": "https://api.deepseek.com",
      "models": ["deepseek-v4-pro", "deepseek-v4-flash"],
      "defaultModel": "deepseek-v4-pro",
      "docsUrl": "https://api-docs.deepseek.com",
      "capabilities": {
        "nativeTools": true,
        "toolChoiceValues": ["auto", "none", "required", "named"],
        "contextWindow": 65536,
        "retainReasoningContent": true,
        "requireToolStreamFlag": false,
        "explicitParallelToolCalls": false
      }
    }
  ]
}
```
**zod**：无入参。`capabilities` 为内存能力表（§5.3）与 `provider_capabilities` 探测结果的合并视图：**探测结果优先，未探测时用能力表静态默认值**。

#### 3.3.3 `GET /api/v1/providers/capabilities`

**响应 200**：
```json
{
  "capabilities": [
    {
      "provider": "deepseek",
      "model": "deepseek-v4-pro",
      "supportsFunctionCalling": true,
      "probeStatus": "supported",
      "contextWindow": 65536,
      "lightweightModel": "deepseek-v4-flash",
      "probedAt": 1761234567890,
      "notes": null
    },
    {
      "provider": "deepseek",
      "model": "deepseek-reasoner",
      "supportsFunctionCalling": false,
      "probeStatus": "unsupported",
      "contextWindow": 65536,
      "lightweightModel": null,
      "probedAt": 1761234000000,
      "notes": "推理模型不支持 Function Calling，自动走 ReAct 通道"
    }
  ]
}
```
**zod**：无入参。**查询**：`SELECT * FROM provider_capabilities ORDER BY probed_at DESC`。未探测的 `(provider, model)` 不出现在列表里（前端据此决定是否触发探测）。

#### 3.3.4 `GET /api/v1/sessions`

**Query**：`?limit=20&offset=0`（zod：`limit` 1-100 默认 20；`offset` ≥0 默认 0）。
**响应 200**：
```json
{
  "items": [
    { "id": "b7c1e2f0-...", "title": "读 CSV 算均值", "provider": "deepseek",
      "model": "deepseek-v4-pro", "messageCount": 12, "totalTokens": 18420,
      "updatedAt": 1761234567890, "createdAt": 1761234000000 }
  ],
  "total": 37, "limit": 20, "offset": 0, "hasMore": true
}
```
**设备关联**：请求带 `X-Device-Token` 时按 `device_token_hash` 过滤；不带则返回全部（本地单用户定位，架构 §10.8）。

#### 3.3.5 `POST /api/v1/sessions`

**请求**：
```json
{ "provider": "deepseek", "model": "deepseek-v4-pro", "title": "读 CSV 算均值" }
```
**zod**：`provider` 1-64 必填；`model` 1-128 必填；`title` 可选 ≤200 字符（不传则 `'新会话'`）。

**响应 201**：
```json
{
  "session": {
    "id": "b7c1e2f0-4a55-4f0e-9c3d-8e1a-2b3c4d5e6f70",
    "title": "读 CSV 算均值", "provider": "deepseek", "model": "deepseek-v4-pro",
    "channelMode": "auto", "degraded": false, "messageCount": 0, "totalTokens": 0,
    "createdAt": 1761234567890, "updatedAt": 1761234567890
  },
  "recoveryCode": "A7K2M9QX",
  "deviceToken": "dt_9f2c1a..."
}
```
> **`recoveryCode` 只此一次明文返回**（架构 §7.6）：服务端只写 `recovery_code_hash`。前端必须在创建后立即提示用户复制，之后**再也拿不到**——`GET /sessions/:id` 不返回它。
> `deviceToken` 同理只返回一次明文（存 `device_token_hash`），前端写入 localStorage 并在后续请求带 `X-Device-Token`。

#### 3.3.6 `POST /api/v1/sessions/recover`

**请求**：
```json
{ "recoveryCode": "A7K2M9QX", "deviceToken": "可选；不传则服务端新发一个" }
```
**zod**：`recoveryCode` 必填，8 位、匹配 `/^[A-HJ-NP-Z2-9]{8}$/`（剔除易混字符 `0/O/1/I`）；`deviceToken` 可选字符串。

**校验顺序（不可颠倒）**：
1. 读会话 → 无 → `RECOVERY_CODE_INVALID`（统一文案「恢复码无效或已失效」，**不区分「不存在」与「已使用」**）。
2. `recovery_locked_until > now` → `423 RECOVERY_LOCKED` + `{ retryAfterMs }`。
3. 恒定时间比较 `timingSafeEqual(sha256(input), recovery_code_hash)` → 不等 → 计数 +1；达 5 → 写 `recovery_locked_until = now+900000` 并返回 `423`；未达 5 → `404 RECOVERY_CODE_INVALID`。
4. `recovery_code_used_at IS NOT NULL` → `404`（用过一次即失效，**不增加失败计数**——防止对已用码继续刷）。
5. 通过 → 事务内写 `recovery_code_used_at=now`、`recovery_failed_count=0`、绑定新 `device_token_hash`。

**响应 200**：
```json
{ "session": { "...同上..." }, "deviceToken": "dt_new_7d1e..." }
```
**错误**：`404 RECOVERY_CODE_INVALID` / `423 RECOVERY_LOCKED`。

#### 3.3.7 `POST /api/v1/sessions/:id/recovery-code`

**请求**：无 body。**zod**：`params.id` 为 uuid。
**响应 200**：`{ "recoveryCode": "R3T8V2ZP", "expiresNote": "旧恢复码已立即失效" }`
**语义**：生成新 8 位码 → 覆盖 `recovery_code_hash` → **旧码立即失效**（Spec §5 / AC-05）；同时重置 `recovery_failed_count=0`、`recovery_locked_until=NULL`（重生成视为一次凭据轮换，不继承旧码的失败计数）。
**错误**：`404 SESSION_NOT_FOUND`。

#### 3.3.8 `GET /api/v1/sessions/:id`

**响应 200**：
```json
{
  "session": { "id": "...", "title": "...", "provider": "deepseek", "model": "...",
               "channelMode": "auto", "degraded": false, "messageCount": 12,
               "totalTokens": 18420, "createdAt": 0, "updatedAt": 0 },
  "messages": [
    { "id": "m_01", "seq": 1, "role": "user", "content": "读 CSV 算均值",
      "tokens": 12, "isSummary": false, "createdAt": 1761234000000 },
    { "id": "m_02", "seq": 2, "role": "assistant",
      "content": "我先读取文件，再计算。",
      "segments": [ { "type": "text", "text": "我先读取文件，再计算。" },
                    { "type": "tool", "callId": "call_abc123" } ],
      "tokens": 240, "isSummary": false, "createdAt": 1761234010000 }
  ],
  "toolCalls": [
    { "id": "tc_01", "callId": "call_abc123", "toolName": "fs.read",
      "displayName": "读取文件", "category": "file", "source": "builtin",
      "risk": "low", "approvalMode": "none", "channel": "native", "iteration": 1,
      "arguments": { "path": "data.csv" },
      "status": "success", "resultSummary": "118 行 · 4.2 KB",
      "resultRef": "r_7f3a91c2", "durationMs": 4, "truncated": false,
      "startedAt": 1761234010000, "endedAt": 1761234010004 }
  ],
  "approvals": [
    { "id": "ap_9f2c", "toolCallId": "tc_02", "toolName": "fs.write",
      "status": "decided", "decision": "allow_once", "decidedAt": 1761234020000 }
  ]
}
```
> `segments` 来自 `messages.segments_json`（跨文档裁决 C-6）；`content` 保持纯文本。
> **不返回** `recoveryCode`、`device_token_hash`、`recovery_code_hash` 任何一项。

#### 3.3.9 `PATCH /api/v1/sessions/:id`

**请求**：`{ "title": "新标题" }` 或 `{ "provider": "glm", "model": "glm-5.3" }`（可只传其一）。
**zod**：`title` 1-200 可选；`provider` 1-64 可选；`model` 1-128 可选；**至少传一个**（`.refine`）。改模型时触发该 `(provider, model)` 的能力探测（架构 §5.5 触发时机①）。
**响应 200**：`{ "session": { ... } }`。**错误**：`404 SESSION_NOT_FOUND` / `400 VALIDATION_ERROR`。

#### 3.3.10 `DELETE /api/v1/sessions/:id`

**响应 200**：`{ "deleted": true, "id": "..." }`。级联删 `messages` / `tool_calls` / `tool_results` / `approvals`（外键 CASCADE）。**错误**：`404 SESSION_NOT_FOUND`。

#### 3.3.11 `POST /api/v1/agent/stream`（SSE 主端点）

**请求头**：`Content-Type: application/json`、`Accept: text/event-stream`、`X-Device-Token`（可选）。
**请求体（完整 `AgentRequest`）**：
```json
{
  "sessionId": "b7c1e2f0-4a55-4f0e-9c3d-8e1a-2b3c4d5e6f70",
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "apiKey": "sk-...",
  "message": "读 data.csv，算均值，写成 report.md",
  "tools": ["fs.read", "fs.write", "calc.evaluate"],
  "channelMode": "auto",
  "maxIterations": 12,
  "temperature": 0.3,
  "maxTokens": 2048
}
```
**zod 校验规则**（`validators/agent.schema.ts`）：

| 字段 | 规则 | 默认 |
|------|------|------|
| `sessionId` | `z.string().uuid().optional()` | —（不传则新建会话，并在 `meta` 事件里回传新 `sessionId`；**不返回恢复码**——恢复码只在 `POST /sessions` 显式返回） |
| `provider` | `z.string().min(1).max(64)` | 必填 |
| `model` | `z.string().min(1).max(128)` | 必填 |
| `apiKey` | `z.string().min(1).max(512).optional()` | —（缺失则用 `env.LLM_SERVER_API_KEY`，两者都无 → SSE `error` `MISSING_API_KEY`） |
| `message` | `z.string().min(1).max(32000)` | 必填 |
| `tools` | `z.array(z.string().min(1).max(64)).max(64).optional()` | 不传 = 全部已启用工具 |
| `channelMode` | `z.enum(['auto','native','react'])` | `'auto'` |
| `maxIterations` | `z.number().int().min(5).max(30)` | `12` |
| `temperature` | `z.number().min(0).max(2)` | `0.3` |
| `maxTokens` | `z.number().int().min(64).max(8192)` | `2048` |

**响应**：`200` + `Content-Type: text/event-stream`，帧格式 `event: <name>\ndata: <json>\n\n`，15s 心跳 `: ping\n\n`。事件定义见 §4。

#### 3.3.11.1 AC-10 干预矩阵的通道归属（四项，其中两项待裁决）

Spec §9 AC-10 要求「打断 / 单步重试 / 从某步重跑 / 改参数重试」四项，且不丢已完成步骤。逐项归属：

| 干预 | 通道 | 状态 |
|------|------|------|
| 打断 | `POST /api/v1/agent/abort`（备选）＋ 浏览器 `AbortController`（主路径） | 已有（T-4） |
| **改参数重试** | `POST /api/v1/approvals/:id/revise`（独立端点，Spec §5 已登记） | **已定，见 §3.3.13** |
| 单步重试 | 暂无 | **缺口** |
| 从某步重跑 | 暂无（`skipped` 状态已设计好，但没有触发入口） | **缺口** |

**架构建议（需项目总监批准，不新增端点）**：给 `AgentRequest` 加两个可选字段，让干预复用同一条 `/agent/stream` 通道与同一个 Agent 循环——**不另开执行引擎**：

```ts
resumeFromCallId: z.string().uuid().optional(),  // 从该 tool_call 处重跑；其后的调用全部标记 skipped
overrideArguments: z.record(z.unknown()).optional(), // 重跑该步时用这组参数（不传=原参数重试）
```

语义：服务端把上下文截断到 `resumeFromCallId` 之前一步，把该 `tool_call` 及其之后的所有 `tool_calls` 置 `status='skipped'`（AC-03：可展开查看、不计入失败数），然后用 `overrideArguments`（或原参数）重新执行该步并继续循环。这样「单步重试」= 不传 `overrideArguments`，「从某步重跑」= 传新的 `overrideArguments`，两者共用一套实现。

**为什么不单开端点**：干预的本质是「带着不同上下文再跑一次同一个循环」，不是一种新的资源操作。单开 `/agent/retry` 会让「执行引擎」从一个变成两个，预算/熔断/循环检测三套状态机都要写两遍——这正是最容易出漂移的地方。

> 在获得批准前，设计侧**不要**为「单步重试 / 从某步重跑」出 UI 规格（改参数重试的 §3.5 可以照常推进，它已定案）。

#### 3.3.12 `POST /api/v1/approvals/:id`

**请求体（默认只含决定，绝不含工具调用内容）**：
```json
{ "token": "t_7d1e9f2c...", "decision": "allow_once", "reason": "可选，仅 reject 时有意义" }
```
**zod（严格三键，`.strict()`）**：

```ts
const ApprovalDecisionSchema = z.object({
  token: z.string().min(1).max(512),
  decision: z.enum(['allow_once', 'allow_session', 'reject']),
  reason: z.string().max(500).optional(),   // 仅 reject 时有意义
}).strict();
```

**出现 `token` / `decision` / `reason` 之外的任何键（尤其 `arguments` / `toolName` / `args`）一律 `400 VALIDATION_ERROR`**——这是「服务端持有原则」的第一道闸。

> **改参数不走本端点**。AC-10 的「改参数重试」走独立端点 `POST /api/v1/approvals/:id/revise`（§3.3.13）。两个端点刻意用不同 schema：本端点严格拒收 `arguments`，revise 端点放开 `arguments` 但仍拒收其它未知键。**不设两个通道**——同一件事有两条路是漂移的起点。

**服务端校验链（顺序不可颠倒，任一失败即 409 + 异常审计）**：
1. `approvals` 查 `id` → 无 → `404 APPROVAL_NOT_FOUND`。
2. `status != 'pending'` → `409 APPROVAL_ALREADY_DECIDED`。
3. `now > expires_at` → 置 `status='expired'` → `410 APPROVAL_EXPIRED`。
4. **`sha256(token) !== challenge_token_hash`（恒定时间比较）→ `409 APPROVAL_TOKEN_MISMATCH` + `mismatch_count+1`**。
5. **参数摘要复核**：服务端从 `tool_calls` 重算 `args_digest`，与 `approvals.args_digest` 比较 → 不符 → `409 APPROVAL_ARGS_MISMATCH` + `mismatch_count+1`。
6. 通过 → 事务内写 `decision` / `reason` / `decided_at` / `status='decided'`（`WHERE decision IS NULL` 断言影响行数）。

> **AC-04 第三条攻击场景的落点**：客户端若提交「与其令牌不匹配、或服务端持有参数已被改写」的待执行内容，服务端**拒绝执行 + 409 + 异常审计**（`mismatch_count` / `last_mismatch_at` / `last_mismatch_detail`）。`mismatch_count` 达到 3 次 → 该挑战立即置 `status='aborted'`，不再接受任何决定。

**响应 200**：
```json
{ "ok": true, "approvalId": "ap_9f2c", "decision": "allow_once",
  "status": "executed", "toolCallId": "tc_02" }
```
`status` 取值：`'executed'`（已放行并正在执行）/ `'rejected'`（用户拒绝）。**决定后服务端在原 SSE 流上继续推送 `tool_result`**（§4.2.6），本端点不返回工具结果本身。

**错误**：`404` / `409`（`APPROVAL_ALREADY_DECIDED` / `APPROVAL_TOKEN_MISMATCH` / `APPROVAL_ARGS_MISMATCH` / `APPROVAL_REVISE_LIMIT` / `APPROVAL_NOT_REVISABLE`）/ `410 APPROVAL_EXPIRED` / `400 VALIDATION_ERROR`。

#### 3.3.13 `POST /api/v1/approvals/:id/revise` —— AC-10「改参数重试」

> **项目总监裁决：新增独立端点**（Spec §5 端点总数 21 → 22）。架构师初版曾建议「不新增端点、给 `decision` 加 `revise` 取值」，**该方案作废**，以本端点为准。改参数与提交决定是两种不同性质的动作（一个提交新内容、一个只提交决定），用 `.strict()` 的不同 schema 分离比塞进同一个判别联合更不容易误用。

**请求**：
```json
{ "token": "t_7d1e9f2c...", "arguments": { "path": "report.md", "operation": "create" } }
```
**zod**：`token` 必填 string 1-512；`arguments` 必填 object（**新的完整参数对象，不是增量 patch**）；**`.strict()` 拒收其它未知键**（`toolName` / `decision` / `callId` 等一律 400）。与 §3.3.12 的主端点刻意使用不同 schema。

**前置校验（任一不过即 400/409）**：
1. 复用 §3.3.12 校验链第 1-5 步（存在 / pending / 未过期 / 令牌验签 / 摘要复核）。
2. **`tool_calls.status` 必须是 `pending`**（尚未开始执行）。已 running / 已完成的调用不可改参数 → `409 APPROVAL_NOT_REVISABLE`。
3. `revise_depth < 3`；已达 3 次 → `409 APPROVAL_REVISE_LIMIT`（防无限改参数拖住一轮循环）。
4. **新参数必须过工具的 `inputSchema`**（zod，字段级错误）→ 不过即 `400 VALIDATION_ERROR`。
5. **新参数必须重跑安全网关**（SSRF / 路径 jail / 计算边界）。用户编辑的参数**不享有任何豁免**——否则「改参数」就是沙箱绕过的后门。不过即返回失败结果（`error_kind='security'`），并把该调用判定为失败回喂 LLM。

**执行步骤**：
6. **作废旧审批**（一次性写入，受两层保护）：
   ```sql
   UPDATE approvals SET decision='revised', status='revised'
   WHERE id=? AND decision IS NULL;
   ```
   - **数据库层**：`trg_approvals_decision_once` 阻断「改写已有 `decision`」。实测：首次写 `revised` 通过；随后改写为 `allow_once` → `APPROVAL_DECISION_IMMUTABLE` 被 ABORT；已 `allow_once` 的再改 `revised` → 同样被 ABORT。
   - **应用层（唯一防线，不可省）**：**必须断言 `changes === 1`**。触发器**管不住**「`WHERE decision IS NULL` 未命中导致的静默 no-op」——实测对已决定的行执行同一条 UPDATE 会返回成功但影响 0 行，若只看 SQL 不报错就会误判为作废成功。**漏掉这条断言，AC-06 的不可篡改在 revise 路径上就是漏的。**
   旧 `tool_calls` 行置 `status='skipped'` + `error_kind='revised'` + `error_msg='用户改参数后重提'`（`skipped` 不计入失败数，D-6）。
7. 新建 `tool_calls` 行（新 `id`，同一 `iteration`，`status='pending'`，新 `args_json` / `args_digest`），并新建 `approvals` 行（`revised_from_id` 指回旧挑战，`revise_depth = 旧值 + 1`，新令牌、新 `expires_at`）。
8. **重新判定运行期风险**：改参数可能改变风险档（典型：把 `method` 从 `POST` 改成 `GET`，或把 `operation` 从 `overwrite` 改成 `create`）。
   - 新 `approvalMode != 'none'` → 在原 SSE 流推送**新的 `tool_approval_required`**（新 `approvalId` / `approvalToken` / `expiresAt`），响应 `status='reapproval_required'` + `nextApproval` + `nextToolCall`，前端原地刷新确认条。
   - 新 `approvalMode == 'none'` → **直接执行**，在原 SSE 流走 `tool_result`，响应 `status='executed_directly'`。

> **审计为什么保留两行**：改参数恰恰是最需要「两者都在」的场景——模型最初请求删 A、用户改成删 B，审计只留一行会丢掉模型的原始意图，事后无法判断是模型越权还是用户授权。旧行 `skipped` + 新行 `pending` 由 `revised_from_id` 串联，`revise_depth` 限 ≤3 次。

**前端约定**：收到 `status='reapproval_required'` 时**不要关闭确认条**，用 `nextApproval` 替换本地的 `approvalId/approvalToken/expiresAt` 并重渲染参数区。

#### 3.3.13 `POST /api/v1/agent/abort`

**请求**：`{ "sessionId": "..." }`。**zod**：`sessionId` 必填 uuid。
**响应 200**：`{ "ok": true, "aborted": true }`。
**语义**：命中内存中的 `Map<sessionId, AbortController>` 并 `abort()`；主路径仍是浏览器直接 `EventSource.close()` / `fetch` abort（Spec §5 标注此端点为备选）。未找到运行中的任务 → 仍返回 `{ ok: true, aborted: false }`（幂等，不报错）。

#### 3.3.14 `GET /api/v1/tools`

**Query**：`?source=builtin|mcp&risk=low|medium|high&category=http|file|compute|mcp`
**响应 200**：
```json
{
  "tools": [
    { "name": "http.request", "wireName": "http_request", "displayName": "HTTP 请求",
      "category": "http", "description": "向外部 HTTP/HTTPS 服务发起请求...",
      "inputSchema": { "type": "object", "properties": { "url": { "type": "string" } },
                       "required": ["url"] },
      "risk": "low", "approvalMode": "none", "enabled": true,
      "source": "builtin", "timeoutMs": 30000 }
  ],
  "grouped": { "low": ["http.request", "fs.read"], "medium": ["fs.write"], "high": [] }
}
```
> `risk` / `approvalMode` 是**基线值**；实际值在调用时由「基线 + 本次参数」判定并随 `tool_call` 事件下发（架构 §6.3）。**前端不自行推断风险**（C-5）。
> 不含 `handler`；`enabled` 是注册表把 `enabled(ctx)` 用当前上下文求值后的布尔投影。

#### 3.3.15 `PATCH /api/v1/tools/:name`

**请求**：`{ "enabled": false }`。**zod**：`params.name` 为规范名（点号），匹配 `/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/`；`body.enabled` 布尔必填。
**响应 200**：`{ "name": "fs.write", "enabled": false }`。
**语义**：写进程内 `Map<canonicalName, boolean>` 用户覆盖层，与定义自带的 `enabled(ctx)` **取逻辑与**；禁用的工具不进入 `toProviderTools()`（LLM 完全看不到）不进入 `list()`。MCP 工具额外受「Server 是否 connected」约束（AC-12）。
**错误**：`404 TOOL_NOT_FOUND`。

#### 3.3.16 `GET /api/v1/mcp/servers`

**响应 200**：
```json
{
  "servers": [
    { "id": "filesystem", "name": "文件系统", "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "workspace"],
      "enabled": true, "status": "connected",
      "tools": ["mcp.filesystem.read_file", "mcp.filesystem.write_file"],
      "lastError": null, "connectedAt": 1761234567890 }
  ]
}
```
`status` 枚举：`disconnected | connecting | connected | failed`。配置存 `server/src/config/mcp-servers.json`（不建表）。**不返回 `env` 的任何值**（密钥不落响应，§7.6.4）。

#### 3.3.17 `POST /api/v1/mcp/servers`

**请求**：
```json
{ "name": "文件系统", "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "workspace"],
  "env": { "LOG_LEVEL": "info" }, "cwd": "D:/proj" }
```
**zod**：`name` 1-64 必填；`command` 1-256 必填，**禁止含 shell 元字符** `; | & $ ` > <`（正则拒绝）→ `400 MCP_COMMAND_INVALID`；`args` 数组 ≤32 项、每项 ≤512 字符；`env` 可选，键值 ≤512 字符（**键名不得命中 `apiKey|token|secret|password|authorization|cookie`** → 拒绝）；`cwd` 可选但必须已存在目录。
**响应 201**：`{ "server": { ... , "status": "disconnected" } }`。**新建默认 `enabled=false`**（架构 §6.3 安全默认），需用户显式开启再连接。
**错误**：`400 VALIDATION_ERROR` / `400 MCP_COMMAND_INVALID` / `409`（`id` 重复）。

#### 3.3.18 `PATCH /api/v1/mcp/servers/:id`

**请求**：`{ "name"?, "command"?, "args"?, "env"?, "cwd"?, "enabled"? }`（至少一项）。
**响应 200**：`{ "server": { ... } }`。
**语义**：`enabled: false` → 断开连接并把其工具从注册表摘除（AC-12：未连接则其工具**完全不进入**下发给模型的清单）。改 `command`/`args` 需先断开。
**错误**：`404 MCP_SERVER_NOT_FOUND` / `400 MCP_COMMAND_INVALID`。

#### 3.3.19 `DELETE /api/v1/mcp/servers/:id`

**响应 200**：`{ "deleted": true, "id": "filesystem" }`。先 `close()` transport 并终止子进程，再删配置并从注册表摘除工具。**错误**：`404 MCP_SERVER_NOT_FOUND`。

#### 3.3.20 `POST /api/v1/mcp/servers/:id/connect`

**响应 200**：
```json
{ "server": { "id": "filesystem", "status": "connected", "tools": ["mcp.filesystem.read_file"] } }
```
**语义**：按需启动（架构 §6.6.4）→ `listTools()` → 逐个适配为 `ToolDefinition` → 以规范名 `mcp.<serverId>.<toolName>` 注册 → 校验 `inputSchema` 为合法 draft-07 子集（不合法则标记只能走 ReAct）。
**错误**：`404 MCP_SERVER_NOT_FOUND` / `502 MCP_CONNECT_FAILED`（带脱敏后的 `lastError`）。**连接失败绝不影响内置工具**（AC-12 / S-5）。

#### 3.3.21 `POST /api/v1/mcp/servers/:id/disconnect`

**响应 200**：`{ "server": { "id": "filesystem", "status": "disconnected", "tools": [] } }`。`client.close()` + 终止子进程 + 从注册表摘除其工具。**错误**：`404 MCP_SERVER_NOT_FOUND`。

### 3.4 本期不实现的端点

| Method | Path | 状态 | 依据 |
|--------|------|------|------|
| POST | `/api/v1/events` | **不实现** | Spec §3：埋点沿用前端本地事件日志，服务端不落库；`local_events` 表不建 |
| GET | `/api/v1/events` | **不实现** | 同上 |

> 架构文档 §11.1 表中曾列出这两个端点，**以 Spec §3 为准标注为不实现**。路由层不挂载；前端不得调用。若后续需落库，需先改 Spec §3 与 §6（新增表必须通过变更流程）。

---

## 4. SSE 事件协议（前后端契约，逐事件落定）

### 4.1 帧格式与顺序约束

```
event: <name>\n
data: <单行 JSON>\n
\n
```
沿用 `utils/sse.ts` 的 `setSSEHeaders` / `sendSSEEvent` / `startSSEHeartbeat` / `endSSE`。

**顺序硬约束**：
1. `meta` 必须是第一帧（通道降级时**可再发一个** `meta`，前端约定：**后到的覆盖先到的**，架构 §9.5）。
2. 同一 `callId`：`tool_call` → (`tool_progress`)* → `tool_result` 严格有序。
3. `done` 与 `error` 互斥，一个流最多各发一个，且必须是最后一帧。
4. 心跳：15s 一次 `: ping` 注释帧（审批等待期靠它维持长连接）。
5. 客户端断开：`req.on('close')` → `AbortController.abort()` → 编排层走 T-4 终止。

### 4.2 十个事件（完整 payload + 触发时机）

事件名**统一下划线**（Spec §11 已知坑「SSE 事件名错配」；跨文档裁决 C-2）。

#### 4.2.1 `meta`
**触发时机**：循环开始时发一次；供应商降级或通道降级时再发一次（`iteration` 不变）。
```json
{
  "sessionId": "b7c1e2f0-4a55-4f0e-9c3d-8e1a-2b3c4d5e6f70",
  "messageId": "m_01",
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "channel": "native",
  "degraded": false,
  "degradedReason": null,
  "iteration": 1,
  "maxIterations": 12,
  "contextWindow": 65536,
  "estimatedPromptTokens": 1842,
  "toolCount": 9,
  "switchedFrom": null,
  "switchReason": null
}
```

#### 4.2.2 `delta`
**触发时机**：LLM 产生可见文本增量（复用前端 50ms 节流）。
```json
{ "text": "我先读取配置文件。" }
```

#### 4.2.3 `reasoning`
**触发时机**：思考模式（DeepSeek / Kimi）产生思维链增量。默认折叠展示。
```json
{ "text": "用户想要统计行数，fs_read 工具最合适。" }
```

#### 4.2.4 `tool_call`
**触发时机**：解析出工具调用后、**执行前**发。参数是**完整对象**（上游 arguments 分片由服务端累积，不下发半截 JSON，§5.1）。
```json
{
  "callId": "call_abc123",
  "name": "fs.read",
  "displayName": "读取文件",
  "category": "file",
  "arguments": { "path": "notes.txt" },
  "risk": "low",
  "approvalMode": "none",
  "source": "builtin",
  "iteration": 1,
  "status": "pending"
}
```
`risk` / `approvalMode` 是**运行期判定结果**（基线 + 本次参数），前端不推断（C-5）。

#### 4.2.5 `tool_progress`
**触发时机**：工具执行过程中的阶段汇报（可选事件，由 handler 的 `ctx.reportProgress` 驱动）。
```json
{ "callId": "call_abc123", "stage": "reading", "message": "读取 sandbox/notes.txt", "at": 1761234567890 }
```

#### 4.2.6 `tool_result`
**触发时机**：工具执行结束。**七种状态共用此事件**，靠 `status` 区分（C-2：不设 `tool_rejected` / `tool_skipped` 单独事件）。审批决定后由服务端**在原 SSE 流上推送此事件**。
```json
{
  "callId": "call_abc123",
  "name": "fs.read",
  "status": "success",
  "summary": "118 行 · 4.2 KB",
  "data": { "content": "第一行\n第二行\n", "truncated": false, "sizeBytes": 4308 },
  "truncated": false,
  "durationMs": 4,
  "resultId": "r_7f3a91c2"
}
```
失败/超时/拒绝/跳过形态：
```json
{
  "callId": "call_abc123", "name": "http.request", "status": "timeout",
  "durationMs": 15003, "resultId": "r_7f3a91c2",
  "error": { "code": "TOOL_TIMEOUT", "kind": "timeout",
             "message": "目标服务在 15s 内未返回响应",
             "suggestion": "该目标近期不稳定，可重试或改用备选接口",
             "retryable": true }
}
```

**`tool_result.status` 七值（锁定）**：

| status | 含义 | 触发 | UI（lucide 规范名） |
|--------|------|------|---------------------|
| `pending` | 已生成，等待调度或等待审批 | `tool_call` 后、执行/审批前 | `Circle` 虚线 / `Clock`，参数区默认展开 |
| `running` | 正在执行 | 进入 handler | `Loader2` + `animate-spin`，accent 色 |
| `success` | 正常返回 | `ok=true` | `CircleCheck`，success 色，参数区默认折叠 |
| `failed` | 工具报错 | `ok=false`（含参数非法、安全拦截、上游错误） | `CircleX`，danger 色，参数区默认展开 |
| `timeout` | 工具自身超时 | 超 `timeoutMs` | `Clock` + `TriangleAlert`，**warning 色（与 failed 区分）** |
| `rejected` | 用户拒绝 | 审批 `decision='reject'` | `Ban`，**中性色（不染红）**——不是错误 |
| `skipped` | 因「从某步重跑」被跳过 | 干预矩阵重跑时跳过已完成步骤 | `CircleSlash`，最弱色 + 整卡 `opacity-60`，**不计入失败数** |

**`tool_result.error.kind` 完整枚举（锁定 10 值 —— 前端按此查表渲染「分类标签 + 语义色 + 恢复动作」）**：

| kind | 中文标签 | 语义色 | retryable | 恢复动作 | 触发来源 |
|------|----------|--------|-----------|----------|----------|
| `invalid_args` | 参数不合法 | danger | **否**（不消耗重试预算） | 改参数重试 | zod 校验失败（字段级错误） |
| `not_found` | 工具或目标不存在 | warning | **否**（不消耗预算） | 换工具 / 换路径 | 注册表无此名（幻觉）/ 文件 404 / 接口 404 |
| `security` | 被安全策略拒绝 | danger | **否**（同一目标本任务内封禁） | 无（**不给绕行建议**） | SSRF 拦截 / 路径越界 / 计算边界 |
| `timeout` | 执行超时 | warning | 是（由模型决定） | 重试 / 换参数 | 工具超 `timeoutMs` |
| `rate_limit` | 上游限流 | warning | 是（退避 + jitter，读 `Retry-After`） | 稍后重试 | 上游 429 |
| `network` | 网络不可达 | warning | 是（**仅幂等方法自动重试**） | 重试 | 连接失败 / DNS 失败 |
| `upstream` | 上游服务错误 | danger | 是（5xx）/ 否（401·403） | 重试 / 检查 Key | 上游 5xx / 鉴权 / 400 |
| `mcp` | MCP 服务异常 | warning | 是（800ms 后 1 次） | 重试 / 重连 Server | `MCP_CALL_FAILED` / 连接失败 |
| `circuit_open` | 工具已熔断 | **neutral** | **否**（**不触发 LLM 调用**） | 换工具 | 同一工具连续失败 3 次 |
| `internal` | 内部错误 | danger | 否 | 无 | 兜底 |

**三条边界规则（逐条回应设计侧的 9 值提案）**：
1. **`payload_too_large` 不进本枚举**——结果超限走 `tool_result.truncated=true` 标志位（不是错误）；请求体过大是 HTTP `413 PAYLOAD_TOO_LARGE`，不产生 `tool_result` 事件。这条我与原提案不同，理由是它压根不是工具执行的失败。
2. **`forbidden` 并入 `security`**——AC-07 原文是「被安全策略拒绝」，前端标签就用这句话，不必再造一个近义词。
3. **新增 `circuit_open`（原提案漏了）**——AC-08 明确要求「连续失败 3 次后第 4 次直接返回熔断提示而不触发 LLM 调用」，这条必须有独立 kind；且它的语义色是 **neutral 不是 danger**，因为熔断不是错误。

**`revised` 不在本枚举中**：它只出现在 DB 的 `tool_calls.error_kind`（被改参数重提的作废行），永不出现在 SSE 载荷。

**未知 kind 兜底（前端必须实现）**：查不到 → 标签「执行失败」+ danger + `[重试]`，**不得崩**。这样架构后续新增 kind 时旧前端仍可用。

#### 4.2.7 `tool_approval_required`
**触发时机**：运行期 `approvalMode ∈ {soft, hard, two_step}` 的调用。服务端**已先把待执行调用落库**（`approvals` 表 + 内存挂起句柄）并签发令牌后才发此事件。
```json
{
  "callId": "call_def456",
  "name": "fs.write",
  "displayName": "写入文件",
  "arguments": { "path": "old/report.csv", "operation": "overwrite" },
  "risk": "high",
  "approvalMode": "hard",
  "reason": "覆盖已有文件不可逆，需要确认",
  "approvalId": "ap_9f2c",
  "approvalToken": "t_7d1e9f2c...",
  "expiresAt": 1761234867890
}
```
客户端凭 `approvalId` + `approvalToken` 调 `POST /api/v1/approvals/:id`，**只回传决定**。渲染形态是 inline 确认条，**不弹窗**（AC-04）。

#### 4.2.8 `context_notice`
**触发时机**：上下文占用 >75% 触发裁剪/压缩时；压缩自检失败时。
```json
{
  "reason": "compacted",
  "removedMessages": 24,
  "estimatedTokensBefore": 58210,
  "estimatedTokensAfter": 12480,
  "summaryPreview": "已读取 sandbox/config.json 与 sandbox/notes.txt，确认端口为 8080。"
}
```
`reason` 枚举：`compacted` / `compaction_failed` / `tool_result_compressed` / `truncated`。

#### 4.2.9 `done`
**触发时机**：循环终止。**T-1~T-5 五种终止条件全部以 `done` 结束**（架构 §4.4）——T-2/T-3/T-5 不是错误，前端不得显示为红色。
```json
{
  "finishReason": "stop",
  "iteration": 3,
  "toolCallCount": 2,
  "usage": { "promptTokens": 12480, "completionTokens": 412 },
  "messageId": "m_01"
}
```
`finishReason` 枚举：`stop` / `max_iterations` / `budget_exhausted` / `aborted` / `circuit_open` / `stream_interrupted`。

#### 4.2.10 `error`
**触发时机**：致命且不可恢复的错误（含 `MISSING_API_KEY`、上游不可达且无法降级）。
```json
{ "code": "MISSING_API_KEY", "message": "未配置 API Key，请在设置页填写", "retryable": false }
```

### 4.3 端到端最小闭环事件序列（Spec §12 第 7 步）

```
event: meta
event: delta                    // "我用计算工具算一下"
event: tool_call                // name=calc.evaluate, status=pending
event: tool_result              // status=success
event: delta                    // 最终答案
event: done                     // finishReason=stop
```

---

## 5. 审批令牌协议（AC-04 / AC-06）

### 5.1 令牌结构

```ts
// server/src/services/agent/approval.service.ts
interface ApprovalChallenge {
  approvalId: string;      // ap_<random>
  sessionId: string;
  toolCallId: string;      // tool_calls.id
  callId: string;          // 传给 LLM 的 tool_call_id
  toolName: string;        // 规范名
  argsDigest: string;      // 参数规范化 SHA-256（键排序 + 剔除易变字段后序列化）
  expiresAt: number;       // 签发 + 300_000（5 分钟）
  token: string;           // 明文，只随 tool_approval_required 下发一次
  tokenHash: string;       // sha256(token)，落库
}
```

**令牌生成**（HMAC-SHA256，密钥取 `AGENT_APPROVAL_SECRET`）：

> **部署硬要求**：**生产部署必须显式配置 `AGENT_APPROVAL_SECRET`，否则进程重启会导致所有挂起审批失效。** 缺省时进程启动随机生成密钥并打 `warn`，重启即换密钥 → 重启前签发的令牌全部验签失败 → 用户看到的「待确认」卡片永远等不到结果（审批条卡死）。要求：随机 ≥32 字节后 base64 写入 `server/.env`；不得与 `LLM_SERVER_API_KEY` 复用同一值；轮换应在无挂起审批时执行。
```ts
const payload = `${sessionId}|${toolCallId}|${toolName}|${argsDigest}|${expiresAt}`;
const sig = createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 32);
const token = `t_${base64url(payload)}.${sig}`;
```
**验签**：常数时间比较（`timingSafeEqual`）重算的 sig 与令牌携带的 sig；**再**比对 `sha256(token)` 与 `approvals.challenge_token_hash`。

### 5.2 绑定与失效

| 绑定项 | 作用 |
|--------|------|
| `sessionId` | 防跨会话批准（架构 §10.4） |
| `toolCallId` + `callId` | 防跨调用批准 |
| `toolName` | 防「批准 A 工具却执行 B 工具」 |
| `argsDigest` | 防「批准的参数被改写」（AC-04 第三场景） |
| `expiresAt` | 5 分钟过期（PRD §6.4）；超时置 `status='expired'` |

**失效触发**：已决定（一次性写入）／过期／`mismatch_count ≥ 3`（异常审计熔断）／会话被删（CASCADE）／进程重启（内存挂起句柄丢失，DB 中 `status='pending'` 记录在会话恢复时标记为 `aborted`）。

### 5.3 `allow_session` 的作用域

`allow_session` 写入内存 `Map<sessionId, Set<"toolName:argsDigest">>`，**仅本次会话进程内存活**，不落库、不跨会话、不跨进程重启。命中后同一 `(toolName, argsDigest)` 在本次会话内不再弹确认条（PRD §6.4 批准疲劳缓解）。

---

## 6. 恢复码协议（AC-05）

| 环节 | 规则 |
|------|------|
| 生成 | 8 位大写字母数字，**剔除易混字符 `0/O/1/I`**（码空间 31^8 ≈ 8.5×10^11）；用 `crypto.randomInt` 逐位取样，不用 `Math.random` |
| 首次返回 | 仅在 `POST /api/v1/sessions` 响应里出现**一次明文**；`POST /:id/recovery-code` 重新生成时也返回一次 |
| 存储 | 只存 `recovery_code_hash = sha256(code + sessionId)`（加盐到会话维度，防跨会话彩虹表） |
| 单次使用 | 成功即写 `recovery_code_used_at`；再次使用 → `404 RECOVERY_CODE_INVALID`（**不区分「不存在」与「已使用」**，统一文案） |
| 重生成 | 覆盖哈希 → **旧码立即失效**；同时重置失败计数与锁定 |
| 暴力防护 | 单会话连续失败 **5 次 → 锁定 15 分钟**（`recovery_locked_until`），成功即归零；校验走 `timingSafeEqual` |
| 恢复范围 | 只还原消息与工具调用记录；**不还原执行中的任务**（中断任务标记 `aborted`） |
| 恢复后 | 该浏览器获得新 `deviceToken`，后续自动关联，**不消耗恢复码** |

---

## 7. 模块文件级设计

### 7.1 服务端目录结构（Phase 2 增量，分层依赖只向下）

```
server/src/
├── app.ts                                  # 入口只装配：<100 行
├── routes/
│   ├── index.ts                            # /api/v1 聚合
│   ├── agent.routes.ts                     # /agent/stream, /agent/abort, /approvals/:id
│   ├── sessions.routes.ts                  # /sessions CRUD + recover + recovery-code
│   ├── tools.routes.ts                     # /tools, /tools/:name
│   ├── mcp.routes.ts                       # /mcp/servers CRUD + connect/disconnect
│   └── providers.routes.ts                 # /providers, /providers/capabilities（新增）
├── controllers/                            # 只做：取参 → 调 service → 写响应。零业务
│   ├── agent.controller.ts                 # 校验 → setSSEHeaders → 驱动 AgentLoop
│   ├── approval.controller.ts              # 【新增】POST /approvals/:id（独立控制器）
│   ├── sessions.controller.ts
│   ├── tools.controller.ts
│   ├── mcp.controller.ts
│   └── providers.controller.ts             # 【新增】
├── services/
│   ├── agent/
│   │   ├── agent-loop.service.ts           # 状态机 + 预算 + 终止（≤300 行，超则拆 loop-budget）
│   │   ├── channel-router.service.ts       # 能力探测 + 通道选择 + 降级
│   │   ├── native-channel.ts               # 通道 A：上游流 → TurnIR
│   │   ├── react-channel.ts                # 通道 B：ReAct 文本 → TurnIR
│   │   ├── react-parser.ts                 # 纯函数：三级降级解析器
│   │   ├── context-manager.service.ts      # token 估算 + 三层压缩 + 锚点保活
│   │   ├── token-estimator.ts              # 纯函数
│   │   ├── fidelity-checker.ts             # 纯函数：保真清单机械自检
│   │   ├── loop-detector.ts                # 纯函数：(工具名, 参数哈希) 循环检测
│   │   ├── circuit-breaker.ts              # 纯函数：每工具熔断
│   │   ├── loop-budget.ts                  # 纯函数：预算/终止判定
│   │   ├── approval.service.ts             # HMAC 令牌 + 挑战生命周期 + 异常审计
│   │   └── abort-registry.ts               # 【新增】Map<sessionId, AbortController>
│   ├── tools/
│   │   ├── registry.service.ts             # 注册/查询/启禁用/分组/双轨制反查
│   │   ├── security-gateway.ts             # 唯一策略执行点（§10.0）
│   │   ├── executor.service.ts             # 超时/重试/审批/截断/落库
│   │   └── schema-validator.ts             # JSON Schema → zod
│   ├── mcp/
│   │   ├── mcp-manager.service.ts          # Client 生命周期 / 状态机
│   │   ├── mcp-tool-adapter.ts             # MCP tool → ToolDefinition
│   │   └── mcp-config.store.ts             # config/mcp-servers.json 读写（不建表）
│   ├── memory/                             # repositories（薄数据访问层）
│   │   ├── session.repository.ts
│   │   ├── message.repository.ts
│   │   ├── tool-call.repository.ts
│   │   ├── tool-result.repository.ts
│   │   ├── approval.repository.ts
│   │   └── provider-capability.repository.ts
│   ├── recovery.service.ts                 # 设备令牌 + 8 位恢复码（§6）
│   └── sse-writer.ts                       # 事件 → SSE 帧（复用 utils/sse.ts）
├── providers/
│   ├── registry.ts                         # 改造：加能力字段
│   ├── capabilities.ts                     # 静态能力表（探测结果的默认来源）
│   ├── openai-compatible.adapter.ts        # **改造：tool_calls 归一化（§7.2）**
│   └── tool-call-normalizer.ts             # **新增：流式 tool_call delta 累积（纯函数）**
├── tools/builtin/                          # 每个工具一个文件，单一导出
│   ├── index.ts                            # BUILTIN_TOOLS 集中登记
│   ├── http-request.tool.ts / fs-read.tool.ts / fs-write.tool.ts / fs-list.tool.ts
│   ├── calc-evaluate.tool.ts / time-now.tool.ts / uuid-generate.tool.ts
│   ├── json-format.tool.ts / text-diff.tool.ts
│   ├── expression-parser.ts                # 【新增】递归下降求值器（不用 eval）
│   └── path-jail.ts                        # 纯函数：路径 jail
├── repositories/
│   ├── db.ts                               # node:sqlite 封装 + withTransaction（SAVEPOINT 嵌套）
│   ├── schema.ts                           # 建表 SQL（与 docs/agent/schema.sql 同源）
│   └── migrations/{index.ts, 001-initial.ts}
├── middlewares/
│   ├── agent-concurrency.ts / rate-limit.ts / error-handler.ts / request-log.ts / not-found.ts
├── validators/
│   ├── agent.schema.ts / session.schema.ts / tools.schema.ts / mcp.schema.ts / approval.schema.ts
├── utils/
│   ├── errors.ts                           # 扩展错误码（§3.2）
│   ├── sse.ts                              # 原样保留
│   ├── tool-name.ts                        # **双轨制唯一实现（消毒 + 反查）**
│   ├── ssrf-guard.ts                       # 纯函数：URL/IP 校验
│   ├── digest.ts                           # 【新增】argsDigest 规范化哈希
│   └── hmac.ts                             # 【新增】审批令牌签发/验签
└── types/{index.ts, tool.ts, agent-events.ts}
```

**依赖铁律**：`routes → controllers → services → (repositories | providers | tools)`，**反向依赖一律禁止**；`utils/` 不依赖 `services/`；`types/` 谁都可依赖。

### 7.2 现有 adapter 缺陷的重写方案（最高优先级）

#### 7.2.1 缺陷定位

`server/src/providers/openai-compatible.adapter.ts` 第 **144-151** 行：
```ts
// Tool-call deltas: normalize arguments fragments into delta text
const toolCalls = extractToolCalls(delta);
if (toolCalls.length > 0) {
  const fragments = toolCalls
    .map((call) => (typeof call.function?.arguments === 'string' ? call.function.arguments : ''))
    .join('');
  if (fragments.length > 0) return { type: 'delta', text: fragments };
}
```
**三处丢失**：`id`（无法把结果关联回调用 → 上游 400）、`name`（不知道调哪个工具 → `TOOL_NOT_FOUND`）、`index`（并行调用无法归并 → 结果错位）。纯问答场景无害（tool_calls 不出现），**Agent 场景致命**。

#### 7.2.2 目标代码结构（新增 `providers/tool-call-normalizer.ts`，纯函数、无 IO）

```ts
// ── 输入：上游 delta 分片 ──────────────────────────────
export interface RawToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

// ── 累积中的单条调用 ───────────────────────────────────
interface Accumulator {
  index: number;
  id: string;              // 取首个非空
  name: string;            // 取首个非空（线上名，执行前反查规范名）
  argFragments: string[];  // 按到达顺序拼接
  seen: boolean;
}

// ── 归一化输出 ─────────────────────────────────────────
export interface NormalizedToolCall {
  index: number;
  id: string;
  name: string;                            // 线上名
  rawArguments: string;                    // 拼接后的原始字符串
  arguments: Record<string, unknown>;      // parse 结果
  parseError?: 'EMPTY_ARGS' | 'INVALID_JSON' | 'MISSING_ID' | 'MISSING_NAME';
}

/** 累积器工厂：隔离可变状态，便于单测。 */
export function createToolCallAccumulator(): ToolCallAccumulator;

/** 纯函数：吃一个 delta 数组，返回是否有更新。 */
export function accumulate(
  acc: ToolCallAccumulator,
  deltas: readonly RawToolCallDelta[],
): void;

/** 纯函数：流结束时把累积结果转成 NormalizedToolCall[]（含 parseError 标记）。 */
export function finalize(acc: ToolCallAccumulator): NormalizedToolCall[];
```

**关键决策**：
1. **按 `index` 建 `Map`**，缺失 `index` 的分片按 `0` 处理（部分 provider 只发单调用不带 index）。
2. `id` / `name` **取首个非空并锁定**——后续分片里它们是空串或 null，不能覆盖。
3. `arguments` 片段**只 append 不解析**，直到 `finish_reason === 'tool_calls'` 或流结束才 `JSON.parse`。
4. `JSON.parse` 失败 → `parseError='INVALID_JSON'`，**产出失败结果 `TOOL_ARGS_INVALID` 并以 `tool_result{status:'failed'}` 回喂 LLM**，不中断整轮（架构 §5.2 第 5 条）。
5. `id` 缺失 → 服务端生成 `call_<uuid>` 兜底（回程 `role:tool` 必须带 `tool_call_id`，缺了上游 400）。
6. **空 `arguments`（无参工具）合法**：`rawArguments === ''` → `arguments = {}`，**不报错**（这是最易写错的一条）。
7. 归一化结果**不立刻下发前端**——`tool_call` 事件要求参数是完整对象，故在 `finalize()` 后才发（§4.2.4）。

#### 7.2.3 adapter 侧改造点

| 位置 | 现在 | 改为 |
|------|------|------|
| L144-151 | 拼成 `delta` 文本 | **删除**；改为 `accumulate(acc, extractToolCalls(delta))` 并 `return null`（工具分片不产生前端事件） |
| L92-97 | 局部 `finishReason/usage` | 增加 `const acc = createToolCallAccumulator()` |
| L166-169 | `[DONE]` 直接 yield done | `[DONE]` 前先 `finalize(acc)` → 有 tool_calls 则 `yield { type:'tool_calls', calls }` 再 yield done |
| L177 | 流结束 yield done | 同上（**无 `[DONE]` 的异常收尾路径也必须 finalize**，否则丢调用） |
| `UpstreamEvent` 类型 | `meta/delta/done` | 增加 `tool_calls` 与 `reasoning`（思考模式） |
| `buildBody` | 无 tools | 增加 `tools` / `tool_choice` / `parallel_tool_calls` / `tool_stream`（按能力表条件下发，§5.3） |

`UpstreamEvent` 扩展：
```ts
export type UpstreamEvent =
  | { type: 'meta'; provider: string; model: string }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_calls'; calls: NormalizedToolCall[] }
  | { type: 'done'; finishReason: string; usage: Usage };
```

#### 7.2.4 纯函数测试点（`__tests__/tool-call-normalizer.test.ts`，必覆盖）

| # | 用例 | 断言 |
|---|------|------|
| T1 | 单调用三片（`{`id`,name,args1}` → `{args2}` → `{args3}`） | `id`/`name` 正确、`rawArguments` 完整拼接、`arguments` 可 parse |
| T2 | 后续分片 `id:""` / `name:null` | **不覆盖**首个非空值 |
| T3 | 并行调用 `index:0` 与 `index:1` 交错到达 | 两条各自归并，不串味 |
| T4 | 缺 `index` 字段的单调用 | 按 0 归并，不丢 |
| T5 | `arguments` 截断（`{"url":"http` 无收尾） | `parseError='INVALID_JSON'`，不抛异常 |
| T6 | **无参工具**（`arguments` 全程空串） | `arguments={}`，`parseError` 为 undefined（**不是 INVALID_JSON**） |
| T7 | `id` 全程缺失 | 服务端补 `call_<uuid>`，`parseError='MISSING_ID'` 仅作告警 |
| T8 | 同时有 `content` 与 `tool_calls`（Kimi 已知行为） | 两者都产出，不互相吞掉 |
| T9 | 流异常结束（无 `[DONE]`） | `finalize()` 仍被调用，结果不丢 |
| T10 | 上游 `arguments` 为对象而非字符串（非标 provider） | 走 `JSON.stringify` 兜底，不崩 |

### 7.3 双通道（通道 A 原生 / 通道 B ReAct）

| 文件 | 职责 | 关键签名 |
|------|------|----------|
| `services/agent/channel-router.service.ts` | 能力探测 + 通道选择 + 降级 | `decideChannel(req, caps): Promise<'native'\|'react'>`；`probeToolSupport(provider, model, apiKey): Promise<ProbeResult>` |
| `services/agent/native-channel.ts` | 上游流 → `TurnIR` | `runNativeTurn(ctx): Promise<TurnIR>` |
| `services/agent/react-channel.ts` | ReAct 文本 → `TurnIR` | `runReactTurn(ctx): Promise<TurnIR>` |
| `services/agent/react-parser.ts` | 三级降级解析器（纯函数） | `parseReactOutput(text): { toolCalls, warnings }` |
| `providers/capabilities.ts` | 静态能力表 | `CAPABILITIES: Record<string, ProviderCapabilities>` |

**统一 IR**（架构 §5.1，两通道产出完全相同，上层不感知差异）：
```ts
interface ToolCallIR { id: string; name: string;        // 线上名
                       arguments: Record<string, unknown>; rawArguments: string;
                       channel: 'native' | 'react'; }
interface TurnIR { text: string; toolCalls: ToolCallIR[];
                   finishReason: 'stop'|'tool_calls'|'length'|'content_filter'|'error';
                   warnings: string[]; usage: Usage; }
```

**通道 A 请求体**（按能力表条件下发，§5.3）：
```jsonc
{ "model": "...", "messages": [...], "stream": true,
  "stream_options": { "include_usage": true },
  "tools": [{ "type": "function", "function": { "name": "http_request", ... } }],
  "tool_choice": "auto",                 // 默认 auto（5 家全支持的唯一安全值）
  "parallel_tool_calls": false,          // 仅当 explicitParallelToolCalls=true 才发
  "tool_stream": true                    // 仅当 requireToolStreamFlag=true 才发（GLM 必发）
}
```
**工具结果回填（硬约束）**：`role:"tool"` 消息条数必须与 assistant 的 `tool_calls` 长度**完全一致**且 `tool_call_id` 匹配，否则上游直接 400。并行调用必须全部追加完再发起下一轮。

**通道 B 输出格式**：**XML 风格 `<tool_call>` 标签包裹 JSON，不用 Markdown 围栏**。
```
<tool_call>{"tool":"http_request","arguments":{"url":"https://x"}}</tool_call>
```
选择 XML 标签而非 ``` 围栏的理由：Markdown 围栏会被模型的 Markdown 渲染习惯干扰（模型常在围栏外补散文、在围栏内加语言标注），且当工具参数本身含 ``` 时围栏解析必然错位；XML 标签闭合无歧义，正则 `<tool_call>([\s\S]*?)</tool_call>` 稳定。

**三级降级解析**（纯函数 `parseReactOutput`）：

| 级别 | 策略 | 命中条件 |
|------|------|----------|
| L1 | `<tool_call>…</tool_call>` 标签内 `JSON.parse` | 标准格式 |
| L2 | 全文扫描第一个平衡的 `{...}`，parse 后校验含 `tool` 字段 | 模型漏了标签 |
| L3 | 正则 `"tool"\s*:\s*"([^"]+)"` + 紧邻 `"arguments"\s*:\s*(\{...\})` | 输出被截断或混入散文 |

解析失败：三级全败且无工具意图 → `toolCalls=[]` 走 T-1 终止；有工具名但参数非法 → `TOOL_ARGS_INVALID`；未知工具名 → `TOOL_NOT_FOUND`（**不消耗重试预算**，架构 §9.1）。

**能力探测（按 model 粒度）**：
- 落点在既有 adapter 内新增 `probeToolSupport()`，**不另开通道**（同一 baseUrl/Key/超时/错误归一化，架构 §5.5）。
- 探测体：只含一个单参假工具 `__probe__`；响应含 `tool_calls` → `supported`；普通文本或拒绝 `tools` 参数 → `unsupported`；网络/鉴权失败 → **`failed`（区别于 `unsupported`）**，三态写入 `provider_capabilities.probe_status`。
- 触发时机：① 用户切换模型；② 该 `(provider, model)` 在表中无记录。**不每轮试探**，不进 SSE 流，不消耗重试预算。

### 7.4 工具注册表

#### 7.4.1 `ToolDefinition` 完整接口（架构 §6.1 锁定）

```ts
export interface ToolDefinition {
  name: string;            // 规范名（点号），唯一主键
  wireName: string;        // 线上名（下划线），仅下发给 LLM
  displayName: string;     // 人话名（设置页/审批条）
  category: 'http' | 'file' | 'compute' | 'mcp';
  description: string;     // 给 LLM 看，必须写清「何时该调用」
  inputSchema: JsonSchemaObject;   // draft-07 子集，禁 $ref/oneOf/patternProperties
  handler: (args, ctx: ToolExecutionContext) => Promise<ToolOutcome>;
  timeoutMs: number;       // 与全局默认取小
  risk: 'low' | 'medium' | 'high';         // 基线
  approvalMode: 'none'|'soft'|'hard'|'two_step';  // 基线
  enabled: (ctx: ToolEnableContext) => boolean;   // 函数式（MCP 可表达「仅当已连接」）
  source: 'builtin' | 'mcp';
  idempotent: boolean;
  maxResultChars: number;
  mcpServerId?: string;
}
```
> 面向 `GET /api/v1/tools` 的投影 `ToolDefinitionPublic` **不含 `handler`**，且 `enabled` 求值为布尔。
> 用户覆盖层：注册表另持 `userEnabled: Map<string, boolean>`；有效启用 = `def.enabled(ctx) && userEnabled.get(name) ?? true`。

#### 7.4.2 内置工具 inputSchema（逐个）

| 规范名 | wireName | inputSchema（properties / required） | timeoutMs | 基线 risk/approval |
|--------|----------|--------------------------------------|-----------|--------------------|
| `http.request` | `http_request` | `url`(string,必) `method`(enum GET/POST/PUT/PATCH/DELETE/HEAD) `headers`(object) `body`(string) `timeoutMs`(number ≤30000) | 30000 | low / none |
| `fs.read` | `fs_read` | `path`(string,必) `encoding`(string) `maxBytes`(number) `lineStart`(number) `lineEnd`(number) `keyword`(string) `glob`(string) | 15000 | low / none |
| `fs.write` | `fs_write` | `path`(string,必) `operation`(enum create/overwrite/append/rename/delete,必) `content`(string) `newPath`(string) | 15000 | medium / soft |
| `fs.list` | `fs_list` | `path`(string,必) `recursive`(bool) `maxEntries`(number) | 15000 | low / none |
| `calc.evaluate` | `calc_evaluate` | `expression`(string,必,≤512) `base`(number 2-36) | 5000 | low / none |
| `time.now` | `time_now` | `format`(string) `timezone`(string) `offsetDays`(number) `from`(string) | 5000 | low / none |
| `uuid.generate` | `uuid_generate` | `count`(number 1-100) | 5000 | low / none |
| `json.format` | `json_format` | `input`(string,必) `mode`(enum pretty/compact/sort-keys/validate) `path`(string, JSON Pointer) | 5000 | low / none |
| `text.diff` | `text_diff` | `left`(string,必) `right`(string,必) `contextLines`(number) | 5000 | low / none |

**运行期风险升级规则（锁定，逐条可实现）**：

| 工具 | 条件 | 实际 risk | 实际 approvalMode |
|------|------|-----------|-------------------|
| `http.request` | `method ∈ {GET, HEAD}`（含缺省） | low | none |
| `http.request` | `method ∈ {POST, PUT, PATCH, DELETE}` | **high** | **hard** |
| `fs.write` | `operation ∈ {create, append, rename}` **且目标不存在** | medium | soft |
| `fs.write` | `operation = overwrite` **且目标已存在** | **high** | **hard** |
| `fs.write` | `operation = delete` | **high** | **hard** |
| `fs.write` | `operation = delete` 且 `recursive/目标 = 工作区根` | high | **two_step** |
| MCP 工具 | 默认 | high | hard（用户可在连接器页逐个下调，**不得自动调低到 low**） |
| 其它内置 | — | low | none |

判定发生在 `security-gateway.ts`，结果随 `tool_call` 事件下发，**前端不推断**（C-5）。

#### 7.4.3 规范名与线上名：消毒 / 反查共用 `utils/tool-name.ts`

```ts
export function sanitizeToolName(canonical: string): string;
export function normalizeWireName(wire: string): string;
export function buildReverseIndex(defs: ToolDefinition[]): Map<string, string>; // wireName → canonical
```
**消毒规则**（架构 §6.1.1）：点号与所有非 `[a-zA-Z0-9_-]` → `_`；连续 `_` 压缩、首尾去除；不以字母开头则前置 `t_`；截断 64 字符；冲突按注册顺序追加 `_2`/`_3`；**规范名保持不变**。
**注册期校验**：规范名必须匹配 `/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/`，不匹配直接抛错（加载期拒绝，而非上线后炸）。
**回程反查**：LLM 返回的是**线上名** → 用 `buildReverseIndex` 还原规范名 → 查不到 → `TOOL_NOT_FOUND`（AC-13）。
**唯一实现铁律**：`tool-call-normalizer.ts` 与 `registry.service.ts` 必须 `import` 同一个 `utils/tool-name.ts`，禁止各写一份。

#### 7.4.4 注册表服务签名

```ts
class ToolRegistry {
  register(def: ToolDefinition, opts?: { overwrite?: boolean }): void;
  registerAll(defs: ToolDefinition[]): void;
  get(name: string): ToolDefinition | undefined;
  getByWireName(wire: string): ToolDefinition | undefined;   // 回程反查
  list(filter?): ToolDefinition[];
  setEnabled(name: string, enabled: boolean): void;          // 用户覆盖层
  groupedByRisk(): Record<'low'|'medium'|'high', ToolDefinition[]>;
  toProviderTools(names?: string[]): ProviderToolSpec[];     // 只用 wireName
  unregisterByMcpServer(serverId: string): void;             // 断开即摘除（AC-12）
}
```

### 7.5 预算与终止（逐条可实现）

| 机制 | 阈值 | 实现位置 | 行为 |
|------|------|----------|------|
| 最大迭代轮数 | **12**（可配 5-30） | `loop-budget.ts` | T-2：产出总结性最终回答（基于已有 observation），`done{finishReason:'max_iterations'}`，**不静默截断** |
| 任务级重试预算 | **5 次** | `loop-budget.ts` | 单任务内所有工具重试合计上限；超出只允许用户手动触发 |
| 每工具熔断 | **连续失败 3 次** | `circuit-breaker.ts` | 第 4 次**直接返回熔断提示，不触发 LLM 调用**；成功一次即归零 |
| 循环检测 | 同 `(工具名, 参数哈希)` 连续 **2 次** | `loop-detector.ts` | 注入 observation「你正在重复同一个调用，请换参数或换工具」 |
| 循环检测 | 连续 **3 次** | `loop-detector.ts` | **中止任务**，保留已完成结果，给「从该步重跑 / 换路径 / 换工具」三个恢复入口 |
| 单轮并行工具 | 4 | `executor.service.ts` | 超出串行化 |
| 单工具超时 | 15s（HTTP 30s） | `executor.service.ts` | `Promise.race` + `AbortController` |
| 任务总预算 | 180s | `agent-loop.service.ts` | T-3 `budget_exhausted` |
| 用户中止 | — | `abort-registry.ts` | T-4 `aborted` |

**参数哈希**：键排序 + 剔除易变字段（`timeoutMs`/`maxBytes`/`maxEntries`/`contextLines`）→ `JSON.stringify` → SHA-256。实现放 `utils/digest.ts`，与审批的 `argsDigest` **共用同一函数**（保证「批准的参数」与「循环检测的键」口径一致）。

**幻觉工具名不消耗预算**（AC-08 第二条）：`TOOL_NOT_FOUND` 归类为「不可重试」，直接回喂可用工具列表，不递减重试预算。

### 7.6 安全实现清单（逐项可验收）

#### 7.6.1 SSRF 五重校验（`utils/ssrf-guard.ts` + `http-request.tool.ts`）

| # | 校验 | 实现要点 | 验收 |
|---|------|----------|------|
| 1 | 协议白名单 | 只允许 `http:`/`https:`；默认只放行 `https:`（`HTTP_ALLOW_INSECURE=true` 才放宽并告警）；`file:`/`ftp:`/`gopher:`/`data:` 一律拒 | `file:///etc/passwd` → `SSRF_BLOCKED` |
| 2 | URL 内嵌凭据拒绝 | 正则检出 `user:pass@` → 拒（凭据不入 URL、不入日志、不回喂模型） | `https://u:p@h/` → `SSRF_BLOCKED` |
| 3 | **DNS 解析后逐条校验** | `dns.promises.lookup(host, {all:true})` 取全部 A/AAAA，**任一**命中禁段即整体拒。禁段：IPv4 `0/8,10/8,100.64/10,127/8,169.254/16,172.16/12,192.168/16,198.18/15,224/4,240/4`；IPv6 `::1,fc00::/7,fe80::/10,::ffff:0:0/8,2002::/16,64:ff9b::/96,::` | `http://169.254.169.254/latest/meta-data/` → `SSRF_BLOCKED` |
| 4 | **DNS 重绑定（TOCTOU）** | 不使用 `fetch` 默认解析：用已校验的 IP 直接建连（`http.request` 覆写 `lookup`），`Host` 头仍为原域名——**校验与连接同一 IP** | 「校验时公网、连接时内网」→ 连接被拒 |
| 5 | **重定向逐跳校验** | 手动跟随 ≤3 跳，每跳重跑 1-4 全套，不信任 `Location` | 公网 302 → `169.254.169.254` → 拒 |

补充：响应体按字节流累计，超 `maxResultChars×3` 字节即停并 `truncated=true`；响应头过滤 `set-cookie`；可选 `HTTP_TOOL_ALLOWLIST` 域名白名单。

#### 7.6.2 文件 realpath 先解析后比较（`tools/builtin/path-jail.ts`）

```
rel → 拒绝绝对路径(含 C:\ 与 \\server\share) → 拒绝含 `..` 段(按 / 与 \ 双分隔符切分)
    → path.resolve(SANDBOX_ROOT, rel) → fs.realpath(存在时) / realpath(父目录)(写入时)
    → path.relative(realRoot, realTarget) 不以 `..` 开头且非绝对 → 通过
```
额外：Windows 保留设备名（`CON/PRN/AUX/NUL/COM1-9/LPT1-9`）与以空格/点结尾的路径拒绝。符号链接逃逸由 realpath 天然覆盖。

#### 7.6.3 审批服务端持有（§5 全章）

服务端**只接受决定**；`POST /approvals/:id` 的 zod schema 用 `.strict()`，出现 `arguments`/`toolName` 等键即 400。令牌验签 + 参数摘要复核任一不匹配 → **409 + 异常审计**，绝不按客户端提交的内容执行。

#### 7.6.4 密钥不落日志

`request-log` 中间件扩展脱敏字段：`apiKey`/`authorization`/`x-api-key`/`env`；`http.request` 的 `headers` 按键名（`apiKey|token|secret|password|authorization|cookie`）值替换为 `***`；上游错误经 `maskKey()`；SQLite 不存 Key（只在请求体中存在）；MCP 子进程**不继承** `LLM_SERVER_API_KEY`。

#### 7.6.5 其它

MCP `spawn(command, args, { shell: false })`，**绝不 `shell: true`**；`command` 禁止 shell 元字符；`env` 只透传用户显式配置。

---

## 8. 前端增量（本阶段只定契约，不写实现）

| 文件 | 职责 |
|------|------|
| `client/src/types/agent-events.ts` | 10 个 SSE 事件的 TS 联合类型，**与服务端 `server/src/types/agent-events.ts` 双向对齐** |
| `client/src/services/stream.ts` | 事件分发 switch 从 4 种扩到 10 种（保留帧分帧容错） |
| `client/src/hooks/useAgentStream.ts` | AbortController 中止 + 50ms 节流 flush + 工具事件聚合 |
| `client/src/stores/agentStore.ts` | 工具调用时间线（按 `callId` 索引，`status` 驱动卡片态） |
| `client/src/components/agent/ToolCallCard.tsx` | 卡片：类别图标 + 规范名 + 状态 + 耗时 + 参数摘要 + 结果摘要；成功默认折叠、失败默认展开 |
| `client/src/components/agent/ToolApprovalBar.tsx` | inline 确认条（**不弹窗**）：允许一次 / 本会话始终允许 / 拒绝（可附原因） |

**图标（lucide-react 1.60.0 规范名，禁止别名、禁止 emoji）**：成功 `CircleCheck`、失败 `CircleX`、超时 `Clock`+`TriangleAlert`、拒绝 `Ban`、跳过 `CircleSlash`、执行中 `Loader2`、待确认 `Circle`、审批 `ShieldAlert`、HTTP `Globe`、文件读 `FileText`、文件写 `FilePen`、目录 `FolderOpen`、计算 `Calculator`、时间 `Clock`、UUID `Fingerprint`、JSON `Braces`、MCP `Plug`、工具 `Wrench`。

---

## 9. 自检清单（交付前逐条打勾）

- [ ] 7 张表建表 SQL 与 `docs/agent/schema.sql` 一致，无 `artifacts` / `local_events`
- [ ] `POST/GET /api/v1/events` 未挂载，端点表已标注「本期不实现」
- [ ] 10 个 SSE 事件名**全部下划线**，与服务端类型文件逐字对齐
- [ ] `tool_result.status` 七值齐备；`rejected` 中性色、`skipped` 不计入失败数
- [ ] `POST /approvals/:id` 的 zod 是 `.strict()`；令牌/摘要不匹配 → 409 + `mismatch_count+1`
- [ ] `sanitizeToolName` 全项目唯一实现（`utils/tool-name.ts`）
- [ ] 恢复码：只存哈希、单次使用、连错 5 次锁 15 分钟、重生成旧码失效
- [ ] adapter L144-151 已删除；`tool-call-normalizer.ts` 10 个测试点全绿
- [ ] SSRF 五重校验逐条可复现；文件 jail 先 realpath 后比较
- [ ] 单文件 ≤300 行；入口 <100 行且只装配

---

## 10. 遗留项裁决结果（2026-10-22 项目总监已全部裁决）

| # | 事项 | 裁决 | 落实 |
|---|------|------|------|
| L-1 | 架构 §11.2 与 §7.2 口径不一致（「9 张表」+ 含 `artifacts`/`local_events` 的重复清单） | **批准同步修订** | §11.2 已收敛为 7 张表；另顺带修掉 §13（L2011 `token_estimate`→`tokens`）、§15 M8 第 30 条、§17 第 19 条三处引用已删表的残留 |
| L-2 | Spec §5 端点表行数与「18 个端点」口径不符 | **口径定为 21 个可调用端点**（Spec §5 已由项目总监改为 21） | 本文 §1 端点总表 21 个；openapi.yaml 16 paths / 21 端点，无需调整 |
| L-3 | `provider_capabilities` 由 Spec 的 5 列扩到 12 列 | **批准扩到 12 列**（AC-01 是持久化要求，5 列装不下响应契约的 6 个能力字段 + `lightweightModel`）；Spec 侧由项目总监自行同步，本文不需回写 | §7.2 与 openapi.yaml 已一致 |
| L-4 | `messages.tokens` vs 旧稿 `token_estimate` | **采用 Spec 的 `tokens`** | §11.2 与 §13 旧列名已改 |
| L-5 | `/agent/stream` 的 `MISSING_API_KEY` 走 SSE `error` 而非 HTTP 401 | **确认按 Spec §12 第 6 步执行**：写 SSE 头之后一切失败走 SSE `error`、HTTP 保持 200；写头之前走 HTTP 4xx JSON。前端错误卡片消费 SSE `error` 由项目总监写入 Phase 3 前端任务书 | openapi.yaml 已按此定义，维持不变 |

**追加（项目总监要求）**：`AGENT_APPROVAL_SECRET` 的生产部署要求已写入架构 §10.4、本文 §5.1 与根目录 `README.md` 环境变量表——三处同一句话：「生产部署必须显式配置 `AGENT_APPROVAL_SECRET`，否则进程重启会导致所有挂起审批失效」。

## 11. 设计侧提出的缺口与本轮处置（2026-10-22）

| # | 设计侧提出 | 裁决 | 落实 |
|---|-----------|------|------|
| Q-1 | AC-10「改参数重试」没有提交通道（`POST /approvals/:id` 的 `.strict()` 使 `arguments` 进不来） | **项目总监裁决：新增独立端点** `POST /api/v1/approvals/:id/revise`（Spec §5 端点 21→22）。架构师初版的「给 `decision` 加 `revise` 取值、不新增端点」方案**作废**——改参数与提交决定是两种性质的动作，用不同 `.strict()` schema 分离更不易误用。**两个通道不并存**（同一件事两条路是漂移起点） | §3.3.13；openapi 新增 path + `ApprovalReviseRequest`；schema.sql `approvals.decision` 加 `'revised'` + `status` 加 `'revised'` + `revised_from_id` + `revise_depth` |
| Q-2 | `error.kind` 缺完整枚举（原只给 `timeout` 一个示例） | **锁定 10 值**（见 §4.2.6 与架构 §8.2），逐条给中文标签 + 语义色 + 恢复动作 + retryable。项目总监要求「以设计侧 9 值为准，增删须说明理由」，**4 处增删已说明理由**：①−`payload_too_large`（结果超限走 `truncated` 标志位、请求体过大是 HTTP 413，都不是工具执行失败）；②−`forbidden`→`security`（AC-07 原文「被安全策略拒绝」）；③+`upstream`（5xx/401 与「网络不可达」的重试语义相反，落到 `internal` 会误导排障）；④+`circuit_open`（AC-08 明确要求第 4 次不触发 LLM 调用，且语义色是 neutral 不是 danger） | §4.2.6 枚举表；架构 §8.2；openapi `SseToolResultError.kind`；schema.sql `error_kind` 注释 |
| Q-3 | AC-10 的「单步重试 / 从某步重跑」同样没有通道 | **确认是缺口**，给出方案（给 `AgentRequest` 加 `resumeFromCallId` / `overrideArguments` 两个可选字段，复用同一循环），但**需项目总监批准**——在批准前设计侧不要出 UI 规格 | §3.3.11.1 |
| A-7 | 架构 §16.1 C-2 正文把事件命名写成 kebab-case | **无需修改**：C-2 正文（§8.1 上方）与 §16.1 裁决表当前均已是下划线，裁决 3 早已修正，设计侧读到的是旧版。前端按下划线实现正确 | 已回设计侧 |
| A-8 | `AppShell.tsx` 有 2 处 `AlertTriangle` 旧别名 | **确认存在**，但已登记为 Phase 3 清理项（架构 §12.3 与 §16.3 D-4），且本阶段禁止改动 `client/` 代码。Phase 3 顺手改 2 行，视觉零差异 | 已回设计侧 |
| A-9 | Spec §2 把 MCP 连机器列进 P1 Backlog，但端点/AC-12 都要求实现 | **同意设计侧判断**：这是 PRD 遗留文案，应以 Spec §5 的六个 MCP 端点 + Spec §7 页面清单 + AC-12 为准，按「做」处理 | 已回设计侧（属 team-lead 的 Spec 维护范围） |

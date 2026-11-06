# Phase 1 架构文档：通用 Agent 工具调用平台（CodeLens 改造）

> 版本：v1.0 | 日期：2026-10-21 | 作者：首席架构师 高见远 | 状态：Accepted
> 上游输入：用户已拍板约束（四类工具全要 / 服务端持久化记忆 / 双通道工具调用 / 技术栈沿用）、现有 CodeLens 代码底座实测、团队级 P0 绝对规则
> 本文档是 Phase 2 实现的唯一技术契约。凡本文未钉死的，实现时不得自由发挥；需要变更时先改本文再改代码。
> **本文只做调研与设计，不含任何代码改动。**

---

## 1. 改造起点与成功标准

### 1.1 现状

CodeLens 是**已交付上线**的编程助手 Web 应用：React 19.3.1 + Vite 8.3.4 SPA 前端，Express 5.3.0 后端，纯 LLM 代理层（BYOK、零留存），会话存浏览器 localStorage，无服务端数据库，无工具调用能力。

### 1.2 目标

把 CodeLens 改造成**通用 Agent 工具调用平台**：用户对 LLM 下达任务，Agent 自主调用 HTTP / 文件 / 计算 / MCP 四类工具完成任务，过程可视化，服务端持久化上下文记忆。

### 1.3 成功标准（可验收）

| # | 标准 | 验证方式 |
|---|------|----------|
| S-1 | LLM 能自主发起工具调用并根据结果继续推理，至少 2 轮迭代 | 端到端：提问"读取 sandbox/a.txt 并求字数"，产生 ≥2 个 tool_call 事件 |
| S-2 | 四类工具全部可用且可插拔 | 工具注册表单元测试 + 手工调用每个内置工具 |
| S-3 | 不支持原生 function calling 的模型能自动降级 ReAct 并正常完成 | 用 mock 模型（返回纯文本 ReAct 格式）验证降级链路 |
| S-4 | 上下文跨会话恢复：关闭浏览器重开后继续同一会话 | 重启服务后 `GET /api/v1/sessions/:id` 返回完整历史 |
| S-5 | MCP Server 不可用时内置工具完全不受影响 | 停掉 MCP 进程后内置工具仍全部通过 |
| S-6 | 单文件 ≤ 300 行、入口 < 100 行、构建/类型检查/lint 全绿 | 门禁命令（§12.4） |
| S-7 | SSRF / 路径越界 / 命令注入三类高危场景全部被拦截 | 安全测试用例逐条断言（§10） |

### 1.4 本次明确不做（Out-of-Scope，锁定）

- 不做多用户 / 账号体系 / 跨设备同步（仍免登录，会话以 `sessionId` 匿名寻址）。
- 不做云端部署与多实例水平扩展（仍单机单容器，内存限流与 SQLite 单文件假设成立）。
- 不做向量检索 / 语义记忆（记忆是"会话上下文持久化 + 窗口压缩"，不是 RAG 知识库）。
- 不做 Agent 多智能体协作（本期单 Agent 循环 + 工具族）。
- 不做 HTTP 请求工具的鉴权代理（不托管第三方 API Key，只透传用户自带的 header）。
- 不做 MCP 的 resources / prompts / sampling 能力（本期只接 tools）。
- 不做定时任务 / 后台常驻 Agent（本期全为"用户提问 → Agent 跑一轮"）。

---

## 2. 现有代码底座盘点与复用评估

### 2.1 复用评估总表

| 现有模块 | 路径 | 行数 | 结论 | 理由 |
|---------|------|------|------|------|
| Provider 适配层（协议/超时/掩码） | `server/src/providers/openai-compatible.adapter.ts` | 290 | **改造复用** | 超时、Key 掩码、错误归一化、SSE 帧解析全部保留；**`parseUpstreamSSE` 的 tool_calls 归一化逻辑必须重写**（见 §2.2） |
| Provider 注册表 | `server/src/providers/registry.ts` | 100 | **改造复用** | 保留 provider/baseUrl/模型结构；新增 `supportsNativeTools` / `toolChoiceValues` / `reasoningContentRetention` 能力字段 |
| BYOK Key 解析 | `chat.service.ts::resolveApiKey` | 15 | **原样保留** | 逻辑与工具调用无关，双模式（body 优先 / env 兜底 / 401）完全适用 |
| 上游消息组装 | `chat.service.ts::buildUpstreamMessages` | 20 | **改造复用** | 需扩展 `UpstreamMessage` 支持 `tool_calls` / `tool_call_id` / `name` 角色 |
| SSE 写帧工具 | `server/src/utils/sse.ts` | 42 | **原样保留** | `setSSEHeaders` / `sendSSEEvent` / `startSSEHeartbeat` / `endSSE` 全部复用，只需扩展事件名联合类型 |
| 内存限流 | `server/src/middlewares/rate-limit.ts` | 69 | **原样保留 + 扩展** | 滑动窗口实现复用；新增按 `sessionId` 的并发闸门（工具调用比对话贵） |
| 错误工具 | `server/src/utils/errors.ts` | — | **原样保留 + 扩展** | `AppError` / `ErrorCode` 复用；新增工具类错误码 |
| 环境配置 | `server/src/config/env.ts` | 74 | **改造复用** | Zod 校验模式复用；新增 `AGENT_*` / `MCP_*` / `SQLITE_*` / `SANDBOX_ROOT` 配置项 |
| 入口装配 | `server/src/app.ts` | 95 | **改造复用** | 保持"只装配"；新增路由挂载与 MCP 生命周期钩子 |
| 系统提示词（四类能力） | `server/src/services/prompts.ts` | 69 | **废弃（内容）/ 保留（文件位置）** | 四段式代码分析提示词与 Agent 场景无关；文件改为承载 Agent system prompt + ReAct 模板 |
| 聊天控制器/服务/路由 | `controllers/chat.controller.ts` 等 | — | **废弃** | `/chat` 与 `/chat/stream` 是"单轮问答"语义，Agent 场景是"多轮工具循环"，接口形态不同 |
| Zod 校验 schema | `server/src/validators/chat.schema.ts` | — | **废弃** | 同上；新建 agent/session/tools 三套 schema |
| 前端 SSE 解析 | `client/src/services/stream.ts` | 97 | **改造复用** | 帧分帧/容错逻辑复用；**事件分发 switch 必须扩展**（4 种 → 11 种事件） |
| 前端 SSE hook | `client/src/hooks/useSSEStream.ts` | 173 | **改造复用** | AbortController 中止、50ms 节流 flush、settle 收尾逻辑复用；新增工具事件状态聚合 |
| zustand stores | `client/src/stores/*` | 184+143+89 | **原样保留 + 新增** | `sessionStore` 保留但语义从"本地会话"改为"服务端会话镜像"；新增 `agentStore`（工具调用时间线） |
| localStorage 存储层 | `client/src/lib/storage.ts` | 253 | **保留（设置项）/ 废弃（会话项）** | `codeagent.settings.v1`（含 Key/主题）保留；`codeagent.sessions.v1` 会话持久化职责移交服务端 SQLite |
| Markdown 渲染 / 代码高亮 | `components/result/*` | — | **原样保留** | 工具结果与最终回答共用渲染管线 |
| 设计令牌 | `client/src/styles/design-tokens.css` | — | **原样保留** | 锁定不变；工具时间线组件必须复用既有令牌，不新增颜色体系 |
| 图标 | `lucide-react` 1.60.0 | — | **原样保留** | 唯一图标库，新增工具图标只用 Lucide 名称，不用 emoji |
| CodeMirror 编辑器 | `components/editor/CodeEditor.tsx` | 120 | **原样保留** | 与工具调用无耦合 |
| 现有 `types/index.ts` | 前后端各一份 | 124 / 57 | **改造复用** | 保留 `Task`/`ThemeMode` 等；新增 `ToolDefinition` / `AgentEvent` 联合类型 |

### 2.2 关键改造点：现有 adapter 的 tool_calls 处理是错的

现有 `parseUpstreamSSE` 把 `delta.tool_calls` 的 arguments 片段**拼成普通文本 `delta`** 发出（adapter 第 144-151 行）：

```ts
// 现有实现（错误）：tool_calls 被降级成纯文本，丢失 name 与 id
const fragments = toolCalls.map((c) => c.function?.arguments ?? '').join('');
if (fragments.length > 0) return { type: 'delta', text: fragments };
```

这在纯问答场景无害（tool_calls 不会出现），但在 Agent 场景是致命的：丢失了 `id`（无法把结果关联回调用）、`name`（不知道调哪个工具）、`index`（并行调用无法归并）。**必须重写为累积式 tool_call delta 归一化**，详见 §5.2。

### 2.3 现有 Provider 注册表的模型清单已过时

现有 registry 中的模型（`deepseek-chat`、`deepseek-reasoner`、`glm-4.6`、`kimi-k2`、`qwen-plus`、`gpt-4o-mini`）在 2026-10 已部分过时：DeepSeek 官方文档明确 `deepseek-chat` / `deepseek-reasoner` 将于 2026-07-24 弃用，替代模型为 `deepseek-v4-flash` / `deepseek-v4-pro`。

**处置**：本期不改 registry 现有条目（避免影响已上线的 CodeLens 问答链路），新增的 Agent 链路使用独立的 `agentProviders` 能力表（§5.3），并在 Phase 2 同步更新既有 registry。

---

## 3. 分层架构

### 3.1 总体分层图

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 表现层：前端 SPA（React 19.3.1 + Vite 8.3.4 + TS ~5.9 + Tailwind 4.3.3）   │
│                                                                           │
│  ┌────────────────┐ ┌──────────────────┐ ┌────────────────────────────┐ │
│  │ 对话区          │ │ 工具调用时间线    │ │ 设置 / 工具管理 / MCP 面板  │ │
│  │ MessageList     │ │ ToolCallTimeline │ │ SettingsModal / McpPanel  │ │
│  │ （复用）        │ │ （新建）          │ │ （扩展）                   │ │
│  └────────────────┘ └──────────────────┘ └────────────────────────────┘ │
│  状态：sessionStore（服务端会话镜像）+ agentStore（工具事件时间线）        │
│  图标：lucide-react 1.60.0（锁定唯一）  令牌：design-tokens.css（锁定）   │
└────────────────────────────────┬──────────────────────────────────────────┘
                                 │ POST /api/v1/agent/stream（SSE，单向）
┌────────────────────────────────▼──────────────────────────────────────────┐
│ API 代理层：Node 22.22.2 + Express 5.3.0                                  │
│  routes → controllers（校验+编排）→ services（业务）→ repositories（数据） │
│  中间件链：CORS → helmet/CSP → IP 限流 → body 限长 → 日志脱敏 → 错误统一  │
└────────────────────────────────┬──────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼──────────────────────────────────────────┐
│ Agent 编排层（新增，本项目核心）                                            │
│                                                                           │
│  AgentLoopService（状态机 / 预算 / 终止条件）                              │
│    ├─ ChannelRouter ──┬─ NativeChannel（function calling）                │
│    │                  └─ ReactChannel（提示词解析）                       │
│    │       ↓ 统一产出                                                       │
│    │   ToolCallIR（内部中间表示，上层不感知通道差异）                      │
│    │       ↓                                                                │
│    ├─ ToolRegistry（注册表：注册/查询/启禁用/按风险分组）                   │
│    │       ↓                                                                │
│    ├─ ToolExecutor（超时/重试/审批/截断/风险分级）                         │
│    │       ├─ BuiltinTool × N（http / fs / compute）                       │
│    │       └─ McpToolAdapter（MCP 动态工具）                               │
│    └─ ContextManager（token 估算/滑动窗口/摘要压缩/工具结果压缩）           │
└────────────────────────────────┬──────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼──────────────────────────────────────────┐
│ 基础设施层                                                                │
│  DataLayer：SQLite（node:sqlite）— sessions / messages / tool_calls 表    │
│  Provider 适配层：OpenAICompatibleAdapter（改造：tool_calls 归一化）       │
│  MCP Client：@modelcontextprotocol/client 2.3.1（stdio transport）        │
└────────────────────────────────┬──────────────────────────────────────────┘
                                 │ HTTPS
                      ┌──────────▼──────────┐
                      │  上游 LLM（5 家）    │
                      └─────────────────────┘
```

### 3.2 分层依赖铁律

- routes 只挂端点 + 中间件；controllers 只做参数校验、调 service、组装响应。
- services 不 import `req`/`res`，不返回 HTTP 响应；只返回业务结果或抛业务异常。
- **Agent 编排层不感知 HTTP**：SSE 帧写出由 controller 层调用 `SseWriter` 完成，编排层只产出事件对象。
- repositories 只做数据存取，不含业务判断。
- 工具 handler 不直接写 SSE（工具执行层与传输层解耦，通过返回的 `ToolOutcome` 携带事件）。
- 依赖只向下，禁止反向 import；跨模块协作走对方 service 接口。

---

## 4. Agent 调度循环设计

### 4.1 状态机

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
   用户提问 ────────►│  idle  ──prepare──►  thinking           │
                    │                      │                   │
                    │        ┌─────────────┼──────────────┐    │
                    │        ▼             ▼              ▼    │
                    │   文本增量      tool_call 解析    通道判定  │
                    │   (token)        (toolCalls)    (decide) │
                    │        │             │              │    │
                    │        │             ▼              │    │
                    │        │      awaiting_approval ─────┤    │
                    │        │        (需人工确认)          │    │
                    │        │             │              │    │
                    │        │             ▼              │    │
                    │        │       executing_tool        │    │
                    │        │             │              │    │
                    │        │             ▼              │    │
                    │        │      tool_result（含失败态）  │
                    │        │             │              │    │
                    │        │             └──► thinking ──┘    │
                    │        │                                  │
                    │        └──(无 tool_call)──► final ─────┤    │
                    │                                          │    │
                    └──────────────────────────────────────────┘    │
                                                                        ▼
                          done ◄──(终止条件满足)──┘
                          
  终止态：done（正常） | error（致命） | aborted（用户中止） | 
          budget_exhausted | max_iterations | circuit_open
```

**状态定义（锁定）**：

| 状态 | 含义 | 停留者 |
|------|------|--------|
| `idle` | 空闲，接受新提问 | 事件循环 |
| `thinking` | 等待上游 LLM 响应（含 token 增量） | AgentLoopService |
| `awaiting_approval` | 工具需人工审批，等待用户确认 | 审批服务 |
| `executing_tool` | 工具执行中 | ToolExecutor |
| `final` | LLM 给出最终回答，无工具调用 | AgentLoopService |
| `done` | 正常终止 | — |
| `error` | 致命错误终止 | — |
| `aborted` | 用户主动中止 | — |

### 4.2 预算与上限（锁定，配置在 `AGENT_*` env）

| 参数 | 默认值 | env 键 | 语义 |
|------|--------|--------|------|
| 最大迭代轮数 | 12 | `AGENT_MAX_ITERATIONS` | 一次提问内最多 LLM↔工具往返轮数 |
| 单轮最大工具并发数 | 4 | `AGENT_MAX_PARALLEL_TOOLS` | 同一轮多个 tool_call 的并发执行上限 |
| 单次提问总超时 | 180s | `AGENT_TOTAL_TIMEOUT_MS` | 整个循环的墙钟预算 |
| 单次 LLM 调用超时 | 60s | `AGENT_LLM_TIMEOUT_MS` | 单次上游请求 |
| 单个工具超时 | 15s（可被工具覆盖） | `AGENT_TOOL_TIMEOUT_MS` | 单次工具执行 |
| 连续工具失败熔断阈值 | 3 | `AGENT_CIRCUIT_THRESHOLD` | 连续 N 次工具失败即熔断本轮 |
| 上下文预算占比 | 0.7 | `AGENT_CONTEXT_RATIO` | 上下文窗口允许被历史占用的比例 |

**迭代计数口径**：`iteration` 从 1 开始，每发生一次"LLM 返回 tool_call"计 1 次迭代。`max_iterations` 命中时，产出一次"已达最大轮数"的最终回答（把已收集的 observation 总结给用户），不以错误结束。

### 4.3 一轮循环的完整时序

```
客户端                controller          AgentLoopService        ToolExecutor      上游 LLM       SQLite
  │                      │                      │                      │               │            │
  │─ POST /agent/stream ─►│                      │                      │               │            │
  │                      │─ createSession ─────────────────────────────────────────────────►─►│
  │                      │─ loadHistory ◄───────────────────────────────────────────────│
  │                      │                      │                      │               │            │
  │                      │── start(agentReq) ─►│                      │               │            │
  │                      │                      │─ buildContext ─────────────────────────────────►│
  │                      │                      │  (token 估算+窗口裁剪+摘要)                      │
  │                      │                      │                      │               │            │
  │                      │                      │─ decideChannel ──►│ (能力探测)      │            │
  │                      │                      │                      │               │            │
  │                      │                      │─ LLM.stream (tools=?) ──────────────────────►│
  │◄─ SSE meta ──────────┼──────────────────────┤                      │               │            │
  │◄─ SSE token × N ────┼──────────────────────┤◄────── delta ────────┤               │            │
  │                      │                      │                      │               │            │
  │                      │                      │  归一化为 ToolCallIR  │               │            │
  │                      │                      │  (通道差异在此消解)   │               │            │
  │                      │                      │                      │               │            │
  │◄─ SSE tool_call ────┼──────────────────────┤                      │               │            │
  │                      │                      │─ 查注册表 → 风险判定 → 审批判定          │            │
  │                      │                      │                      │               │            │
  │                      │                      │  [需审批]──► SSE tool_approval_required ─►│           │
  │◄─ POST /agent/approve ►│                      │                      │               │            │
  │                      │                      │                      │               │            │
  │                      │                      │─ execute(IR) ──────►│               │            │
  │                      │                      │                      │─ 执行+超时+重试+截断        │
  │◄─ SSE tool_progress ─┼──────────────────────┤◄──── progress ──────┤               │            │
  │◄─ SSE tool_result ───┼──────────────────────┤◄──── outcome ──────┤               │            │
  │                      │                      │─ persistToolCall ────────────────────────────►│
  │                      │                      │                      │               │            │
  │◄─ SSE context_notice ┼──────────────────────│ (若触发裁剪/压缩)    │               │            │
  │                      │                      │─ 下一轮：把 observation 拼回上下文          │            │
  │                      │                      │─ LLM.stream ─────────────────────────────────►│
  │◄─ SSE token × N ────┼──────────────────────┤                      │               │            │
  │                      │                      │  (无 tool_call → final)                       │
  │◄─ SSE done ──────────┼──────────────────────┤                      │               │            │
  │                      │─ persistMessages ─────────────────────────────────────────────────►│
```

### 4.4 终止条件（锁定，五种，逐一可测）

| # | 条件 | 判定点 | 系统行为 | SSE 终止事件 |
|---|------|--------|----------|--------------|
| T-1 | 正常完成 | LLM 返回 assistant 文本且无 tool_calls | 落库 assistant 消息 | `done`，`finishReason=stop` |
| T-2 | 达到 max_iterations | `iteration > AGENT_MAX_ITERATIONS` | 生成总结性最终回答（基于已有 observation），落库 | `done`，`finishReason=max_iterations` |
| T-3 | 预算耗尽 | 墙钟超 `AGENT_TOTAL_TIMEOUT_MS` 或累计 token 超模型窗口 | 立即中止，保留已产生内容 | `done`，`finishReason=budget_exhausted` |
| T-4 | 用户中止 | 客户端 `AbortController.abort()`（前端停止按钮） | AbortSignal 贯穿到上游 fetch 与工具执行 | `done`，`finishReason=aborted` |
| T-5 | 连续工具失败熔断 | 连续 `AGENT_CIRCUIT_THRESHOLD` 次工具失败（同一轮内） | 停止继续调用工具，把失败摘要作为 observation 回喂 LLM 让其收尾 | `done`，`finishReason=circuit_open` |

**关键约束**：T-2/T-3/T-5 都不是"错误"。它们必须以 `done` 事件结束（携带对应 `finishReason`），前端不得显示为红色错误。只有"上游不可达且无法降级"才是 `error` 事件。

---

## 5. 双通道工具调用设计

### 5.1 统一中间表示（Internal IR）

两条通道产出**完全相同**的 IR，上层（AgentLoopService、ToolExecutor、SSE）不感知通道差异。

```ts
/** 工具调用的统一中间表示。两条通道都必须归一化成此结构。 */
export interface ToolCallIR {
  /** 稳定调用 ID。原生通道用上游返回的 id；ReAct 通道自生成。 */
  id: string;
  /** 工具名，必须能唯一命中注册表（已做冲突消解，见 §6.5）。 */
  name: string;
  /** 已解析的参数对象（JSON Schema 校验通过后）。 */
  arguments: Record<string, unknown>;
  /** 原始参数字符串（原生通道为 arguments 原文，ReAct 通道为抽取的 JSON 原文），用于错误诊断。 */
  rawArguments: string;
  /** 本次调用由哪条通道产生。 */
  channel: 'native' | 'react';
}

/** 一轮 LLM 输出的归一化结果。 */
export interface TurnIR {
  /** LLM 产生的可见文本（可能是空）。 */
  text: string;
  /** 解析出的工具调用列表（可能为空）。 */
  toolCalls: ToolCallIR[];
  /** 上游 finish_reason 原值（已归一化）。 */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  /** 解析告警（如 ReAct 通道 JSON 解析失败后走了兜底）。 */
  warnings: string[];
  usage: Usage;
}
```

**IR 归一化点**：原生通道的 `parseUpstreamSSE` 与 ReAct 通道的 `parseReactOutput` 都只输出 `TurnIR`，`AgentLoopService` 只消费 `TurnIR`。这是"上层不感知差异"的物理保证。

### 5.2 通道 A：原生 function calling

**请求**（在现有 `buildBody` 上扩展）：

```jsonc
{
  "model": "deepseek-v4-pro",
  "messages": [...],
  "stream": true,
  "stream_options": { "include_usage": true },
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "http_request",
        "description": "发起一次 HTTP 请求",
        "parameters": { "type": "object", "properties": {...}, "required": [...] }
      }
    }
  ],
  "tool_choice": "auto"
}
```

**流式解析（重写 adapter 的 tool_calls 分支）**：

上游按 `index` 分片推送，`name` 与 `id` 通常只在首片出现，`arguments` 分多片：

```
delta.tool_calls[0] = { index:0, id:"call_abc", type:"function",
                        function:{ name:"http_request", arguments:"{\"url\"" } }
delta.tool_calls[0] = { index:0, id:"", type:"function",
                        function:{ name:null, arguments:":\"https://x\"}" } }
```

归一化算法（`normalizeToolCallDeltas`，纯函数，可单测）：

1. 用 `Map<number, {id, name, argsFragments[]}>` 按 `index` 累积。
2. `id` 取首个非空值；`name` 取首个非空值。
3. `arguments` 片段按到达顺序拼接为 `rawArguments`。
4. 收到 `finish_reason: "tool_calls"` 时，将累积结果转成 `ToolCallIR[]`。
5. 拼接后 `JSON.parse` 失败 → 该调用标记 `parseError`，产出失败结果（`errorCode=TOOL_ARGS_INVALID`）并以 `tool_result{status:'failed'}` 事件回喂 LLM，**不中断整轮**。

**工具结果回填**（严格按 OpenAI 兼容格式）：

```jsonc
// 先追加 assistant 消息（必须原样带回 tool_calls）
{ "role": "assistant", "content": null, "tool_calls": [
  { "id": "call_abc", "type": "function",
    "function": { "name": "http_request", "arguments": "{\"url\":\"https://x\"}" } }
]}
// 再为每个调用追加一条 role=tool 消息（数量必须与 tool_calls 一一对应）
{ "role": "tool", "tool_call_id": "call_abc", "name": "http_request", "content": "{\"status\":200,...}" }
```

> **硬约束**：`role:"tool"` 消息的条数必须与 assistant 消息的 `tool_calls` 长度一致，且 `tool_call_id` 必须匹配。上游对不匹配会直接 400。并行调用时所有 tool 消息都要追加完，才能发起下一轮。

### 5.3 各 Provider 的 function calling 差异（联网核实，2026-10-21）

**结论：不能假定"5 家 provider 行为一致"。必须在 provider 能力表里逐项声明。**

| Provider | 原生 tools | `tool_choice` 可用值 | `parallel_tool_calls` | 特殊坑（必须处理） |
|----------|-----------|---------------------|----------------------|--------------------|
| OpenAI | 支持 | `auto` / `none` / `required` / 指定函数 | 支持 | `strict: true` 需 OpenAI 支持的 JSON Schema 子集；strict 模式下必须 `parallel_tool_calls:false` |
| DeepSeek | 支持 | `auto` / `none` / `required` / 指定函数 | **忽略该参数**（并行始终开启） | ① 思考模式下必须在每轮 assistant 消息保留 `reasoning_content`，否则 400；② strict 模式需 `base_url` 改为 `https://api.deepseek.com/beta`；③ `deepseek-reasoner`（旧推理模型）**不支持 Function Call**，必须走 ReAct |
| 智谱 GLM | 支持 | `auto` / `none` / `required` / 指定函数 | 取决于模型 | ① **必须显式传 `tool_stream: true`**，否则不返回 `tool_calls`（`glm-5.3` 起默认 true）；② 思考模式下 `tool_choice` 不支持 `required` 与指定函数 |
| 通义千问 | 支持 | `auto` / `none` / 指定函数（**不支持 `required`**） | 支持，需显式 `parallel_tool_calls:true` | 思考模式下不支持 `required`；`qwen-omni-realtime` 系列不支持 `tool_choice` 与 `parallel_tool_calls` |
| Moonshot Kimi | 支持 | `auto` / `none` / `required`（仅 kimi-k3） / 指定函数 | 支持 | ① 思考模式（kimi-k2.5/2.6/2.7/k3）必须在 assistant 消息保留 `reasoning_content`；② `finish_reason=tool_calls` 时 `content` 偶尔非空（模型在解释为何调用），需容忍 |

**能力表设计**（新增 `server/src/providers/capabilities.ts`）：

```ts
export interface ProviderCapabilities {
  /** 是否支持原生 function calling。false → 强制走 ReAct。 */
  nativeTools: boolean;
  /** 允许下发的 tool_choice 取值集合。 */
  toolChoiceValues: readonly ('auto' | 'none' | 'required' | 'named')[];
  /** 是否需要显式下发 parallel_tool_calls。 */
  explicitParallelToolCalls: boolean;
  /** 是否必须在 assistant 历史消息中保留 reasoning_content。 */
  retainReasoningContent: boolean;
  /** 是否需要显式下发 tool_stream。 */
  requireToolStreamFlag: boolean;
  /** 触发原生能力探测失败后的降级策略。 */
  onToolCallFailure: 'fallback_react' | 'error';
}
```

**参数下发规则（`buildToolRequest`）**：
- `tool_choice` 默认发 `auto`（5 家全支持，是唯一安全的公共值）。
- `required` / 指定函数：仅当 `toolChoiceValues` 包含且未处于思考模式时才发。
- `parallel_tool_calls`：仅当 `explicitParallelToolCalls` 为 true 时发 `false`（保守，MVP 不做并行调用以简化审批与结果归并）。
- `tool_stream: true`：仅当 `requireToolStreamFlag` 为 true 时发。
- `reasoning_content`：当 `retainReasoningContent` 为 true 时，在 assistant 历史消息中保留该字段。

### 5.4 通道 B：ReAct 降级

**提示词模板**（`server/src/services/prompts/react.prompt.ts`，锁定骨架）：

```text
你是一个可以调用工具的智能体。请严格遵守以下协议：

可用工具：
{{TOOLS_BLOCK}}

当你需要调用工具时，**只输出**下面这一段 JSON 代码块，不要输出任何其他内容：
```tool_call
{"tool": "工具名", "arguments": { ...参数... }}
```

当工具结果返回后，你会看到形如：
```tool_result
{"tool": "工具名", "ok": true, "data": ...}
```

规则：
1. 每次只调用一个工具，等待结果返回后再决定下一步。
2. 不得臆造工具名；不在上面列表中的工具一律不能调用。
3. 工具返回错误时，依据错误信息修正参数重试，最多 3 次。
4. 信息足够时，直接用自然语言给出最终回答，不要再输出 tool_call 块。
```

**输出解析器**（`parseReactOutput`，纯函数，三级降级）：

| 级别 | 策略 | 命中条件 |
|------|------|----------|
| L1 | 提取 ```` ```tool_call ```` 围栏块内的 JSON | 标准格式 |
| L2 | 全文扫描第一个平衡的 `{...}`，尝试 `JSON.parse` 后校验有 `tool` 字段 | 模型漏了围栏 |
| L3 | 正则 `"tool"\s*:\s*"([^"]+)"` + 紧邻的 `"arguments"\s*:\s*(\{...\})` | 模型输出被截断或混入了散文 |

解析失败处理（兜底，不崩循环）：
- 三级全失败且文本不含任何工具意图 → 视为普通回答（`toolCalls=[]`），进入 T-1 终止。
- 解析出工具名但参数非法 → 生成 `ToolCallIR` 但 `arguments={}`，由 ToolExecutor 做 schema 校验，产出失败结果（`errorCode=TOOL_ARGS_INVALID`）回喂 LLM。
- 解析出未知工具名 → 产出失败结果（`errorCode=TOOL_NOT_FOUND`），回喂 LLM 并在错误信息中列出可用工具名。

**ReAct 通道的 observation 回填**：ReAct 没有 `role:"tool"` 协议，服务端把工具结果包装成一条 `user` 消息：

```jsonc
{ "role": "user", "content": "```tool_result\n{\"tool\":\"http_request\",\"ok\":true,\"data\":{...}}\n```" }
```

并在其前保留一条 `assistant` 消息记录模型上一轮的原始输出（保证上下文连续）。

### 5.5 能力探测与自动切换

**探测落点（回答 PM 提问 1）**：**在既有 provider 适配层内新增一个 `probeToolSupport()` 方法，不另开独立 probe 通道。**

理由：
1. 探测请求与真实调用**必须走同一条链路**（同 baseUrl、同 Key、同超时、同错误归一化）。另开通道会产生「探测通过但实际失败」或反之的偏差——而能力探测的唯一用途就是预测实际调用会不会失败。
2. 探测是**一次性**的（PRD §8.3：切换模型或首次使用时发一次，结果落 `provider_capabilities` 表，**不在每轮试探**——每轮试探既烧 token 又拖慢首字延迟）。既有 adapter 已有 `chat()` 非流式方法，探测复用它即可，无需新抽象。
3. 探测请求体：定义**一个只有一个参数的假工具**（如 `__probe__`，参数 `x: string`），要求模型调用它。判定：响应含 `tool_calls` → 支持；响应为普通文本或上游明确拒绝 `tools` 参数 → 不支持；请求本身失败（网络/鉴权）→ **探测失败**（区别于「不支持」，PRD AC-01 三态）。
4. **探测定时**：仅在①用户切换模型时、②该 `(provider, model)` 在 `provider_capabilities` 表中无记录时触发。设置页的「测试连通性」复用同一方法，结果一并落表。
5. 探测**不进入 SSE 事件流**，不消耗任务的重试预算。

**三级探测**（静态优先，运行时兜底）：

| 级别 | 触发时机 | 方法 | 结果 |
|------|----------|------|------|
| L0 静态 | 请求发出前 | 查 `ProviderCapabilities.nativeTools` | false → 直接走 ReAct，不浪费一次上游调用 |
| L1 运行时 | 收到上游 4xx 且错误信息匹配 `/tool_choice\|tools\|tool_calls\|not support/i` | 标记该 `(providerId, modelId)` 会话级降级 | 切换 ReAct 重试本轮 |
| L2 降级后回切 | 后续请求 | 每次新会话开始时，对 L1 降级过的模型重试一次原生通道 | 成功 → 清除降级标记；仍失败 → 保持 ReAct |

**探测结果持久化**（PRD §7.1 / §8.3 / AC-01）：落 `provider_capabilities` 表，主键 `(provider, model)`，字段 `supports_function_calling`（`true` / `false` / `probe_failed`）、`probed_at`、`notes`。**L1 运行时降级也要回写此表**（把 `false` 记下来），避免每个会话都重新踩同一个坑。

**降级标注给前端**：`meta` 事件携带 `channel` 字段（`native` / `react`）与 `degraded: boolean` 与 `degradedReason?: string`。前端在工具时间线顶部显示一条静态提示条（文案：当前模型不支持原生工具调用，已降级为指令解析模式），不弹窗、不打断。

**是否可回切**：可以，但仅在**新会话**级别自动回切（L2），**同一轮内不自动回切**（避免同一轮里两个通道的 observation 格式不一致导致上游 400）。用户可在设置页手动锁定通道（`auto` / `native` / `react`），锁定时跳过探测。

---

## 6. 工具注册表设计

### 6.1 `ToolDefinition` 接口（锁定）

```ts
export type ToolRiskLevel = 'low' | 'medium' | 'high';
export type ToolApprovalMode = 'none' | 'soft' | 'hard' | 'two_step';
export type ToolSource = 'builtin' | 'mcp';

export interface ToolDefinition {
  /** 规范名（点号命名空间，唯一标识）。内部 / 展示 / 落库用此名。 */
  name: string;
  /** 下发给 LLM 的工具名（已消毒，见 §6.1.1）。LLM 只会见到这个名字。 */
  wireName: string;
  /** 面向用户的显示名（设置页 / 审批条 / 示例任务用，不出现在工具卡片上）。 */
  displayName: string;
  /** 工具类别，决定图标与分组。 */
  category: 'http' | 'file' | 'compute' | 'mcp';
  /** 给 LLM 看的功能描述，必须写清「何时该调用」，这是工具选择准确率的主要来源。 */
  description: string;
  /** JSON Schema（draft-07 子集），直接下发给上游 provider。 */
  inputSchema: JsonSchemaObject;
  /** 执行器。输入是已通过 schema 校验的参数，输出是归一化结果。 */
  handler: ToolHandler;
  /** 单次执行超时上限（毫秒），与全局默认取小。 */
  timeoutMs: number;
  /** 基线风险等级（工具自身的潜在影响面）。实际风险由「基线 + 本次参数」在调用时判定。 */
  risk: ToolRiskLevel;
  /** 基线确认强度。实际确认强度由「基线 + 本次参数」在调用时判定并随事件下发。 */
  approvalMode: ToolApprovalMode;
  /**
   * 是否启用。**函数式**（PRD §5.2）：MCP 工具可表达「仅当该 server 已连接才为 true」，
   * 内置工具可表达「仅当某能力可用才为 true」。返回 false 的工具不进入 tools 列表。
   */
  enabled: (ctx: ToolEnableContext) => boolean;
  /** 来源。 */
  source: ToolSource;
  /** 幂等键：相同 key 重复调用返回缓存结果。内置工具大多为 true（无副作用）。 */
  idempotent: boolean;
  /** 结果最大字符数，超出截断。 */
  maxResultChars: number;
  /** 仅 mcp 来源：所属 MCP Server 标识。 */
  mcpServerId?: string;
}

export interface ToolEnableContext {
  sessionId: string;
  /** MCP Server 连接状态（内置工具忽略）。 */
  mcpServerConnected?: boolean;
  /** 用户对高危工具的风险档位下调结果（MCP 工具用）。 */
  riskOverride?: ToolRiskLevel;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => Promise<ToolOutcome>;

export interface ToolExecutionContext {
  sessionId: string;
  /** 工具结果落库后的可回查 ID。 */
  resultId: string;
  /** 进度上报回调（用于 tool_progress 事件）。 */
  reportProgress: (stage: string, message?: string) => void;
  /** 外部中止信号。 */
  signal: AbortSignal;
}

export interface ToolOutcome {
  ok: boolean;
  /** 归一化后的结果数据（会 JSON 序列化后回喂 LLM）。 */
  data: unknown;
  /** 面向用户的简短摘要（前端卡片标题区显示）。 */
  summary: string;
  /** 失败时的错误码（ok=false 时必填）。 */
  errorCode?: ToolErrorCode;
  /** 失败时的可读信息。 */
  errorMessage?: string;
  /** 该错误是否值得重试。 */
  retryable?: boolean;
  /** 结果是否被截断。 */
  truncated?: boolean;
}
```

### 6.1.1 工具名双轨制：规范名（点号）vs 线上名（下发给 LLM）

> **这是 Phase 1 跨文档裁决项 C-1，也是本项目最高优先级的实现约束。**

**问题**：PRD §5.1 规定工具标识符采用点号命名空间（`http.request` / `fs.read` / `mcp.filesystem.read_file`），UIUX §3.1 依赖该形式做卡片展示与审计检索。但**所有 OpenAI 兼容 provider 强制校验 `tools[].function.name` 必须匹配 `^[a-zA-Z0-9_-]{1,64}$`——点号不在允许字符集内**。

**证据（联网核实 2026-10-21）**：
- OpenAI 官方 API 文档：`name` "Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 64."
- 实测错误：`Invalid 'tools.function.name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.`（HTTP 400，整个请求被拒——不是单个工具被跳过，是**整次请求失败**）。
- 已有生产事故两起：某 Agent 框架因 MCP 工具名带点号（`aippt.doc_beautify`）在 DeepSeek 上 100% 失败；某插件因工具名 `demo.time` 上线即 400。
- 根因：MCP 规范允许工具名含点号（`2025-11-25` spec 允许 `A-Za-z0-9_-` 之外的点号形式），但 OpenAI 兼容协议层不允许——**协议转换层必须做名字消毒**。

**裁决：采用双轨制（规范名 + 线上名）**。

| 轨道 | 名称形式 | 用途 | 出现位置 |
|------|----------|------|----------|
| **规范名**（canonical） | 点号，如 `http.request`、`mcp.filesystem.read_file` | 内部标识、数据库落库（`tool_calls.tool_name`）、前端卡片展示、审计检索、用户复制 | `tool_calls.tool_name`、UI 卡片标识符列、设置页 |
| **线上名**（wire） | 下划线，如 `http_request`、`mcp_filesystem_read_file` | **仅**用于下发给 LLM 的 `tools[].function.name` | 上游请求体、`ToolCallIR.name` |

**消毒规则（`sanitizeToolName`，纯函数，必须有单测）**：
1. 点号 `.` → 下划线 `_`；其余非 `[a-zA-Z0-9_-]` 字符（空格、中文、斜杠等）→ `_`。
2. 连续下划线压缩为单个；首尾下划线去除。
3. 结果必须非空且以字母开头（不以数字或下划线开头）——不满足则前置 `t_`。
4. 截断至 64 字符（provider 硬上限），截断后若产生冲突则追加 `_2` / `_3`。
5. **冲突消解**：消毒后若与已有工具的线上名相同，按注册顺序追加数字后缀直到唯一；**规范名保持不变**（`http.request` 与 `http_request` 两个不同工具可以共存，线上名分别是 `http_request` 与 `http_request_2`）。
6. **注册期校验**：注册表在 `register()` 时校验规范名匹配 `/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/`（点号命名空间），不匹配直接抛错（加载期拒绝，而非上线后才炸）。

**回程映射**：LLM 返回的 `tool_calls[].function.name` 是**线上名**。执行前必须用注册表的 `wireName → canonical` 反查表还原为规范名，再落库与展示。反查失败 → 失败结果 `errorCode=TOOL_NOT_FOUND`。

**ReAct 通道同样使用线上名**：提示词中的工具清单用线上名（保证模型产出的名字能被反查），但**提示词中同时给出规范名**供人读：`{"name": "http_request", "displayName": "HTTP 请求"}`。

**对 UIUX 的影响（已回传设计侧）**：卡片展示用**规范名**（点号，mono 字体），与 PRD §5.1 / UIUX §3.1 一致；`tool_calls.tool_name` 落库**规范名**（保证"卡片显示 = 审计记录显示 = 可检索"）；只有下发给 LLM 的那一层用线上名。两者在设置页的工具详情里同时可见（规范名 + 线上名 + 消毒来源说明）。

**这条约束的落点**：`providers/tool-call-normalizer.ts` 与 `services/tools/registry.service.ts` 必须共用同一个 `sanitizeToolName`（放 `utils/tool-name.ts`），杜绝两处实现漂移。Phase 2 第一个里程碑就要有「注册一个带点号的工具 → 断言下发给 provider 的名字是下划线形式 → 断言 LLM 返回该名字能被反查回规范名」的端到端测试。

### 6.2 注册、查询、启禁用

**注册表服务**（`server/src/services/tools/registry.service.ts`）：

```ts
class ToolRegistry {
  register(def: ToolDefinition): void;          // 同名覆盖需显式 overwrite: true
  registerAll(defs: ToolDefinition[]): void;
  get(name: string): ToolDefinition | undefined;
  list(filter?: { source?: ToolSource; risk?: ToolRiskLevel; category?: ToolDefinition['category']; enabledOnly?: boolean }): ToolDefinition[];
  setEnabled(name: string, enabled: boolean): void;
  /** 按风险分组，供前端分区展示。 */
  groupedByRisk(): Record<ToolRiskLevel, ToolDefinition[]>;
  /** 导出为上游可用的 tools 参数。 */
  toProviderTools(names?: string[]): ProviderToolSpec[];
}
```

**启禁用语义**：
- 禁用是**运行时状态**，存内存（进程内 Map）+ 可选持久化到 `tool_preferences` 表（按 sessionId 或全局）。
- 禁用的工具：不进入 `toProviderTools()`（LLM 看不到）、从注册表 `list()` 中隐藏、已被 LLM 请求但已禁用 → 失败结果 `errorCode=TOOL_DISABLED`。
- **安全默认**：`destructive` 风险工具与 `exec` 风险工具**默认 enabled=false**，必须用户显式开启。

### 6.3 按风险分组

**风险是「工具 + 操作」的二元判定，不是纯工具属性**（PRD §5.1 / UIUX §3.8 关键设计）：同一个 `fs.write`，新建文件是中风险（软确认即可），覆盖已有文件是高风险（硬确认）；同一个 `http.request`，GET 是低风险，DELETE 是高风险。

因此 `ToolDefinition.risk` 与 `approvalMode` 是**基线值**，实际值在**调用时**由「基线 + 本次参数」共同判定，随事件下发给前端。**前端不自行推断风险**（UIUX §3.8：前端不能成为安全判定的第二来源）。

| 风险等级 | 判定标准 | 典型工具/操作 | 基线确认强度 |
|----------|----------|---------------|--------------|
| `low` | 只读、不外发、无副作用、可无限重试 | `fs.read`、`fs.list`、`calc.evaluate`、`time.now`、`uuid.generate`、`json.format`、`text.diff`；`http.request` 的 GET/HEAD | `none` |
| `medium` | 有网络出口或写操作，但范围受限、可回滚 | `fs.write` 的新建 / 追加 / 重命名 | `soft`（30 秒撤销横幅） |
| `high` | 触及外部系统、影响范围不可预判、或有破坏性 | `fs.write` 的覆盖已有文件 / 删除；`http.request` 的 POST/PUT/PATCH/DELETE；MCP 工具（默认按 high 起评，用户可逐个下调） | `hard`（就地 inline 确认条） |

**确认强度四档（PRD §6.4）**：

| 档位 | 交互形态 | 适用 |
|------|----------|------|
| `none` | 不打断 | 只读操作 |
| `soft` | 执行后 30 秒撤销横幅（不打断流程） | 可逆写入 |
| `hard` | 就地 inline 确认条（不弹窗、不打断对话流）：完整展示目标 + 完整参数 + 影响范围，提供「允许一次 / 本次会话始终允许 / 拒绝（可附原因）」 | 破坏性 / 对外写 |
| `two_step` | inline 确认条 + 必须勾选「我已审阅参数并接受风险」或键入确认短语才启用「允许」 | 灾难性 / 不可逆对外（如删除整个工作区目录） |

**关键设计**：`two_step` **仅在用户或规则显式升级时使用**——它是逃生舱，不是常态。

**运行期风险升级规则（锁定）**：

| 工具 | 参数组合 | 实际风险 | 实际确认 |
|------|----------|----------|----------|
| `http.request` | method ∈ {GET, HEAD} | low | none |
| | method ∈ {POST, PUT, PATCH, DELETE} | high | hard |
| `fs.write` | mode = create / append / rename（目标不存在） | medium | soft |
| | mode = overwrite（目标已存在） | high | hard |
| `fs.delete` | 任意 | high | hard |
| `fs.delete` | recursive = true 且目标是工作区根目录 | high | **two_step** |
| MCP 工具 | 默认 | high | hard（用户可在连接器页逐个下调） |
| 其它内置工具 | — | low | none |

**安全默认**：`high` 风险工具与 `exec` 类工具**默认 `enabled=false`**，必须用户显式开启。MCP 工具整体默认 `enabled=false`（PRD §5.3：MCP server 默认不启用）。

### 6.4 新增一个工具的完整步骤清单（交付给未来维护者的契约）

新增任何工具（内置或 MCP）必须按以下 8 步完成，缺一步视为未完成：

1. **定义 `ToolDefinition`**：在 `server/src/tools/builtin/<name>.tool.ts` 导出一个 `ToolDefinition` 常量（单一导出，文件名 = 工具名）。
2. **写 JSON Schema**：`inputSchema` 必须是 draft-07 子集（`type`/`properties`/`required`/`enum`/`items`/`description`），**禁止** `$ref`/`oneOf`/`patternProperties` 等 DeepSeek strict 模式不支持的关键字（否则 strict 模式会 400）。
3. **写 handler**：只做业务逻辑，**不**做超时（由 ToolExecutor 统一施加）、**不**做审批（由 ToolExecutor 统一判定）、**不**写 SSE（用 `ctx.reportProgress`）。
4. **风险定级**：填 `risk` / `approvalMode` / `idempotent` / `maxResultChars`；若为 MCP 工具，另填 `mcpServerId`。
5. **注册**：在 `server/src/tools/builtin/index.ts` 的 `BUILTIN_TOOLS` 数组中登记（集中登记，禁止在别处隐式注册）。
6. **加测试**：`server/src/tools/builtin/__tests__/<name>.tool.test.ts` 必须覆盖：正常路径、参数非法路径、超时路径（用注入的慢 handler）、越界/安全路径（若涉及路径或网络）。
7. **加文档**：在 `docs/agent/phase1-architecture.md` 的 §6.6 工具清单表登记（name / risk / 参数 / 返回）。
8. **过门禁**：文件 ≤300 行；`npm run typecheck` 与 `npm test` 全绿。

**MCP 工具的例外**：MCP 工具由 MCP Server 提供，schema 来自 `listTools()` 的 `inputSchema` 原样透传。适配层负责：① 校验其是否为合法的 draft-07 子集（不合法则该工具降级为 ReAct-only，不进入原生 tools 列表）；② 补 `risk`（MCP 工具默认 `high`，用户可在连接器页逐个下调，但**不得**自动调高为 `low`）；③ 补 `approvalMode`（默认 `hard`）；④ 补 `timeoutMs`（默认 15s）；⑤ 规范名按 `mcp.<serverId>.<toolName>` 构造并做线上名消毒（§6.1.1）。

### 6.5 工具名冲突消解

冲突场景：内置 `http.request` 与某个 MCP Server 也提供名为 `http.request` 的工具。

**消解规则（锁定）**：
1. 注册表主键是**规范名**：内置工具用 `http.request` 这类点号名；MCP 工具一律加 `mcp.<serverId>.` 前缀，如 `mcp.filesystem.read_file`。
2. 因此内置工具永远不会被 MCP 覆盖。
3. 多个 MCP Server 之间同名：`<serverId>` 唯一（用户配置时校验重复），若仍冲突（serverId 规范化后相同）则拒绝注册第二个 Server 并返回明确错误。
4. 传给 LLM 的工具名是**线上名**（`mcp_filesystem_read_file`，§6.1.1 消毒后），LLM 看到的名字唯一且符合 provider 校验。
5. `ToolCallIR.name` 存**线上名**；执行前用 `wireName → canonical` 反查表还原规范名，查不到 → 失败结果 `errorCode=TOOL_NOT_FOUND`。
6. 前端展示用 `displayName` + 来源标签（内置 / MCP Server 名），不展示消解后的原始名。

### 6.6 内置工具族逐个设计

**内置工具清单（与 PRD §5.1 锁定，9 个）**：

| 规范名 | 类别 | 能力 | 基线风险/确认 |
|--------|------|------|---------------|
| `http.request` | http | 任意外部 API：method/headers/body/query；JSON 与纯文本响应；超时与重试 | low/none（GET·HEAD）；运行期非幂等方法 → high/hard |
| `fs.read` | file | 读沙箱内文件（支持行范围、关键字搜索、glob 匹配） | low/none |
| `fs.write` | file | 新建/覆盖/追加/重命名/删除沙箱内文件 | 运行期：新建·追加·重命名 → medium/soft；覆盖已有文件·删除 → high/hard |
| `fs.list` | file | 列目录、查文件大小与修改时间 | low/none |
| `calc.evaluate` | compute | 表达式求值（四则/幂/三角/进制转换），受限语法沙箱 | low/none |
| `time.now` | compute | 当前时间、时区换算、日期加减 | low/none |
| `uuid.generate` | compute | 生成 UUID v4 | low/none |
| `json.format` | compute | JSON 美化/压缩/校验/路径提取（JSON Pointer） | low/none |
| `text.diff` | compute | 两段文本差异比对 | low/none |

**两处与架构初稿的差异（PRD 收敛结果，采纳）**：
1. **不再单设 `fs.delete`**——删除是 `fs.write` 的一个 `operation` 取值。理由：工具越少，LLM 选择准确率越高、上下文成本越低（PRD P3 自身即关注「工具太多不知道怎么选」）；且删除的 high/hard 风险由**运行期参数判定**表达（§6.3），不需要独立工具承载。
2. **不再单设 `json.path` / `text.regex` / `text.stats` / `tool.result.read`**——JSON Pointer 路径提取并入 `json.format`；正则与文本统计不在 PRD 锁定清单内，移入 Backlog；**长结果回查不新增工具**，改为「artifacts 落盘在沙箱工作区内，`fs.read` 直接按路径回查」（§7.5.2），零新增能力面。

#### 6.6.1 `http.request`（HTTP 请求工具）

```ts
{
  name: 'http.request',            // 规范名（点号）
  wireName: 'http_request',        // 线上名（下发给 LLM，§6.1.1 消毒生成）
  displayName: 'HTTP 请求',
  category: 'http',
  description: '向任意外部 HTTP/HTTPS 服务发起请求并返回响应。当需要查询实时数据、调用第三方 API、下载网页内容时使用。支持 GET/POST/PUT/PATCH/DELETE。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL，必须以 http:// 或 https:// 开头' },
      method: { type: 'string', enum: ['GET','POST','PUT','PATCH','DELETE','HEAD'], description: 'HTTP 方法，默认 GET' },
      headers: { type: 'object', description: '请求头，键为字符串值为字符串' },
      body: { type: 'string', description: '请求体（字符串），仅 POST/PUT/PATCH 有意义' },
      timeoutMs: { type: 'number', description: '超时毫秒数，最大 30000，默认 15000' }
    },
    required: ['url']
  },
  timeoutMs: 30000,
  risk: 'low',             // 基线：GET/HEAD 为 low；非幂等方法运行期提升为 high（§6.3）
  approvalMode: 'none',    // 基线；非幂等方法运行期提升为 hard
  enabled: true,
  source: 'builtin',
  idempotent: true,        // GET/HEAD 为 true；非幂等方法运行期按 false 处理
  maxResultChars: 20000
}
```

**SSRF 防护（逐条可验收，见 §10.1）**：
- 协议白名单：**只允许 `https:`**（PRD S1 ①，HTTPS-only）。`http:` 默认拒绝——如需放宽（如本地开发访问 `http://localhost`）必须由 `HTTP_ALLOW_INSECURE=true` 显式开启，且开启时告警。其他协议（`file:` `ftp:` `gopher:` `data:`）一律拒绝。
- 拒绝 URL 内嵌凭据（`https://user:pass@host/`）——凭据不入 URL，不入日志，不回喂模型（PRD S1 ②）。
- DNS 解析后校验：解析目标 host 的所有 A/AAAA 记录，**任一**落在内网/保留段即整体拒绝。
- 禁网段（IPv4）：`0.0.0.0/8`、`10.0.0.0/8`、`100.64.0.0/10`、`127.0.0.0/8`、`169.254.0.0/16`（含云元数据 `169.254.169.254`）、`172.16.0.0/12`、`192.168.0.0/16`、`198.18.0.0/15`、`224.0.0.0/4`、`240.0.0.0/4`。
- 禁网段（IPv6）：`::1/128`、`fc00::/7`、`fe80::/10`、`::ffff:0:0/8`（IPv4 映射，映射后按 IPv4 规则判）、`2002::/16`（6to4，映射后按 IPv4 规则判）、`64:ff9b::/96`（NAT64）、`::/128`。
- **DNS 重绑定防护**：不使用 `fetch` 默认解析。实现方式：先用自定义 resolver（`dns.promises.lookup` + `all:true`）解析并校验 IP，然后**用已校验的 IP 直接建立连接**（`http.request` 的 `host`/`lookup` 覆写），`Host` 头仍为原域名。校验与连接使用同一 IP，杜绝"校验时公网、连接时内网"的 TOCTOU 窗口。
- 重定向：手动跟随，最多 3 跳，**每一跳都重新做完整校验**（不信任 `Location`）。
- 响应体截断：按字节流读取，累计超过 `maxResultChars` 对应的字节数（UTF-8 估算 ×3）即停止并置 `truncated=true`。
- 响应类型：只读文本类（`text/*`、`application/json`、`application/xml`、`text/html`）；二进制（`image/*` 等）只返回元信息不返回内容。
- 返回结构：`{ status, statusText, headers(过滤 set-cookie), contentType, body, truncated, durationMs }`。
- 方法风险提升（运行期判定，§6.3）：`GET`/`HEAD` → `risk=low`, `approvalMode=none`；`POST`/`PUT`/`PATCH`/`DELETE` → `risk=high`, `approvalMode=hard`（PRD §5.1/§6.4：非 GET 的外部写必须硬确认）。判定结果随 `tool_call` 事件下发，**前端不推断**。

#### 6.6.2 文件工具族（`fs.read` / `fs.write` / `fs.list` / `fs.delete`）

**沙箱根目录**：`SANDBOX_ROOT`（默认 `<项目根>/workspace/`，启动时 `mkdir -p`；PRD §5.3 / OD-02 要求默认项目内且可配置）。所有路径参数**必须**是相对于 `SANDBOX_ROOT` 的相对路径。**artifacts 落盘也在此目录内**（§7.5.2），使 `fs.read` 能直接回查长结果。

**路径 jail 实现**（`server/src/tools/builtin/path-jail.ts`，纯函数可单测）：
1. 拒绝绝对路径（`path.isAbsolute` → 拒绝，含 Windows 盘符 `C:\` 与 UNC `\\server\share`）。
2. 拒绝含 `..` 的路径段（先按 `path.sep` 与 `/` 切分检查，再做归一化——两道都做，防 `..\\` 混合分隔符绕过）。
3. 归一化：`path.resolve(SANDBOX_ROOT, rel)`。
4. 真实路径校验：`fs.realpath`（若目标存在）后必须仍以 `SANDBOX_ROOT` 的 realpath 为前缀（`path.relative` 不以 `..` 开头且不为绝对路径）。
5. 目标不存在时（写入场景）：校验其**父目录**的 realpath 在 jail 内。
6. Windows 特有：拒绝保留设备名（`CON` `PRN` `AUX` `NUL` `COM1-9` `LPT1-9`）与以空格/点结尾的路径。

| 工具 | 参数 | 风险 | 约束 |
|------|------|------|------|
| `fs.read` | `path`(必填), `encoding`(默认 utf-8), `maxBytes`(默认 256KB), `lineStart?`, `lineEnd?`, `keyword?`, `glob?` | low / none | 二进制文件拒绝；超限截断；**`glob` 匹配限定在沙箱内**；返回 `{ content, truncated, sizeBytes, encoding, matchedLines? }` |
| `fs.write` | `path`(必填), `operation`(必填：`create`/`overwrite`/`append`/`rename`/`delete`), `content?`, `newPath?`(rename 目标) | **运行期**：create/append/rename → medium/soft；overwrite 已有文件 / delete → high/hard；delete 且目标是工作区根 → **two_step** | `operation=delete` 时 `content` 禁传、`newPath` 必填为 rename 目标；父目录不存在则自动创建；单次写入 ≤1MB；受 jail 约束 |
| `fs.list` | `path`(必填，可为 `.`), `recursive`(默认 false), `maxEntries`(默认 500) | low / none | 返回 `{ entries: [{name, type, size, mtimeMs}] }`，超限截断 |

**全部文件工具必须拒绝符号链接逃逸**：`realpath` 校验天然覆盖（symlink 指向 jail 外 → realpath 前缀检查失败）。

#### 6.6.3 计算与系统工具

| 工具 | 参数 | 说明 | 风险/确认 |
|------|------|------|-----------|
| `calc.evaluate` | `expression`(必填), `base?`(默认 10，2–36 进制换算用) | 纯函数表达式求值。**不使用 `eval`/`Function`**。实现：自建递归下降解析器（支持 `+ - * / % ^`、三角函数、括号、一元负号、数字；`^` 用 `Math.pow` 限制指数 ≤1000、结果必须有限）。**白名单函数**：`sin cos tan asin acos atan log ln sqrt abs floor ceil round min max`；**语法与深度上限**：递归深度 ≤32、表达式长度 ≤512 字符；**除零明确报错**（`errorCode=CALC_DIVIDE_BY_ZERO`，不返回 Infinity/NaN）；禁用变量、赋值与函数调用定义。 | low / none |
| `time.now` | `format?`(默认 ISO), `timezone?`(默认本地), `offsetDays?`, `from?` | 当前时间、时区换算、日期加减。 | low / none |
| `uuid.generate` | `version?`(默认 v4) | 用 `node:crypto` 的 `randomUUID()`（v4）。 | low / none |
| `json.format` | `input`(必填), `mode`(默认 `pretty`，可选 `compact`/`sort-keys`/`validate`), `path?`(JSON Pointer 路径提取) | JSON 美化/压缩/校验/路径提取。**解析失败返回错误而非抛异常**。 | low / none |
| `text.diff` | `left`(必填), `right`(必填), `contextLines?`(默认 3) | 两段文本差异比对。**复用既有 `diff` 包**（`client/package.json` 已含 `diff@^9.0.0`；服务端新增同名依赖、版本一致，不自己实现 diff 算法）。 | low / none |

> **刻意不提供的工具**：`process_exec`（执行系统命令）——命令注入风险极高，且用户已明确「计算与系统工具」指计算/时间/UUID/JSON 这类**确定性系统能力**，不含任意命令执行。如未来需要，必须单独立 ADR 并默认 `enabled=false` + 强制审批 + 命令白名单。
>
> **移入 Backlog（不在 PRD §5.1 锁定清单内）**：`text.regex`（正则匹配）、`text.stats`（文本统计）。正则若后续加入，必须限制输入长度 ≤64KB、pattern 长度 ≤1KB，并禁止嵌套量词以防灾难性回溯。

#### 6.6.4 MCP 动态工具

**MCP Client 生命周期**：

```
        ┌──────────────┐   用户在 MCP 面板点击「连接」
        │  disconnected │◄──────────────────────────────┐
        └──────┬───────┘                               │
               │ 启动（按需）                            │ close()
               ▼                                       │
        ┌──────────────┐   connect() 成功              │
        │  connecting  │──────────────────────────►┌──────────────┐
        └──────┬───────┘                           │   connected   │
               │ 失败                               │  (复用连接)   │
               ▼                                     └──────┬───────┘
        ┌──────────────┐                                   │ 进程退出/超时
        │   failed     │                                   │ (30min 空闲)
        └──────────────┘                                   ▼
                                                  ┌──────────────┐
                                                  │ disconnected │
                                                  └──────────────┘
```

- **按需启动**：不预启动任何 MCP Server。用户配置 Server 后，首次需要其工具时才 `connect()`。
- **连接复用**：`connected` 状态下所有工具调用复用同一 Client/Transport，不重复握手。
- **健康检查**：每次 `callTool` 前不发探测包（省往返）；改为**空闲 30 分钟自动断开** + **调用失败时立即判定不可用** + 用户可手动「重新连接」。
- **断开清理**：`client.close()` 关闭 transport 并终止子进程；进程注册 `exit` 钩子做兜底清理。
- **listTools 并入注册表**：连接成功后调用 `client.listTools()`，取 `{ tools: [{name, description, inputSchema}] }`，逐个适配为 `ToolDefinition`（补 `risk`/`approvalMode`/`timeoutMs`/`maxResultChars`/`displayName`/`category`），以规范名 `mcp.<serverId>.<name>` 注册（线上名由消毒规则生成）。**注册前校验 `inputSchema` 是合法 draft-07 子集**，不合法的工具标记 `nativeOnly=false`（只能经 ReAct 通道使用）。
- **工具名冲突消解**：见 §6.5。
- **MCP 不可用时的降级（硬要求）**：
  - MCP Server 连接失败 → 该 Server 的工具**不注册**，内置工具完全不受影响。
  - 已连接后调用失败 → 本次调用产出失败结果（`errorCode=MCP_CALL_FAILED`, `retryable=true`），作为 observation 回喂 LLM，**Agent 循环不中断**。
  - 连续失败 3 次 → 该 Server 标记 `unhealthy`，工具从 `toProviderTools()` 移除（LLM 看不到），其他工具与内置工具不受影响。
  - **MCP 故障绝不影响内置工具可用性**——这是 S-5 的验收点。

**MCP 工具结果归一化**：MCP `callTool` 返回 `{ content: [{type:'text', text}], isError? }`。适配层：
- `isError=true` → `ToolOutcome{ok:false, errorCode:'MCP_TOOL_ERROR', errorMessage:拼接后的 text}`。
- `content` 中多个 text block 用 `\n` 拼接。
- 非 text block（image/audio/resource）→ 只保留类型标记与大小，不把二进制塞进上下文。

### 6.7 工具执行器（统一施加超时/重试/审批/截断）

`ToolExecutor.execute(ir, ctx)` 流程：

1. **查注册表** → 未找到 → 失败 `TOOL_NOT_FOUND`。
2. **查启用状态** → 已禁用 → 失败 `TOOL_DISABLED`。
3. **Zod 校验参数**（用 `inputSchema` 生成的 Zod schema，或直接用 `zod` 手写 schema 存在注册表旁）→ 失败 → `TOOL_ARGS_INVALID`（**字段级错误信息**，如「参数 url 缺失；参数 method 需为 GET/POST/...」）。
4. **审批判定** → 运行期 `approvalMode` ≠ `none` → 持久化待执行调用 + 签发 token → 挂起等审批（§10.4）。
5. **超时包装**：`Promise.race([handler(...), timeoutPromise])`，超时后 `AbortController.abort()` 传给 handler。
6. **重试**（按 §9.1 矩阵）。
7. **结果截断**：序列化后超过 `maxResultChars` → 截断 + `truncated=true` + 落库完整内容。
8. **落库** → `tool_calls` 表（含完整结果，`result_truncated` 标记）。
9. **产出事件** → `tool_result`（`status` 区分成功/失败/超时/拒绝/跳过）。

---

## 7. 上下文记忆设计

### 7.1 技术选型：SQLite 驱动

**结论：使用 Node 22 内置 `node:sqlite`（`DatabaseSync`），不引入 `better-sqlite3`。**

**实测结论（本机 Windows + Node 22.22.2，2026-10-21）**：

| 维度 | `node:sqlite`（内置） | `better-sqlite3` 13.0.3 |
|------|---------------------|--------------------------|
| 安装 | 零安装，零依赖 | npm install **实测 2 分 30 秒**（含预编译二进制下载） |
| 编译风险 | 无 | 13.0.3 **已内置 win32-x64/darwin/linux 预编译产物且无 install 脚本**（实测 `prebuilds/win32-x64.node` 存在、`scripts` 无 `install`/`postinstall`），故本机不触发 node-gyp；但 `engines.node >= 22`，Node 版本漂移或其他平台仍可能落到源码编译分支 |
| 运行时告警 | **会打印 `ExperimentalWarning: SQLite is an experimental feature`**（Node 22 上 Stability 1.1） | 无 |
| API | `DatabaseSync` / `StatementSync` / `backup` / `constants`；方法 `open/close/prepare/exec/function/location/aggregate/createSession/applyChangeset/enableLoadExtension/loadExtension`；语句方法 `iterate/all/get/run/columns/setAllowBareNamedParameters/setAllowUnknownNamedParameters/setReadBigInts/setReturnArrays` | `prepare/run/get/all/transaction/pragma/backup` |
| 事务 | 无 `transaction()` 辅助函数，需手写 `BEGIN/COMMIT/ROLLBACK`（实测 WAL + 事务正常，`journal_mode=wal` 生效） | 有 `db.transaction(fn)` 辅助（嵌套用 savepoint） |
| Node 24 状态 | Stability 1.2（RC），无告警 | — |

**选 `node:sqlite` 的理由**：
1. **零安装风险是本项目的第一优先级**——部署环境是 Windows + 沙箱 + Dockerfile，`better-sqlite3` 实测安装耗时 2.5 分钟且在 Node 版本不匹配时可能退化为源码编译（需 Python + MSVC），会直接卡住交付。`node:sqlite` 零依赖零编译。
2. Node 22.22.2 已内置且实测功能完备（prepared statement / WAL / 事务 / `columns()` / `backup()` 全部可用）。
3. 迁移成本已被"薄数据访问层"吸收：全部 SQL 收敛在 `server/src/repositories/` 下，若未来必须换驱动，改动面 = 一个 adapter 文件 + 一条 ADR。

**必须处理的已知问题**：
- **ExperimentalWarning 噪音**：Node 22 上每次启动打印一行告警。处置：启动脚本加 `--disable-warning=ExperimentalWarning`（实测 Node 22.22.2 支持该 flag），并在此 ADR 记录为已知接受的权衡。同时在 `docs/agent/phase1-architecture.md` 的风险登记中标注。
- **Stability 1.1（Node 22）**：API 在 Node 22 的次版本间可能变。处置：CI 锁定 Node 22.22.2 精确版本（`engines` + `.nvmrc` + Docker 基础镜像固定 digest），不做跨大版本自动升级。
- **无 `transaction()` 辅助**：在 `repositories/db.ts` 提供 `withTransaction(fn)` 封装（手写 BEGIN/COMMIT/ROLLBACK + 嵌套用 SAVEPOINT），补齐这个缺口。
- **同步 API 阻塞事件循环**：SQLite 查询是同步的。处置：所有查询必须走索引且为单行/小批量读取；长耗时分析查询禁止上同步路径。

**为何不用其他方案**：

| 方案 | 不选原因 |
|------|----------|
| `better-sqlite3` | 安装耗时与潜在编译风险（见上）；能力已被 `node:sqlite` 覆盖；唯一优势 `transaction()` 辅助可用 30 行封装补齐 |
| `node-sqlite3-wasm` | WASM 性能低于原生且包体积大，无收益 |
| 纯 JSON 文件 | 无事务、无索引、无并发写安全，Agent 循环写入频繁（每轮工具调用都落库）必然损坏 |
| PostgreSQL / MySQL | 本地运行、无服务端进程，部署复杂度与需求严重不匹配 |

### 7.2 SQLite Schema

> **重写记录（2026-10-22，Phase 2）**：本节按 **Spec §6「数据库表清单（锁定 — 7 张）」** 全量重写。上一版建 6 张（`sessions` / `messages` / `tool_calls` / `artifacts` / `local_events` / `schema_migrations`）存在三处契约缺口与两处越界建表，已被 Spec §6 判定需修正：
> - **缺 `approvals`** → `POST /api/v1/approvals/:id` 与 AC-06「决定与参数绑定、不可篡改」无处落库，直接违反 AC-04 第三条攻击场景与 AC-06。
> - **缺 `provider_capabilities`** → `GET /api/v1/providers/capabilities` 与 AC-01「不每轮试探」无处落库。
> - **缺 `tool_results`** → `tool_calls.result_ref` 悬空，L1 工具结果外置（`artifact_path` / `inline_preview`）无处落地。
> - **多建 `artifacts`** → Spec §6 判定用 `tool_results.artifact_path` 承载，不单独建表。
> - **多建 `local_events`** → Spec §3 判定埋点沿用前端本地事件日志，服务端不落库。
>
> **口径**：本节 7 张表为实现唯一口径；落盘 SQL 见 `docs/agent/schema.sql`（可直接执行）。

**库文件**：`server/data/agent.db`（`AGENT_DB_PATH` 可覆盖；目录不存在则自动创建）。
**PRAGMA**（连接建立时执行一次）：`journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`、`synchronous=NORMAL`。

**命名对齐说明**（Spec §6 列名 vs 本节列名，逐项交代）：

| Spec §6 列名 | 本节列名 | 处置 |
|---|---|---|
| `messages.tokens` | `tokens` | 采用 Spec 名；**取代**本文 §11.2 旧稿的 `token_estimate`（实现时只建 `tokens`，避免双列漂移） |
| `tool_calls.result_ref` | `result_ref` | 指向 `tool_results.id`（无结果时 NULL） |
| `provider_capabilities`（5 列） | 扩展为 12 列 | Spec 给的是核心列；`GET /api/v1/providers/capabilities` 的响应契约（§11.1）需 `contextWindow` / `toolChoiceValues` / `retainReasoningContent` / `requireToolStreamFlag` / `explicitParallelToolCalls`，加 OD-A3 的 `lightweightModel`，故一并落表。新增列均为可空或带默认值，**不违反 Spec 核心列** |
| `approvals`（7 列） | 扩展为 13 列 | 新增 `session_id`/`tool_name`/`args_digest`/`status`/`created_at`/`mismatch_count`/`last_mismatch_at`——AC-04「409 + 异常审计」需要记录不匹配尝试，Spec 核心列不足以承载 |
| `sessions`（9 列） | 扩展为 16 列 | 新增 `recovery_failed_count` / `recovery_locked_until`——AC-05「连错 5 次锁 15 分钟」需要持久化计数器（不能只存内存，重启即失效） |

```sql
-- ══════════════════════════════════════════════════════════
-- 1/7  sessions —— 会话主记录 + 恢复凭证（只存哈希）
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,            -- uuid v4
  title               TEXT NOT NULL DEFAULT '新会话',
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  channel_mode        TEXT NOT NULL DEFAULT 'auto'
                      CHECK (channel_mode IN ('auto','native','react')),
  degraded            INTEGER NOT NULL DEFAULT 0,  -- 0/1：本会话是否已降级到 ReAct
  message_count       INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  -- 恢复凭证（跨文档裁决 ADR-022：服务端只存哈希，绝不存明文）
  device_token_hash   TEXT,                        -- 同浏览器自动关联（SHA-256）
  recovery_code_hash  TEXT,                        -- 8 位恢复码（SHA-256，单次使用）
  recovery_code_used_at INTEGER,                   -- 使用时间；非 NULL = 已用过，再拒绝
  recovery_failed_count INTEGER NOT NULL DEFAULT 0,-- 连续失败计数（成功即归零）
  recovery_locked_until INTEGER,                   -- 锁定截止 epoch ms（连错 5 次 → now+15min）
  summary             TEXT,                        -- 锚点清单 JSON（原始诉求 + 保真清单，§7.5.3）
  created_at          INTEGER NOT NULL,            -- epoch ms
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_token_hash);

-- ══════════════════════════════════════════════════════════
-- 2/7  messages —— 消息（content 纯文本 + segments_json 分段结构）
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS messages (
  id                 TEXT PRIMARY KEY,             -- uuid v4
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,             -- 会话内递增序号，从 1 开始
  role               TEXT NOT NULL
                     CHECK (role IN ('user','assistant','system','tool')),
  content            TEXT NOT NULL DEFAULT '',     -- 纯文本（便于检索与摘要），C-6
  segments_json      TEXT,                         -- 分段结构 [{type:'text'|'tool',...}]，C-6 落点
  -- Agent 专用字段（普通问答恒为 NULL）
  reasoning_content  TEXT,                         -- 思考模式思维链（DeepSeek/Kimi 需回填）
  tool_calls_json    TEXT,                         -- assistant 消息 tool_calls 原文（JSON 数组）
  tool_call_id       TEXT,                         -- role=tool 消息的关联 ID
  finish_reason      TEXT,                         -- stop|tool_calls|length|max_iterations|...
  usage_json         TEXT,                         -- {promptTokens, completionTokens}
  tokens             INTEGER NOT NULL DEFAULT 0,   -- 本条消息的 token 估算（§7.4）
  is_summary         INTEGER NOT NULL DEFAULT 0,   -- 1 = 压缩产生的摘要消息
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_seq_uq ON messages(session_id, seq);

-- ══════════════════════════════════════════════════════════
-- 3/7  tool_calls —— 工具调用审计（一等公民，只追加）
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tool_calls (
  id              TEXT PRIMARY KEY,                -- uuid v4（服务端生成，= 审批回执的关联键）
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
  call_id         TEXT NOT NULL,                   -- 传给 LLM 的 tool_call_id（原生通道为上游 id）
  tool_name       TEXT NOT NULL,                   -- 规范名（点号，如 http.request）——落库/展示/检索口径
  tool_wire_name  TEXT NOT NULL,                   -- 线上名（下划线）——仅用于回程反查核对
  display_name    TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('http','file','compute','mcp')),
  source          TEXT NOT NULL CHECK (source IN ('builtin','mcp')),
  risk            TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  approval_mode   TEXT NOT NULL CHECK (approval_mode IN ('none','soft','hard','two_step')),
  channel         TEXT NOT NULL CHECK (channel IN ('native','react')),
  iteration       INTEGER NOT NULL DEFAULT 0,      -- 第几轮迭代（从 1 开始）
  args_json       TEXT NOT NULL DEFAULT '{}',      -- 参数原文（脱敏后，截断到 8KB）
  args_digest     TEXT,                            -- 参数规范化 SHA-256（循环检测 + 审批绑定，§9.1.2）
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','success','failed','timeout','rejected','skipped')),
  error_kind      TEXT,                            -- invalid_args|not_found|security|timeout|rate_limit|network|upstream|mcp|circuit_open|internal|revised
                                                   -- 注：revised 仅用于被改参数重提的作废行，不出现在 SSE error 载荷
  error_msg       TEXT,                            -- 脱敏后的可读信息（不含堆栈/绝对路径/Key）
  result_ref      TEXT,                            -- → tool_results.id（无结果或结果内联时为 NULL）
  result_summary  TEXT,                            -- 面向用户的一行摘要
  truncated       INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER,
  ended_at        INTEGER,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_toolcalls_session ON tool_calls(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_toolcalls_message ON tool_calls(message_id);
CREATE INDEX IF NOT EXISTS idx_toolcalls_name_status ON tool_calls(tool_name, status);
CREATE INDEX IF NOT EXISTS idx_toolcalls_digest ON tool_calls(session_id, tool_name, args_digest);

-- ══════════════════════════════════════════════════════════
-- 4/7  tool_results —— 工具结果外置（大结果只留指针，artifacts 表不建）
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tool_results (
  id             TEXT PRIMARY KEY,                 -- uuid v4（= tool_calls.result_ref）
  tool_call_id   TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  inline_preview TEXT,                             -- 进上下文的预览片段（≤4000 字符）
  artifact_path  TEXT,                             -- 完整结果落盘路径（相对 SANDBOX_ROOT，fs.read 可回查）
  bytes          INTEGER NOT NULL DEFAULT 0,       -- 完整结果字节数
  truncated      INTEGER NOT NULL DEFAULT 0,       -- 1 = 预览被截断，完整内容在 artifact_path
  sha256         TEXT,                             -- 完整结果 SHA-256（回查时校验未被篡改）
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_toolresults_call ON tool_results(tool_call_id);

-- ══════════════════════════════════════════════════════════
-- 5/7  approvals —— 审批挑战与决定（AC-04/AC-06：服务端持有 + 审计不可篡改）
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS approvals (
  id                   TEXT PRIMARY KEY,           -- 挑战 ID（= 事件里的 approvalId，前缀 ap_）
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_call_id         TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  tool_name            TEXT NOT NULL,              -- 规范名
  args_digest          TEXT NOT NULL,              -- 参数规范化 SHA-256（与 tool_calls 一致）
  challenge_token_hash TEXT NOT NULL,              -- 服务端签发令牌的 SHA-256（**不存令牌明文**）
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','decided','expired','aborted','revised')),
  decision             TEXT CHECK (decision IN ('allow_once','allow_session','reject','revised')),
                                                   -- 'revised' = 被改参数重提（非用户决定，仅作审计终态）
  reason               TEXT,                       -- 用户拒绝时填写的原因
  mismatch_count       INTEGER NOT NULL DEFAULT 0, -- 令牌/参数摘要不匹配的提交次数（异常审计）
  last_mismatch_at     INTEGER,
  last_mismatch_detail TEXT,                       -- 脱敏后的不匹配原因码（如 TOKEN_MISMATCH / ARGS_MISMATCH）
  -- 「改参数重试」链（AC-10）：revise 后旧记录置 status='revised'（decision 保持 NULL，
  -- 触发器 trg_approvals_decision_once 不受影响），新记录用 revised_from_id 指回上一版
  revised_from_id      TEXT,
  revise_depth         INTEGER NOT NULL DEFAULT 0, -- ≤3 次上限，防无限改参数
  expires_at           INTEGER NOT NULL,           -- 令牌过期时间（签发 +300s）
  decided_at           INTEGER,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_call ON approvals(tool_call_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, expires_at);

-- 审批决定「一次性写入」硬约束：decision 落定后不可改写（AC-06 不可篡改）
CREATE TRIGGER IF NOT EXISTS trg_approvals_decision_once
BEFORE UPDATE OF decision ON approvals
WHEN OLD.decision IS NOT NULL AND NEW.decision IS NOT OLD.decision
BEGIN
  SELECT RAISE(ABORT, 'APPROVAL_DECISION_IMMUTABLE');
END;

-- ══════════════════════════════════════════════════════════
-- 6/7  provider_capabilities —— function calling 能力探测结果（按 (provider, model) 粒度）
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS provider_capabilities (
  provider                  TEXT NOT NULL,
  model                     TEXT NOT NULL,
  supports_function_calling INTEGER,               -- 1=支持 0=不支持 NULL=未知
  probe_status              TEXT NOT NULL DEFAULT 'unknown'
                            CHECK (probe_status IN ('unknown','supported','unsupported','failed')),
  context_window            INTEGER,               -- 保守取值；NULL 则用 provider 默认
  lightweight_model         TEXT,                  -- 压缩摘要用的便宜型号（OD-A3）
  tool_choice_values_json   TEXT,                  -- ['auto','none','required','named']
  retain_reasoning_content  INTEGER NOT NULL DEFAULT 0,
  require_tool_stream_flag  INTEGER NOT NULL DEFAULT 0,
  explicit_parallel_tool_calls INTEGER NOT NULL DEFAULT 0,
  probed_at                 INTEGER,
  notes                     TEXT,                  -- 探测失败原因 / 官文档注（脱敏）
  PRIMARY KEY (provider, model)
);
CREATE INDEX IF NOT EXISTS idx_capabilities_probed ON provider_capabilities(probed_at DESC);

-- ══════════════════════════════════════════════════════════
-- 7/7  schema_migrations —— 迁移版本
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
```

**外键与级联策略**：

| 关系 | 策略 | 理由 |
|------|------|------|
| `sessions` → `messages` | `ON DELETE CASCADE` | 删会话即删消息 |
| `sessions` → `tool_calls` | `ON DELETE CASCADE` | 删会话即删工具调用 |
| `sessions` → `approvals` | `ON DELETE CASCADE` | 审批随会话 |
| `messages` → `tool_calls.message_id` | `ON DELETE SET NULL` | 删消息保留工具调用审计 |
| `tool_calls` → `tool_results` | `ON DELETE CASCADE` | 结果随调用 |
| `tool_calls` → `approvals` | `ON DELETE CASCADE` | 审批随调用 |

**审计不可篡改（AC-06 硬要求）**：
1. `approvals.decision` / `decided_at` / `reason` 只在 `decision IS NULL` 时写入（repository 层用 `UPDATE ... WHERE id=? AND decision IS NULL`，影响行数 ≠ 1 即抛 `APPROVAL_ALREADY_DECIDED`），并由 `trg_approvals_decision_once` 触发器做数据库级兜底。
2. `tool_calls` 与 `approvals` **只追加**：不提供任何 UPDATE/DELETE 端点（用户只能整体清除 DB 文件）。`tool_calls.status` 的状态推进由编排层在流内完成，任务结束后不再改写。
3. 令牌与参数摘要**只存哈希**（`challenge_token_hash` / `args_digest`）——DB 文件泄露也无法伪造一次批准。
4. **改参数重试不改写历史**（AC-10）：用户改参数时，旧挑战置 `status='revised'`（`decision` 保持 `NULL`，故 `trg_approvals_decision_once` 不受影响）、旧 `tool_calls` 行置 `status='skipped'` + `error_kind='revised'`，**新参数另起一行 `tool_calls` 与新挑战**。审计链由 `revised_from_id` 串联，`revise_depth` 限 ≤3 次。理由：审计必须同时保留「模型最初请求的参数」与「用户实际批准的参数」——改参数场景恰恰是最需要两者都在的（模型请求删 A、用户改成删 B）。

**本期刻意不建的表**：

| 不建 | 原因 | 替代方案 |
|------|------|----------|
| `artifacts` | Spec §6 判定：大结果用 `tool_results.artifact_path` 承载即可，单独一张表只是多一次 JOIN 且字段几乎全冗余（`path`/`bytes`/`sha256` 已在 `tool_results`）。artifact 文件落在 `SANDBOX_ROOT/.artifacts/` 下，`fs.read` 可直接按路径回查，**零新增能力面**（§6.6 差异说明第 2 条） | `tool_results.artifact_path` + `bytes` + `sha256` |
| `local_events` | Spec §3 明确：埋点沿用前端本地事件日志，服务端不落库；对应 `POST/GET /api/v1/events` 两个端点本期不实现 | 前端本地事件日志 |
| `tools` | 工具定义在代码中；运行时启禁用是进程内状态（MVP 无多用户，持久化无收益） | `services/tools/registry.service.ts` 内存 Map |
| `mcp_servers` | 仅 4-5 个字段，用 `config/mcp-servers.json` 承载；为它建表是过度设计 | JSON 配置文件 |
| `approval_audit`（第 8 张） | 7 张是 Spec 锁定的硬上限；异常审计需求由 `approvals.mismatch_count` / `last_mismatch_at` / `last_mismatch_detail` 三列承载，不新增表 | 见上 |

### 7.3 迁移策略

- 迁移脚本放 `server/src/repositories/migrations/`，每个文件导出一个 `up(db)` 函数，按版本号顺序执行。
- 启动时：`db.exec('BEGIN')` → 读 `schema_migrations` 已有版本 → 依次执行缺失的迁移 → 写版本记录 → `COMMIT`。任一步失败整体回滚并拒绝启动（**不静默降级**）。
- 迁移必须幂等（用 `IF NOT EXISTS`）。
- 版本号只增不改。已发布的迁移永不修改。

### 7.4 Token 估算策略

上游多数 provider 不返回精确的 prompt token 数（流式下 `usage` 通常在末尾才到），因此必须自估。

**估算函数**（`server/src/services/agent/token-estimator.ts`，纯函数）：
- 英文/代码：约 **4 字符 = 1 token**（代码因符号密集略高，取 **3.5 字符/token**）。
- 中文：约 **1.5 字符 = 1 token**（取 **0.7 token/汉字**）。
- 混合文本：按字符集分段累加后取整。
- 工具定义（tools JSON）也计入 prompt token：按同样规则估算序列化后的 JSON 长度。
- 预留缓冲：估算值 × 1.1（防止低估导致上游 400）。

**各模型上下文窗口**（写入 provider 能力表）：保守取值——DeepSeek 64K、GLM 128K、Kimi 128K、Qwen 128K、OpenAI 128K。**具体值随 provider 变化，能力表可覆盖**。

### 7.5 上下文窗口管理（三层压缩 + 机械保真自检）

> **与 PRD §7.2 的收敛**：采用 PRD 的三层结构（L1 工具结果瘦身 / L2 消息摘要 / L3 近期原文保留）+ **保真清单机械自检**（护栏 G5 要求 100% 通过率，缺项即回退并提示用户，不静默截断）。这是本项目对「压实必须保真」最硬的一条落地——**保真是可机械验证的工程断言，不是提示词工程**。

**预算计算**：
```
modelWindow      = capabilities.contextWindow           // 如 128000
compressTrigger  = floor(modelWindow * 0.75)             // PRD §7.2：占用 >75% 触发 L2
allowedRatio     = AGENT_CONTEXT_RATIO (0.7)
historyBudget    = floor(modelWindow * allowedRatio)
reservedOutput   = floor(modelWindow * 0.2)              // 预留输出
toolsTokens      = estimate(toolsJson)
summaryReserve   = 4000                                  // 给压缩摘要留位置
usableHistory    = historyBudget - toolsTokens - summaryReserve - reservedOutput
```

**装配顺序（从旧到新）**：
1. **锚点前缀**（§7.5.5，**永不参与压缩淘汰**）
2. system prompt（Agent 角色 + 工具使用规则）
3. 历史消息（按 §7.5.1 规则裁剪）
4. 当前轮的用户消息
5. （若有）上一轮的 assistant tool_calls 消息 + 对应的 tool 结果消息

#### 7.5.1 三层压缩结构

| 层 | 机制 | 触发 | 成本 |
|----|------|------|------|
| **L1 工具结果瘦身** | 单条工具结果 > **8K token** 时：正文落盘 `artifacts`（工作区内），上下文内只留「摘要 + 路径 + 前 500 字符 + sha256」 | 每次写入结果时 | 0 |
| **L2 消息摘要压缩** | 估算占用 > 模型窗口 **75%** 时，对历史做**九段结构化摘要** | 每次 LLM 调用前估算 | 1 次小模型调用 |
| **L3 近期原文保留** | 摘要之外**始终保留最近 6 轮原文**，不是「摘要完就没了」 | 随 L2 | 0 |

**7.5.1.1 L1 工具结果瘦身细则**：

| 结果大小 | 处置 |
|---------|------|
| ≤ 8K token | 全文进上下文 |
| > 8K token | 正文落盘 `artifacts`（`artifacts.path` 位于 `SANDBOX_ROOT` 内）；上下文只留：`{"summary": "<前 500 字符>", "path": "<workspace 内相对路径>", "sha256": "<hex>", "bytes": N, "truncated": true}` |

**回查机制（零新增工具）**：落盘路径在沙箱工作区内，**`fs.read` 直接按该路径回查**——不新增 `tool.result.read` 工具，也不需要额外的权限面。上下文里的 `path` 字段即回查指针（这正是知识库「保留指针而非全文」的直接落地）。

**7.5.1.2 L2 摘要的九段结构**（PRD §7.2 锁定，不做自由发挥）：

1. 原始请求与意图
2. 关键技术概念
3. 涉及的文件与代码段（保留路径与关键片段）
4. 遇到的错误与对应修复
5. 问题解决过程与**已做出的决策及其理由**
6. 用户原话（**逐字保留，不改写**）
7. 待办事项
8. 当前工作（精确到「刚做完什么、正在做什么」）
9. 可选的下一步（附对话原文引用）

**7.5.1.3 压缩后机械自检（护栏 G5，100% 通过率）**：

压缩完成后，**机械可验**地检查保真清单是否齐全：

| # | 保真项 | 机械校验方式 |
|---|--------|--------------|
| F-1 | **原始用户诉求** | 摘要段 1 非空 **且** 摘要段 6 含第一轮 user message 的逐字子串（长度 ≥ 原文 80%） |
| F-2 | **已做决策及其理由** | 摘要段 5 非空 **且** 包含 ≥1 条「决策—理由」配对（形如「因为…所以…」或显式列表项） |
| F-3 | **已修改文件清单** | 摘要段 3 提取出的文件路径集合 ⊇ 被压缩历史中 `fs.write` 涉及的文件路径集合 |
| F-4 | **验证命令与结果** | 摘要段 4 或段 8 中出现 ≥1 条命令/结果对（形如 `命令 → 结果`）**或**显式标注「本任务无验证命令」 |
| F-5 | **待办事项** | 摘要段 7 非空 **或** 显式标注「无待办」 |

**自检失败的处理（不静默截断）**：
1. 先尝试**机械补齐**——从被压缩的原始消息里直接抽取缺失项（原始诉求取第一轮 user message 原文；文件清单取 `tool_calls` 的 `fs.write` 参数；待办取最后一条 user message），补进摘要。
2. 补齐后**再自检一次**。仍缺项 → **判定压缩失败**：回退（不应用本次压缩，历史保持原样），并向用户发 `context_notice{reason:'compaction_failed'}` + 明确提示「上下文已满，请新建会话或缩短任务」。**绝不静默截断**（PRD AC-06）。

**7.5.1.4 压缩失败的降级链**：

| 层级 | 机制 | 是否保证保真 |
|------|------|-------------|
| 1 | LLM 九段摘要 + 机械自检 + 机械补齐 | 是（自检 100% 通过才应用） |
| 2 | 自检仍缺项 → **回退并提示用户** | 是（不压缩 = 不丢） |
| 3 | 摘要 LLM 调用本身失败（网络/上游错误） | 退化为**确定性摘要**：规则拼接工具调用列表（名称+状态+耗时）、最近 N 条 user 消息前 200 字符、错误列表；**确定性摘要同样过一遍 F-1~F-5 自检**（它天然满足 F-1/F-3/F-5，F-2/F-4 若缺则按层 2 回退） |

**7.5.1.5 摘要用小模型（成本可控）—— 回答 PM 提问 3**：

**provider 层按调用场景路由模型的能力**：需要，且**实现成本很低**——不引入通用路由框架，只在既有 provider 能力表上**加一列** `lightweightModel`：

| 场景 | 用哪个模型 | 配置位置 |
|------|-----------|---------|
| 主对话 / 工具调用 | 用户选定的主模型 | `provider_capabilities` / 用户设置 |
| **上下文压缩摘要** | **同供应商的轻量型号** | 能力表 `lightweightModel` 列，**可被用户覆盖** |
| 能力探测 | 同轻量型号（探测请求本身极简） | 同上 |

各 provider 的轻量型号映射（写入能力表，Phase 2 接入时按各 provider 官方模型清单核实后落定）：

| provider | 主模型示例 | 轻量型号（摘要用） |
|----------|-----------|-------------------|
| deepseek | deepseek-v4-pro | deepseek-chat（轻量档） |
| zhipu | glm-4.6 | glm-4.5-air |
| moonshot | kimi-k2 | moonshot-v1-8k |
| qwen | qwen-plus | qwen-turbo |
| openai | gpt-4o | gpt-4o-mini |

- 用户可在设置页**手动覆盖**摘要模型（留空则用能力表默认值；留空且能力表也无 → 回退主模型 + 更小 `max_tokens`）。**这就是 OD-03 的关闭条件**（PRD §18：需各 provider 的模型清单快照 → Phase 2 接入能力表时落定）。
- **不引入模型路由框架**（不引入 LiteLLM / OpenRouter 类依赖）：场景只有两种（主对话 vs 摘要），一张两列的映射表足够，引入框架是过度设计。
- 摘要调用**不使用主模型**。按 PRD §8.3 与 OD-03 的倾向：**同供应商的轻量型号**。
- provider 能力表新增 `lightweightModel` 字段（如 DeepSeek 的 `deepseek-chat` 轻量版、GLM 的 `glm-4.5-air`、Qwen 的 `qwen-turbo`）；未配置时回退到主模型 + 更小的 `max_tokens`。
- 摘要调用固定：**非流式**、单次、**`max_tokens` ≤ 2048**、**不带 tools**。理由：压缩是内部机制，不应触发工具调用，也不该进入 SSE 事件流。
- 摘要**不进入 SSE 事件流**，但压缩结果通过 `context_notice` 告知用户（§7.5.4）。

**7.5.1.6 L3 与滑动窗口的先后关系**：

L2 压缩时，**最近 6 轮原文永不参与被压缩范围**。若历史短于 6 轮则不触发 L2。L2 之后仍超预算时，才进入 §7.5.2 的滑动窗口丢弃。

#### 7.5.2 滑动窗口截断规则（兜底，L2 之后才执行）

| 步骤 | 触发条件 | 动作 |
|------|----------|------|
| S-1 单条消息超限 | 单条消息估算 > `usableHistory / 2` | 保留该条的头 2000 字符 + 尾部 1000 字符，中间替换为 `…[已截断 N 字符]`，标记 `truncated` |
| S-2 丢弃最旧历史 | L2 后仍超 `usableHistory` | 从最旧消息开始丢弃**整轮**（一条 assistant + 其关联的 tool 消息 + 对应 user 消息为「一轮」），**不切半轮**——半轮会产生孤儿 tool 消息，上游因 `tool_calls` 与 `role:"tool"` 数量不匹配而 400 |
| S-3 硬上限 | 即使丢弃后仍超 | 继续丢弃直到 ≤ `usableHistory`；仍超则报 `CONTEXT_OVERFLOW`（这是唯一会因上下文而失败的场景） |

> **重要**：滑动窗口丢弃是**最后手段**，且仅在 L2 压缩（含机械自检）已尽力后执行。PRD 护栏 G5 要求的「不静默截断」通过 §7.5.1.3 的自检+回退保证——正常路径不会走到 S-2。

#### 7.5.3 锚点清单（固定前缀，永不淘汰）

**每次 LLM 请求中作为固定前缀重新注入**（PRD §7.2 锚点保活；知识库「恰当高度指令」原则——给目标+约束+验收+工具，把「怎么做」留给执行）：

| 锚点 | 内容 | 来源 |
|------|------|------|
| A-1 系统提示 | Agent 角色 + 工具使用规则 | 常量 |
| A-2 当前任务目标 | 用户的原始诉求（第一轮 user message 原文） | `sessions.summary` 冻结副本 |
| A-3 保真清单 | 已做决策与理由、已修改文件清单、验证命令与结果、未决问题与已知坑、当前计划与下一步 | 由压缩过程维护（§7.5.1.3 的 F-1~F-5） |

**锚点不参与压缩淘汰**——即使历史被全部摘要，锚点仍在每次请求的开头。这是「Agent 忘了『不要改数据库层』这类硬约束」这一类问题的根治手段。

**锚点的存储**：`sessions.summary` 存 A-2 + A-3 的当前版本（JSON），每次压缩成功后更新；`messages.is_summary=1` 的消息存九段摘要正文（供用户展开查看）。

#### 7.5.4 上下文压缩的通知

触发压缩、截断或压缩失败时，向前端发 `context_notice` 事件：

| reason | 触发 | payload |
|--------|------|---------|
| `compacted` | L2 压缩成功 | `removedMessages, estimatedTokensBefore, estimatedTokensAfter, summaryPreview?` |
| `compaction_failed` | 自检缺项且回退 | `removedMessages: 0, reason: '上下文已满，请新建会话或缩短任务'` |
| `tool_result_compressed` | L1 瘦身 | `callId, path, bytes, sha256` |
| `truncated` | 滑动窗口丢弃 | `removedMessages` |

前端在对话区**内联 notice**（插在被压缩的那一轮之前，借鉴 Claude Code 的 `CompactBoundaryMessage`），不是 Toast——压缩是不可逆事实，Toast 会消失（与设计侧一致）。


### 7.6 会话恢复流程

1. 前端启动 → `GET /api/v1/sessions` → 拉取会话列表（含 `title` / `updatedAt` / `messageCount`）。
2. 用户点开会话 → `GET /api/v1/sessions/:id` → 返回 `{ session, messages: [...], toolCalls: [...] }`。
3. 前端用 `sessionStore` 装载为内存态（**不再写 localStorage**）。
4. 继续提问 → `POST /api/v1/agent/stream`，body 带 `sessionId`。
5. 服务端按 `sessionId` 从 SQLite 装配上下文（§7.5），**服务端是唯一事实源**，前端不重传历史（避免前后端上下文不一致）。
6. 服务端重启后，会话与历史仍在（SQLite 文件持久化），恢复流程与首次完全一致。

**跨浏览器恢复（PRD §7.1 / AC-05）——两条路径**：

| 路径 | 机制 | 服务端存储 |
|------|------|-----------|
| ① 同浏览器自动关联 | 创建会话时生成随机**设备令牌**存 localStorage；请求时经 `X-Device-Token` 头带上 | `sessions.device_token_hash`（**只存 SHA-256**，不存明文） |
| ② 跨浏览器 / 跨设备 | 创建会话时生成 **8 位恢复码**（大写字母数字，去除易混字符 `0/O/1/I`）；用户复制到另一浏览器输入 | `sessions.recovery_code_hash`（**只存哈希**）+ `recovery_code_used_at` |

**恢复码规则（锁定）**：
- **单次使用**：使用成功后写 `recovery_code_used_at`，**再次使用即拒绝**并提示「恢复码无效或已失效」（PRD AC-05）。这是刻意的安全取舍——恢复码是「一次性交接凭证」而非长期密码。
- **可手动重新生成**：用户可在设置页重新生成，旧码的哈希立即被覆盖 → **旧码立即失效**。
- **暴力尝试防护（OD-04）**：单会话连续失败 **5 次 → 锁定 15 分钟**。8 位码空间为 31^8 ≈ 8.5×10^11（剔除易混字符后），叠加 5 次/15 分钟的锁定，单会话年化尝试上限 < 1.8×10^5 次——不足以穷举。**前提是恢复码校验走哈希 + 恒定时间比较**（`crypto.timingSafeEqual`）。
- 恢复成功后，该浏览器获得一个新的设备令牌关联（不消耗恢复码）。
- 恢复只还原**会话内容与工具调用记录**，不还原「正在执行中的任务」——中断的任务标记为 `aborted`。

**兼容迁移**：现有 localStorage `codeagent.sessions.v1` 中的历史会话，**不自动迁移**到服务端（内容是纯代码问答，无工具调用，迁移价值低、复杂度高）。前端在首次启动时检测到旧 localStorage 会话 → 展示一次「发现旧版本地会话」提示，提供「导入为新会话」按钮（把消息转成 `role=user/assistant` 的普通消息写入服务端）。**不导入则旧数据保留在 localStorage 不动**（不破坏用户数据）。

---

## 8. SSE 事件协议（前后端契约）

### 8.1 事件类型全表

> **跨文档裁决 C-2（回应 UIUX 附 D 的 A4）**：SSE 事件名采用**下划线（snake_case）**，与 §8.1 事件类型全表及 UIUX v1.2.0 保持一致，不使用中划线。UIUX 提出的 `tool_rejected` / `tool_skipped` 两个事件**不单独设事件类型**——它们的语义已由 `tool_result` 的 `status` 字段覆盖（`status: 'rejected'` / `status: 'skipped'`），这样前端只需处理 4 个工具事件（`tool_call` / `tool_progress` / `tool_result` / `tool_approval_required`），不必为每个状态写一个分支。

| 事件名 | payload 字段 | 触发时机 | 前端用途 |
|--------|--------------|----------|----------|
| `meta` | `sessionId, messageId, provider, model, channel, degraded, degradedReason?, iteration, maxIterations, contextWindow, estimatedPromptTokens, toolCount, switchedFrom?, switchReason?` | 循环开始时发一次 | 状态栏显示模型/通道；工具时间线初始化 |
| `delta` | `text` | LLM 产生可见文本增量 | 追加到 assistant 消息（复用现有 50ms 节流） |
| `reasoning` | `text` | 思考模式下 LLM 产生思维链增量（DeepSeek/Kimi） | 折叠区展示（默认收起） |
| `tool_call` | `callId, name, displayName, category, arguments, risk, approvalMode, source, iteration, status:'pending'` | 解析出工具调用、**执行前**发 | 工具时间线插入「待确认/执行中」卡片 |
| `tool_progress` | `callId, stage, message?, at` | 工具执行过程中的阶段汇报 | 卡片内进度提示（可选事件） |
| `tool_result` | `callId, name, status, summary?, data?, truncated?, durationMs, resultId?, error?` | 工具执行结束（成功/失败/超时/已拒绝/已跳过**共用此事件**，靠 `status` 区分） | 卡片转终态 |
| `tool_approval_required` | `callId, name, displayName, arguments, risk, approvalMode, reason, approvalToken, expiresAt` | 高危工具等待确认 | 渲染 inline 确认条（**不弹窗**） |
| `context_notice` | `reason, removedMessages?, estimatedTokensBefore?, estimatedTokensAfter?, summaryPreview?` | 触发裁剪/压缩 | 顶部提示条 |
| `done` | `finishReason, iteration, toolCallCount, usage?, messageId` | 循环终止（正常/超限/中止/熔断均属此） | 结束流式状态，写入 store |
| `error` | `code, message, retryable?` | 致命错误（不可恢复） | 错误卡片 |

**`tool_result.status` 枚举（对齐 PRD §6.1 六态 + UIUX §3.2.1 衍生态，锁定 7 值）**：

| status | 含义 | UI 呈现（UIUX §3.2） |
|--------|------|---------------------|
| `pending` | 已生成、等待调度或等待审批 | `Circle` 虚线 / `Clock`，参数区默认展开 |
| `running` | 正在执行 | `Loader2` 旋转，accent 色 |
| `success` | 正常返回 | `CircleCheck`，success 色，参数区默认折叠 |
| `failed` | 工具报错 | `CircleX`，danger 色，参数区默认展开 |
| `timeout` | 工具自身超时 | `Clock` + `TriangleAlert`，**warning 色（与 failed 区分）** |
| `rejected` | 用户拒绝 | `Ban`，**中性色（不染红）**——不是错误 |
| `skipped` | 因「从某步重跑」被跳过 | `CircleSlash`，最弱色 + 整卡 `opacity-60`，**不计入失败数** |

**事件名沿革（跨文档裁决 C-3）**：现有 CodeLens 用 `delta` 表示文本增量——**保持不变**。本文早期草案曾提议改名 `token`，经与 UIUX 对齐后**撤销该提议**：`delta` 已在现有前端实现中被消费（`stream.ts` 的 `case 'delta'`），保持不变可减少改造面与回归风险。UIUX §4.1 假设的 `text-delta` 一并对齐为 `delta`。

**跨文档裁决 C-4（回应 UIUX 附 D 的 A1，审批回执通道）**：审批回执走**独立 HTTP 端点** `POST /api/v1/approvals/:id`，**不在 SSE 同流回传决定**。理由：审批可能跨越数分钟（用户思考时长），SSE 长连接不适合承载用户决策；且 SSE 流在审批等待期间需要靠心跳维持（已有 15s ping），独立端点更健壮。服务端在审批前已把待执行调用**保存到服务端**（`approvals` 表 + 内存挂起句柄）并签发 `approvalToken`，客户端只回传「`approvalId` + `token` + 决定」——**服务端绝不接受客户端提交的工具调用内容**（PRD §6.4 服务端持有原则，防「批准的与实际执行的不一致」漏洞）。决定后服务端在原 SSE 流上继续推送 `tool_result`（`status: 'rejected'` 或继续执行）。

**跨文档裁决 C-5（回应 UIUX 附 D 的 A3，风险与确认档位）**：服务端在 `tool_call` 事件中下发 `risk` 与 `approvalMode`，**前端不自行推断**——前端不能成为安全判定的第二来源。

**跨文档裁决 C-6（回应 UIUX 附 D 的 A2，Message.content 粒度）**：前端 `Message.content` 由 `string` 扩展为 `Segment[]`（`{type:'text',text}` | `{type:'tool',call}`），这是工具卡与文本段在**同一条 assistant 消息内交替渲染**的前提（UIUX §4.1）。服务端侧对应落库变更：`messages.content` 保持为**纯文本**（便于检索与摘要），新增 `messages.segments_json` 存分段结构（含工具卡占位与 `callId`），前端据此还原渲染。**一条 assistant turn = 一条消息 = 内部文本段与工具卡交替**。

### 8.1.1 与 PRD §14 事件清单的对照（回答 PM 提问 2）

PRD §15 的 OpenAPI 增量清单写的是 `tool_call_start / tool_call_delta / tool_call_end / approval_required / compaction`。**本架构不采用这组命名**，但语义**一一覆盖**。对照如下（前端按本表实现，OpenAPI 按本表更新）：

| PRD §14 表述 | 本架构事件 | 说明 |
|--------------|-----------|------|
| `tool_call_start` | **`tool_call`** | 工具调用开始（含工具名、参数、risk、approvalMode）。参数是**一次性完整下发**，不需要 delta 事件——上游流式返回的 arguments 片段已在服务端累积成完整 JSON 后才下发（否则前端要处理半截 JSON） |
| `tool_call_delta` | **（无对应事件）** | 上游 SSE 的 arguments 分片由服务端 `tool-call-normalizer.ts` 累积，**不下发给前端**。前端只在 `tool_call` 事件里拿到完整参数 |
| `tool_call_end` | **`tool_result`** | 调用结束，`status` 区分 7 态（成功/失败/超时/已拒绝/已跳过等） |
| `approval_required` | **`tool_approval_required`** | 同名同义 |
| `compaction` | **`context_notice`**（`reason: 'compacted'`） | 压缩事件；另加 `compaction_failed` / `tool_result_compressed` / `truncated` 三个 reason |

**为什么不采用 `tool_call_start/delta/end` 三段式**：三段式适合「参数本身很长、需要逐字渲染」的场景（如流式代码编辑器）。本产品的工具参数是结构化对象（URL、路径、JSON），**整体到达才可校验、才有意义**；拆成 start/delta/end 只会让前端多写一个半截参数的渲染分支，却不带来任何信息增益。PRD §6.1 的卡片参数区设计（格式化 JSON + 语法高亮）本身也要求参数完整。

> 若后续确有「超长参数需要流式渲染」的需求，扩展方式是给 `tool_call` 事件加 `partialArgs` 字段做增量追加，**不新增事件类型**——避免前端为两种形态写两套分支。

### 8.2 JSON 示例（逐个）

**meta**
```json
{
  "sessionId": "b7c1e2f0-4a55-4f0e-9c3d-8e1a-2b3c4d5e6f70",
  "messageId": "m_01",
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "channel": "native",
  "degraded": false,
  "iteration": 1,
  "maxIterations": 12,
  "contextWindow": 65536,
  "estimatedPromptTokens": 1842,
  "toolCount": 9
}
```

**delta**（文本增量）
```json
{ "text": "我先读取配置文件。" }
```

**reasoning**
```json
{ "text": "用户想要统计行数，fs.read 工具最合适。" }
```

**tool_call**
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

**tool_progress**（可选事件）
```json
{ "callId": "call_abc123", "stage": "reading", "message": "读取 sandbox/notes.txt", "at": 1761234567890 }
```

**tool_result（成功）**
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

**tool_result（失败 / 超时 / 已拒绝 / 已跳过 —— 同一事件，靠 status 区分）**
```json
{
  "callId": "call_abc123",
  "name": "http.request",
  "status": "timeout",
  "durationMs": 15003,
  "resultId": "r_7f3a91c2",
  "error": {
    "code": "TOOL_TIMEOUT",
    "kind": "timeout",
    "message": "目标服务在 15s 内未返回响应",
    "suggestion": "该目标近期不稳定，可重试或改用备选接口",
    "retryable": true
  }
}
```

**`error.kind` 完整枚举（锁定 10 值）**

> 前端按 `kind` 查表渲染「分类标签 + 语义色 + 恢复动作」，**不用 `error.code`**（`code` 是面向排障的展示串，会演进；`kind` 是稳定分类）。枚举必须与 UIUX §2.6 逐条对齐，否则 QA 会判「错误提示与架构分类不一致」。

| kind | 中文标签 | 语义色 | retryable | 恢复动作 | 触发来源 |
|------|----------|--------|-----------|----------|----------|
| `invalid_args` | 参数不合法 | danger | 否（**不消耗重试预算**） | 改参数重试 | zod 校验失败（字段级错误） |
| `not_found` | 工具或目标不存在 | warning | 否（**不消耗预算**） | 换工具 / 换路径 | 注册表无此名（幻觉）/ 文件 404 / 接口 404 |
| `security` | 被安全策略拒绝 | danger | 否（**同一目标本任务内封禁**） | 无（**不给绕行建议**） | SSRF 拦截 / 路径越界 / 计算边界 |
| `timeout` | 执行超时 | warning | 是（由模型决定） | 重试 / 换参数 | 工具超 `timeoutMs` |
| `rate_limit` | 上游限流 | warning | 是（退避 + jitter，读 `Retry-After`） | 稍后重试 | 上游 429 |
| `network` | 网络不可达 | warning | 是（**仅幂等方法自动重试**） | 重试 | 连接失败 / DNS 失败 |
| `upstream` | 上游服务错误 | danger | 是（5xx）/ 否（401·403） | 重试 / 检查 Key | 上游 5xx / 鉴权 / 400 |
| `mcp` | MCP 服务异常 | warning | 是（800ms 后 1 次） | 重试 / 重连 Server | `MCP_CALL_FAILED` / 连接失败 |
| `circuit_open` | 工具已熔断 | **neutral** | 否（**不触发 LLM 调用**） | 换工具 | 同一工具连续失败 3 次 |
| `internal` | 内部错误 | danger | 否 | 无 | 兜底 |

**对设计侧 9 值提案的 4 处增删（逐条说明理由）**：

| 变动 | 理由 |
|------|------|
| **− `payload_too_large`** | 结果超限**不是错误**，走 `tool_result.truncated=true` 标志位；请求体过大是 HTTP `413 PAYLOAD_TOO_LARGE`，压根不产生 `tool_result` 事件。放进枚举会让前端多一个永远不会命中的分支 |
| **− `forbidden` → `security`** | AC-07 原文就是「被安全策略拒绝」，直接用原文的语义命名，不另造近义词 |
| **+ `upstream`** | 「上游 5xx / 401」与「网络不可达」的重试语义相反（前者要退避重试、后者要检查网络），且 401 明确不可重试。若没有这一值，5xx 只能落到 `internal`，会让用户以为是本产品坏了——排障方向直接跑偏 |
| **+ `circuit_open`** | AC-08 明确要求「连续失败 3 次后第 4 次直接返回熔断提示而不触发 LLM 调用」，必须有独立分类。且语义色是 **neutral 不是 danger**：熔断不是错误，染红会让用户误判工具损坏 |

**未知 kind 兜底（契约，前端必须实现）**：查表未命中 → 标签「执行失败」+ danger 色 + 动作 `[重试]`，**不得崩**。这样架构后续新增 kind 时，已发布的前端仍能正常渲染。

**`revised` 不在本枚举中**：它只出现在 DB 的 `tool_calls.error_kind`（被改参数重提的作废行），**永不出现在 SSE 载荷**。

**tool_approval_required**
```json
{
  "callId": "call_def456",
  "name": "fs.delete",
  "displayName": "删除文件",
  "arguments": { "path": "old/report.csv", "recursive": false },
  "risk": "high",
  "approvalMode": "hard",
  "reason": "删除文件不可逆，需要确认",
  "approvalId": "ap_9f2c",
  "approvalToken": "t_7d1e...",
  "expiresAt": 1761234867890
}
```

> `approvalId` + `approvalToken` + `expiresAt`（5 分钟过期，PRD §6.4）：客户端凭此调用 `POST /api/v1/approvals/:id`，**只回传决定**（允许一次 / 本会话始终允许 / 拒绝+原因），绝不回传工具调用内容。

**context_notice**
```json
{
  "reason": "compacted",
  "removedMessages": 24,
  "estimatedTokensBefore": 58210,
  "estimatedTokensAfter": 12480,
  "summaryPreview": "已读取 sandbox/config.json 与 sandbox/notes.txt，确认端口为 8080，待完成启动命令的构造。"
}
```

**done**
```json
{
  "finishReason": "stop",
  "iteration": 3,
  "toolCallCount": 2,
  "usage": { "promptTokens": 12480, "completionTokens": 412 },
  "messageId": "m_01"
}
```

**error**
```json
{ "code": "UPSTREAM_ERROR", "message": "上游服务暂时不可用，请稍后重试", "retryable": true }
```

### 8.3 协议约束（前后端共同遵守）

1. 每帧格式固定：`event: <name>\ndata: <json>\n\n`（沿用现有 `sendSSEEvent`）。
2. **事件顺序保证**：`meta` 必须是第一帧；同一 `callId` 的 `tool_call` → (`tool_progress`*) → `tool_result` 严格有序；`done` / `error` 必须是最后一帧。
3. `done` 与 `error` 互斥，一个流最多发一个。
4. 心跳：沿用现有 15s `: ping` 注释帧。
5. 客户端断开：`req.on('close')` → `AbortController.abort()` → 编排层走 T-4 终止。
6. 所有 `data` 必须是合法 JSON 单行（不含裸换行）。
7. 事件名的 TS 联合类型在 `client/src/types/index.ts` 与 `server/src/types/index.ts` **双向对齐**，改一处必须改另一处（用共享类型文件或代码生成，避免漂移）。

---

## 9. 错误重试与降级策略矩阵

### 9.1 错误分类表（先分类，再决定是否重试）

> **采用 PRD §8.1 的错误分类表驱动**，不用全局重试计数。理由：ReAct 式 Agent 的重试预算约 90% 花在「永远不可能成功」的错误上（最典型是模型幻觉出不存在的工具名，指数退避救不了它）。**工具名与参数先在代码侧做确定性校验，不交给模型重试。**

| 错误类型 | 判定 | 处理 | 是否重试 | 消耗重试预算 |
|---------|------|------|---------|-------------|
| 参数非法 / 不符合 schema | zod 校验失败 | 立刻把**字段级错误**回喂模型（「参数 url 缺失；参数 method 需为 GET/POST/...」） | 否 | **否** |
| 工具不存在（幻觉） | 名称不在注册表 | 立刻回喂「该工具不存在，你当前可用的工具是：…」，模型必须改选 | 否 | **否** |
| 权限 / 路径越界 / SSRF 拦截 | 安全网关拒绝 | 明确告知「该操作被安全策略拒绝，原因是 X」，**不给绕行建议**；**同一被拒目标在本次任务内封禁**（不再重试该目标） | 否 | **否** |
| 目标不存在（文件 404 / 接口 404） | 资源层返回 | 回喂模型，让它换路径 | 否 | 否 |
| 限流 429 | 上游返回 | 指数退避 **+ 抖动（jitter）**，最多 2 次 | 是 | 是 |
| 上游 5xx / 临时不可用 | 上游返回 | 指数退避 + 抖动，最多 2 次 | 是 | 是 |
| 网络超时 | 连接层 | 同上；**HTTP 工具仅幂等方法（GET/HEAD）自动重试**，非幂等不自动重试（需重新确认） | 是（幂等才自动） | 是 |
| 工具执行超时 | 工具自身超时 | 回喂模型「工具超时」，允许它换参数或换工具 | 由模型决定 | 否 |
| 熔断打开 | 该工具已熔断 | 直接返回「该工具暂时不可用（连续失败 N 次）」，**不触发 LLM 调用** | 否 | 否 |
| `MCP_CALL_FAILED` | MCP 侧失败 | 800ms 后重试 1 次；该 Server 连续失败 3 次后熔断 | 是 | 是 |

**任务级重试总预算：5 次**（PRD §8.2）。单任务内所有工具重试**合计**上限 5 次，超出后不再自动重试，只允许用户手动触发。计数器随任务生命周期，非全局。

**重试上限是硬约束**：单次工具调用的总耗时（含重试）不得超过 `ToolExecutor` 施加的 `timeoutMs` 的 **2 倍**，超出即放弃。

**9.1.1 每工具熔断器**（PRD §8.2）：同一工具在**本次任务内**连续失败 3 次 → 打开熔断 → 后续调用**直接快速失败**，**不触发 LLM 调用**（省一次往返，也让模型不必为已知不可用的工具浪费轮次）。熔断状态在会话内可见（工具卡片标「已熔断」）。MCP Server 熔断独立计数，且只影响该 Server 的工具（§9.7）。

**9.1.2 循环检测**（PRD §8.2）：以 `(工具名, 参数归一化哈希)` 为键。
- 同一键连续出现 **2 次** → 向模型注入一条 observation：「你正在重复同一个调用，请换参数或换工具」。
- 同一键连续出现 **3 次** → 判定死循环，**中止本次任务**，保留已完成结果，给出「检测到重复调用，已停止」的明确说明与「从该步重跑 / 换路径 / 换工具」三个恢复入口。

参数归一化哈希：先对参数对象做**键排序 + 剔除易变字段**（如 `timeoutMs`、`maxBytes`），再 JSON 序列化取 SHA-256。剔除规则可配置，默认剔除 `timeoutMs`/`maxBytes`/`maxEntries`/`contextLines`。

### 9.2 工具失败如何作为 observation 回喂（而非崩循环）

**核心原则：工具失败不是 Agent 循环的终止条件，而是一次"负向观察"。**

失败的处理链：
1. `ToolExecutor` 捕获失败 → 产出 `ToolOutcome{ok:false, errorCode, errorMessage, retryable}`。
2. 编排层把它渲染成 observation：
   - 原生通道：`{ role:"tool", tool_call_id, name, content: JSON.stringify({ok:false, error:{code,message}}) }`。
   - ReAct 通道：user 消息里的 ```` ```tool_result ```` 块，内容同上。
3. 该 observation 进入下一轮上下文，LLM 看到失败原因，可以：换参数重试、换工具、走别的路径、或直接向用户说明失败。
4. **同时**向客户端发 `tool_result` 事件（`status` 为 `failed` / `timeout` / `rejected` / `skipped`，前端展示错误，但对话流不中断）。

**错误信息给 LLM 时的内容约束**（防死循环）：
- 必须包含**可操作的修正信息**：如 `TOOL_ARGS_INVALID` 要说明哪个参数不合法、期望类型；`TOOL_NOT_FOUND` 要列出可用工具名；`SSRF_BLOCKED` 要说明目标被拦截（但不暴露内网网段细节，避免 LLM 试图绕过）。
- **不包含**：内部堆栈、文件绝对路径、数据库结构、内网拓扑。

### 9.3 连续失败熔断

- 计数器：同一轮迭代内连续工具失败次数。成功一次即重置为 0。
- 阈值：`AGENT_CIRCUIT_THRESHOLD`（默认 3）。
- 命中后：不再执行工具，把失败摘要作为 observation 回喂，让 LLM 收尾回答；终止原因 `finishReason=circuit_open`。
- **MCP Server 独立熔断**：单个 MCP Server 连续失败 3 次 → 标记 unhealthy → 其工具从 `toProviderTools()` 移除。**不影响其他 MCP Server，不影响内置工具**。

### 9.4 LLM 上游错误归一化

| 上游情况 | 归一化错误码 | HTTP | 可重试 | 降级动作 |
|----------|--------------|------|--------|----------|
| 连接失败 / DNS 失败 | `UPSTREAM_ERROR` | 502 | 是 | 退避重试 2 次（500ms/1500ms），仍失败则结束 |
| 响应超时（>60s） | `UPSTREAM_TIMEOUT` | 504 | 是 | 重试 1 次；仍超时 → 若本轮已有 tool_call 结果则让 LLM 收尾，否则报错 |
| HTTP 401 / 403 | `UPSTREAM_AUTH_ERROR` | 502 | 否 | 立即结束，提示检查 Key（**不区分"Key 无效"与"欠费"，统一文案**） |
| HTTP 429 | `UPSTREAM_RATE_LIMITED` | 429 | 是 | 读 `Retry-After` 头（上限 10s）后重试 2 次 |
| HTTP 5xx | `UPSTREAM_ERROR` | 502 | 是 | 退避重试 2 次 |
| HTTP 400 且信息匹配 tool 相关 | `UPSTREAM_TOOL_UNSUPPORTED` | 502 | 否 | **切换 ReAct 通道重试本轮**（L1 探测） |
| HTTP 400 其他 | `UPSTREAM_BAD_REQUEST` | 502 | 否 | 结束，提示上游拒绝请求（不透传原始报文） |
| 响应 JSON 解析失败 | `UPSTREAM_PARSE_ERROR` | 502 | 否 | 重试 1 次（非流式路径） |
| 流中断（已出部分内容） | `UPSTREAM_STREAM_INTERRUPTED` | 502 | 否 | 结束，**保留已产生内容**，标记 `finishReason=stream_interrupted` |

**错误信息脱敏（强制）**：所有上游错误信息经 `maskKey()` 处理（复用现有 adapter 的实现）后，才允许进入日志与前端响应。绝不透传上游原始报文（可能含 Key 回显或内部端点信息）。

### 9.4b 供应商降级链（主供应商不可用时自动切换）

> **PRD §8.3 / AC-08**：主供应商 5xx / 限流连续失败 → 自动切到用户配置列表中的下一个供应商，**界面明示「已切换到 X，原因是 Y」，任务不中断**。复用 v1.0 已有的五家 provider 架构。

- **切换触发**：同一供应商连续 2 次 5xx/429 且退避重试已耗尽（不是单次失败即切——单次 5xx 可能是瞬时抖动）。
- **切换范围**：仅在**用户已配置**的 provider 列表内切换，按用户设置页的顺序；不自动切到未配置或未授权（无 Key）的 provider。
- **切换后的行为**：
  - 换 provider 与 model，`meta` 事件重发（`provider`/`model` 更新，附 `switchedFrom`/`switchReason`）。
  - **能力表按新 provider+model 重新判定**——不能假设新供应商也支持原生 function calling（`provider_capabilities` 表按 `(provider, model)` 存，见 §11.2）。
  - 已产生的工具调用与消息**不重放**，从当前轮继续。
- **不可切换时**：无其他可用 provider → 按 §9.4 的上游错误处理结束，并向用户明示「无可用供应商」。
- **切换次数上限**：单任务内最多切换 2 次，避免在多个坏供应商之间打转。

### 9.5 通道降级

见 §5.5。补充：降级切换发生在**同一轮内**是允许的（原生失败 → ReAct 重试本轮），此时 `meta` 事件**已经发出**，因此需要再发一个 `meta` 事件（`iteration` 不变，`channel` 改为 `react`，`degraded=true`）。前端约定：**后到的 `meta` 覆盖先到的**（同一次请求内）。这一约定必须写进前端实现注释。

### 9.6 SQLite 故障降级

- **读失败**（DB 文件损坏/锁超时）：捕获 `SQLITE_*` 错误 → 降级为**内存模式**（`InMemoryStore`），当前请求继续跑（工具执行与 LLM 调用不依赖 DB），但**明确告知用户**"会话持久化不可用，本次对话不会保存"。
- **写失败**：同上——丢弃该条写入（不阻断 Agent 循环），累计失败计数，超过 5 次则完全切换到内存模式。
- **启动时 DB 不可用**：不静默降级——尝试用内存模式启动并打 `error` 级日志 + 健康检查返回 `degraded: true`。**决策依据**：服务已上线过，DB 坏了直接不启动会导致整个服务不可用；降级可用性更重要。
- **数据不丢的补偿**：内存模式下的所有写入缓存在内存，进程不重启则数据还在；重启则丢。日志中明确记录"本次会话未持久化"。

### 9.7 MCP 故障隔离

见 §6.6.4。核心：MCP 的任何故障**只影响 MCP 工具自身**，通过"工具级错误 → observation 回喂 → 熔断移除"两条路径消化，绝不冒泡为循环终止。

---

## 10. 安全设计清单（逐项可验收）

### 10.0 安全网关分层（PRD §5.3 / §16 S1-S2 / S8）

所有工具调用**统一经过一个安全网关层**，再进入具体工具 handler。网关是唯一的策略执行点——工具 handler 自身**不重复实现**安全检查（避免各处实现漂移）。

```
ToolCallIR
   │
   ▼
┌─────────────────────────────────────────────────┐
│ 安全网关（services/tools/security-gateway.ts） │
│  ① 工具存在性与启用状态校验                     │
│  ② 参数 schema 校验（zod，字段级错误）          │
│  ③ 运行期风险与确认档位判定（§6.3）             │
│  ④ 协议/参数级策略：                            │
│     HTTP → 协议白名单、URL 内凭据拒绝、          │
│             DNS 解析后逐条公网校验、逐跳重校验    │
│     文件 → realpath 先解析后判定、绝对路径/       │
│             \0 / .. 拒绝                           │
│     计算 → 白名单函数、深度上限、除零明确报错     │
│  ⑤ 提示注入特征检测（工具结果回传前）           │
│  ⑥ 同一被拒目标的任务内封禁                     │
└─────────────────────────────────────────────────┘
   │  (通过)
   ▼
ToolExecutor → 工具 handler
```

**关键顺序约束（不可颠倒）**：
- **文件**：先 `realpath` 解析符号链接，**再**判断是否落在沙箱根内。先比较未解析字符串会让 `../../` 与软链穿过（PRD S2 明确）。
- **HTTP**：先做协议白名单与 URL 内凭据拒绝，**再做 DNS 解析后的逐条公网校验**。校验与连接必须用同一已校验 IP（防 DNS rebinding 的 TOCTOU 窗口，§10.1 S-3）。

**提示注入防护（PRD S4）**：工具结果回传前统一标注为不可信数据；检测到「ignore previous instructions」类特征串时，向用户发警告横幅并在结果外包一层沙箱注释。同时**沙箱与 SSRF 的拒绝信息不向模型提供绕行建议**（§9.1）。

### 10.1 SSRF 防护（`http.request` 工具）

| # | 项 | 实现 | 验收 |
|---|-----|------|------|
| S-1 | 协议白名单 | 只允许 `http:`/`https:` | `file:///etc/passwd`、`ftp://x` → `SSRF_BLOCKED` |
| S-2 | 内网段拦截 | DNS 解析后校验所有 A/AAAA，任一命中内网/保留段即拒 | `http://127.0.0.1:8080`、`http://169.254.169.254/latest/meta-data/`、`http://10.0.0.1/`、`http://[::1]/` → 全部 `SSRF_BLOCKED` |
| S-3 | DNS 重绑定 | 校验与连接使用同一已校验 IP（自定义 `lookup` 覆写），不二次解析 | 构造"首次解析公网、连接时返回内网"的 DNS → 连接被拒 |
| S-4 | 重定向逐跳校验 | 手动跟随 ≤3 跳，每跳重新完整校验 | 公网 URL 302 → `http://169.254.169.254/` → 拒 |
| S-5 | 响应体截断 | 字节流累计超限即停，`truncated=true` | 下载 10MB 响应 → 返回前 20000 字符 + `truncated=true` |
| S-6 | 禁敏感响应头 | 响应头过滤 `set-cookie` | 响应中不含 `set-cookie` |
| S-7 | 出网白名单（可选） | `HTTP_TOOL_ALLOWLIST` env（逗号分隔域名后缀）；设置后只允许匹配域名 | 不在白名单 → `SSRF_BLOCKED` |

### 10.2 路径 jail（文件工具族）

| # | 项 | 验收 |
|---|-----|------|
| P-1 | 绝对路径拒绝 | `fs_read {"path":"/etc/passwd"}` → `PATH_JAIL_VIOLATION` |
| P-2 | `..` 拒绝 | `fs_read {"path":"../../secret.txt"}` → `PATH_JAIL_VIOLATION` |
| P-3 | 混合分隔符 | `fs_read {"path":"..\\..\\secret.txt"}` → `PATH_JAIL_VIOLATION`（Windows 必测） |
| P-4 | 符号链接逃逸 | jail 内 symlink 指向 jail 外 → realpath 校验失败 → `PATH_JAIL_VIOLATION` |
| P-5 | Windows 保留设备名 | `fs_write {"path":"CON"}` → `PATH_JAIL_VIOLATION` |
| P-6 | 根目录保护 | `fs_delete {"path":"."}` → 拒绝 |

### 10.3 命令注入与信任边界

- **内置工具不执行任何 shell 命令**：`calc.evaluate` 用自建递归下降解析器，**不使用 `eval` / `new Function` / `child_process`**；白名单函数 + 深度上限 + 除零明确报错（§6.6.3）。
- **MCP stdio 命令的信任边界（必须写进 UI 与文档）**：
  - MCP Server 的 `command` / `args` / `env` 由**用户在设置页显式配置**，服务端**不做任何字符串拼接或 shell 解析**——用 `child_process.spawn(command, args, { shell: false })` 形式（`StdioClientTransport` 内部即如此），**绝不** `shell: true`。
  - `command` 必须是**绝对路径或 PATH 中可执行文件名**；禁止包含 shell 元字符（`;` `|` `&` `$` `` ` `` `>` `<`）→ 拒绝。
  - `env` 只透传用户显式配置的键值，不继承父进程全部环境变量（`LLM_SERVER_API_KEY` 等服务端密钥**不得**传给 MCP 子进程）。
  - **信任模型（必须在 UI 明示）**：配置 MCP Server 等于授权该程序以本机用户权限运行。用户只应配置可信来源的 MCP Server。
  - MCP Server 自身的工具可能执行任意操作——其风险等级由用户在 MCP 面板逐个配置（默认 `write`），`destructive` 需显式确认。

### 10.4 高危工具审批机制

- 审批触发：运行期判定的 `approvalMode` 为 `soft` / `hard` / `two_step` 的调用（规则见 §6.3）。`two_step` 必须额外勾选确认项。**确认强度由服务端判定并随事件下发，前端不推断**（UIUX §3.8）。
- 流程：编排层检测到运行期 `approvalMode` ≠ `none` → **先把待执行调用持久化到服务端**（`approvals` 表 + 内存挂起句柄）并签发 `approvalToken`（绑定 `sessionId` + `callId` + 工具名 + 参数摘要，5 分钟过期）→ 发 `tool_approval_required`（携带 `approvalId`/`approvalToken`/`expiresAt`）→ **该轮循环在此挂起** → 前端渲染 inline 确认条 → 用户点决定 → `POST /api/v1/approvals/:id`（body 只含 `{token, decision, reason?}`，`decision` ∈ `allow_once` / `allow_session` / `reject`）→ 服务端校验 token 后执行或拒绝 → 在原 SSE 流上发 `tool_result`（`status: 'rejected'` 或继续执行的结果）。
- **服务端持有原则（安全硬要求）**：服务端**绝不接受客户端提交的工具调用内容**——只接受决定。参数由服务端自己在 `approvals` 表里取，避免「用户批准的与实际执行的不一致」这一已被公开指出的 human-in-the-loop 漏洞。
- 审批挂起超时：`AGENT_APPROVAL_TIMEOUT_MS`（默认 300s），超时按拒绝处理。
- 审批状态存内存 `Map<callId, {resolve, timer}>`，进程重启后挂起的审批作废（会话恢复时该工具调用标记 `status='denied'`）。
- `callId` 必须绑定 `sessionId`，防止跨会话批准。

> **运维硬要求（必须写进部署文档）**：**生产部署必须显式配置 `AGENT_APPROVAL_SECRET`，否则进程重启会导致所有挂起审批失效。**
> 原因：令牌签名密钥缺省时由进程在启动时随机生成并打 `warn` 日志，重启即换密钥 → 重启前签发的令牌全部验签失败 → 用户看到的「待确认」卡片在新进程里永远等不到结果（表现为审批条卡死）。显式配置后密钥跨重启稳定，挂起审批仍会因内存句柄丢失而作废（这是已接受的代价，与密钥无关），但**不会额外产生「令牌验签失败」的假象**，排障路径清晰。
> 配置要求：随机 ≥32 字节、`base64` 后写入 `server/.env`；**不得**与 `LLM_SERVER_API_KEY` 复用同一值；轮换会作废所有在途令牌（应在无挂起审批时执行）。

### 10.5 密钥不落日志

- 复用现有 `request-log` 脱敏中间件，扩展脱敏字段：`apiKey`、`authorization`、`x-api-key`、`env`（MCP 配置中的值）。
- 工具 `arguments` 可能含敏感信息（如 `headers.Authorization`）→ 落库与日志中，对 `http.request` 的 `headers` 做键名脱敏（值替换为 `***`，键名匹配 `apiKey|token|secret|password|authorization|cookie`，与 PRD §6.1 一致）。
- LLM 上游错误信息经 `maskKey()` 处理。
- SQLite 文件本身**不含** LLM API Key（Key 只在请求体中存在，不落库）。
- 客户端：Key 仍存 localStorage（沿用现有 BYOK 设计），设置页提供一键清除。

### 10.6 超时与并发上限

| 维度 | 上限 | 位置 |
|------|------|------|
| 单次 LLM 调用 | 60s | adapter（已有） |
| 单次工具执行 | 15s（`http.request` 30s） | ToolExecutor |
| 单轮提问总时长 | 180s | AgentLoopService |
| 单次提问迭代轮数 | 12 | AgentLoopService |
| 单轮并行工具数 | 4 | ToolExecutor |
| 同时进行的 Agent 请求 | 3（`AGENT_MAX_CONCURRENT`，按 IP 计） | 中间件 |
| 同时运行的 MCP Server | 4 | McpManager |
| 请求体大小 | 64KB（沿用） | express.json |
| 工具结果上下文长度 | 20000 字符（`http.request`）/ 4000 字符（进上下文阈值） | 注册表 |

### 10.7 资源配额

- 单会话最大消息数：2000（超出时最旧消息自动归档为 summary）。
- 单会话最大工具调用数：500（超出拒绝新调用并提示）。
- 单次提问最大工具调用数：40。
- DB 文件大小监控：`GET /api/v1/health` 返回 `db.sizeBytes`，超过 200MB 提示清理。

### 10.8 其它

- **CORS**：沿用 env 白名单，默认同源。
- **CSP**：沿用现有 helmet 配置；新增前端若使用 `blob:` 图片需加 `img-src blob:`。
- **依赖安全**：`@modelcontextprotocol/client` 需 lockfile 安装 + `npm audit` 门禁。
- **路径穿越（工具注册表）**：MCP Server 配置的 `cwd` 必须是已存在目录。

---

## 11. API 端点清单 + 数据库表清单

### 11.1 API 端点（锁定级粒度）

统一前缀 `/api/v1`；统一错误格式 `{ "error": { "code": "CODE", "message": "..." } }`。

| Method | Path | 功能 | 请求体 | 响应 |
|--------|------|------|--------|------|
| GET | `/api/health` | 健康检查（含 db/mcp 状态） | — | `{ status, uptime, db: {ok, sizeBytes, degraded}, mcp: {servers, healthy} }` |
| GET | `/api/v1/providers` | provider 与模型列表（**含能力字段**） | — | `{ providers: [{id,name,baseUrl,models[],defaultModel,docsUrl,capabilities:{nativeTools,toolChoiceValues,contextWindow,retainReasoningContent,requireToolStreamFlag,explicitParallelToolCalls}}] }` |
| GET | `/api/v1/providers/capabilities` | 各 provider/model 的 function calling 能力探测结果（PRD §8.3，不每轮试探） | — | `{ capabilities: [{provider, model, supportsFunctionCalling, probedAt, notes}] }` |
| GET | `/api/v1/sessions` | 会话列表 | `?limit&offset` | `{ items: [{id,title,provider,model,messageCount,updatedAt}], total }` |
| POST | `/api/v1/sessions` | 新建会话 | `{ provider, model, title? }` | `{ session, recoveryCode? }`（首次创建时返回 8 位恢复码，**只此一次明文返回**） |
| POST | `/api/v1/sessions/recover` | 用恢复码跨浏览器恢复 | `{ recoveryCode }` | `{ session, deviceToken }`（恢复码单次使用；连续失败 5 次锁 15 分钟） |
| POST | `/api/v1/sessions/:id/recovery-code` | 重新生成恢复码（旧码立即失效） | — | `{ recoveryCode }` |
| GET | `/api/v1/sessions/:id` | 会话详情（含历史与工具调用） | — | `{ session, messages: [...], toolCalls: [...] }` |
| PATCH | `/api/v1/sessions/:id` | 重命名/改模型 | `{ title?, provider?, model? }` | `{ session }` |
| DELETE | `/api/v1/sessions/:id` | 删除会话（级联删消息与工具调用） | — | `{ deleted: true }` |
| POST | `/api/v1/agent/stream` | **Agent 主端点（SSE）** | `AgentRequest`（见下） | SSE 事件流（§8） |
| POST | `/api/v1/approvals/:id` | 提交审批决定（独立端点，不走 SSE 同流） | `{ token, decision: 'allow_once'\|'allow_session'\|'reject', reason? }` | `{ ok: true, status: 'executed'\|'rejected' }` |
| POST | `/api/v1/agent/abort` | 主动中止（备选路径，浏览器 abort 为主） | `{ sessionId }` | `{ ok: true }` |
| GET | `/api/v1/tools` | 工具注册表列表 | `?source&risk&category` | `{ tools: [ToolDefinitionPublic], grouped: {low:[],medium:[],high:[]} }` |
| PATCH | `/api/v1/tools/:name` | 启用/禁用工具 | `{ enabled }` | `{ name, enabled }` |
| POST | `/api/v1/events` | 写入本地埋点（PRD §14.5，**只落本地，不远程上报**） | `{ event, props? }` | `{ ok: true }` |
| GET | `/api/v1/events` | 读取本地埋点（设置页查看与导出） | `?event&limit` | `{ events: [{event, props, createdAt}] }` |
| GET | `/api/v1/mcp/servers` | MCP Server 配置列表 | — | `{ servers: [{id,name,command,args,enabled,status,tools:[],lastError?}] }` |
| POST | `/api/v1/mcp/servers` | 添加 MCP Server | `{ name, command, args[], env?, cwd? }` | `{ server }` |
| PATCH | `/api/v1/mcp/servers/:id` | 改配置/启禁用 | `{ name?, command?, args?, env?, cwd?, enabled? }` | `{ server }` |
| DELETE | `/api/v1/mcp/servers/:id` | 删除 MCP Server | — | `{ deleted: true }` |
| POST | `/api/v1/mcp/servers/:id/connect` | 手动连接/重连 | — | `{ server }` |
| POST | `/api/v1/mcp/servers/:id/disconnect` | 手动断开 | — | `{ server }` |

**`AgentRequest`**
```jsonc
{
  "sessionId": "可选；不传则新建会话",
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "apiKey": "可选，BYOK",
  "message": "用户输入（单条）",
  "tools": ["可选；本次允许使用的工具名白名单，不传=全部已启用"],
  "channelMode": "auto | native | react（可选，覆盖会话设置）",
  "maxIterations": 12,
  "temperature": 0.3,
  "maxTokens": 2048
}
```

**`ToolDefinitionPublic`**（对外暴露的注册表视图，**不含 handler 函数**）
```jsonc
{
  "name": "fs.read",                    // 规范名（点号），卡片展示与审计检索用
  "wireName": "fs_read",                // 线上名（下发给 LLM 用）
  "displayName": "读取文件",              // 人话名，设置页/审批条/示例任务用
  "category": "file",
  "description": "...",
  "inputSchema": { "type": "object", "properties": {...} },
  "risk": "low",                        // 基线风险；实际风险由调用时判定
  "approvalMode": "none",               // 基线确认强度；实际由调用时判定
  "enabled": true,
  "source": "builtin",
  "mcpServerId": null
}
```

### 11.2 数据库表清单（锁定）

> **同步修订（2026-10-22，Phase 2；项目总监裁决 L-1 授权）**：本节已与 Spec §6 及本文 §7.2 收敛为**同一口径的 7 张表**。删除了 `artifacts` 与 `local_events` 两条已判不建的条目，并同步列名 `token_estimate` → `tokens`（Spec §6 命名）。**权威建表 SQL 见 `docs/agent/schema.sql`，叙述版见 §7.2。**

**表数量：7 张**（Spec §6 锁定）。

| # | 表 | 用途 | 关键字段 | 索引 |
|---|----|------|----------|------|
| 1 | `sessions` | 会话元信息 + 恢复凭证 | `id`(PK), title, provider, model, channel_mode, degraded, message_count, total_tokens, device_token_hash, recovery_code_hash, recovery_code_used_at, recovery_failed_count, recovery_locked_until, summary, created_at, updated_at | `idx_sessions_updated(updated_at DESC)`、`idx_sessions_device(device_token_hash)` |
| 2 | `messages` | 消息（含 Agent 的 tool_calls 与摘要） | `id`(PK), session_id(FK), seq, role, content, **segments_json**, reasoning_content, tool_calls_json, tool_call_id, finish_reason, usage_json, **tokens**, is_summary, created_at | `idx_messages_session_seq`、`idx_messages_session_created`、`uq_messages_session_seq(session_id, seq)` |
| 3 | `tool_calls` | 工具调用审计（一等公民） | `id`(PK), session_id(FK), message_id(FK,SET NULL), call_id, tool_name(**规范名**), tool_wire_name, display_name, category, source, risk, approval_mode, channel, iteration, args_json, args_digest, status(**7值**), error_kind, error_msg, result_ref, result_summary, truncated, started_at, ended_at, duration_ms, created_at | `idx_toolcalls_session`、`idx_toolcalls_message`、`idx_toolcalls_name_status(tool_name,status)`、`idx_toolcalls_digest(session_id,tool_name,args_digest)` |
| 4 | `tool_results` | 工具结果外置（长结果只留指针） | `id`(PK), tool_call_id(FK), inline_preview, artifact_path, bytes, truncated, sha256, created_at | `idx_toolresults_call(tool_call_id)` |
| 5 | `approvals` | 审批挑战与决定（**不可篡改**） | `id`(PK), session_id(FK), tool_call_id(FK), tool_name, args_digest, challenge_token_hash, status, decision(`allow_once`\|`allow_session`\|`reject`), reason, mismatch_count, last_mismatch_at, last_mismatch_detail, expires_at, decided_at, created_at | `idx_approvals_session`、`idx_approvals_call`、`idx_approvals_status(status,expires_at)`；触发器 `trg_approvals_decision_once` |
| 6 | `provider_capabilities` | function calling 能力探测结果（**不在每轮试探**） | `provider`+`model`(复合PK), supports_function_calling, probe_status(`supported`/`unsupported`/`failed`), context_window, lightweight_model, tool_choice_values_json, retain_reasoning_content, require_tool_stream_flag, explicit_parallel_tool_calls, probed_at, notes | 主键 `(provider, model)`、`idx_capabilities_probed(probed_at DESC)` |
| 7 | `schema_migrations` | 迁移版本 | `version`(PK), name, applied_at | 主键 |

**刻意不建的表**：

| 不建 | 理由 |
|------|------|
| `artifacts` | Spec §6 判定：长结果指针并入 `tool_results.artifact_path`；artifact 文件仍落 `SANDBOX_ROOT/.artifacts/`，`fs.read` 可按路径回查（ADR-014 / ADR-023） |
| `local_events` | Spec §3 判定：埋点沿用前端本地事件日志，服务端不落库；对应 `POST/GET /api/v1/events` 两个端点本期不实现 |
| `tools` | 工具定义在代码中；运行时启禁用是进程内状态（`Map` 用户覆盖层），MVP 无多用户，持久化无收益 |
| `mcp_servers` | 仅 4-5 个字段，用 `config/mcp-servers.json` 承载——为它建表是过度设计 |
| `approval_audit`（第 8 张） | 7 张是 Spec 锁定的硬上限；异常审计由 `approvals.mismatch_count` / `last_mismatch_at` / `last_mismatch_detail` 三列承载 |

**审计只追加**（PRD §7.1 / S3）：`approvals` 与高危 `tool_calls` 记录**只追加，不提供删除端点**。用户可整体清除数据库文件。

**`messages.segments_json`**（跨文档裁决 C-6 的落点）：存 assistant 消息的分段结构（文本段与工具卡占位交替），使前端能还原「一条 assistant 消息内文本与工具卡交替」的渲染。`content` 保持纯文本以便检索与摘要。

---

## 12. 目录结构（落到文件级）

### 12.1 服务端

```
server/src/
├── app.ts                              # 入口：只装配（挂中间件+路由+启动），<100 行
├── config/
│   ├── env.ts                          # 扩展：AGENT_*/MCP_*/SQLITE_*/SANDBOX_*
│   └── mcp-servers.json                # MCP Server 用户配置（非密钥数据）
├── routes/
│   ├── index.ts                        # 路由聚合
│   ├── agent.routes.ts                 # /agent/stream, /agent/approve, /agent/abort
│   ├── sessions.routes.ts              # /sessions CRUD
│   ├── tools.routes.ts                 # /tools, /tools/:name
│   └── mcp.routes.ts                   # /mcp/servers CRUD + connect/disconnect
├── controllers/
│   ├── agent.controller.ts             # 校验 AgentRequest + 驱动 SSE
│   ├── sessions.controller.ts
│   ├── tools.controller.ts
│   └── mcp.controller.ts
├── services/
│   ├── recovery.service.ts               # 设备令牌 + 8 位恢复码（§7.6）
│   ├── agent/
│   │   ├── agent-loop.service.ts       # 状态机 / 预算 / 终止条件（核心）
│   │   ├── channel-router.service.ts   # 能力探测 + 通道选择 + 降级
│   │   ├── context-manager.service.ts  # token 估算 + 三层压缩 + 锚点保活
│   │   ├── token-estimator.ts          # 纯函数：字符集 → token 估算
│   │   ├── native-channel.ts           # 通道 A：function calling → TurnIR
│   │   ├── react-channel.ts            # 通道 B：ReAct 解析 → TurnIR
│   │   ├── react-parser.ts             # 纯函数：三级降级解析器
│   │   ├── approval.service.ts         # 高危工具审批（服务端持有 + 令牌）
│   │   ├── fidelity-checker.ts         # 纯函数：保真清单机械自检 F-1~F-5
│   │   ├── loop-detector.ts            # 纯函数：(工具, 参数哈希) 循环检测
│   │   ├── circuit-breaker.ts           # 纯函数：每工具熔断器
│   │   └── loop-budget.ts              # 纯函数：预算/终止条件判定
│   ├── tools/
│   │   ├── registry.service.ts         # 注册表：注册/查询/启禁用/分组
│   │   ├── security-gateway.ts        # 安全网关：唯一策略执行点（§10.0）
│   │   ├── executor.service.ts         # 超时/重试/审批/截断/落库
│   │   ├── schema-validator.ts         # JSON Schema → Zod 校验
│   │   └── mcp/
│   │       ├── mcp-manager.service.ts  # Client 生命周期 / 状态机
│   │       ├── mcp-tool-adapter.ts     # MCP tool → ToolDefinition
│   │       └── mcp-registry-bridge.ts  # MCP 工具并入注册表 + 冲突消解
│   ├── memory/
│   │   ├── session.repository.ts
│   │   ├── message.repository.ts
│   │   ├── tool-call.repository.ts
│   │   ├── tool-result.repository.ts
│   │   ├── artifact.repository.ts
│   │   ├── approval.repository.ts
│   │   ├── provider-capability.repository.ts
│   │   └── local-event.repository.ts
│   ├── sse-writer.ts                   # 事件 → SSE 帧（复用 utils/sse.ts）
│   └── prompts/
│       ├── agent.prompt.ts             # Agent system prompt
│       ├── react.prompt.ts             # ReAct 模板（唯一来源）
│       └── compaction.prompt.ts        # 上下文摘要提示词
├── tools/builtin/
│   ├── index.ts                        # BUILTIN_TOOLS 集中登记
│   ├── http-request.tool.ts
│   ├── fs-read.tool.ts
│   ├── fs-write.tool.ts
│   ├── fs-list.tool.ts
│   ├── fs-delete.tool.ts
│   ├── calc-evaluate.tool.ts
│   ├── time-now.tool.ts
│   ├── uuid-generate.tool.ts
│   ├── json-format.tool.ts
│   ├── text-diff.tool.ts
│   ├── tool-result-read.tool.ts        # 回查长结果
│   └── path-jail.ts                    # 路径 jail 纯函数
├── providers/
│   ├── registry.ts                     # 改造：加能力字段
│   ├── capabilities.ts                 # 新增：ProviderCapabilities 表
│   ├── openai-compatible.adapter.ts    # 改造：tool_calls 归一化
│   └── tool-call-normalizer.ts         # 新增：流式 tool_call delta 累积
├── repositories/
│   ├── db.ts                           # node:sqlite 封装 + withTransaction
│   ├── schema.ts                       # 建表 SQL
│   └── migrations/
│       ├── index.ts                    # 迁移执行器
│       └── 001-initial.ts
├── middlewares/
│   ├── agent-concurrency.ts            # 按 IP 限制同时 Agent 请求数
│   ├── rate-limit.ts                   # 改造：加 /agent/stream 限额
│   ├── error-handler.ts
│   ├── request-log.ts                  # 改造：扩展脱敏字段
│   └── not-found.ts
├── validators/
│   ├── agent.schema.ts
│   ├── session.schema.ts
│   ├── tools.schema.ts
│   └── mcp.schema.ts
├── utils/
│   ├── errors.ts                       # 扩展错误码
│   ├── sse.ts                          # 原样保留
│   ├── ssrf-guard.ts                   # 新增：URL/IP 校验纯函数
│   └── async-handler.ts
└── types/
    ├── index.ts                        # 扩展
    ├── tool.ts                         # ToolDefinition 等
    └── agent-events.ts                 # SSE 事件联合类型（前后端对齐）
```

### 12.2 前端

```
client/src/
├── main.tsx
├── App.tsx                             # 布局组装 <100 行
├── components/
│   ├── layout/                         # AppShell / TopBar / SessionSidebar / StatusBar（改造）
│   ├── chat/                           # ChatPanel / MessageList / MessageItem（改造：渲染工具卡片）
│   ├── agent/                          # 【新建】
│   │   ├── ToolCallTimeline.tsx        # 工具调用时间线容器
│   │   ├── ToolCallCard.tsx            # 单个调用卡片（执行中/成功/失败三态）
│   │   ├── ToolResultView.tsx          # 结果展示（复用 CodeBlock/MarkdownContent）
│   │   ├── ToolApprovalBar.tsx         # 审批条
│   │   ├── ChannelNotice.tsx           # 降级提示条
│   │   └── ContextNotice.tsx           # 上下文压缩提示
│   ├── tools/                          # 【新建】
│   │   ├── ToolManagerPanel.tsx        # 工具注册表管理（按风险分组）
│   │   └── ToolToggle.tsx
│   ├── mcp/                            # 【新建】
│   │   ├── McpPanel.tsx                # MCP Server 列表与配置
│   │   └── McpServerItem.tsx
│   ├── editor/ CodeEditor.tsx          # 原样保留
│   ├── result/                         # 原样保留（CodeBlock / MarkdownContent / DiffView）
│   ├── settings/                       # SettingsModal 扩展工具管理入口
│   ├── session/ common/ empty/         # 原样保留
├── hooks/
│   ├── useSSEStream.ts                 # 改造：扩展事件分发
│   ├── useAgentStream.ts               # 【新建】：Agent 专用流 hook
│   └── useTheme.ts
├── services/
│   ├── stream.ts                       # 改造：11 种事件分发
│   ├── api.ts                          # 扩展：sessions/tools/mcp 请求
│   └── agent.ts                        # 【新建】：agent 端点封装
├── stores/
│   ├── sessionStore.ts                 # 改造：服务端会话镜像
│   ├── agentStore.ts                   # 【新建】：工具事件时间线
│   ├── settingsStore.ts                # 保留
│   └── uiStore.ts                      # 保留
├── lib/
│   ├── storage.ts                      # 改造：保留 settings，废弃 sessions 持久化
│   ├── result-parser.ts                # 保留
│   ├── languages.ts format.ts diff.ts cn.ts   # 保留
│   └── tool-approval.ts                # 【新建】：审批状态本地镜像
├── types/
│   ├── index.ts                        # 扩展
│   └── agent-events.ts                 # 与服务端对齐的事件联合类型
└── styles/
    ├── design-tokens.css               # 锁定不变
    └── app.css
```

**文件数变化**：服务端 46 → 约 78 个文件；前端 40 → 约 55 个。

### 12.3 图标使用约定（锁定）

新增工具相关图标一律使用 lucide-react 名称，**禁止 emoji**：

| 语义 | Lucide 图标名 |
|------|--------------|
| HTTP 请求 | `Globe` |
| 文件读取 | `FileText` |
| 文件写入 | `FilePen`（已核验存在于 1.60.0） |
| 文件列表 | `FolderOpen` |
| 文件删除 | `Trash2` |
| 计算器 | `Calculator` |
| 时间 | `Clock` |
| UUID | `Fingerprint` |
| JSON | `Braces` |
| 正则 | `Regex`（已核验存在于 1.60.0） |
| MCP | `Plug` / `PlugZap` |
| 工具时间线 | `Wrench` |
| 执行中 | `Loader2`（配合 `animate-spin`） |
| 成功 | `CircleCheck` |
| 失败 | `CircleX` |
| 审批 | `ShieldAlert` |
| 降级提示 | `TriangleAlert` |

> **图标命名约定（锁定）**：一律使用 lucide **规范名**（`CircleCheck` / `CircleX` / `TriangleAlert`），**不使用旧兼容别名**（`CheckCircle2` / `XCircle` / `AlertTriangle`）。依据：项目实际安装的 `client/node_modules/lucide-react/dist/lucide-react.d.ts` 导出语句为 `CircleCheck as CheckCircle2` / `CircleX as XCircle` / `TriangleAlert as AlertTriangle`——规范名是主定义，旧别名仅为向后兼容保留。且已交付上线的既有代码（`Toast.tsx` / `ResultPanel.tsx` / `SettingsModal.tsx` 共 8 处）用的正是规范名，若新代码用别名会造成同屏两种写法。
> **存在性已核验（无需 Phase 2 再查）**：`FilePen` / `Regex` / `TriangleAlert` 三者在本项目安装的 lucide-react 1.60.0 中均存在，备选名（`FilePlus` / `ScanText` / `PlugZap`）不需要启用。
> **Phase 3 清理项**：`client/src/components/layout/AppShell.tsx` 第 5 行 import 与第 120 行用法共 2 处 `AlertTriangle`，顺手改为 `TriangleAlert`（2 行机械替换，视觉零差异）。

### 12.4 门禁命令（Phase 2 必须全过）

```bash
# 1. 单文件行数 ≤300
find server/src client/src -name '*.ts' -o -name '*.tsx' | xargs wc -l | sort -rn | awk '$1>300 && $2!="total" {print "OVER:", $0}'
# 2. 入口文件行数 <100
wc -l server/src/app.ts client/src/main.tsx client/src/App.tsx
# 3. 类型检查 + 测试
npm run typecheck --prefix server && npm run typecheck --prefix client
npm test --prefix server && npm test --prefix client
# 4. 依赖审计
npm audit --prefix server --audit-level=high
```

---

## 13. 性能目标

| 指标 | 目标 | 手段 |
|------|------|------|
| 首 token 延迟（TTFT） | P50 ≤ 2.5s，P95 ≤ 6s | 服务端零排队直连上游；首轮 prompt 精简（system + 工具定义 + 用户消息）；连接复用（`fetch` 默认 keep-alive） |
| 单轮工具调用延迟 | ≤ 1.5s（本地工具）/ ≤ 5s（网络工具） | 本地工具同步执行（node:sqlite/文件）；网络工具受 `timeoutMs` 约束 |
| 端到端完成（3 轮迭代） | ≤ 20s | 每轮 LLM 流式增量输出；工具并行执行（同轮 ≤4） |
| 工具调用轮次预算 | ≤ 12 轮，单次提问 ≤ 40 次工具调用 | `AGENT_MAX_ITERATIONS` 硬上限 |
| SSE 背压 | 客户端消费不及时时**不阻塞** LLM 读取 | 服务端 `res.write` 返回 false 时暂停读取上游（背压信号），上游缓冲上限 1MB，超限丢弃中间 token 增量（保留最后一段） |
| 同时 Agent 请求 | 3（按 IP） | `AGENT_MAX_CONCURRENT` 中间件 + 429 响应 |
| SQLite 查询 | 单条 < 5ms | 全部走索引；`messages(session_id, seq)` 复合索引 |
| 工具注册表查询 | < 1ms | 内存 Map，不查 DB |
| 上下文装配 | < 50ms | 缓存 token 估算结果于 `messages.tokens` 列，不重复扫描 |
| 前端渲染 | 工具卡片 < 16ms/个 | 时间线虚拟化（超过 50 条时只渲染可视区） |
| 首屏 | < 2s | 沿用现有（Vite gzip + 按需加载 + 哈希长缓存） |

**SSE 背压细节**（现有代码无此处理，需新增）：`res.write()` 返回 `false` 表示内核缓冲已满。此时应**暂停**从上游 `ReadableStream` 读取（`await` 一个 `drain` 事件），而不是继续读导致内存膨胀。若等待超过 5s，丢弃**最旧的 token 增量**（保留首尾），并在流结束时发 `context_notice{reason:'backpressure_dropped'}`。

---

## 14. 不可行警告 / 风险登记

> 如实登记，不粉饰。

### 14.1 结构性风险

| # | 风险 | 影响 | 缓解 | 残余风险 |
|---|------|------|------|----------|
| R-1 | **`node:sqlite` 在 Node 22 上是 Stability 1.1（实验性）** | API 在 Node 22 次版本间可能变；启动有 `ExperimentalWarning` | 锁死 Node 22.22.2 精确版本（`engines` + `.nvmrc` + Docker 基础镜像固定 digest）；启动加 `--disable-warning=ExperimentalWarning`；数据访问层薄封装，替换驱动 = 1 个文件 | **中**。若 Node 22.23 改了 API，需适配。建议在 Phase 2 第一个里程碑加一条 CI 检查：Node 22 升级后跑 DB 冒烟测试 |
| R-2 | **ReAct 通道的准确性显著低于原生 function calling** | 弱模型在 ReAct 下可能输出不合规 JSON、臆造工具名、反复调用同一工具 | 三级解析降级 + 熔断 + 错误信息可操作化；ReAct 通道的 `max_iterations` 收紧到 8 | **中**。ReAct 只是"能跑"，不是"跑得好" |
| R-3 | **GLM 必须显式传 `tool_stream: true` 才返回 tool_calls** | 不传则表现为"模型就是不调工具"，极难排查 | 能力表 `requireToolStreamFlag` + 单元测试断言请求体含该字段 | 低（已内建） |
| R-4 | **思考模式下 DeepSeek/Kimi 必须在 assistant 消息保留 `reasoning_content`，否则 400** | 上下文装配漏掉该字段 → 整个请求失败 | 能力表 `retainReasoningContent` + 装配层强制保留 | 中（装配层容易漏，需专门的回归测试） |
| R-5 | **`deepseek-reasoner`（旧推理模型）不支持 Function Call** | 用户选了不支持的模型会走 ReAct，体验差 | 能力表按 **model** 粒度而非 provider 粒度配置；`meta` 事件告知前端已降级 | 低 |
| R-6 | **MCP Server 是本机任意程序** | 配置恶意 MCP = 本机代码执行 | `shell:false`、禁 shell 元字符、不透传服务端密钥、UI 明示信任边界、默认风险等级 `write` | **高（固有）**。这是用户主动授权的行为，无法技术性根除 |
| R-7 | **`http.request` 的 SSRF 防护不可能 100% 完备** | 新型绕过手法可能出现 | 多层防御（协议+IP段+同IP连接+逐跳校验+白名单）；`HTTP_TOOL_ALLOWLIST` 可作最终兜底 | **中（固有）**。建议生产部署时设置 allowlist |
| R-8 | **前端 localStorage 会话与新服务端会话并存** | 用户可能困惑（历史列表出现两处） | 首次启动提示导入；不自动删除旧数据 | 低 |
| R-9 | **上下文压缩依赖 LLM 摘要，质量不稳定** | 摘要可能丢失关键约束 | 摘要提示词强制保留清单；压缩失败有确定性降级；原始消息不删（可审计） | 中 |
| R-10 | **多 provider 的 tool_choice 语义不一致** | `required` 在 Qwen/GLM 思考模式下不生效 | 只下发 `auto`（唯一公共安全值）；`required` 需能力表 + 模式判断 | 低 |
| R-11 | **工具并行调用与审批的交互复杂** | 并行时多个待审批如何排序 | MVP **不启用并行工具执行**（`parallel_tool_calls` 保守发 `false`），串行执行 + 逐个审批 | 低（规避而非解决） |
| R-12 | **Agent 请求比问答贵 10-100 倍**（多轮 LLM + 工具） | 成本与限流压力 | 严格迭代上限 + 预算 + 熔断；按 IP 限流；BYOK 模式成本归用户 | 低 |
| R-13 | **同步 SQLite 阻塞事件循环** | 大表扫描会卡住整个 SSE 服务 | 只走索引查询；禁止分析型 SQL；必要时迁 worker_thread | 低（MVP 数据量） |
| R-14 | **`better-sqlite3` 若未来替换需重新评估** | 预编译产物与 Node 版本强绑定 | 已在 ADR 记录替换条件 | 低 |
| R-15 | **压缩保真自检可能频繁失败导致长任务中断** | LLM 摘要缺 F-2/F-4 时机械补齐不了 → 回退 → 用户被要求缩短任务 | F-1/F-3/F-5 可机械补齐（从原始消息抽取）；F-2/F-4 靠摘要质量。提示文案明确给出可操作出路 | **中**。PRD AC-06 明确接受此行为（「回退并提示用户，不静默截断」），但长任务体验受影响，需实测摘要质量后调整九段 prompt |
| R-16 | **供应商降级链会中断流式响应** | 切换 provider 时上游连接必须重建 | `meta` 事件重发告知「已切换到 X，原因是 Y」；已产生的 token 保留在消息里 | 低 |
| R-17 | **恢复码是持有即拥有的凭证** | 免登录 + 服务端持久化的固有代价，无二次身份验证 | 单次使用限制泄露窗口；只存哈希；5 次/15 分钟锁定；服务端无法二次验证 | **中（固有）**。已在 ADR-022 记录 |
| R-18 | **本地埋点可能意外写入敏感内容** | `local_events.props_json` 若含 args/result 原文即泄露 | 服务端强制字段白名单校验（禁止 `args`/`result`/Key/用户目录路径）；仅允许 PRD §14.5 列出的事件名 | 低 |
| R-19 | **`HTTP_ALLOW_INSECURE` 若被误开即失去 HTTPS-only 防线** | 明文传输 + 中间人 | 默认关闭；开启时启动日志显式告警；生产环境检测到开启即拒绝启动 | 低 |

### 14.2 明确不可行的能力（本期）

| 能力 | 不可行原因 |
|------|-----------|
| 跨设备同步 / 多用户 | 免登录 + 本地运行，无账号体系与云端存储 |
| 语义记忆 / 向量检索 | 记忆定位是"会话上下文持久化"，不是知识库检索；引入 embedding + 向量库对本地单机是过度设计 |
| 任意系统命令执行 | 命令注入风险无法在 MVP 内可靠控制；`calc.evaluate` 用自建解析器替代 `eval` |
| 后台常驻 Agent / 定时任务 | 需要独立的调度器与进程生命周期管理，超出本期范围 |
| HTTP 请求工具托管第三方 API Key | 变成密钥托管服务，合规与安全成本陡增 |
| MCP resources / prompts / sampling | 本期只接 tools；resources 需另设计上下文注入协议 |
| 100% 准确的 ReAct 解析 | 提示词解析本质是启发式；只能靠熔断与错误回喂兜底 |
| Agent 多智能体协作 | 需要任务分解协议与消息路由，远超本期 |

---

## 15. 实施顺序建议

> 原则：最快跑通端到端（先让"一句话 → 一次工具调用 → 结果回喂 → 最终回答"这条主干亮起来），再补外围。

### 里程碑 M1：骨架与契约（后端为主）
1. `types/agent-events.ts` + `types/tool.ts`（前后端对齐的事件与工具类型）。
2. `repositories/db.ts` + `schema.ts` + `migrations/001-initial.ts`（node:sqlite 封装 + 4 张表 + `withTransaction`）。
3. `providers/capabilities.ts`（能力表）+ `providers/tool-call-normalizer.ts`（流式 tool_call 累积，**纯函数先写测试**）。
4. `services/tools/registry.service.ts`（注册表）+ `types` 定义。

**验收**：`GET /api/v1/tools` 返回内置工具清单；DB 文件生成且 4 张表存在；tool_call delta 归一化单测全绿。

### 里程碑 M2：单工具跑通（端到端最小闭环）
5. 改造 `openai-compatible.adapter.ts`：请求带 `tools`、解析 tool_calls、保留 `reasoning_content`。
6. `services/agent/native-channel.ts`（原生通道 → TurnIR）。
7. `services/agent/agent-loop.service.ts`（状态机，**先只支持单工具、无审批、无并行**）。
8. `services/agent/context-manager.service.ts` + `token-estimator.ts`。
9. 内置工具先实现 3 个：`calc.evaluate`、`fs.read`、`http.request`。
10. `POST /api/v1/agent/stream` + SSE 事件写出。

**验收**：输入"读取 sandbox/a.txt 并统计字数" → 产生 `meta` → `token` → `tool_call` → `tool_result` → `token` → `done`，且 `messages` 与 `tool_calls` 表正确落库。**这是 M2 的硬验收点，也是整个项目的第一个"能跑"时刻。**

### 里程碑 M3：前端可视化
11. `services/stream.ts` 扩展 11 种事件分发 + `hooks/useAgentStream.ts`。
12. `stores/agentStore.ts`（工具事件时间线）。
13. `components/agent/*`（ToolCallTimeline / ToolCallCard / ToolResultView / ChannelNotice / ContextNotice）。
14. `stores/sessionStore.ts` 改造为服务端镜像 + `lib/storage.ts` 精简。

**验收**：前端能实时看到工具调用卡片的三态流转。

### 里程碑 M4：工具族补全 + 安全
15. 剩余内置工具（PRD §5.1 锁定 9 个）：`fs.write` / `fs.list` / `time.now` / `uuid.generate` / `json.format` / `text.diff`（`fs.read` 与 `http.request` 已在 M2 实现，`calc.evaluate` 同批）。
16. `utils/ssrf-guard.ts` + `tools/builtin/path-jail.ts`（**各配一组安全测试**）。
17. 工具管理面板（`/tools` 端点 + `ToolManagerPanel`）。
18. `ToolExecutor` 的超时/重试/截断/熔断。

**验收**：§10.1 与 §10.2 的每一条都有对应的自动化测试用例且通过。

### 里程碑 M5：MCP 接入
19. `services/tools/mcp/mcp-manager.service.ts`（生命周期）。
20. `mcp-tool-adapter.ts` + `mcp-registry-bridge.ts`（并入注册表 + 名字冲突消解）。
21. `/mcp/servers` 端点 + `components/mcp/*` 面板。
22. 编写一个本地测试用 MCP Server（stdio）作为开发夹具。

**验收**：配置一个测试 MCP Server，其工具出现在注册表并可被调用；杀掉 MCP 进程后内置工具仍全部可用（S-5）。

### 里程碑 M6：ReAct 降级 + 记忆完善
23. `services/agent/react-channel.ts` + `react-parser.ts`（三级降级解析器，先写单测）。
24. `channel-router.service.ts`（能力探测 + 降级 + 回切）。
25. 上下文摘要压缩（`compaction.prompt.ts` + 压缩流程）。
26. 会话 CRUD 端点 + 前端会话历史改为服务端。

**验收**：用一个"不支持 tools 的 mock 模型"验证 ReAct 全链路；长会话触发压缩且不丢关键信息。

### 里程碑 M7：审批 + 收尾
27. 审批服务 + `approvals` 表 + `tool_approval_required` 事件 + `POST /api/v1/approvals/:id` 端点 + `ToolApprovalBar`（inline 确认条，不弹窗）。
28. 错误重试矩阵全量实现 + 上游错误归一化补齐。
29. SQLite 故障内存降级路径。
30. 性能优化（SSE 背压、token 估算缓存）。
31. 全量测试 + 门禁命令全过 + 端到端验证脚本（对齐 `docs/spec.md` §12 的格式）。

### M8：PRD 收敛新增项（与 M4~M7 并行）

28. **安全网关层**（`security-gateway.ts`）：统一策略执行点，含 SSRF/路径/计算三类协议级策略 + 提示注入检测 + 被拒目标任务内封禁。**必须先于第 15 步的工具实现**（否则每个工具各写一套，策略必然漂移）。
29. **跨浏览器恢复**：设备令牌 + 8 位恢复码 + 恢复端点 + 锁定策略（ADR-022）。
30. **本地埋点：本期不做**（Spec §3 / PRD §14.5 判定）。原计划的 `local_events` 表 + `POST/GET /api/v1/events` 两个端点**均不实现**，埋点沿用前端本地事件日志，数据不出浏览器。若后续有指标诉求，需先改 Spec §3 与 §6（新增表必须走变更流程）。
31. **供应商降级链**：provider 列表内自动切换 + `meta` 重发 + 能力表按 `(provider, model)` 重新判定。
32. **循环检测 + 每工具熔断器**：`loop-detector.ts` + `circuit-breaker.ts`（纯函数，便于单测）。
33. **三层压缩 + 机械自检**：`fidelity-checker.ts`（F-1~F-5）+ `artifacts` 落盘 + 锚点保活（ADR-020）。

### 依赖关系图

```
M1 ──► M2 ──► M3 ──┬──► M4 ──┐
                     │         ├──► M6 ──► M7
                     └──► M5 ──┘
```

**关键路径**：M1 → M2 → M3 是最小可演示路径（用户提问 → 一次工具调用 → 看到可视化结果）。M4/M5 可与 M3 后半段并行。M6 的 ReAct 降级可以延后到 M5 之后，但**必须在 M7 之前完成**（否则"模型不支持 tools"的用户完全无法使用）。

---

## 16. 跨文档一致性裁决（PRD / UIUX / 架构三方收敛）

> Phase 1 三份文档（PRD、UIUX、架构）由不同成员并行产出，存在口径分歧。本节是**唯一裁决源**，冲突时以本节为准。三方文档需按本节回改。

### 16.1 裁决总表

| # | 议题 | 分歧 | 裁决 | 依据 |
|---|------|------|------|------|
| **C-1** | **工具名点号命名空间** | PRD §5.1 与 UIUX §3.1 要求点号（`http.request`）；但**所有 OpenAI 兼容 provider 强制 `tools[].function.name` 匹配 `^[a-zA-Z0-9_-]{1,64}$`，点号非法 → 整个请求 HTTP 400** | **双轨制**：规范名（点号，用于内部/落库/展示/审计）+ 线上名（下划线，仅下发给 LLM）。消毒规则见 §6.1.1 | OpenAI 官方文档 + 两起生产事故；MCP 规范允许点号但 OpenAI 兼容层不允许，转换层必须消毒 |
| **C-2** | **SSE 事件命名风格** | 架构 §16.1 初稿曾写中划线，与 §8.1 事件表（10 事件全下划线）及 UIUX v1.2.0（下划线）自相矛盾 | **统一下划线（snake_case）**：与 §8.1 十事件集、UIUX v1.2.0、PRD v1.1 三文档一致 | 项目总监裁决 3：①§8.1 与 UIUX 双文档已一致用下划线，改动面最小；②与已锁定 DB 列名（`tool_calls`/`session_id`/`args_json`/`segments_json`）同源；③沿用 C-3 同一论证——改名收益为零、回归风险为正。此条不改则前后端监听器与事件名错配，工具可视化整体失效 |
| **C-11** | **降级标识字段名** | 架构初稿用 `mode`；设计侧 UIUX v1.1.0 改用 `channel` | **锁定 `channel`**，取值 `'native' \| 'react'` | `mode` 与前端暗/亮主题 `mode` 撞名；`function_calling` 是 PRD 能力表的列名语义（`supports_function_calling`），不是运行时通道名。设计侧 v1.1.0 已按 `channel` 实现，采纳以免返工 |
| **C-3** | **文本增量事件名** | 现有 CodeLens 用 `delta`；架构初稿提议改 `token`；UIUX §4.1 假设 `text-delta` | **保持 `delta` 不变** | 现有前端 `stream.ts` 已消费该事件，改名收益为零、回归风险为正 |
| **C-4** | **审批回执通道** | UIUX §10.3 假设 SSE 同流；PRD §6.4 要求服务端持有 + 签发令牌 | **独立端点 `POST /api/v1/approvals/:id`**，服务端持久化待执行调用并签发 token；客户端只回传决定 | 审批可能跨数分钟，SSE 长连接不适合承载用户思考时长；PRD 的服务端持有原则防「批准的与实际执行的不一致」漏洞 |
| **C-5** | **风险判定归属** | UIUX §3.8 主张服务端判定、前端不推断 | **服务端判定并随 `tool_call` 事件下发 `risk` 与 `approvalMode`** | 前端不能成为安全判定的第二来源 |
| **C-6** | **`Message.content` 粒度** | UIUX §10.3 要求 `content: Segment[]` 以支持文本与工具卡交替渲染 | **前端 `Message.content` 扩展为 `Segment[]`**；服务端 `messages.content` 保持纯文本（便于检索/摘要），新增 `messages.segments_json` 存分段结构 | 一条 assistant turn = 一条消息 = 内部文本段与工具卡交替（UIUX §4.1） |
| **C-7** | **工具状态与事件的关系** | UIUX 列出 `tool-rejected` / `tool-skipped` 两个独立事件 | **不单设事件**：`tool_result` 的 `status` 字段承载 7 值（`pending`/`running`/`success`/`failed`/`timeout`/`rejected`/`skipped`） | 前端只需处理 4 个工具事件，减少分支；状态语义与 PRD §6.1 六态 + UIUX §3.2.1 衍生态一一对应 |
| **C-8** | **风险等级体系** | 架构初稿用 `read`/`write`/`exec`/`destructive`；PRD/UIUX 用 `low`/`medium`/`high` + 独立的 `approvalMode` | **采用 PRD/UIUX 的两维模型**：`risk`（低/中/高，描述影响面）+ `approvalMode`（`none`/`soft`/`hard`/`two_step`，描述交互强度） | PRD §5.2 明确「风险与确认档位是两个独立维度」；UIUX §3.8 已按此展开 |
| **C-9** | **风险是工具属性还是操作属性** | PRD §5.1 / UIUX §3.8 明确是「工具 + 操作」二元判定 | **`ToolDefinition.risk`/`approvalMode` 是基线；运行期按参数判定实际值**并随事件下发 | 同一个 `fs.write`，新建是 medium，覆盖已有文件是 high |
| **C-10** | **工具命名的两处冲突是否成立** | 架构初稿曾用 `mcp__<serverId>__<tool>` 下划线前缀消解 | **MCP 工具规范名用 `mcp.<serverId>.<tool>`**（点号，与内置工具同构），线上名由 C-1 消毒规则统一生成 | 内置与 MCP 工具在同一坐标系里可读、可排序、可去重（PRD §5.1） |

### 16.2 需要 PM / 设计侧回改的点

**PM（PRD）**：
- §5.1 工具总表的工具名**保持点号不变**（作为规范名）；需补一句说明「下发给 LLM 时使用消毒后的下划线形式」，避免 Phase 2 实现时误用点号导致 400。
- §5.2 `ToolDefinition` 接口需补 `wireName`（线上名）与 `category` 字段；`risk`/`approvalMode` 两个字段保留为**基线**并注明运行期可升级。
- §7.1 表清单：本架构落 7 张表（PRD 8 张中的 `artifacts` 表本期不建，用 `tool_results.artifact_path` 指向文件落盘；`local_events` 表本期不做埋点——沿用 CodeLens 既有「前端本地事件日志」方案，PRD §14.4 的本地埋点可复用前端实现，不强制落服务端）。**`approvals` 与 `provider_capabilities` 两表必须建**。

**设计（UIUX）**：
- §3.2 状态机：卡片渲染的 `status` 取自 `tool_result` 事件的 `status` 字段（7 值），**不再需要 `tool-rejected` / `tool-skipped` 两个独立事件**（C-7）。
- §3.1 卡片标识符列：展示**规范名**（点号），与 `tool_calls.tool_name` 落库值一致（保持「所见 = 所存 = 可检索」）；设置页工具详情可额外展示线上名。
- §3.8 风险等级：改为 `low`/`medium`/`high` 三级 + `approvalMode` 四档，语义不变但字段名对齐。
- §10.3 第 1 条（`Message.content` → `Segment[]`）：**采纳**（C-6）。
- §10.3 第 3 条（审批回执）：**采纳独立端点**（C-4），但需在 §3.7 审批交互中说明「决定提交后，服务端在原 SSE 流上推送 `tool_result`」。
- §附 D 的 A1~A4 四问：**已全部裁决**，见 §16.1 的 C-4、C-6、C-5、C-2。

### 16.3 项目总监裁决采纳项（跨成员 advisory 处置）

> 本节记录 Phase 1 门禁中由三位成员提出、经项目总监裁决采纳的事项。Phase 2 开工前必须全部落实。

| # | 来源 | 采纳内容 | 落点 |
|---|------|---------|------|
| **D-1** | 架构师 | Phase 2 第一个里程碑必须包含「点号工具名端到端反查测试」：注册一个带点号的工具 → 断言下发给 provider 的名字是下划线形式 → 断言 LLM 返回该名字能反查回规范名。单测拦不住（单测里工具名只是字符串 key，从不经过 LLM） | §6.1.1、实施顺序 |
| **D-2** | 架构师 | 启动脚本与 package.json 的 start 命令加 `--disable-warning=ExperimentalWarning`——node:sqlite 在 Node 22 是实验特性（Stability 1.1），其告警会污染 SSE 控制台与用户排障 | 启动脚本 |
| **D-3** | 架构师 | CI 与 Dockerfile 的 Node 版本锁定为**精确版本 22.22.2**（不用 `^22.x`）；理由：node:sqlite 随 Node 小版本演进，锁精确版才有可复现性，跨大版本升级需跑 DB 冒烟测试 | CI / Dockerfile |
| **D-4** | 设计侧 | 图标统一使用 lucide **规范名**（`CircleCheck` / `CircleX` / `TriangleAlert`），不使用旧兼容别名；`client/src/components/layout/AppShell.tsx` 第 5 行与第 120 行共 2 处 `AlertTriangle` 在 Phase 3 改为 `TriangleAlert`（视觉零差异） | §12.3 |
| **D-5** | 产品经理 | **标识符四项纪律**：凡是要下发给外部系统的标识符（LLM 工具名 / SSE 事件名 / API 路径 / 错误码 / DB 列名），实现前必须锁定四项——**命名空间 + 允许字符集 + 长度上限 + 冲突消解规则**；四项未锁死不得开工 | Phase 2 开工纪律 |
| **D-6** | 产品经理 + 设计侧联合 | `skipped` 语义补两条：**仍可展开查看**（信息不丢）+ **不计入失败数**（保护护栏 G2「工具调用失败率 < 8%」——否则一次「从某步重跑」会凭空产生一次失败，污染指标） | PRD §6.1 |

**D-5 的由来（记录在案，防止复发）**：本次 C-1（点号工具名导致整请求 400）的成因正是漏了「允许字符集」这一项。工具名作为规范名点号本身是对的，但下发给 OpenAI 兼容 provider 时受 `^[a-zA-Z0-9_-]{1,64}$` 约束，未做字符集校验即引发 P0。四项纪律是对这类问题的通用防线。

---

## 17. 技术约束清单（给 Phase 2 的硬输入）

1. **图标**：一律 lucide-react SVG 组件（1.60.0 锁定），禁 emoji，禁第二套图标库。新增工具图标见 §12.3。
2. **视觉**：禁紫色→粉色渐变；沿用 `design-tokens.css` 的 Signal Blue 单一强调色；工具时间线不新增颜色体系，语义色只用既有 `--color-danger` / `--color-warning` / `--color-success`。
3. **运行时**：Node 22.22.2（精确版本，写入 `.nvmrc` 与 Docker 基础镜像）/ React 19.3.1 / Vite 8.3.4 / TS ~5.9 / Tailwind 4.3.3 / Express 5.3.0 / zod 4.6.7 / zustand 5.0.15。
4. **新增依赖（唯一）**：`@modelcontextprotocol/client` 2.3.1（v2 稳定线；v1 的 `@modelcontextprotocol/sdk` 1.32.1 仅在 v2 迁移有阻力时作为备选，v1 只维护到 v2 发布后 6 个月）。**SQLite 驱动不新增依赖**（用内置 `node:sqlite`）。
5. **分层**：依赖只向下；controller 不碰数据层；service 不 import `req`/`res`；Agent 编排层不感知 HTTP。
6. **文件**：单文件 ≤300 行；入口 <100 行；类型/schema 单独成文件。
7. **API**：一律 `/api/v1` 前缀；错误格式 `{ error: { code, message } }`；SSE 事件名与 `types/agent-events.ts` 双向对齐。
8. **版本管理**：CI 用 lockfile 安装，禁 `npm install <pkg>@latest` 随手升级。
9. **验证**：新增依赖与调用的 API 必须过"存在性核验"（对照 §18 的实测结果与官方文档），禁止凭印象写 API 签名。
10. **工具名双轨（不可省略）**：内部/落库/展示用点号规范名（`http.request`），下发给 LLM 用消毒后的下划线线上名（`http_request`）——点号会致整请求 HTTP 400（§6.1.1）。
11. **风险两维 + 运行期判定**：`risk`（low/medium/high）+ `approvalMode`（none/soft/hard/two_step），由服务端判定并随 `tool_call` 下发，**前端不推断**。
12. **降级标识字段名是 `channel`**（`'native' | 'react'`），不是 `mode`（与主题 mode 撞名）。
13. **内置工具锁定 9 个**（PRD §5.1）：`http.request` / `fs.read` / `fs.write` / `fs.list` / `calc.evaluate` / `time.now` / `uuid.generate` / `json.format` / `text.diff`。删除是 `fs.write` 的 `operation` 取值，不单设工具。
14. **安全网关是唯一策略执行点**（§10.0）：工具 handler 不重复实现安全检查；文件**先 realpath 后判定**，顺序不可颠倒。
15. **HTTP 仅 https**（`HTTP_ALLOW_INSECURE=true` 才放宽）；拒绝 URL 内嵌凭据。
16. **压缩保真必须过机械自检**（F-1~F-5，护栏 G5 100% 通过率）；缺项即回退并提示用户，**不静默截断**；锚点清单每次请求固定前缀重注入。
17. **确定性校验失败不消耗重试预算**（参数非法/工具不存在/安全拦截）；任务级重试总预算 5 次。
18. **恢复码单次使用 + 5 次/15 分钟锁定**，服务端只存 SHA-256 哈希，校验用恒定时间比较。
19. **埋点只写前端本地事件日志，服务端不落库、不做远程上报**（Spec §3：`local_events` 表不建，`POST/GET /api/v1/events` 不实现）；props 禁止含 args/result 原文、Key、用户目录路径。
20. **新增依赖仅两个**：`@modelcontextprotocol/client` 2.3.1（精确锁定，禁 `latest`）、`diff`（服务端复用客户端已有的 `diff@^9.0.0` 版本）。SQLite 驱动仍零新增依赖。

---

## 18. 联网核实结果（2026-10-21）

> 全部经 npm registry 当日核实或本机实测。版本号均为核实当日实际值。

### 18.1 npm registry 核实

| 包 | 最新版 | 本项目当前 | 结论 |
|----|--------|-----------|------|
| `@modelcontextprotocol/client` | **2.3.1**（2026-10-05 发布；v2.0.0 于 2026-07-27 发布，v2 为当前稳定线，实现 MCP spec 2026-07-28；`engines.node >= 20`） | 未引入 | **选用** |
| `@modelcontextprotocol/server` | 2.3.1 | — | 本期不需要（只做客户端） |
| `@modelcontextprotocol/sdk`（v1 旧线） | 1.32.1（`engines.node >= 18`） | 未引入 | 备选；官方说明 v1 在 v2 发布后至少 6 个月内继续收 bugfix 与安全更新 |
| `better-sqlite3` | 13.0.3（`engines.node >= 22`） | 未引入 | **不选**，理由见 §7.1 |
| `react` / `react-dom` | 19.3.1 | 19.3.1 | 已是最新，无需升级 |
| `zustand` | 5.0.15 | 5.0.15 | 已是最新 |
| `zod` | 4.6.7 | 4.6.7 | 已是最新 |
| `express` | 5.3.0 | 5.3.0 | 已是最新 |
| `lucide-react` | **1.61.0** | 1.60.0 | 有小版本更新。**本期不升级**（P0 锁定 1.60.0，避免连带回归）；Phase 2 可评估 |
| `vite` | 8.3.5 | 8.3.4 | 有补丁更新，**本期不升级**（lockfile 锁定） |
| `typescript` | 7.0.2 | ~5.9 | **不升级**（延续 OD-3：TS 7 的 typescript-eslint 生态未验证） |
| `tailwindcss` / `@tailwindcss/vite` | 4.3.3 | 4.3.3 | 已是最新 |

### 18.2 本机实测（Windows + Node 22.22.2，managed node）

| 实测项 | 结果 |
|--------|------|
| `node:sqlite` 可用性 | **可用**。`require('node:sqlite')` 导出 `DatabaseSync, StatementSync, constants, backup`；`DatabaseSync` 方法 `open/close/prepare/exec/function/location/aggregate/createSession/applyChangeset/enableLoadExtension/loadExtension`；`StatementSync` 方法 `iterate/all/get/run/columns/setAllowBareNamedParameters/setAllowUnknownNamedParameters/setReadBigInts/setReturnArrays` |
| `node:sqlite` 告警 | 打印 `ExperimentalWarning: SQLite is an experimental feature and might change at any time`（Node 22 上 Stability 1.1） |
| 告警抑制 | `--disable-warning=ExperimentalWarning` **实测生效**（Node 22.22.2 支持该 flag） |
| WAL / 事务 | `PRAGMA journal_mode=WAL` **生效**（查询返回 `wal`）；`BEGIN`/`COMMIT` 手写事务**正常**；`PRAGMA foreign_keys=ON` 可用 |
| `StatementSync.columns()` | **可用**，返回列元信息数组 |
| `node:sqlite` 备份 | `backup` 导出**存在**（函数） |
| `better-sqlite3` 安装 | `npm install better-sqlite3@13.0.3` **成功，但耗时 2 分 30 秒**（同机纯 JS 包 `ms` 对照组 10-25 秒，差值为大体积预编译产物下载） |
| `better-sqlite3` 是否触发编译 | **未触发**。13.0.3 的 `scripts` 中**无** `install`/`postinstall`；包内**自带** `prebuilds/win32-x64.node`（另有 darwin/linux/linuxmusl/arm64）；`require` 后 `new Database(':memory:')` 读写正常 |
| `better-sqlite3` API 差异 | 无 `db.transaction()` 辅助函数（`node:sqlite` 同样没有，需自行封装）；`node:sqlite` 缺 `transaction`/`pragma` 便利方法，其余 `prepare/run/get/all` 一致 |

### 18.3 MCP SDK v2 Client API（官方文档核实）

```ts
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'my-first-client', version: '1.0.0' });
const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/index.ts'] });
await client.connect(transport);                       // 派生进程 + initialize 握手
const { tools } = await client.listTools();            // [{ name, description, inputSchema }]
const result = await client.callTool({ name, arguments });
// result: { content: [{ type: 'text', text }], isError?: boolean }
await client.close();                                 // 关闭 transport 并终止子进程
```

官方明确的三条行为（已内嵌到 §6.6.4 设计）：
1. **"Never start the server yourself — `connect()` does."** —— `connect()` 负责 spawn 与握手，client 拥有该进程的生命周期。
2. **"A failed handler and rejected arguments come back as an ordinary result with `isError: true` set."** —— 工具执行失败**不是**异常，而是带 `isError: true` 的正常返回；只有"调用了未注册的工具名"才抛异常。这直接决定 §6.6.4 的错误归一化逻辑。
3. **"A model consumes `listTools()` output unchanged: `name`, `description`, `inputSchema`."** —— MCP 工具的 `inputSchema` 是纯 JSON Schema，可直接映射为 `ToolDefinition.inputSchema`。

### 18.4 各 Provider function calling 差异（官方文档核实）

来源：DeepSeek 官方 `api-docs.deepseek.com/zh-cn/guides/tool_calls/` 与推理模型页、阿里云 Model Studio `help.aliyun.com/zh/model-studio/qwen-function-calling`、Moonshot `platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls`。

- **DeepSeek**：`tools` / `tool_choice`（`auto`/`none`/`required`/指定函数）均支持；`parallel_tool_calls` **被忽略**（并行始终开启）；strict 模式需把 `base_url` 换成 `https://api.deepseek.com/beta`，且仅支持 `string/number/integer/boolean/object/array/enum/anyOf` 关键字（**不支持** `minLength`/`maxLength`/`pattern`/`format`/`minimum`/`maximum`/`multipleOf`/`patternProperties`/数组上下界）；**思考模式下必须在每轮 assistant 消息保留 `reasoning_content`，缺失返回 400**；`deepseek-reasoner`（旧推理模型）**不支持 Function Call 与 Json Output**；`deepseek-chat`/`deepseek-reasoner` 已定于 2026-07-24 弃用。
- **GLM（智谱）**：`tools` / `tool_choice` 支持；**必须显式传 `tool_stream: true`**，否则模型不返回 `tool_calls`（`glm-5.3` 起默认 `true`）；思考模式下 `tool_choice` 不支持 `required` 与指定函数。
- **Qwen（通义千问）**：`tools` 支持；`tool_choice` 支持 `auto`/`none`/指定函数，**不支持 `required`**（思考模式下尤其）；`parallel_tool_calls` 需显式 `true`；流式 `delta.tool_calls` 的 `id`/`name` 只在首片出现、`arguments` 多片分片，需按 `index` 拼接；`qwen-omni-realtime` 系列不支持 `tool_choice` 与 `parallel_tool_calls`。
- **Kimi（Moonshot）**：`tool_calls` 取代旧 `function_call`（旧字段不再支持）；`tool_choice` 支持 `auto`/`none`，`required` 仅 `kimi-k3` 支持；**思考模式（kimi-k2.5/2.6/2.7/k3）必须在每轮 assistant 消息保留 `reasoning_content`**；`finish_reason=tool_calls` 时 `content` **偶尔非空**（模型在解释调用原因），需容忍；流式 `delta.tool_calls` 按 `index` 拼接，`id`/`name` 只在首片出现。
- **OpenAI**：`tools` / `tool_choice` 全支持；strict 模式要求 `parallel_tool_calls: false`。

### 18.5 MCP SDK v2 包形态核实（纠正 PRD §16 D2 / §18 OD-06 的一处事实偏差）

**本机实测 `@modelcontextprotocol/client@2.3.1` 的 `package.json`（2026-10-21）**：

| 字段 | 实测值 |
|------|--------|
| `version` | 2.3.1（2026-10-05 发布） |
| `type` | `module` |
| `exports["."]` | **同时提供** `import`（`./dist/index.mjs`）与 `require`（`./dist/index.cjs`）双入口 |
| `exports["./stdio"]` | 同上，双入口 |
| `engines.node` | `>=20` |
| `dependencies` | `zod, jose, cross-spawn, eventsource, pkce-challenge, eventsource-parser, @modelcontextprotocol/core` |

**两处对 PRD 的纠正**：

1. **不是「ESM-only」**。PRD §16 D2 与 §18 OD-06 写「ESM-only」，实测包**同时提供 CJS 入口**（`exports` 含 `require` 条件）。本项目 `server/package.json` 已是 `"type": "module"`，用 `import` 即可；**但「ESM-only」这个描述不准确**，不应作为技术约束写进 Spec——否则将来有人基于它做错误推断（比如以为必须配 `tsx` 或 `.mjs` 扩展名）。
2. **协议 2026-07-28 已是正式版，不是 beta**。官方 versioning 页明确：「The current protocol version is 2026-07-28」，版本状态分 `Draft` / `Current` / `Final` 三级，2026-07-28 属 **Current**（可投入使用，可能继续做向后兼容变更）。v2 SDK 在 2026-07 期间确为 beta（对应 Release Candidate），但**现已发布稳定版**（npm `latest` 指向 2.3.1）。因此 PRD 的「协议 2026-07-28 处于 beta」是**发布时点的信息，已过期**。

**结论不变**：锁定 `@modelcontextprotocol/client` 2.3.1，禁跟随 `latest`。理由是 API 稳定性与可复现构建，而非「beta 风险」。

### 18.6 其它核实

- `node:sqlite` 稳定性分级：Node 22 为 Stability 1.1（active development，打印实验性告警）；Node 24 起为 1.2（release candidate，不打印告警）。本项目锁定 Node 22.22.2。
- 官方对 `node:sqlite` 的建议：保持数据访问层薄，"将来换 `better-sqlite3` 只需改一个文件"——本项目的 `repositories/db.ts` 即为该薄层。
- `node:sqlite` 为同步 API，会阻塞事件循环；官方建议长耗时分析查询放 `worker_thread`。本项目据此禁止分析型 SQL。

---

## 19. 引用知识库文件

本文档编写时引用了专家包内以下文件（路径相对 `mvp-dev-expert-team/references/`）：

| 文件 | 引用内容与落地位置 |
|------|------------------|
| `01-standards/spec-as-contract.md` | 自包含规格要求 → §1.3 成功标准、§1.4 明确不做、§6.4 新增工具的步骤清单、§16 版本锚定 |
| `01-standards/code-organization.md` | 分层依赖只向下、单文件 ≤300 行、入口只装配、类型单独成文件 → §3.2 依赖铁律、§12 目录结构、§12.4 门禁命令 |
| `01-standards/generated-code-failure-modes.md` | 幻觉依赖/接口核验、系统约束显式化、错误路径覆盖、缺失 import 静默失败 → §18 联网核实清单、§10 安全清单、§14 风险登记、§9 错误矩阵 |
| `01-standards/context-engineering.md` | 上下文是预算、压实保真（保留决策/改动清单/验证命令）、即时检索优于堆砌 → §7.4-7.5 上下文窗口管理与摘要压缩 |
| `01-standards/test-discipline.md` | 影响图定向、回归率一等指标、变异加固、测试作者与实现作者解耦 → §15 里程碑的验收点、§6.4 第 6 步"加测试"、§10 安全测试逐条断言 |
| `architecture/ai-agent-patterns.md` | 权限感知 Function Calling（LLM 看不到被禁工具，而非知道不能用）、流式 Function Calling 增量累积、递归调用深度上限、熔断降级、上下文分层 → §5.2 增量累积算法、§6.2 启禁用语义、§4.2 迭代上限、§9.3 熔断、§7.5 上下文管理 |
| `architecture/mvp-stack.md` | 技术选型矩阵基线（Express/React/SQLite/桌面端 Tauri+SQLite 路线）→ §7.1 选型对比 |
| `cost-models/development-costs.md` | 隐性成本（服务器/LLM 调用/域名 CDN）→ §14.2 R-12 成本风险、§13 性能目标（成本受迭代上限控制） |

**联网核实来源（2026-10-21）**：npm registry（各包 `dist-tags.latest` 与发布时间，通过 `npm view` 与 `registry.npmjs.org` 双通道）；Node.js 官方文档 `nodejs.org/api/sqlite.html`（稳定性分级）；`modelcontextprotocol/typescript-sdk` 官方 README 与 `ts.sdk.modelcontextprotocol.io/v2/get-started/first-client`（v2 Client API 逐条核实）；DeepSeek 官方 `api-docs.deepseek.com`；阿里云 Model Studio 官方文档；Moonshot Kimi 官方文档；`mako.ai` 与 `hirenodejs.com` 的 node:sqlite 实践指南（作为交叉验证，非权威来源）；本机实测（node:sqlite API 表面 / WAL / 事务 / 告警抑制 / better-sqlite3 安装耗时与预编译产物）。

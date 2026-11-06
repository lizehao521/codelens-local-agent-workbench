# Spec — CodeLens Agent 工具调用平台 v2.0

> 生成日期：2026-10-22
> 基于：PRD v1.1（docs/agent/phase1-prd.md）+ 架构文档（docs/agent/phase1-architecture.md）+ UIUX v1.2.0（docs/agent/phase1-uiux.md）
> 状态：已确认（用户 2026-10-22 指示从断点继续推进）
> 上游：改造已交付上线的 CodeLens v1.0（代码分析应用）→ 通用 Agent 工具调用平台
> 变更纪律：小改更新 §13 后继续；大改回 Phase 0 重走三文档

---

## 1. 产品定义

- **一句话描述**：通用 Agent 对话工作台——用户用自然语言提需求，Agent 自主决定调用哪些工具、传什么参数、循环多轮直到得出答案；工具调用全程可视化（名称/参数/状态/耗时/结果），会话与工具记录服务端持久化。
- **目标用户**：小林（自学转行者，要"看得见每步在干什么"）、阿豪（后端工程师，要调内网 HTTP + 读本地日志 + 高危先问过他）、老周（独立全栈，要接他已有的 MCP Server）
- **核心问题**：通用聊天窗摸不到用户的接口/文件/系统；Dify 自托管过重、n8n 学习曲线陡且按消息计费、Cline/Roo Code 绑 IDE 且每步弹窗导致批准疲劳。缺一个**本地可跑、零安装、工具调用透明可控、成本自付**的 Agent。

## 2. MVP 范围（锁定——不在此列表的一律不做）

| # | 功能 | 验收标准 | RICE |
|---|------|---------|------|
| 1 | BYOK 配置 + **模型 function calling 能力探测**（按 model 粒度缓存） | AC-01 | 30.0 |
| 2 | 计算与系统工具组 `calc.evaluate`/`time.now`/`uuid.generate`/`json.format`/`text.diff` | AC-02 | 18.0 |
| 3 | **工具调用可视化时间线**（十字段 + 7 态 + 折叠策略） | AC-03 | 15.0 |
| 4 | HTTP 请求工具（SSRF 防护 + 重定向逐跳校验 + 响应体上限） | AC-04 | 13.5 |
| 5 | SQLite 会话持久化 + 跨浏览器恢复（设备令牌 + 8 位恢复码） | AC-05 | 13.5 |
| 6 | 高危工具三档确认闸（软/硬/两步）+ 服务端签名令牌 + 审计 | AC-06 | 12.0 |
| 7 | 文件读写工具组（沙箱 jail：realpath 后判定 + 符链逃逸防护） | AC-07 | 9.6 |
| 8 | **Agent 调度循环**（注册表 + 双通道 + 最大轮次 + 循环检测） | AC-02 | 6.0 |
| 9 | 错误分类重试 + 每工具熔断 + 任务级重试预算 + 供应商降级链 | AC-08 | 7.2 |
| 10 | 上下文三层压缩 + 九段摘要 + 保真锚点 + 压缩后机械自检 | AC-09 | 6.4 |
| 11 | 干预矩阵（打断 / 单步重试 / 从某步重跑 / 改参数重试） | AC-10 | 9.6 |
| 12 | Token 成本与上下文占用显示（顶部占用条 + 任务结束成本） | AC-11 | 7.0 |

**P1（优先级低于 P0；架构、API、UI 均已设计完毕）**：任务预设模板、执行记录导出 Markdown、**MCP 连接器**（§5 六端点与 UIUX §4.4 已设计，Phase 3 在 P0 跑通后按设计实现；**未连接时对模型完全不可见**，AC-12）、可编辑计划面板、多工作区、artifacts 面板。

## 3. 明确不做（Out-of-Scope — 锁定）

| 不做 | 原因 | 何时考虑 |
|------|------|----------|
| **`process_exec`（任意命令执行）** | MVP 内无法可靠控制风险 | 有沙箱方案后 |
| 可视化编排画布 | 与"Agent 自主决策"定位冲突 | — |
| 代码执行沙箱 | 安全面成本；自建表达式求值器覆盖 80% | v2.0 |
| 浏览器自动化 | HTTP 工具 + 用户本机 MCP Playwright 已覆盖 | — |
| 多 Agent 协作 | 先把单 Agent 多轮多工具做扎实 | v2.0 |
| 账号体系 / 云同步 / 付费 | 沿用 v1.0 免登录边界 | 有跨设备诉求（OD） |
| MCP 官方技能市场 | 官方仅 7 个在维护，给用户不可信目录是负资产 | — |
| **远程 MCP（非 stdio）** | 任意远端 = 工具源，攻击面不可控 | — |
| `local_events` 埋点服务端落库 | PRD §14.5：埋点沿用前端本地事件日志，不强制落服务端 | 有指标诉求 |

## 4. 技术架构（锁定 — 含版本锚定）

| 层 | 技术 | 版本 | 锁定原因 |
|----|------|------|----------|
| 前端 | React + Vite SPA | 19.3.1 / 8.3.4 | 沿用 v1.0，无 SEO 需求 |
| 前端语言 | TypeScript | ~5.9 | TS 7.0.2 生态未验证 |
| 样式 | Tailwind CSS | 4.3.3 | @theme inline 映射既有 Token |
| 代码编辑 | CodeMirror 6 | @uiw/react-codemirror 4.25.12 | 保留 v1.0；Monaco 不支持移动端 |
| 状态 | zustand | 5.0.15 | 沿用 |
| 图标 | **lucide-react**（唯一库） | 1.60.0 | P0-1；**用规范名不用旧别名** |
| 后端 | Node + Express | **Node 22.22.2 精确锁定** / Express 5.3.0 | node:sqlite 随小版本演进，锁精确版才可复现 |
| 校验 | zod | 4.6.7 | 沿用 |
| 数据库 | **node:sqlite（Node 22 内置）** | — | 零安装零编译；better-sqlite3 实测安装 2m30s 且预编译与 Node 版本强绑定 |
| MCP | @modelcontextprotocol/client | 2.3.1（v2 稳定线） | stdio transport，按需启动 + 故障隔离 |
| 认证 | 免登录；BYOK（body.apiKey / env LLM_SERVER_API_KEY） | — | 沿用 v1.0 |

**目录结构原则**：沿用 v1.0 分层（routes→controllers→services→providers/middlewares/validators/utils），新增 `agent/`（循环编排）、`tools/`（注册表与工具族）、`mcp/`（连接器）、`db/`（数据层）。分层依赖只向下；单文件 ≤300 行；入口只装配零业务。

## 5. API 端点清单（锁定——开发唯一依据）

统一前缀 `/api/v1`（health 除外）；统一错误 `{ "error": { "code", "message" } }`；**共 23 个可调用端点**（下表 22 行，末行 connect/disconnect 计 2 个）。

| Method | Path | 功能 |
|--------|------|------|
| GET | `/api/health` | 健康检查（含 db/mcp 状态） |
| GET | `/api/v1/providers` | provider 与模型列表（含 capabilities 字段） |
| GET | `/api/v1/providers/capabilities` | 能力探测结果（不每轮试探） |
| GET | `/api/v1/providers/sync-status` | 上游模型同步状态与最近日志 |
| GET | `/api/v1/sessions` | 会话列表 |
| POST | `/api/v1/sessions` | 新建会话（返回 8 位恢复码，仅创建时明文一次） |
| POST | `/api/v1/sessions/recover` | 恢复码跨浏览器恢复（单次使用；连错 5 次锁 15 分钟） |
| POST | `/api/v1/sessions/:id/recovery-code` | 重生成恢复码（旧码立即失效；新码同样只明文返回一次） |
| GET | `/api/v1/sessions/:id` | 会话详情（含消息与工具调用） |
| PATCH | `/api/v1/sessions/:id` | 重命名 / 改模型 |
| DELETE | `/api/v1/sessions/:id` | 删除会话（级联） |
| **POST** | **`/api/v1/agent/stream`** | **Agent 主端点（SSE）** |
| POST | `/api/v1/approvals/:id` | 提交审批决定（**独立端点，不走 SSE 同流**）。`decision` **三值**：`allow_once` / `allow_session` / `reject`；zod `.strict()`，body 出现 `arguments` 一律 400 |
| POST | `/api/v1/approvals/:id/revise` | **AC-10 改参数重试**（唯一可带 `arguments` 的端点）：新参数**必须重跑 inputSchema 与安全网关**（不通过即失败回喂 LLM——否则改参数就是绕过沙箱的正规后门）；仅限 `status='pending'` 未开始执行的调用，单调用限改 3 次（`revise_depth`）；旧挑战置 `decision='revised'` + `status='revised'`、旧 tool_call 置 `skipped`、新参数另起一行保留审计 |
| POST | `/api/v1/agent/abort` | 主动中止（浏览器 abort 为主，此端点为备选） |
| GET | `/api/v1/tools` | 工具注册表列表（按风险分组） |
| PATCH | `/api/v1/tools/:name` | 启用 / 禁用工具 |
| GET | `/api/v1/mcp/servers` | MCP Server 配置列表 |
| POST | `/api/v1/mcp/servers` | 添加 MCP Server |
| PATCH | `/api/v1/mcp/servers/:id` | 改配置 / 启禁用 |
| DELETE | `/api/v1/mcp/servers/:id` | 删除 |
| POST | `/api/v1/mcp/servers/:id/connect` \| `/disconnect` | 手动连接 / 断开 |

**`AgentRequest`**：`{ sessionId?, provider, model, apiKey?, message, tools?, channelMode?: 'auto'|'native'|'react', maxIterations: 12, temperature: 0.3, maxTokens: 2048, resumeFromCallId?, overrideArguments? }`

> **AC-10 干预能力的两个通道字段（不新增端点）**：`resumeFromCallId` = 从该 `tool_call` 处重跑，其后调用全部置 `skipped`；`overrideArguments` = 重跑时用这组参数。**单步重试** = 只传 `resumeFromCallId`；**从某步重跑** = 两个都传。两者共用一套实现——干预的本质是「带着不同上下文再跑同一个循环」，单开端点会让执行引擎从一个变两个，预算/熔断/循环检测三套状态机要写两遍，是漂移高发区。

**`ToolDefinitionPublic`**（不含 handler）：`{ name(点号规范名), wireName(下划线线上名), displayName, category, description, inputSchema, risk(基线), approvalMode(基线), source:'builtin'|'mcp', enabled, timeoutMs }`

> **注**：架构 §11.1 另有 `POST/GET /api/v1/events`（埋点），按 §3 本期不实现，Phase 2 在端点表中标注。

## 6. 数据库表清单（锁定 — 9 张）

| 表 | 核心字段 | 说明 |
|----|----------|------|
| `sessions` | id, title, created_at, updated_at, device_token_hash, recovery_code_hash, provider, model, summary | 会话主记录 + 恢复码（只存哈希） |
| `messages` | id, session_id, seq, role, content, tokens, is_summary, segments_json, created_at | `segments_json` 存文本段/工具卡交替结构（C-6） |
| `tool_calls` | id, session_id, message_id, tool_name(规范名), args_json, status, risk, approval_mode, started_at, ended_at, duration_ms, error_kind, error_msg, result_ref, iteration | 审计一等公民 |
| `tool_results` | id, tool_call_id, inline_preview, artifact_path, bytes, truncated, sha256 | 大结果落盘只留指针（`artifacts` 表不建） |
| `approvals` | id, tool_call_id, challenge_token_hash, decision, reason, decided_at, expires_at | **必建**：审批审计不可篡改（AC-06） |
| `provider_capabilities` | provider, model, supports_function_calling, probed_at, notes | **必建**：避免每轮试探（AC-01） |
| `provider_models` | provider, model, provider_name, base_url, default_model, docs_url, model_name, capabilities_json, synced_at | 上游模型同步的最近成功快照（重启兜底） |
| `model_sync_log` | id, occurred_at, status, attempt, message, detail, source_url | 每次同步尝试的状态/异常记录 |
| `schema_migrations` | version, applied_at | 迁移版本 |

**不建**：`artifacts`（用 `tool_results.artifact_path`）、`local_events`（埋点走前端本地日志）。

> **⚠ 待 Phase 2 架构师修正**：架构文档 §7.2 当前建表为 `sessions/messages/tool_calls/artifacts/local_events/schema_migrations`，**缺 `approvals`/`provider_capabilities`/`tool_results`，且含已判不建的 `artifacts`/`local_events`**。以本表为准重写 §7.2。

## 7. 页面清单（锁定）

| 页面 | 路由 | 核心组件 | 对应 API |
|------|------|----------|----------|
| 主工作台 | `/` | 左会话列表 / 中 Agent 对话流（含工具时间线 + inline 审批条）/ 右运行检视器 Inspector | agent/stream, approvals/:id, sessions |
| 设置 | 模态 | Provider+Key+模型 / **工具管理**（按风险分组、启停）/ **MCP 连接器**（stdio 命令、连接状态、工具清单）/ 安全边界（HTTP 白名单、文件系统根）/ 数据管理（导入导出、清除） | tools, mcp/servers, providers |
| 移动端 | `/` | 对话 / 工具 / 会话 三 TabBar | 同上 |

响应式：≥1024 三栏；768-1024 两栏 + 双抽屉；<768 单栏 + TabBar。**沿用 v1.0 三栏骨架与「深色 IDE 工作台」设计语言（中栏与右栏内容换血）**。

## 8. 设计 Token（锁定）

沿用 v1.0 已锁定的 `client/src/styles/design-tokens.css` 为**唯一来源，禁止修改**，**零新增颜色 Token**：
- 主色 `accent`（Signal Blue 深色 #197FE6 / 浅色 #0B5CCB）、成功 `success`（#3FB950 / #16A34A）、中性底 `bg-primary`/`bg-secondary`
- 字体 Inter + Noto Sans SC + JetBrains Mono（代码）
- **图标 lucide-react 1.60.0，规范名**（`CircleCheck`/`CircleX`/`TriangleAlert`），16/20/24px，stroke-width 2
- 深色优先 + 浅色可选 + 跟随系统；动效 150/250ms；禁弹跳缓动

## 9. 验收标准（锁定 — QA 唯一依据）

| 编号 | EARS 格式验收标准 | 优先级 |
|------|-------------------|--------|
| AC-01 | While 用户配置有效 Key 并测试连通性，系统**必须**返回该模型是否支持原生 function calling 并写入 `provider_capabilities`；If 探测为不支持，Agent **必须**走 ReAct 通道并在卡片标注「提示词解析模式」 | P0 |
| AC-02 | While 用户提交「读 CSV → 算均值 → 写成 md」，Agent **必须**在**不追加用户指令**下自主发起 ≥3 次工具调用；If 达到 12 轮上限，系统**必须**中止并输出未完成项，不静默截断 | P0 |
| AC-03 | While 一次任务产生 5 次工具调用，系统**必须**在卡片上展示类别图标、规范名、状态、耗时、参数摘要、结果摘要；成功默认折叠、失败默认展开；`skipped` 可展开查看且**不计入失败数** | P0 |
| AC-04 | If Agent 请求非 GET 外部 HTTP 或覆盖已有文件，系统**必须**暂停并弹 inline 确认条（不弹窗）；If 客户端提交的待执行内容与服务端令牌不匹配，服务端**必须**拒绝执行并返回 409 + 异常审计 | P0 |
| AC-05 | While 含 6 次工具调用的会话，When 关闭浏览器并在另一浏览器输入恢复码，系统**必须**完整恢复消息与工具记录；If 恢复码已使用，系统**必须**拒绝 | P0 |
| AC-06 | While 命中高危工具，系统**必须**由服务端保存待执行调用并签发 5 分钟令牌，客户端只回传「id + token + 决定」 | P0 |
| AC-07 | If 工具参数路径越界或请求内网地址，系统**必须**硬拦截并回喂「被安全策略拒绝」，同一目标本任务内不再重试 | P0 |
| AC-08 | If 某工具连续失败 3 次，系统**必须**在第 4 次直接返回熔断提示而不触发 LLM 调用；If 模型幻觉出不存在工具名，系统**必须**立即回喂可用工具列表且不消耗重试预算 | P0 |
| AC-09 | While 上下文占用 >75%，系统**必须**触发三层压缩并产出含九段结构的摘要，且保真清单机械自检通过；If 自检缺项，系统**必须**回退并提示「上下文已满」，不静默截断 | P0 |
| AC-10 | While Agent 运行中，用户**必须**可随时打断、单步重试、从某步重跑、改参数重试，且不丢已完成步骤 | P0 |
| AC-11 | 系统**必须**在顶部常驻上下文占用条（>75% 琥珀、>88% 警示）并在任务结束展示 Token 成本 | P0 |
| AC-12 | 若 MCP Server 未连接，其工具**必须**不进入下发给模型的工具清单（模型完全不可见），且不影响内置工具 | P1 |
| AC-13 | 工具名双轨制：注册带点号工具 → 下发给 provider 的名字**必须**是下划线形式 → LLM 返回该名字**必须**能反查回规范名；反查失败返回 `TOOL_NOT_FOUND` 且不执行 | P0 |

## 10. 边界与约束

- 不支持 IE；Chrome/Safari/Firefox/Edge 最新两版；≥360px 响应式
- 单任务默认最多 12 轮 LLM 调用（可配 5-30）；任务级重试预算 5 次；单工具超时（HTTP 10s / MCP 可配）
- 性能：首 token <3s；工具事件到达即渲染（delta 复用 50ms 节流）；SSE 15s 心跳
- 安全：SSRF 五重校验（禁内网/环回/链路本地/云元数据 + DNS 解析后逐一校验 + 重定向逐跳校验）；文件 realpath 先解析后比较；审批服务端持有；密钥不落日志
- 无障碍：状态「图标 + 文字」双通道，不靠颜色单独传达；触屏目标 ≥44px
- **标识符四项纪律**：凡下发给外部系统的标识符（工具名/事件名/API 路径/错误码/DB 列名），实现前必须锁定命名空间 + 允许字符集 + 长度上限 + 冲突消解规则

## 11. 内嵌已知坑（防重蹈覆辙）

| 坑 | 指纹 | 根因 | 修法 |
|----|------|------|------|
| **点号工具名整请求 400** | openai-compatible / function calling | provider 强制 `^[a-zA-Z0-9_-]{1,64}$`，点号非法 | 双轨制：点号规范名 + 下划线线上名，共用 `utils/tool-name.ts` 消毒/反查；Phase 2 首里程碑端到端测试 |
| **现有 adapter 把 tool_calls 降级成纯文本** | express / openai adapter | `parseUpstreamSSE` 把 arguments 片段拼成 delta 文本，丢 `id`/`name`/`index` | **必须重写**为累积式 tool_call delta 归一化 |
| **SSE 事件名错配** | sse / 前后端契约 | 文档曾出现 kebab 与下划线两套 | 统一**下划线**（见 §12 事件表） |
| 静态托管 404（v1.0 已修） | express-5 / import.meta.url | 相对路径按编译后模块位置解析 | 向上查找 package.json 定位包根 |
| E2E 进程泄漏（v1.0 已修） | bash-on-windows | `&` 背景化整条 `cd&&node` 链，`$!` 抓到子 shell；Windows SO_REUSEADDR 让旧进程冒充新服务 | `( cd dir && exec env PORT=$PORT node app.js ) & PID=$!` + 端口预检 + taskkill |
| Vite emptyDir 触发安全删除拦截 | vite / 沙箱 | 批量 rmSync >50 文件被拦 | 构建前 bash 清 dist 或对 dist 目录走 approve 通道 |
| node:sqlite 实验性告警 | node-22 | Stability 1.1 | start 命令加 `--disable-warning=ExperimentalWarning` |
| **审批写入的静默 no-op** | node:sqlite / UPDATE | 「`UPDATE approvals SET decision=? WHERE id=? AND decision IS NULL`」在已决定时**不报错**，`changes=0`；SQL CHECK 触发器只能拦「非法值」、无 FROM 前置，**拦不住对不存在行的写入**。前端会收到 200 但审批实际未生效 | 应用层**必须断言 `changes === 1`**，否则抛 409 并写异常审计（架构师实测发现的真实缺口） |

## 12. 端到端验证步骤（最低可跑通门槛）

```bash
# 1. 构建
cd server && npm run build && cd ../client && npm run build
node scripts/prepare-dist.mjs

# 2. 启动（单端口）
cd server && PORT=8080 node --disable-warning=ExperimentalWarning dist/app.js
# 等待 "codelens-server listening on :8080"

# 3. 健康检查（含 db/mcp）
curl -s http://localhost:8080/api/health
# 断言：status=ok，db.ok=true

# 4. 工具注册表
curl -s http://localhost:8080/api/v1/tools
# 断言：含 http.request / fs.read / calc.evaluate；每项带 wireName（下划线）与 risk

# 5. 会话创建 + 恢复码
curl -s -X POST http://localhost:8080/api/v1/sessions -H 'Content-Type: application/json' -d '{"provider":"deepseek","model":"deepseek-v4-pro"}'
# 断言：返回 session + recoveryCode（8 位）

# 6. Agent 无 Key 错误流
curl -s -N -X POST http://localhost:8080/api/v1/agent/stream -H 'Content-Type: application/json' \
  -d '{"provider":"deepseek","model":"deepseek-v4-pro","message":"读文件"}'
# 断言：SSE 含 event: error + MISSING_API_KEY

# 7. 纯计算工具（无需 Key 外发，可本地验证 Agent 循环最小闭环）
curl -s -N -X POST http://localhost:8080/api/v1/agent/stream -H 'Content-Type: application/json' \
  -d '{"provider":"deepseek","model":"deepseek-v4-pro","apiKey":"'"$KEY"'","message":"用计算工具算 (1234.5*87)/13"}'
# 断言：SSE 序列含 tool_call(name=calc.evaluate) → tool_result(status=success) → delta → done

# 8. 前端
curl -s http://localhost:8080/ | head -c 80
# 断言：返回 index.html
```

## 13. 变更记录

| 日期 | 变更 | 原因 | 影响 |
|------|------|------|------|
| 2026-10-22 | v2.0 初始生成 | 基于已确认三文档 | 全量 |
| 2026-10-22 | DB 表锁定为 7 张（含 approvals/provider_capabilities/tool_results，去 artifacts/local_events） | 架构 §7.2 缺审批与能力表会违反 AC-04/AC-01 | §6 + Phase 2 重写 §7.2 |
| 2026-10-22 | 埋点端点 `/api/v1/events` 本期不实现 | PRD §14.5 沿用前端本地日志 | §3、§5 |
| 2026-10-22 | AC-10「改参数重试」最终定为**独立端点** `POST /api/v1/approvals/:id/revise`（端点数 21→22） | 中途曾采用同一端点的 `decision='revise'` 方案，**现已完全移除**——两通道不并存，避免契约漂移 | §5、AC-10 |
| 2026-10-22 | `AgentRequest` 增 `resumeFromCallId` / `overrideArguments` 两字段 | AC-10 的「单步重试」「从某步重跑」此前无任何入口（`skipped` 状态已设计但无法触发）；不新增端点以免执行引擎一分为二 | §5、AC-10 |
| 2026-10-22 | P1 条目补充「架构/API/UI 已设计完毕」说明 | 避免与 §5 六端点、AC-12 表面冲突（MCP 仍为 P1 优先级，非不做） | §2 |
| 2026-10-22 | `provider_capabilities` 由 5 列扩为 12 列 | AC-01 要求探测结果持久化，5 列装不下 6 个能力字段 | §6 |

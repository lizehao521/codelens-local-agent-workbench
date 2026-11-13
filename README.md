# CodeLens — 本地 Agent 工作台

自带工具与审批闸的**个人**本地 Agent 工作台（单用户 / 可自托管，非团队产品）：用一句话交代任务，Agent 自主选工具、逐步执行，每一步（工具、参数、结果）都可见，高风险动作按等级先请示你。支持网页端（自部署）与桌面端（Electron）；密钥用你自己的（BYOK）、只留在本机，免注册。**推理成本由你自己的 API Key 承担**——这是特点（无订阅溢价），也是约束（不配 Key 不能用，试用仅用于演示）。

> 本仓库是 v2.0 Agent 工作台实现，定位为**个人工具**：先当个人 / 小范围自用工具打磨，不铺商业化路线，**不提供团队版 / 企业版（暂不承诺）**。**`docs/agent/spec.md` 是唯一现行规格真相源**；`docs/spec.md` 描述的是已退役的 v1.0，仅作历史参考。架构见 `docs/agent/phase2-architecture-detail.md`，决策见 `docs/decisions/`（ADR-001~010）与 `agent-decisions/`（ADR-011~025）。

## 现行真相源（Source of Truth）

> 为避免两代文档并存造成的叙事分裂，在此显式指路：
> - **现行规格（v2.0）**：`docs/agent/spec.md` —— 产品定位与能力契约的唯一真相源。
> - **当前运行态说明书**：`docs/agent/CODELENS-MANUAL.md` —— 工具清单、沙箱、技能库、RSI、门禁与已知边界（v2.11.0 实测）。
> - **已退役文档（v1.0，仅作历史参考）**：`docs/spec.md`、`docs/phase1-prd.md`、`docs/phase1-uiux.md`、`docs/openapi.yaml` 已被 `docs/agent/*` 取代，**请勿以其过时定位（例如 v1.0「代码分析四能力」）当作现行定位**。

## 功能

- **Agent 工作台**：自然语言任务 → 显式状态机（原生 function calling / ReAct 双通道）→ 工具调用 → 观测反馈 → 最终答案；每轮工具与推理可见
- **工具调用 + 三档审批**：内置工具（`fs.read` / `fs.list` / `fs.write`、`code.check`（语法）/ `type.check`（项目根 `tsc --noEmit`）/ `test.run`（项目根跑单文件测试）、计算、时间、UUID、JSON、文本 diff、HTTP 请求）与 MCP 连接器；高危工具走审批（none / soft / hard / two_step），审批令牌 HMAC 签名，支持改参重批与单步重跑
- **上下文与预算**：上下文占用条、75% 自动压缩；单任务四道预算（迭代数、工具调用总数、累计 token、墙钟）同时生效，到顶先写 RunState 终态再停，汇报卡区分「已完成 / 预算耗尽 · 未完成」
- **会话持久化**：服务端 SQLite（node:sqlite），刷新/重开不丢失；恢复码支持换机找回
- **BYOK**：DeepSeek / 智谱 GLM / Moonshot / 通义千问 / OpenAI / 自定义 OpenAI 兼容端点；Key 仅存本浏览器，服务端只代理转发、不落库、不记日志
- **免 Key 试用（可选）**：配置兜底 Key 后可开启试用模式，按 IP 每日限次 + 三级 token 预算闸，防成本失控。试用态固定使用服务端配置的上游与模型（`TRIAL_PROVIDER` / `TRIAL_MODEL` / `TRIAL_BASE_URL`），**切换上游请自带 Key**；上游不可用时界面会给出中文原因与一键配置入口，不会白屏。
- **双端形态**：网页端（Express 托管构建产物）+ 桌面端（Electron，Windows 安装包）
- **深色 IDE 工作台**：深色优先 + 浅色可选 + 跟随系统；桌面三栏 / 平板两栏 + 抽屉 / 手机底部 TabBar

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19.3.1 + Vite 8.3.4 + TypeScript 5.9 + Tailwind CSS 4.3.3 + zustand + lucide-react |
| 后端 | Node 22+ + Express 5.3.0 + TypeScript + zod 4.6.7 + node:sqlite |
| 桌面端 | Electron 45 + electron-builder（Windows NSIS 安装包） |
| 存储 | 服务端 SQLite（node:sqlite，路径见 `AGENT_DB_PATH`）；前端不持久化任何密钥 |
| 部署 | 单容器（Express 托管 Vite 构建产物）；桌面端内嵌同一服务端 |

架构决策记录见 `docs/decisions/`，规格契约见 `docs/agent/spec.md`，API 契约见 `docs/agent/openapi.yaml`（v2.0）。

## 快速开始

> 生产主路径：**Docker 单容器**。桌面端（Windows 安装包）为可选产物，用于不便跑 Docker 的场景。

### 开发模式（前后端分离跑）

```bash
# 终端 1：服务端（:8080）
cd server && npm install && npm run dev

# 终端 2：前端（:5173，/api 代理到 8080）
cd client && npm install && npm run dev
```

打开 http://localhost:5173 → 点右上角设置 → 选 provider、填自己的 API Key → 保存 → 回到工作台描述任务即可。

### 生产模式（单端口）

```bash
cd client && npm install && npm run build
cd ../server && npm install && npm run build
rm -rf server/dist-client && cp -r client/dist server/dist-client   # 在仓库根目录执行
cd server && npm start        # http://localhost:8080
```

### Docker

```bash
docker build -t codelens:latest .
docker run -p 8080:8080 codelens:latest
```

### 桌面端（Windows）

```bash
node scripts/build-desktop.mjs      # 在线构建（需能访问 electron 下载源）
node scripts/build-desktop-offline.mjs  # 离线构建（使用本地 electron 镜像）
```

产物输出见 `desktop/electron-builder.yml` 的 `directories.output`（默认 `C:/codelens-build/release`）。

## 环境变量（server/.env，均可空）

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8080` | 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址；默认仅本机（服务带高危工具与恢复码端点）。局域网/容器访问需显式设 `0.0.0.0` |
| `NODE_ENV` | `development` | 环境（development/production/test） |
| `ALLOWED_ORIGINS` | 空 | CORS 白名单（逗号分隔）；空 = 仅同源 |
| `LLM_SERVER_API_KEY` | 空 | 服务端兜底 Key（试用/演示模式：所有匿名用户共享，受试用量与预算闸限制） |
| `TRUST_PROXY` | 空 | `true` 时信任代理头取 IP（Nginx 反代场景） |
| `CLIENT_DIST_DIR` | 空 | 静态前端目录；空 = `<server>/dist-client` |
| `AGENT_DB_PATH` | 空 | SQLite 会话库路径；空 = `<server>/data/codelens.db` |
| `SANDBOX_ROOT` | 空 | 文件沙箱根目录；空 = `<server>/workspace` |
| `AGENT_APPROVAL_SECRET` | 空 | 高危工具审批令牌 HMAC 密钥；留空则启动时生成随机值并持久化到数据目录（桌面端已内置） |
| `AGENT_MAX_CONCURRENT` | `3` | 单实例并行 Agent 任务上限（1-16） |
| `AGENT_MAX_TOOL_CALLS` | `40` | 单任务工具调用总次数预算（12 轮 × 平均 3 次 + 余量）；到顶走收尾路径 |
| `AGENT_TASK_BUDGET_MS` | `180000` | 单任务墙钟预算（ms）；正常任务 60–150s，留一次重试余量 |
| `AGENT_TOKEN_BUDGET_FACTOR` | `2` | 单任务 token 预算 = 上下文窗口 × 该系数；0 = 不设上限 |
| `AGENT_CONVERGENCE_ROUNDS` | `3` | 连续 N 轮无文件改动 / 无新证据 / 无工具结果变化即判收敛；0 = 关闭 |
| `MCP_CONFIG_PATH` | 空 | MCP servers JSON 覆盖路径 |
| `API_RATE_LIMIT_PER_MIN` | `300` | /api 全局限速：每 IP 每分钟请求数；0 = 不限 |
| `RECOVERY_RATE_LIMIT_PER_MIN` | `10` | 恢复码端点限速：每 IP 每分钟；0 = 不限 |
| `MODEL_SOURCE_URL` | 空 | 上游模型源 URL；空 = 禁用自动拉取 |
| `MODEL_REFRESH_INTERVAL_MS` | `3600000` | 模型源周期刷新间隔（ms） |
| `MODEL_SYNC_RETRY_MAX_ATTEMPTS` | `3` | 模型同步重试次数上限（0-10） |
| `MODEL_SYNC_RETRY_BACKOFF_MS` | `1000` | 模型同步重试退避（ms） |
| `MODEL_SOURCE_ALLOW_INSECURE` | 空 | `true` 允许 http 上游（仅模型同步） |
| `MODEL_SOURCE_ALLOW_PRIVATE` | 空 | `true` 允许私有/回环网段上游（仅模型同步） |
| `MODEL_SOURCE_FORMAT` | `native` | 上游响应格式：native/openai |
| `HTTP_TOOL_ALLOWLIST` | 空 | HTTP 工具域名白名单（逗号分隔）；空 = 不限 |
| `EXEC_TOOL_ALLOWLIST` | `git,node` | `sys.exec` 命令白名单（逗号分隔，小写）；空 = 全部走两步确认，不是「不限」 |
| `EXEC_TOOL_TIMEOUT_MS` | `60000` | `sys.exec` 单次调用默认超时（ms）；0 = 取默认值（不给无界） |
| `EXEC_TOOL_MAX_TIMEOUT_MS` | `300000` | `sys.exec` 允许请求的最大超时（ms，硬上限）；0 = 取默认值 |
| `POLICY_INJECT_MAX_LESSONS` | `8` | 每轮最多注入几条 π 经验；0 = 不限 |
| `POLICY_INJECT_MAX_CHARS` | `480` | 每轮注入经验文本的字符上限（含序号前缀）；0 = 不限 |
| `HTTP_ALLOW_INSECURE` | 空 | `true` 允许 HTTP 工具访问 http（非 https）目标 |
| `TRIAL_MODE_ENABLED` | 空 | `true` 开启兜底 Key 试用模式（无 BYOK Key 可走兜底 Key，受试用量+预算闸限制） |
| `TRIAL_DAILY_LIMIT` | `5` | 每 IP 每日试用次数（试用模式下生效）；0 = 不限 |
| `FALLBACK_GLOBAL_DAILY_TOKEN_LIMIT` | `0` | 兜底 Key 全局日 token 预算（所有匿名用户合计）；0 = 不限 |
| `FALLBACK_PER_IP_DAILY_TOKEN_LIMIT` | `0` | 兜底 Key 每 IP 日 token 预算；0 = 不限 |
| `FALLBACK_PER_TASK_TOKEN_LIMIT` | `0` | 兜底 Key 单任务 token 预算；0 = 沿用上下文软闸 |

> **生产部署必须显式配置 `AGENT_APPROVAL_SECRET`。**
> 留空时服务端会在首次启动生成随机密钥并持久化到数据目录的 `approval-secret.key`（权限 0600）；桌面端已在 `%APPDATA%` 内完成同样动作。若该密钥丢失或轮换，重启前签发的审批令牌会全部验签失败（用户看到「待确认」卡片卡死）。要求：随机 ≥32 字节；不得与 `LLM_SERVER_API_KEY` 复用同一值；轮换应在无挂起审批时执行。

## 测试

```bash
cd server && npm test        # vitest：校验/限流/adapter/提示词/Agent 循环/审批/安全
cd client && npm test        # vitest：存储/结果解析/Agent 请求/工作台挂载
bash scripts/e2e.sh          # 端到端：构建+启动+curl 断言
bash scripts/agent-e2e.sh    # Agent 闭环端到端（可选真实 Key）
```

## 安全模型（BYOK）

1. Key 只存用户浏览器 localStorage，界面明示「不会上传到我们的服务器」（请求时经 HTTPS 传给服务端代理，服务端不落库、不记日志、不进错误响应）。**注意**：与 Key 不同，对话历史由服务端 SQLite 持久化，清除浏览器缓存不会删除历史。
2. 服务端按 IP 限流（默认 300 次/分）、请求体 ≤256KB、上游超时 60s；高危工具走审批闸，工具执行受沙箱（path-jail）与 SSRF 白名单约束。
3. 全链路 HTTPS；严格 CSP；LLM 输出按不可信内容渲染（禁原始 HTML）。
4. 一键清除 Key；清除浏览器缓存仅移除本地 Key 副本，不影响服务端对话历史（删除历史需服务端能力，当前未提供）。

## 定位与路线

### 一句话定位

**CodeLens 是一个跑在你自己机器上的通用 Agent 工作台**：你用一句话交代任务，它在本地自主调用工具、每一步都看得见、按风险分级向你请示；你用自己的 Key（BYOK），密钥不出本机，上游随手换。一个本地优先、看得见、管得住的 AI 执行台——不是摸不到你文件/接口的聊天框，也不是每步逼你点「允许」的 IDE 插件。

### 对外叙事（用户感知优先）

对外部用户，叙事主线先讲「**省心可控 + 后台越用越懂你**」的感知，而非内核机制：

- 任务一句话交代、每步可见、高危操作先问过你、密钥不出本机、随手换上游——你为「省心可控」买单。
- 强化内核 `Improve(π)` 是本产品的**内部引擎**，在后台持续增量、让你「越用越懂你」（感知）；但它**不对「自我改进闭环」这一完整体对外承诺**，不是对外卖点（见 `产品宪法补丁.md §5`）。其实现为**最小可回滚环**——版本化策略 π（`server/src/repositories/policy.repository.ts` + `server/src/services/agent/update.service.ts`）：判决 r → π 增量 → 下一轮 Act 的 system prompt 注入（消费者见 `system-prompt.ts` 的 `buildSystemPrompt`），每次修改 append-only 可回滚、可审计；仍按草案持续增量，非全自动自改。

### 部署形态（主次）

- **网页端（自部署 / Docker 单容器）为主形态**：零安装、开浏览器即用，是当前主部署路径（见「快速开始」）。
- **桌面端（Electron）是隐私诉求用户的主入口**（最硬的本地 / 隐私形态）：密钥与数据不出本机最无争议。网页端是零安装大众主路径，两者是受众分流，不是主次优劣。

### 自托管说明（单用户 / 非多租户 / 无团队版）

- 当前表述为「**本地单用户 / 可自托管部署（非多租户）**」：不提供官方托管实例。
- 安全模型是免登录 + 设备令牌 + 本地 SQLite + 恢复码（**单用户本地**）；当前没有官方多用户 / 团队协作实例，「自托管」指你在自有机器或服务器上跑单用户实例，而非多租户云服务。[^od-a8]
- **团队版 / 企业版暂不承诺**：没有账号体系、成员管理、共享会话或审计后台，也不在路线图里作承诺。
- **成本归属**：服务端只转发请求，推理费用由你配置的上游 Key 结算；项目不提供包月额度或团队计费模型。

### 四类能力（分析 / 解释 / 调试 / 优化）

- v1.0「代码分析四能力」作为**独立产品定位**已退役；其四类任务模板作为内置提示词**保留并可用**（前端已接线）。

### 与竞品的真差异

- 相对 **OpenCode**（本地 / 开源 / BYOK / 终端驱动，与 CodeLens 在「本地 + 开源 + BYOK」轴上几乎同轴）：CodeLens 的真差异在于**网页 GUI + 过程可视化 + 跨浏览器恢复码 + GUI 审批闸**，而非「本地 BYOK」本身（见 `docs/product-positioning.md` §2.2）。
- 相对通用聊天窗 / Cursor / Cline / Roo / Claude Code 等：差异见「功能」与 `docs/agent/spec.md`。

> 版本与交付物校验以 `RELEASE-MANIFEST.json`（由构建脚本生成）为准，文档不手写安装包数值。

[^od-a8]: 依据 `agent-decisions/OPEN-DECISIONS.md OD-A8`：免登录 + 服务端持久化在对外多用户场景下不可用，故当前仅支持单用户本地 / 自托管部署，无官方多用户实例。

## 目录结构

```
├── client/          # 前端 SPA（Vite + React + TS + Tailwind 4）
├── server/          # Node 服务端（Express 5 + TS）
├── desktop/         # Electron 桌面壳 + 构建脚本
├── docs/            # spec / openapi / PRD / 架构 / UIUX / ADR / 决策日志
├── scripts/         # e2e、桌面构建、env 文档断言等
└── Dockerfile       # 多阶段构建
```

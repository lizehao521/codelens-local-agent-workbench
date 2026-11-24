# CodeLens — 本地 Agent 工作台

个人本地 Agent 工作台；单用户 / 可自托管、非多租户；BYOK（自己的 API Key，存浏览器 localStorage、服务端不落库不记日志）；不承诺团队版 / 企业版；推理成本由用户自己的 Key 承担。现行规格唯一真相源 `docs/agent/spec.md`。

## 产品定位与 BYOK

三档审批（soft/hard/two_step）、原生 function calling / ReAct 双通道、工具可见、深色 IDE 工作台、网页端（Express）+ 桌面端（Electron）。密钥安全边界 4 条：仅存浏览器 localStorage、服务端不落库、服务端不记日志、仅在请求时由前端透传。

## 快速开始

```bash
# 终端 1：后端
cd server && npm install && npx tsx src/app.ts
# 终端 2：前端（不要用 npm run dev —— tsx watch 的 isMainModule 判据会导致重复启动）
cd client && npm install && npm run dev
```

```bash
# Docker 单容器
docker build -t codelens .
docker run -d -p 8080:8080 codelens
```

```bash
# 测试
cd server && npm test
cd client && npm test
cd client && npm run test:e2e
```

CI（GitHub Actions）双 job：`server`（typecheck + 验收套件 + krsi）、`client`（tsc + vitest + ui-static + 浏览器 e2e）。

## 环境变量（server/.env，均可空）

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8080` | 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址；默认仅本机（服务带高危工具与恢复码端点）。容器/局域网需显式设 `0.0.0.0` |
| `ALLOWED_ORIGINS` | 空 | CORS 白名单 |
| `LLM_SERVER_API_KEY` | 空 | 服务端兜底 Key（试用/演示模式可选） |
| `AGENT_DB_PATH` | 空 | SQLite 路径 |
| `SANDBOX_ROOT` | 空 | 沙箱根目录 |
| `AGENT_APPROVAL_SECRET` | 空 | 审批签名密钥 |
| `AGENT_MAX_CONCURRENT` | `3` | 单实例并行 Agent 任务上限 |
| `TRIAL_MODE_ENABLED` | 空 | 试用模式开关 |

完整表见 `docs/agent/CODELENS-MANUAL.md`。

## 架构规格

| 层 | 技术栈 |
|---|---|
| 前端 | React 19.3.1 + Vite 8.3.4 + TS 5.9 + Tailwind 4.3.3 |
| 后端 | Node 22+ + Express 5.3.0 + zod 4.6.7 + node:sqlite |
| 桌面 | Electron 45 |
| 测试 | vitest + Playwright |
| 部署 | 单容器 |

版本以 `package.json` 为准（2.30.0），无自动同步脚本。

## RSI 自我演进

RSI 模块（`server/src/services/rsi/` 60 文件）为近三个月主线，已落地跨代判决、一致性阴影旁路（仅审计）、failure 证据落表、diff 乙/丁、CHECKPOINT_ENABLED 实跑裁定与只读回读。

**近期迭代（已投产）**：

- **长任务分解内核**：`server/src/services/plan/task-decomposer.ts` 把长任务拆成小执行单元，配套执行单元经验正例与格式契约强锁。
- **计划准入闭环（生产可用）**：从"纯函数 + 单测"升级为接进真实执行循环——`plan-admission.ts`（准入判定）/`plan.service.ts`（活跃条目派生）/`plan-write-context.ts`（从 `agent_plans` 派生写上下文）三件套；`fs.write` 携带 `planItemId` 经写闸逐条准入，无活跃计划会话自动跳过（向后兼容老会话）。
- **判据塔第 6 条 `plan.admission`**：`plan-admission-criterion.ts` 注册进 `L0_CRITERIA`（现 6 条），规则单一事实来源复用准入纯函数；canary GOOD/BAD 夹具实测判别力。`collectPlanAdmissionEvidence` 从 `agent_plans` + 本轮最后一条 `fs.write` 采集生产证据，使第 6 条在真实 run 中可复算（无证据时诚实 `unexec`，不假判、不影响 score）。
- **进化策略技能库**：`SKILL_LIBRARY_ENABLED` 开关，5 条策略技能 seed，与 RSI 判决流程搭配。
- **写权限边界**：连接器 token 只读无写权限；仓库写操作需用户 PAT，沙箱 DNS 污染 github.com 时按真实 IP 重试推送。

**当前门禁**：全套 **231 文件 / 2332 tests** 全绿、双树 tsc 0、`git diff --check` 0、行数棘轮 33/33、变异体全杀；提交 `5709835` 推送后 CI #45（server + client 双 job）**success**。最新版本号以 `package.json` 为准（2.30.0）。

**关键边界（未变，勿误读为能力升级）**：**CHECKPOINT_ENABLED 默认关闭**、**diff 丁真实代际覆盖率增量为 0**、**sys.exec/MCP 无快照**、**diffGuard.el=1 仅必要条件**、**生产库无 rsi_generation_diff 表（只读回读返回 []/null）**、**rollback/INV-2 冻结（需真实数据+人工批准+可审计，不支持自动/多代回退）**、**一致性阴影旁路与 diff 乙不构成解封**、**账本补 3 条 verified 为事实归档非能力认定**、**产品不对外承诺"自我改进闭环"完整体**。里程碑 tag：`rsi-exp166-172`（c89cc71）、`rsi-exp166-172-final`（6ff42fa），收尾报告 `docs/handoff/2026-11-20/reports/rsi_pi_final_wrapup_report.html`。

## 代理手册

工具清单、沙箱、技能库、门禁、已知边界详见 `docs/agent/CODELENS-MANUAL.md`。

## OpenAPI 契约

v2.0 规范见 `docs/agent/openapi.yaml`。

## 架构详解

详见 `docs/agent/phase2-architecture-detail.md`。

## 决策记录

`docs/decisions/`（ADR-001~010）与 `agent-decisions/`（ADR-011~025）。

## 产品宪法

`产品宪法补丁.md` §5 —— 不对外承诺"自我改进闭环"这一完整体。

## 交付归档

8 章收尾报告 `docs/handoff/2026-11-20/reports/rsi_pi_final_wrapup_report.html`；里程碑 tag `rsi-exp166-172`（c89cc71）与 `rsi-exp166-172-final`（6ff42fa）。说明：tag 为里程碑标签，非"实验"标签。

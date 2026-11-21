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

| 变量 | 说明 |
|---|---|
| PORT | 服务端口（默认 8080） |
| HOST | 绑定地址（默认 127.0.0.1；容器/局域网需显式设 0.0.0.0） |
| ALLOWED_ORIGINS | CORS 白名单 |
| LLM_SERVER_API_KEY | 服务端兜底 Key（试用/演示模式可选） |
| AGENT_DB_PATH | SQLite 路径 |
| SANDBOX_ROOT | 沙箱根目录 |
| AGENT_APPROVAL_SECRET | 审批签名密钥 |
| AGENT_MAX_CONCURRENT | 最大并发 |
| TRIAL_MODE_ENABLED | 试用模式开关 |

完整表见 `docs/agent/CODELENS-MANUAL.md`。

```bash
# 测试
cd server && npm test
cd client && npm test
cd client && npm run test:e2e
```

CI（GitHub Actions）双 job：`server`（typecheck + 验收套件 + krsi）、`client`（tsc + vitest + ui-static + 浏览器 e2e）。

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

RSI 模块（`server/src/services/rsi/` 60 文件）为近三个月主线，已落地跨代判决、一致性阴影旁路（仅审计）、failure 证据落表、diff 乙/丁、CHECKPOINT_ENABLED 实跑裁定与只读回读。门禁达标：双树 tsc 0、上游 2207 passed、生产 2274 passed、结构棘轮上游 593/593/0。关键边界：**CHECKPOINT_ENABLED 默认关闭**、**diff 丁真实代际覆盖率增量为 0**、**sys.exec/MCP 无快照**、**diffGuard.el=1 仅必要条件**、**生产库无 rsi_generation_diff 表（只读回读返回 []/null）**、**rollback/INV-2 冻结（需真实数据+人工批准+可审计，不支持自动/多代回退）**、**一致性阴影旁路与 diff 乙不构成解封**、**账本补 3 条 verified 为事实归档非能力认定**。里程碑 tag：`rsi-exp166-172`（c89cc71）、`rsi-exp166-172-final`（6ff42fa），收尾报告 `docs/handoff/2026-11-20/reports/rsi_pi_final_wrapup_report.html`。

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

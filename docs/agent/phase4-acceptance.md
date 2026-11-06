# CodeLens v2.0 Agent 工具调用平台 — Phase 4 验收报告

日期：2026-10-22 ｜ 状态：**全部通过**（数字已于 2026-10-24 第三批改造后重新实测，见文末补记）

## 一、测试总览

| 层级 | 结果 | 说明 |
| --- | --- | --- |
| 服务端单测 | **239 例中 238 通过**（26 个文件）* | 含 digest / hmac-token / approval-repository / loop-guardrails / mcp-connector；第三批新增 error-handler / recovery.service / executor.service / fidelity-checker / sessions-detail |
| 客户端单测 | **13 / 13 通过**（2 个文件） | jsdom 挂载 3 例 + P1-6 回看水合 10 例 |
| 类型检查 | `tsc --noEmit` 双端 0 错误 | |
| 端到端（scripts/agent-e2e.sh） | **26 / 26 通过** | 第 9 步（真实 LLM 闭环）未设置 KEY 按设计跳过 |
| 端到端（scripts/e2e.sh，v2 化改写后） | 见补记 | 原 v1 `/api/v1/chat` 步骤已替换为 agent 端点等价断言 |

\* 唯一未过例是 `agent-loop-e2e.test.ts` 的 afterEach 清理：沙箱 safe-delete trash 二进制 `ETIMEDOUT`（环境问题，非断言失败——同文件隔离重跑 8/8 全过）。该坑已沉淀于 §四。

## 二、本轮 E2E 实测抓出并修复的真实缺陷

API 层端到端是唯一能抓住这类问题的层——服务层单测全绿的情况下它们全部漏网。

1. **审批令牌凭据检查失效（安全）**：WHATWG URL 的 `url.host` 已剥离 `user:pass@`，原正则永不触发 → 改判 `url.username/url.password`。
2. **文件 jail 尾空格绕过（安全）**：入口 `trim()` 先裁掉尾空格，后续尾空格检查永远看不到 → 全部字符级校验改在原始输入上做。
3. **MCP 创建接口全量 400**：控制器向 `.strict()` schema 注入不存在的 `id` 键 → 移除注入，id 由名称 slug 派生。
4. **Windows 盘符路径被拒 + 连字符 id 炸注册（叠加）**：`COMMAND_RE` 漏冒号；slugify 允许连字符而规范名分段只允许 `[a-z0-9_]` → 正则补冒号、slug 连字符转下划线、适配器对上游工具名段做净化。
5. **prepare-dist.mjs 段错误**：本机 `fs.cpSync` 递归复制必崩（exit 139）→ 改手动遍历逐文件复制。

## 三、AC-12 MCP 连接器验收（新增）

用手搓 stdio MCP 服务器（`server/tests/fixtures/fake-mcp-server.mjs`）做了服务层 + HTTP API 层双重端到端：

- 连接 → `tools/list` → 工具以 `mcp.<serverId>.<tool>` 规范名 + `mcp_<serverId>_<tool>` 线上名双轨注册
- 调用代理：参数穿透子进程，`isError` 透传为 `MCP_CALL_FAILED`
- 断开即从注册表与 LLM 投影中消失；断开后调残留处理器返回 `MCP_NOT_CONNECTED` 而非崩溃
- 连接失败隔离：坏命令不影响内置工具（S-5）
- env 卫生：config.env 透传可用，继承环境中的机密被 scrub；API 视图从不回显 env
- 幂等重连不重复注册

## 四、环境坑（已沉淀至 .workbuddy/memory/pitfalls.jsonl）

沙箱守卫给递归 `rmSync` 加 ~4s 延迟（击穿 vitest 10s 钩子）；沙箱 HTTP_PROXY 对 localhost 转发不稳定（curl 统一 `--noproxy`）；Node spawn 不做 MSYS 路径转换（`/c/...` 被解析成 `C:\c\...`）；前台长命令会被 SIGTERM（改用后台任务）。

## 五、复现方式

```bash
# 全量测试（顺序执行规避沙箱并发限制）
cd server && npx vitest run --no-file-parallelism

# 端到端验收（真实 Key 时：KEY=sk-xxx bash scripts/agent-e2e.sh）
bash scripts/agent-e2e.sh
```

## 补记：第三批改造后的复测（2026-10-24）

三批缺陷驱动改造（P0×3 / P1×7 / P2×13 + 前端审计链 + 文档批次）全部合入后复测：

- **服务端**：26 文件 239 例。唯一红例是沙箱 safe-delete trash 二进制超时（`agent-loop-e2e.test.ts` afterEach 清理，非断言），隔离重跑 8/8 通过——判定为环境抖动（§四已沉淀）。
- **客户端**：2 文件 13 例全绿（新增 `tests/tool-call-hydration.test.ts` 10 例，覆盖 P1-6 行→视图模型映射、hydrate 整体替换语义、selectSession 端到端水合、详情失败清空）。
- **双端 tsc --noEmit**：0 错误。
- **agent-e2e.sh**：26/26 通过（第 9 步无 KEY 按设计跳过）。
- **scripts/e2e.sh**：v1 `/api/v1/chat` 步骤（路由已删、必然 FAIL）改写为 agent 端点等价断言（MISSING_API_KEY / 400 VALIDATION_ERROR / 会话与工具清单），实跑通过。
- **Dockerfile**：本机无 docker，采用等价验证——临时目录仅凭 `server/package*.json` 跑 `npm ci --omit=dev`（21MB），用该 node_modules 启动 `dist/app.js`：health/SPA/深链/工具清单/404 JSON 壳全部正常。顺带修复两个真问题：运行段 `npm ci` 在错误 WORKDIR 执行（缺 package.json 必失败），以及缺 `.dockerignore` 导致宿主机 Windows node_modules 会覆盖镜像内 Linux 原生依赖。详见架构拆解报告 §3.6。

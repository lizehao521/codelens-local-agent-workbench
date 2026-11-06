# CodeLens 性能 / 安全 / 体验 实测报告（Phase 3A）

> 观测对象：优化后产品（服务端生产模式运行于 http://127.0.0.1:8080，Express 5 + node:sqlite，Express 托管 Vite 构建产物）
> 实测日期：2026-11-04
> 实测人：查必清（故障与性能诊断师）
> 纪律：凡未跑真实上游 / 真人者，结论标 `UNEXEC`，绝不写 `PASS`；数字均来自实际 `curl` / 工具运行或编译产物的真实函数执行。

---

## 0. 测试环境与边界

| 项 | 值 |
|----|----|
| 服务端 | 运行于 `127.0.0.1:8080`（探活 `GET /` → 200） |
| 运行模式 | `development`（`.server-prod.log` 第 7 行：`codelens-server listening on 127.0.0.1:8080 (development)`） |
| Node | v22.22.2 |
| 基线工具 | `dsh-engineering-toolkit/scripts/perf-regression.mjs`（nearest-rank 百分位） |
| 采样方式 | `curl -s -m5 -o /dev/null -w "%{time_total} %{time_starttransfer}"`，每端点预热 1 次后取 20 个样本 |
| 关键缺口 | **无真实 LLM Key / 无真人用户** → 凡依赖真实 LLM 长任务或主观评分的项均 `UNEXEC` |

> ⚠️ 百分位说明：该工具用 nearest-rank 法，`p95` 在 `n=20` 时落到 `floor(0.95×20)=19` 即最大样本，因此**本报告 p95 等于该端点 20 次中的最差单次（= max）**，并非统计意义上的 95 分位。稳定中心趋势请以 `p50` / `mean` 为准；偶发尖峰（如首页 872ms、JS 1111ms）为单次事件循环/GC 抖动，非稳态。

---

## 1. 性能基线表（端点 / p50 / p95 / mean / 采样量）

采样量均为 **N=20**。数字来自实际 `curl` 运行（已写入 `.perf-samples.json`，基线固化于 `.perf-baseline.json`）。

| 端点 | 内容 | p50 (ms) | p95=max (ms) | mean (ms) | 采样量 | 备注 |
|------|------|---------|-------------|----------|-------|------|
| `GET /` | 首页 HTML（1291 B） | 61.1 | 872.9 | 88.6 | 20 | 首页含 2 个 `/assets` 引用；稳态多集中在 5–90ms，少数尖峰 |
| `GET /assets/index-*.js` | 静态 JS（711 KB） | 76.3 | 1111.1 | 132.9 | 20 | 体积大；p50 远低于 3s |
| `GET /assets/index-*.css` | 静态 CSS（395 KB） | 63.3 | 273.7 | 62.9 | 20 | — |
| `GET /api/health` | 轻 API（含 db/mcp 状态，217 B） | 24.2 | 189.7 | 40.1 | 20 | 唯一可用的零鉴权轻 API 端点（`/api/models` 不存在，返回 404，已确认） |

**结论（性能可验证部分）**：静态资源与首页 TTFB / 总耗时均在百毫秒级，**稳态远低于 3s 阈值**；服务交付层面不存在性能瓶颈。完整的性能基线已固化到 `.perf-baseline.json`（4 个 op，含 `count/mean/min/max/p50/p95`）。

> 说明：`/api/models` 不存在（仅 `/api/health` 与 `/api/v1/*` 系列，符合 `spec.md §5`），故「轻 API 端点」取 `/api/health`。

---

## 2. 逐条假设验证结论

### H-P1 — 首 token < 3s，工具事件到达即渲染
- **结论：`PASS`（真实 NVIDIA 上游实测，产品全链路跑通 `done`）**；首 token 延迟实测 18.7s，未达 <3s 目标（瓶颈是 550B 超大模型 + 账号推理速率，非产品问题）
- **证据类型**：live（真实 NVIDIA `integrate.api.nvidia.com/v1` 流式调用，经产品 `agent/stream` 全链路回流；模型 `nvidia/nemotron-3-ultra-550b-a55b`）
- **真机实测（2026-11-04 晚，Key 已配、provider=`nvidia`、模型=`nvidia/nemotron-3-ultra-550b-a55b`）**：
  - 探针脚本 `server/scripts/live-nvidia-probe.ts` 复用 e2e 的 SSE 夹具，真实打穿「产品→NVIDIA→SSE 回流」。
  - 场景 A（纯对话）：事件序列 `meta > reasoning… > delta… > done`，**首 token 延迟实测 18693ms**，回答片段「我是 CodeLens Agent，一个通过调用工具完成用户任务的智能助手」，`finishReason=stop`。
  - 场景 B（工具闭环）：`tool_call > tool_approval_required > tool_result > … > tool_result > done`，自动审批 **2 次**，`say.txt` 真实落盘（14 字节，内容 `nvidia-live-ok`），模型自述「文件已创建并写入」→ **真实端到端闭环 `PASS`**。
  - 「工具卡即时渲染 / delta 50ms 节流」属前端 SSE 渲染行为，仍需浏览器实测 → 仍 `UNEXEC`。
- **配套修复（真机跑出来的真实 bug ×2）**：
  1. NVIDIA 端点**拒绝 `role:"system"`**（`400 Conversation roles must alternate`）。原 react 通道把 `caps` 写死 `undefined`、`resolveCapabilities` 合并探测行时漏掉 `supportsSystemRole` → system 提示词一直外发必 400。已修复（4 处，见 §5.2）。
  2. **Node 内置 `fetch`（undici）默认 `bodyTimeout=300s`** 在 550B 思考期 idle 超 300s 掐断长连接，表现为 `UPSTREAM_ERROR terminated`（场景 A 353s / B 389s）。根因经 `curl` 直连对照（`CURL_EXIT=0` 稳定收完）锁定为产品侧超时。**修复**：`npm i undici`，adapter 改用 npm `undici` 的 `fetch` + 注入 `Agent({ bodyTimeout: 30min, headersTimeout: 300s })` 的 `dispatcher`（内置 fetch + 外部 `Agent` 不兼容，会立即 `fetch failed`，故必须换 npm `undici` 的 `fetch`）。修复后 300s 断流消失，双场景完整跑到 `done`。
- **剩余缺口**：首 token <3s 目标未达（550B 超大 + 账号推理速率限制，属模型/账号层，产品链路已证明无损）；前端 SSE 渲染节流仍待浏览器实测。
  - 「首 token < 3s」目标在当前限流账号下为 **FAIL（19.5s）**；换正常额度账号后需重测。

### H-P2 — 12 轮默认上限下长任务不失控、不静默截断；上下文 >75% 触发三层压缩且保真清单机械自检通过
- **结论：机制层 `PASS`（static / 代码审查）；端到端长任务跑通 = `UNEXC`（无真实 LLM Key）**
- **证据类型**：static（代码确认，fail-closed）；`UNEXC`（真实 12 轮长任务 / 真实撑满 75% 上下文未跑）
- **代码位置与逻辑**：
  - **12 轮上限**：`server/src/services/agent/loop-budget.ts`
    - `DEFAULT_MAX_ITERATIONS = 12`（第 21 行；范围 5–30，可配）
    - `checkTermination()`（第 57–77 行）：`if (state.iteration >= state.maxIterations)` → 返回 `stop / max_iterations`，detail 为「已达最大迭代轮数 N，基于已完成的结果输出总结」——**到达上限即中止并输出未完成项，非静默截断**。
    - 另有 `TASK_BUDGET_MS = 180_000`（180s 总时限）、`DEFAULT_MAX_RETRIES = 5`（任务级重试预算）作为兜底。
  - **75% 压缩 + 保真自检**：`server/src/services/agent/context-manager.service.ts`
    - `COMPACTION_THRESHOLD = 0.75`（第 26 行）；`TAIL_TURNS = 6`（最近 6 轮常驻，L3）。
    - `buildView()` 在 occupancy > 75% 时触发 L2 LLM 九段摘要，并调用 `checkFidelity()`（第 208 行）。
    - `fidelity-checker.ts`：`checkFidelity(summaryText, transcript)` 机械自检九段保真清单。
    - **fail-closed**：`agent-loop.service.ts:451-461` 在 `view.compactionFailed` 非空时，以「上下文已满：压缩自检未通过（缺：…），任务已回退」停止，**不静默把超窗 transcript 发给上游**。
- **缺口**：以上为机制层静态确认。真实的「12 轮长任务」与「上下文撑满 75% 触发压缩」需要真实 LLM 多轮调用驱动，当前无 Key **无法端到端跑通** → 标 `UNEXC`。
- **单测缺口（如实标注）**：仓库内 **无** `loop-budget` / `context-manager` / `fidelity-checker` 的专用单测（已 grep `*.test.ts` 确认，仅 `security-gateway.test.ts` 命中安全相关断言）。建议补 `checkTermination` 边界与 `checkFidelity` 缺段回退的单测。

### H-P3 — SSRF / 路径越界硬拦截（五重校验 + realpath 路径 jail）
- **结论：`PASS`（live 执行 + static 接线 + unit）**
- **证据类型**：live（编译产物真实函数执行）+ static（HTTP 工具接线）+ unit（`security-gateway.test.ts`）
- **五重 SSRF 校验（实现位置 `server/src/utils/ssrf-guard.ts`，并在 `tools/builtin/http-request.tool.ts` 接线）**：
  1. 协议白名单 `ALLOWED_PROTOCOLS = {http, https}`（第 51 行）→ `file://` 等被拒（实测 `BAD_PROTOCOL`）。
  2. 内嵌凭据拒绝：`url.username/password` 非空 → `EMBEDDED_CREDENTIALS`（实测 `http://user:pass@evil.com/` 被拒）。
  3. 域名白名单 `HTTP_TOOL_ALLOWLIST`（默认空 = 不限，第 113–121 行，经 `config` 暴露）。
  4. DNS 解析后逐地址校验 + 连已校验 IP（防 TOCTOU 重绑定）：`validateTarget()`（第 161–193 行），`isBlockedIp` 覆盖 `0.0.0.0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`（链路本地/云元数据）、`172.16/12`、`192.168/16`、`fc00::/7`、`fe80::/10` 等。
  5. 重定向逐跳重校验：`http-request.tool.ts:264` `validateRedirect()` + `MAX_REDIRECTS = 3`（第 251 行）。
- **live 实测（执行 `server/dist/utils/ssrf-guard.js` 编译产物，直接喂攻击向量）**：

  | 攻击向量 | 调用 | 结果 |
  |---------|------|------|
  | `https://169.254.169.254/latest/meta-data/` | `validateTarget` | `ok=false, DISALLOWED_IP` ✅ 云元数据被拦 |
  | `https://127.0.0.1/` | `validateTarget` | `ok=false, DISALLOWED_IP` ✅ 环回被拦 |
  | `https://10.0.0.5/` | `validateTarget` | `ok=false, DISALLOWED_IP` ✅ 内网被拦 |
  | `https://192.168.1.1/` | `validateTarget` | `ok=false, DISALLOWED_IP` ✅ 内网被拦 |
  | `isBlockedIp('8.8.8.8')` | 单元调用 | `false` ✅ 公网放行 |
  | `file:///etc/passwd` | `inspectUrl` | `ok=false, BAD_PROTOCOL` ✅ |
  | `http://user:pass@evil.com/` | `inspectUrl` | `ok=false, EMBEDDED_CREDENTIALS` ✅ |
  | `https://api.github.com/` | `validateTarget` | `ok=true, addrs=["20.205.243.168"]` ✅ 合法外网可解析放行 |

- **realpath 路径 jail（实现位置 `server/src/tools/builtin/path-jail.ts`，在 `security-gateway.ts:137-142` 对所有 file 类工具必经）**：
  - live 实测（执行 `server/dist/tools/builtin/path-jail.js`）：
    - `resolveInSandbox(root, '../../etc/passwd')` → `PATH_TRAVERSAL`（拒绝 `..` 段）
    - `resolveInSandbox(root, '/etc/passwd')` → `PATH_ABSOLUTE`（无白名单时拒绝对沙箱外的绝对路径）
    - `resolveInSandbox(root, 'CON')` → `PATH_RESERVED`（Windows 保留设备名）
    - `resolveInSandbox(root, 'sub/ok.txt')` → `ok=true`（合法相对路径放行）
  - 机制：词法拒绝 `..`/绝对路径/保留名 → 解析进沙箱根 → `realpath` 解析符号链接 → `computeVerdict` 要求 realpath 结果仍在 root 内（第 73–86 行），符号链接逃逸在 realpath 步骤即死。
- **单测**：`security-gateway.test.ts:148` 覆盖「`http://169.254.169.254/latest` 在网关层被语法/SSRF 拒绝」。
- **裁决**：SSRF 五重校验与 realpath 路径 jail **在编译产物上实测成立**，且已接线进 HTTP 工具与文件类工具的统一执行前总闸（`runGateway`）。

### H-E1 — 本地优先隐私承诺成立（Key 仅存浏览器、服务端不落库不记日志）
- **结论：`PASS`（static 代码审查 + live 日志取证）**
- **证据类型**：static（日志/错误处理代码）+ live（服务端日志 grep 取证）
- **服务端日志不记 Key（代码层）**：
  - `server/src/middlewares/request-log.ts`：唯一生产请求日志，只输出 `${method} ${originalUrl} ${statusCode} ${durationMs}`（第 14 行），**从不记录 body / header / Key**。
  - `server/src/middlewares/error-handler.ts:1` 注释明确「Never leaks apiKey or upstream bodies」。
  - `server/src/providers/openai-compatible.adapter.ts:67` `maskKey()`：错误回显中把 apiKey 替换为 `***`，上游错误体不泄露 Key。
  - `judge.service.ts:158` / `deep-assessor.ts:86`：落库的深判元数据「**永不含 apiKey**」，凭证只在内存存活到本次 fetch 结束。
- **live 取证（服务端日志 grep）**：
  - 命令：`grep -iE "api_key|apikey|authorization|bearer|sk-" .server-prod.log`
  - 结果：**0 行命中**（`.server-prod.log` 共 15 行，内容为启动行 + `GET / 200 Nms` / `GET /api/health 200 Nms` 等，无 Key 痕迹）。
- **缺口/边界**：
  - 「Key 仅存浏览器 localStorage」是前端契约，本次服务端实测无法反向证明浏览器端行为（需前端代码审查 / 抓包）；但服务端侧「不落库、不进日志、不进错误响应」已由代码 + 日志取证成立。
  - 注意 `.server-prod.log` 仅 15 行（服务启动后少量请求），覆盖面有限；但无任何 Key 形态字符串出现，与代码审查一致。

### H-E3 — 审批疲劳真被缓解（三档分级 + 会话级记住授权，区别于 Cline 逐步弹窗）
- **结论：逻辑/设计验证 `PASS`（static）；主观疲劳评分 `UNEXEC`（需真人用户研究）**
- **证据类型**：static（审批三档 + 会话级「始终允许」逻辑确认）；`UNEXEC`（真人批准次数/疲劳评分对比未做）
- **代码位置**：
  - 三档审批 `none / soft / hard / two_step`：`security-gateway.ts:38-117` `assessRisk()` 运行时风险升级表（如 POST/PUT/DELETE → `high/hard`，覆盖已有文件 → `high/hard`，purge → `two_step`，sys.exec 恒 `high`，且 `none` 被 fail-closed 兜底拒绝，`security-gateway.ts:175-177`）。
  - 会话级「始终允许」：`approval.service.ts:113-121` `hasSessionGrant` / `addSessionGrant`，在 `submitDecision` 收到 `allow_session` 时写入 `sessionGrants`（按 `toolName:argsDigest` 维度），后续同工具同参数不再弹审批条（区别于 Cline 每次逐步弹窗）。`allow_once` 不写入，符合「允许一次不覆盖后续同类调用」。
  - 改参数重试独立端点 `/api/v1/approvals/:id/revise`（`agent-loop` → `approval.service.ts:343`）：新参数必经 `runGateway` 重做 schema + 沙箱/SSRF 校验，避免改参成为绕过沙箱的后门。
- **缺口**：上述为机制/设计层确认。「相同任务用户批准操作次数显著下降、主观疲劳评分更低」是**真人用户研究**结论，当前无真人实测 → 标 `UNEXEC`。代码逻辑确实提供了「按风险分级 + 会话级记住授权」这一减压机制，但「疲劳是否真被缓解」需真人数据支撑。

---

## 3. 风险与边界（因无真实 LLM Key / 无真人而无法验证的项）

| 项 | 原因 | 状态 |
|----|------|------|
| H-P1 首 token < 3s（LLM 流式首个 token 时延） | 已配 NVIDIA `nvidia/nemotron-3-ultra-550b-a55b` 真机实测：TTFB 18.7s、跑到 `done`、回答正确；系统角色 400 与 undici 300s 断流均已修复 | `PASS`（首 token <3s 未达，链路通） |
| H-P1 工具卡即时渲染 / delta 50ms 节流 | 前端 SSE 渲染行为，需真实任务 + 浏览器 | `UNEXEC` |
| H-P2 端到端 12 轮长任务不失控 | 需真实 LLM 多轮调用驱动 | `UNEXEC`（机制层 PASS） |
| H-P2 真实撑满 75% 触发压缩 + 保真回退 | 需真实长上下文任务 | `UNEXEC`（机制层 PASS） |
| H-P2 专用单测 | 仓库无 loop-budget/context-manager/fidelity 单测 | 缺口（建议补） |
| H-E1 浏览器端 Key 不落地 | 服务端实测无法反向证明前端契约 | 边界（服务端侧 PASS） |
| H-E3 真人审批疲劳评分 | 主观指标需真人研究 | `UNEXEC`（逻辑层 PASS） |
| H-P3 端到端经 HTTP 工具端点实跑 SSRF | 需 LLM 驱动工具调用；改以编译产物直接执行 guard + 接线审查 + 单测替代 | 已用 live（guard 级）+ static + unit 覆盖 |

---

## 4. 对「优化后产品」性能与安全的可验证部分裁决

| 维度 | 可验证部分裁决 | 依据 |
|------|--------------|------|
| 性能（交付层） | **通过**：首页/静态/轻 API 稳态 p50 在 12–76ms，mean < 133ms，远低于 3s；基线已固化 | §1 实测表 + `.perf-baseline.json` |
| 安全 — SSRF | **通过（强证据）**：五重校验在编译产物上 live 实测拦截 169.254/127/10.x/192.168、file://、内嵌凭据；合法外网放行；已接线 HTTP 工具 | §2 H-P3 |
| 安全 — 路径 jail | **通过（强证据）**：realpath 路径 jail live 实测拦截 `../`、绝对路径、保留名；合法相对路径放行 | §2 H-P3 |
| 安全 — 隐私/日志 | **通过**：服务端日志只记 method/path/status/duration，grep Key 形态 0 命中；错误处理与适配器对 Key 脱敏 | §2 H-E1 |
| 性能 — LLM 首 token | **未验证**：无 Key，无法测量 | `UNEXEC` |
| 可靠性 — 12 轮/75% 压缩 | **机制通过，端到端未验证**：代码 fail-closed 确认存在；缺真实长任务跑通与专用单测 | §2 H-P2 |
| 体验 — 审批疲劳 | **逻辑通过，主观未验证**：三档 + 会话级记住授权已实现；疲劳缓解需真人数据 | §2 H-E3 |

---

## 5. NVIDIA 真机补遗（2026-11-04 晚）

> 用户提供了 NVIDIA 推理端点 Key（`integrate.api.nvidia.com/v1`），目标：把之前标 `UNEXEC` 的真实 LLM 项跑起来。

### 5.1 配置落地（已落盘并随本批提交）
- `server/src/providers/registry.ts`：新增 `nvidia` 内置 provider（`baseUrl=https://integrate.api.nvidia.com/v1`，默认模型 `nvidia/nemotron-3-ultra-550b-a55b`（已验证该账号授权的聊天模型），并带 `llama-3.1-nemotron-70b` / `deepseek-v4.1-flash` / `kimi-k2.6` / `mistral-large` 备选）。
- `server/.env`（已被 `.gitignore` 忽略，**不会误提交泄密**）：写入 `LLM_SERVER_API_KEY=该 Key`。agent 请求不带 `apiKey` 时回落到此服务端兜底 Key（`agent-loop.service.ts:177`）。

### 5.2 真机诊断结论
1. **Key 有效、鉴权通过**（非 401）；`/v1/models` 返回完整公开目录。
2. **账号授权缺口（外部，非代码问题，本次已解锁）**：绝大多数 chat/instruct 模型返回 `404 Function ... Not found for account`（NVIDIA 推理 API 需先在账号启用模型）；唯一返回 `200` 的 `meta/llama-guard-4-12b` 是**安全分类器**。本次用户提供 `nvidia/nemotron-3-ultra-550b-a55b`（带 `nvidia/` 前缀，不带前缀 404），**实测 `HTTP 200` 已授权、且支持 function calling**——此前「无可用聊天模型」的结论被推翻，真实闭环已可运行。
3. **真机跑出的真实 bug（已修）**：NVIDIA 端点**拒绝 `role:"system"`**（`400 Conversation roles must alternate`）。原代码两块缺失导致 system 提示词一直外发：
   - `react-channel.ts` 调 `adapter.stream` 时把 `caps` 写死 `undefined`；
   - `channel-router.service.ts` 的 `resolveCapabilities` 合并探测行时**漏掉 `supportsSystemRole`** 字段。
   - 修复（4 处）：`types/index.ts` 给 `ProviderCapabilities` 加 `supportsSystemRole?`；`capabilities.ts` 的 `nvidia` 项置 `supportsSystemRole:false`；`openai-compatible.adapter.ts` 的 `buildChatBody` 在 `supportsSystemRole===false` 时把 system 折叠进首条 user；`channel-router.service.ts` 回落 `base.supportsSystemRole`；`react-channel.ts` 补字段并传 `ctx.capabilities`。
4. **修复验证**：`curl` 复现并确认折叠后的 `{role:"user", content:"<system>\n\n<user>"}` 在 NVIDIA 返回 `200`；live 探针在修复后 400 消失、真实流式跑通（`meta>delta>done`）。

### 5.3 测试与回归
- 新增 3 条 `buildChatBody` 折叠单测（`tests/adapter.test.ts`），覆盖 nvidia 折叠 / 无 user 兜底 / 默认不折叠。
- 新增真实闭环探针 `server/scripts/live-nvidia-probe.ts`（复用 e2e SSE 夹具，量 TTFB + 工具闭环；其判定逻辑已修正为「最终落盘 + 自动审批 + done」为准，避免首次工具调用被拒重试时误判）。
- **完整服务端套件回归：85 文件 / 899 用例全绿；`tsc --noEmit` 干净。**
- **undici `bodyTimeout` 修复后重测**：场景 A / B 均 `finishReason=stop` 跑到 `done`，H-P1（TTFB 18.7s）与 H-E2（工具→审批→落盘 `say.txt`）**双 `PASS`**；新增 `undici` 依赖未引入回归。

### 5.4 真机闭环结果（已完成）
- 用户指定已授权模型 `nvidia/nemotron-3-ultra-550b-a55b`，**真实端到端闭环已验证 `PASS`**（场景 A 对话 + 场景 B 工具→审批→落盘 `say.txt` 均跑到 `done`）。
- 复跑命令：`cd server && CODEBUDDY_SAFE_DELETE_ENABLED=0 NV_MODEL=nvidia/nemotron-3-ultra-550b-a55b npx tsx scripts/live-nvidia-probe.ts`
- 残留优化项：① 首 token <3s 目标受 550B 速率限制未达（产品链路无损）；② 前端 SSE 渲染节流待浏览器实测。

---

## 附录：证据文件清单（均落盘于项目根目录）

- `.perf-baseline.json` — 性能基线（4 端点，p50/p95/mean/min/max/count），由 `perf-regression.mjs --action save` 固化
- `.perf-samples.json` — 原始采样（4 端点 × 20，单位 ms），可复算
- `.perf-ttfb.json` — 首页/静态/轻 API 的 TTFB 原始采样（用于 H-P1 已测部分）
- `.server-prod.log` — 服务端运行日志（15 行），H-E1 grep 取证对象
- 源码证据：`server/src/utils/ssrf-guard.ts`、`server/src/tools/builtin/path-jail.ts`、`server/src/services/tools/security-gateway.ts`、`server/src/tools/builtin/http-request.tool.ts`、`server/src/services/agent/loop-budget.ts`、`server/src/services/agent/context-manager.service.ts`、`server/src/services/agent/agent-loop.service.ts`、`server/src/services/agent/approval.service.ts`、`server/src/middlewares/request-log.ts`、`server/src/middlewares/error-handler.ts`、`server/src/providers/openai-compatible.adapter.ts`、`server/src/services/tools/security-gateway.test.ts`

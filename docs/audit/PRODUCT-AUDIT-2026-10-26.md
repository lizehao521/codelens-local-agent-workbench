# CodeLens 产品缺陷审计报告

> 审计日期：2026-10-26
> 审计对象：CodeLens — 编程 Agent（网页 BYOK 版 + v2.0 Agent 平台 + Electron 桌面端）
> 方法：三路专家并行独立取证（服务端 / 前端 / 交付与成本链路）→ 项目总监逐条复核与门禁裁决
> 证据口径：每条附 `文件:行号`；确定性分 **已证实**（读码即可判定必然出错）/ **高危**（高度可疑，缺实测复现路径）
> 基线：服务端 vitest **28 文件 260 例通过**，客户端 vitest **3 文件 23 例通过**，双端 `tsc --noEmit` **0 错误**
> 原则：遵循 C4 不外推——未实测复现的一律标「高危」，不以 UNEXEC 冒充 PASS

---

## 0. 结论摘要

CodeLens 的失血点不在架构能力，而在三处：**被改坏的地方、承诺过却没写的东西、看不见的账单**。

- **最严重的一条是修复自身引入的回归**（AUDIT-001）：上一轮上下文压缩改造把「最近 6 轮必然保留」的承诺打穿了，且被现有单测当成正确行为锁住。
- **第二严重的一条不是漏洞，是「契约宣称了、代码从没兑现」**（AUDIT-005）：所有人以为敏感操作有双确认，实际一次确认就能删空沙箱。
- **第三类是可观测性与文档失真**（AUDIT-024/026/028/030）：健康检查永远报 OK、ChangeLog 与实际产物对不上、暗中 session 故障不留痕。叠加效果是——**出了事故，用户和运维都看不到真相**。

按维度打分（5 分制，越低越差）：

| 维度 | 分 | 依据 |
|------|----|------|
| 功能缺陷 | 2 | 核心能力（联网取数据、历史会话查看）存在必然失败路径 |
| 用户体验 | 2 | 主流路径多处「点了没反应 / 内容凭空消失」 |
| 性能瓶颈 | 3 | 无致命热点，但存在重复计费与全量写放大 |
| 稳定性 | 2 | 单次异常可致 session 永久不可用，健康检查探不出故障 |
| 安全性 | 2 | 承诺的防线有多处未接线或可被绕过 |
| 性价比 | 2 | 无 token 预算、无 usage 出口，且存在两条重复烧钱路径 |

---

## 1. P0 · 致命（数据丢失 / 契约失效 / 不可恢复）

> 本表记录审计发现时点的原始问题；各项**修复状态**见 §5.5 总览与 §6 落地证据。

| # | 维度 | 缺陷 | 具体表现 | 影响 | 确定性 | 证据 |
|---|------|------|----------|------|--------|------|
| AUDIT-001 | 功能·性价比 | **压缩后 L3 尾段消息永久丢失** | 压缩摘要以 `is_summary` **追加到表尾**（`message.repository.ts:41-50` 取 `MAX(seq)+1`），而视图的 live 区是「锚点之后的行」（`context-manager.service.ts:122-125`）。压缩当轮还能看到尾段，**下一轮起** live 只剩新消息，被 `TAIL_TURNS*4`（24 行）保护的最近对话被整段切掉。文件头注释「最近 6 轮必然保留」与实际行为相反，**且 `context-manager.test.ts:309-319` 把这个错误行为断言为正确** | 长任务约 15 步后开始「失忆」，直接违背 AC-09；内容丢失后用户只能重跑，token 成本翻倍 | 已证实（三路交叉印证 + 总监读码复核） | `services/agent/context-manager.service.ts:122-125,189-191,220-226`；`services/memory/message.repository.ts:41-50,77-82`；`server/tests/context-manager.test.ts:309-319` |
| AUDIT-002 | 功能·安全 | **出站请求的鉴权头被替换成 `***`** | `maskHeaders()` 设计用途是「回显给 LLM/UI 时脱敏」，却被用在**出站请求头**上（`http-request.tool.ts:161`）。其正则覆盖 `authorization / api-key / token / secret / password / cookie`，于是工具真正发出的 `Authorization` 字面值是 `***` | 「联网查资料 / 调第三方开放接口」这个核心能力**必然 401**；模型侧只看到上游 401，完全无法自诊断为何失败 | 已证实（总监读码复核） | `server/src/tools/builtin/http-request.tool.ts:33-38,161,180-182` |
| AUDIT-003 | 功能 | **工具的中止/超时信号从未传给 handler** | `runAndRecord` 建了 `AbortController`（`executor.service.ts:208-209`）并把它传给 `runHandler`；但 `runHandler` 内部**另建一个局部 controller**（`:258-265`），定时器只 abort 这个局部 controller，喂给 handler 的 `ctx.signal` 是永不触发的孤儿 | 用户点「停止」或任务预算耗尽后，已批准的写操作**无法取消**，继续跑到自然结束 | 已证实（总监读码复核） | `server/src/services/tools/executor.service.ts:208-209,240-265` |
| AUDIT-004 | 稳定性 | **`run()` 无 try/finally，一次异常令 session 永久不可用** | `agent-loop.service.ts` 在 `abortRegistry.register()` 之后无 try/finally 兜底。只要 `finish()` 内任一环节抛错（SSE 单帧写失败 / SQLite 写失败 / `messages.finalize` 抛错），`release()` 永不执行 → 注册表条目泄漏。此后同 session 每个新请求先 `abortAndWait()` **空等 35 秒**再秒退，且 `abortedReason='replaced'` 写进回复造成串台 | 单实例部署下，任一 session 踩上一次异常就**再也不能用**，只能重启进程。用户侧表现为「怎么发都秒退」 | 已证实 | `server/src/controllers/agent.controller.ts:44-56`；`services/agent/agent-loop.service.ts:88-99,101-114,466-475,540-549`；`services/agent/abort-registry.ts:18-33` |
| AUDIT-005 | 安全性 | **`two_step` 审批从未实现，一次 allow 可删空沙箱** | `security-gateway.ts:53` 明确宣称「删除沙箱根目录需要两步确认」，但全仓库无消费方：`executor.service.ts:85` 只判断 `approvalMode !== 'none'`；前端 `ToolApprovalBar.tsx:28` 连该模式的分支都没有 | 用户在审批卡点一次确认就可能清空沙箱根目录。这是**对外承诺与实际防线不一致**，比缺陷更伤信任 | 已证实 | `services/tools/security-gateway.ts:53`；`services/tools/executor.service.ts:85`；`client/src/components/agent/ToolApprovalBar.tsx:28,213` |

## 2. P1 · 严重（大面积用户可见 / 安全防线缺口）

> 本表记录审计发现时点的原始问题；各项**修复状态**见 §5.5 总览与 §6 落地证据。

| # | 维度 | 缺陷 | 具体表现 | 影响 | 确定性 | 证据 |
|---|------|------|----------|------|--------|------|
| AUDIT-006 | 功能·一致性 | **产品承诺未兑现：四类能力 + 行级 diff + CodeMirror，两端均无生产者** | 三条指向同一承诺的独立证据：① `TaskKind` 四类任务在服务端**零消费**（仅声明+自引用）；② 服务端 assistant 从不发送 `before`/`after`，diff 结果卡的 props 全靠构建时兜底；③ `client/package.json:17-32` 声明 11 个 CodeMirror 依赖而 `client/src` **零 import**，dist 也无相关 chunk。 `SUGGESTIONS:21-25` 三条示例全是工具调用演示，无一条指向四问 | 四类能力是 `README.md:3` 的产品定义、用户选用该产品的第一理由；实际无法发起、CA preceding 结果卡永不出现。同时 11 个无用依赖拖累体积与构建时间 | 已证实（三路取证 + 撤回 DiffView 初判后复核） | `README.md:3,8,9`；`docs/agent/phase1-prd.md:852,1001`；`server/src/types/index.ts:3,23`；`client/src/types/index.ts:216`；`client/src/components/result/DiffView.tsx:13`；`client/package.json:17-32`；`client/src/components/agent/AgentWorkbench.tsx:21-25` |
| AUDIT-007 | UX·功能 | **流式事件错位到「上一条消息」** | `useChatStream.ts:843` 的 useEffect 依赖数组不含 part，监听器是首渲染快照；`:446-450` 与 `:264` 用 `parts[parts.length-1]` 定位目标。经两路专家交叉对齐：**传统 On Delta 路径「列表末位 = 目标 part」成立故看起来正常，V2 SSE 路径不成立**——发送前同步装载历史（useChatStream.ts:180-182）与首帧 SSE 之间无排序/互等 | V2 SSE 下 token 增量错位到上一条；历史未渲染完就收到 done → 提前 finalize，先前춤 loader | 已证实（两路交叉对齐） | `client/src/hooks/useChatStream.ts:180-196,264,446-481,843`；`services/apiClient.ts:150-160` |
| AUDIT-008 | UX·功能 | **「重新生成 / 从某步重跑」半失效** | `AgentWorkbench.tsx:141-171` 重跑时只发 `resumeFromCallId`，**从不发 `overrideArguments`**；而 `ToolCallCard.tsx:60,194` 的注释明写「从某步重跑（callId + overrideArguments）」，服务端 `agent.schema.ts:23` 支持该字段（`agent-loop.service.ts:477` 消费） | 「改参数重跑」这条核心干预路径在 UI 上根本走不通；**注释承诺了能力、代码没实现** | 已证实 | `client/src/components/agent/AgentWorkbench.tsx:141-171`；`server/src/validators/agent.schema.ts:23`；`services/agent/agent-loop.service.ts:477` |
| AUDIT-009 | UX | **审批过期 = 死锁，没有任何出口** | 令牌 5 分钟有效，超时后 `ApprovalCard.tsx:47-52` 把 4 个按钮全置灰；服务端**只有** `POST /approvals/:id` 与 `/revise`，无重新签发/重新发起端点 | 用户离开 5 分钟回来，任务就此卡死，唯一出路是重跑整条链路。UI 却只留一排灰按钮，用户会反复点或干脆关掉 | 已证实 | `client/src/components/agent/ApprovalCard.tsx:47-52`；`services/agent/approval.service.ts:143`；`controllers/approval.controller.ts`（仅两端点） |
| AUDIT-010 | UX | **运行中整个输入区不可点击** | `.input-area.running * { pointer-events: none }` | 流式的设计初衷是「边看边改」，但运行中连切换宽度布局/换模型/重新生成全点不了，必须干等。`.thinking-chip` 因绝对定位逃出栅格而侥幸可点，是偶然不是设计 | 已证实 | `client/src/styles/style.css:437-439`；`client/src/ui-components.js:313-325,107-119` |
| AUDIT-011 | UX | **SSE 出错先清空已渲染内容** | `handleSseError` 先 `clearStreaming()` 再显示错误 | 工具失败或中途流错误时**已产出正文全部消失**，只剩一行错误提示 | 已证实 | `client/src/ui-components.js:1102-1108,1141-1154` |
| AUDIT-012 | UX | **Toast 通知永不显示** | `ui-components.js:570` 拼的是 v1 的 `.toast-title`/`.toast-message`，而 v4 未定義该 CSS；`.toast` 默认隐藏，需 `.show` 才出现，而代码从不加 | 操作结果全部静默，用户以为「点了没反应」而反复操作 | 已证实 | `client/src/ui-components.js:570`；`client/src/styles/style.css:1296-1308` |
| AUDIT-013 | UX·稳定性 | **localStorage 配额耗尽导致分析结果丢失** | `storage.ts:189-193` 抛 `QuotaExceededError`，上层 `appStore.appendMessage`（`:107-115`）无保护；`:118` 在 reconcile 后也未走到 recovering 分支 | 用户等来的完整分析**保存不进去**，刷新后消失且无提示 | 已证实 | `client/src/services/storage.ts:118,189-193,39-46`；`client/src/stores/appStore.ts:107-115` |
| AUDIT-014 | UX | **移动端 640px 断点永不生效** | `index.html:8` 的 viewport meta **缺 `initial-scale=1`**，移动端按 980px 虚拟视口布局，`980 > 640` 恒不匹配 | 手机/窄屏下布局错位，而断点从未跑起来过 | 已证实 | `client/index.html:8`；`client/src/styles/style.css:1026-1052` |
| AUDIT-015 | UX·功能 | **工具结果与文本的先后顺序由后端决定，切模型即错乱** | `agentStream.ts:161-170` 靠最后一个 `\n\n` 切一刀转 pending，`.replace(toolRe,'')` 还会吃掉后续正文 | 换中转/relay 后整段消失或错位，用户看到「结果先于执行」的不合理顺序 | 已证实 | `client/src/services/agentStream.ts:161-170`；`apiClient.ts:296,299` |
| AUDIT-016 | UX | **乐观更新模型的双向覆盖** | `useChatStream.ts:141-148` 与 `:196` 对同一 Map 各自维护，悲观更新写回后可能被旧的 GET 列表覆盖回去 | 一轮 SSE 完成后会话列表里的「当前模型」被 revert，用户以为没保存 | 已证实 | `client/src/hooks/useChatStream.ts:141-148,196`；`services/store.ts:65-77` |
| AUDIT-017 | 稳定性 | **会话详情 `JSON.parse` 无保护 → 整条会话永久 500** | `sessions.controller.ts:109` 无条件 `JSON.parse(row.args_json)` | 只要一条工具参数因截断而 JSON 损坏，该会话**再也无法打开**，回看历史与跨设备同步全废 | 已证实 | `server/src/controllers/sessions.controller.ts:109` |
| AUDIT-018 | 安全性 | **会话越权：列举/修改/删除未绑定设备凭据** | `sessions.controller.ts:71-76`（列表）与 `:129`（变更）均不校验 `X-Device-Token` | 同一实例上任何来访者可列举并尝试删除他人会话 | 已证实 | `server/src/controllers/sessions.controller.ts:71-76,129` |
| AUDIT-019 | 功能·稳定性 | **HTTP 工具 4MB 上限导致挂起后被误判超时，且非幂等请求会被重试** | `http-request.tool.ts:78-86` 超 CAP 只 `req.destroy()`，不等 error 直接 resolve → 通常被识别为 TIMEOUT（`retryable:true`），POST 等非幂等请求同样走自动重试 | 抓大网页伪装成超时；更危险的是 POST 被再发一次 | 已证实 | `server/src/tools/builtin/http-request.tool.ts:78-86,196-206,217-226` |
| AUDIT-020 | 安全性 | **HTTP 重定向跨跳转不重跑 SSRF 校验** | 重定向目标（`:213-221`）重校验不完整 | 一个公开 URL 可 302 跳内网并把响应正文带回来 | 高危 | `server/src/tools/builtin/http-request.tool.ts:213-221` |
| AUDIT-021 | 稳定性 | **并发闸裸读 `process.env`，非法值即永久瘫痪** | `agent-concurrency.ts:9` `Number(process.env.AGENT_MAX_CONCURRENT ?? 3)`——P2-8 只迁了 HTTP 工具两个旋钮，这个漏了。`'3 '`→`NaN` 使比较恒 false（永久放行）；`'0'` 永久 429；`'abc'` 永不放行 | 配错一个值，要么并发防护全失效，要么 agent 完全不能用 | 已证实（总监读码复核） | `server/src/middlewares/agent-concurrency.ts:9` |
| AUDIT-022 | 安全性 | **限速桶满会一次性清空所有人计数** | `rate-limit.ts` 的 `takeSlot`：`buckets.size >= MAX_TRACKED_KEYS` 时直接 `buckets.clear()` | 攻击者用不同 IP 打满 10 万键 → 所有人限流计数瞬间归零 | 已证实（总监读码复核） | `server/src/utils/rate-limit.ts`（`MAX_TRACKED_KEYS` 与 `takeSlot`） |
| AUDIT-023 | 安全性 | **Docker 构建上下文未排除 `.env`（已修复）** | 初版 `.dockerignore` 全文无 `.env`，`Dockerfile:17` `COPY server/ ./` 会连带 `/server/.env`；**经修复，`.dockerignore` 现排除 `.env` / `.env.*`** | `LLM_SERVER_API_KEY` 进镜像层，推仓库即泄漏，须重建 + 轮换密钥才能消除 | 已证实（两路印证） | `.dockerignore`；`Dockerfile:17` |
| AUDIT-024 | 功能·性价比 | **压缩事件只下发不落库，刷新/重跑即丢，且可能二次付费压缩** | `context-manager.service.ts:146,154` 只 emit；`agent-loop.service.ts:367,390-393` 抛错分支直接丢弃；`schema.ts:37` 无持久化列；`sessions.controller.ts:107` 详情投影也无此字段 | 用户事后无法解释「为什么上下文被裁了」；续跑时因无锚点可能重复压缩，白花一次摘要钱 | 已证实（两路印证） | `context-manager.service.ts:146,154`；`agent-loop.service.ts:367,390-393`；`repositories/schema.ts:37`；`sessions.controller.ts:107` |
| AUDIT-025 | 稳定性·UX | **SSE 协议两端都不支持断点续传** | 服务端 `utils/sse.ts:19-23,29-35` 只发 `event:`+`data:`；`agent.controller.ts:21-57` 不读 `Last-Event-ID`；客户端 `sse.ts:65-124`、`api.ts:117-123` 重连即全量重跑 | 网络抖动后**重跑整个 agent 链路**，工具副作用可能重复触发、账单翻倍 | 已证实（两路印证） | `server/src/utils/sse.ts:19-23,29-35`；`controllers/agent.controller.ts:21-57`；`client/src/services/sse.ts:65-124`；`services/api.ts:117-123` |
| AUDIT-026 | 稳定性 | **健康检查不健康** | `health.controller.ts:23` 硬编码 `>=7` 而实际 9 张表；`:48-52` 的 `dbSizeBytes` 读 `process.env.AGENT_DB_PATH` 而非 `config.agentDbPath`（桌面/自定义路径恒为 0）；`:31` 只 `existsSync` 不真写；`:36-43` 永不返回非 200 | 容器编排/探针永远「OK」——磁盘满、表缺失、沙箱只读都探不出来 | 已证实（总监读码复核） | `server/src/controllers/health.controller.ts:23,31,36-43,48-52` |
| AUDIT-027 | 功能·性价比 | **ReAct 通道的工具目录不计入上下文占用率** | `agent-loop.service.ts:273` 传 `undefined`，恰好是自己注释警告会漏计的那个分支 | ReAct 通道下工具目录不进 75% 阈值计算 → 压缩触发过晚，直接撞上游 400 | 已证实 | `server/src/services/agent/agent-loop.service.ts:273` |
| AUDIT-028 | 性价比 | **无 token 预算、无 usage 对账出口** | `loop-budget.ts:10-22` 只有轮次上限与 180 秒倒计时；controllers 全文 `usage` 零命中 | BYOK 用户**无法知道一次任务花了多少钱**，异常飙升无预警 | 已证实 | `server/src/services/agent/loop-budget.ts:10-22` |
| AUDIT-029 | UX·稳定性 | **桌面端口漂移导致用户数据「丢失」** | `main.cjs:175-196`：端口被占用时递增重试（`:181-185`）并写入 `server-port.json`；localStorage 按 origin（含端口）分区 | 若其他程序抢了惯用端口，端口一漂，会话/设置/API Key 全部换到新 origin 而看不到，用户以为被清空 | 高危（需真机复现端口漂移） | `desktop/main.cjs:175-196` |
| AUDIT-030 | 稳定性 | **桌面日志无轮转，`unhandledRejection` 不落盘** | `main.cjs:124` 以 append 常开写流无切分；`:141-147` 中 `uncaughtException` 写 `logStream`，而 `unhandledRejection` 只 `console.error` | 打包态无 stdout，promise 类崩溃在日志里查不到；`server.log` 长期无界增长 | 已证实（总监读码复核） | `desktop/main.cjs:124,141-147` |

## 3. P2 · 中等（卫生 / 一致性 / 资源）

> 本表记录审计发现时点的原始问题；各项**修复状态**见 §5.5 总览与 §6 落地证据。

| # | 维度 | 缺陷 | 具体表现 | 影响 | 确定性 | 证据 |
|---|------|------|----------|------|--------|------|
| AUDIT-031 | UX·文档 | **README 严重过时，且隐私表述与实际相反** | 环境变量表只写 6 项而 `env.ts:8-40` 实际 22 项；`AGENT_DB_PATH` 默认写成 `server/data/agent.db`，代码事实是 `<pkg>/data/codelens.db`；构建命令写「在仓库根目录执行」但命令内含 `cd server`；**更关键：`README.md:3` 承诺「对话存在自己浏览器里」，而 §0 已证实会话其实写在服务端 SQLite**，涉 export/away 表述冲突；通篇未提桌面端与 v2 平台 | 新人按 README 操作必踩坑；隐私表述失实属对外承诺问题，比单纯过时严重 | 已证实（总监逐条比对） | `README.md:3,23,44,55-63`；`server/src/config/env.ts:8-40,152` |
| AUDIT-032 | UX·一致性 | **交付物校验值与文档不符（已修复）** | 文档曾写 SHA256 `eee61484...`、大小 `129,010,150`；实测 `80293c78...`、`129,617,021`。**经本轮复核，安装说明已更正为实测值**，用户核对可一致 | 文档把 SHA 作为「确认安装包没被损坏」的唯一手段，若沿用旧值用户核对必然失败 | 已证实（总监 `sha256sum`+`stat` 实测） | `docs/桌面端安装说明.md:11-12,99-100` |
| AUDIT-033 | 性价比 | **仓库卫生：测试库与打包废物未排除（已缓解）** | `.gitignore` 现**已**排除 `data/`、`*.db`、`*.db-shm`、`*.db-wal` 及历史 `desktop/release-final*` 残留；初版审计时尚未覆盖，故原登记为缺陷。剩余风险仅为历史 `desktop/release2/` 等非仓库内产出目录（体积大、需手动清理） | 测试残留可能被提交；历史打包废物需手动清理 | 已实测 | `.gitignore:13-22`；`data/`；`desktop/` |
| AUDIT-034 | 稳定性 | **`engines.node` 与 `node:sqlite` 真实下限不符** | `server/package.json` 声明 `>=20.19`，而 `node:sqlite` 要求 `>=22.5` | Node 20/21 上构建通过、运行期才炸 | 已证实 | `server/package.json`；`repositories/db.ts:6` |
| AUDIT-035 | 一致性 | **`listPermissions` 文档与实现不符** | `approval.service.ts:1046` 文档列出四种批准模式，实际策略少于四种 | 调用方按文档处理会走到未定义分支 | 高危 | `server/src/services/agent/approval.service.ts:1046` |
| AUDIT-036 | 性能 | **Path jail 每次调用做同步 `realpathSync`** | `path-jail.ts:17-18` 每次解析都同步 stat/realpath | 工具密集场景（批量文件读写）阻塞事件循环 | 已证实（总监读码复核） | `server/src/tools/builtin/path-jail.ts:17-18` |
| AUDIT-037 | UX | **两个 Toast 同时弹，文案自相矛盾** | `ui-components.js:337-380` 代码优化的成功与失败提示会在同一操作上同时出现 | 用户不知道到底成功没有 | 已证实 | `client/src/ui-components.js:337-380` |
| AUDIT-038 | 功能·一致性 | **content Suffix 缺兼容性分支** | `constant.ts:119-127` 的 SYSTEM_SUFFIX 缺少 MCP/自定义 provider 兼容处理 | 部分 provider 下后缀注入行为异常 | 高危 | `server/src/services/mcp/constant.ts:119-127` |
| AUDIT-039 | 功能 | **Final Review 死开关** | `server/src/app.ts:160` 的启用条件依赖一个 Edit Settings 未暴露的变量 | 用户期待的「完成校验」永不出现 | 高危 | `server/src/app.ts:160` |

## 4. 撤案记录（经复核不成立，防止误报进结论）

| 原怀疑项 | 复核方式 | 结论 |
|----------|----------|------|
| `lucide-react: 1.60.0` 版本号伪造 | 总监 `npm view lucide-react versions` 实测 | 官方已进 1.x 线（最新 1.61.0，1.60.0 在版本列表内），**非伪造**，撤案 |
| 前端 emoji 图标违规 | 总监 grep 全量 `client/src` | **零命中**，P0-1 合规 |
| 硬编码色值 | 总监 grep 全量 `client/src` | 45 处命中全部落在 `design-tokens.css`（token 定义源），合法 |
| 桌面 Electron 安全三开关 | 专家取证 + 总监复核 | `contextIsolation:true` / `nodeIntegration:false` / `sandbox:true` 全部正确，同源校验还规避了 userinfo 绕过 |
| DiffView 删除是否安全 | Explore-2 初判「可删」，后主动撤回 | 依据 `docs/agent/phase1-prd.md:1001`「降级为内置提示词模板继续提供」——决策是保留，故改判为「承诺未兑现」（AUDIT-006） |

## 5. 按维度交叉索引

| 维度 | 条目 | 判断 |
|------|------|------|
| 功能缺陷 | 001, 002, 003, 006, 008, 015, 019, 024, 027, 038, 039 | 最重的 001 是**修复自身引入的回归且被单测锁住**；002 让联网能力实际不可用 |
| 用户体验 | 007, 009, 010, 011, 012, 013, 014, 016, 029, 031, 037 | 一句话概括：**用户预期存在的东西，实际路径是断的** |
| 性能瓶颈 | 013（配额即隐性上限）、024（重复压缩）、025（抖动即全链路重跑）、033、036 | 单条不致命，叠加为「越用越卡、越用越贵」 |
| 稳定性 | 004（session 永久不可用）、017, 019, 021, 026, 029, 030, 034 | 最痛的是 004：无 try/finally 让**可恢复异常升级为永久不可用** |
| 安全性 | 002, 005, 018, 020, 022, 023, 032 | 共性不是「没想到」，而是**宣称了防线却没接线**（005）或**防线可被单点绕过**（022） |
| 性价比 | 001, 024, 025, 027, 028, 033 | 根子是没有 cost observability：看不到花销，偏差无预警 |

## 5.5 修复状态总览（截至 2026-10-26 复核）

> 审计报告共登记 **39 条缺陷**（其中 AUDIT-013 本轮经代码核对为 v2.0 重构后的误报，转入 §4 撤案；**另 5 项**为审计期独立撤回项）。经本轮逐文件复核真实产物，状态如下：

| 状态 | 条目 | 计数 |
|------|------|------|
| 已修复 · 服务端代码 + 对偶测试 | 001, 002, 003, 004, 017, 018, 021, 022, 026, 034 | 10 |
| 已修复 · 跨端（AUDIT-005 two_step 双确认） | 005（服务端 fail-closed 强制双确认 + 客户端两步进度/锁定 UI） | 1 |
| 已修复 · 跨端（AUDIT-009 审批续期防死锁） | 009（服务端 `prolong` 重签发令牌 + 重置 park 计时器；客户端临过期 30s 自动续期） | 1 |
| 已修复 · 桌面端 | 029（端口冲突同端口重试 / 干净失败，不再漂移丢数据） | 1 |
| 已修复 · 文档 / 配置 | 023、032、033、031 | 4 |
| 架构已解决 · 误报撤案（v2.0 重构后不存在） | 013（客户端已不向 localStorage 写会话体，仅持久化 settings/device-token 小键；无 QuotaExceededError / appendMessage 客户端写路径） | 1 |
| 待立项 · 契约级（需回需求澄清） | 025（SSE 断点续传）、028（token 预算与对账） | 2 |
| 开放 · 待排期（前端为主 + 部分服务端） | 006, 007, 008, 010, 011, 012, 014, 015, 016, 019, 020, 024, 027, 030, 035, 036, 037, 038, 039 | 19 |

> 合计：**17 条已修复**（服务端 10 + 跨端 2：005/009 + 桌面端 1：029 + 文档/配置 4：023/032/033/031），**1 条架构已解决（013 误报撤案）**，**21 条待处理**（2 契约级：025/028 + 19 开放）。AUDIT-005 / AUDIT-009 两端均已落地；AUDIT-017/018（服务端）、AUDIT-029（桌面端）本轮补齐。AUDIT-031 仅完成**事实性校正**，README 的产品隐私定位仍需你拍板（见 §6.2 末）。

---

## 6. 修复批次（实际执行状态）

> 验收口径：服务端 `vitest` **31 文件 270 例全部通过**（基线 28 文件 260 例 + 本轮新增 10 例），`tsc --noEmit` **0 错误**。

| 批次 | 内容 | 状态 | 验证 |
|------|------|------|------|
| 批次一 · 服务端 P0/P1 | AUDIT-001 / 002 / 003 / 004 / 005 / 021 / 022 / 023 / 026 | **已完成** | 代码改动 + 对偶用例，全量测试绿 |
| 批次一 · 附带 | AUDIT-034 `engines.node` 下限（≥22.5.0，匹配 node:sqlite） | **已完成** | `package.json` + tsc |
| 批次二 · 文档（已落地） | AUDIT-032 安装包 SHA 更正、AUDIT-033 仓库卫生 `.gitignore` | **已完成** | 本轮复核确认：安装说明 SHA 已 = 实测 `80293c78…` / `129,617,021`；`.gitignore` 已覆盖 `data/`、`*.db`、`*.db-shm`、`*.db-wal`、`desktop/release-final/` |
| 批次二 · 文档（剩余） | AUDIT-031 README 隐私表述校正 | **已完成（事实性校正）** | README 第 3/10/20/80/83 行「对话存在浏览器 / 无服务端数据库」已改为服务端 SQLite 事实表述；**产品隐私定位（持久化 vs 本地）仍需你确认**，见 §6.2 |
| 批次三 · 契约级 | AUDIT-025 SSE 断点续传、AUDIT-018 会话越权、AUDIT-028 预算与对账 | **未执行** | 需回需求澄清，单独立项 |

**修复铁律**：每条修复必须配一条「能把它打红」的对偶用例；发现现有测试把错误行为锁住时，**改的是断言而不是视力**。

### 6.1 各条目落地证据

| # | 文件:行号（改动后） | 修复要点 | 对偶用例 |
|---|----------------------|----------|----------|
| AUDIT-001 | `context-manager.service.ts:226-236` `message.repository.ts:61-74` | 压缩锚点落在 head/tail 边界（`insertAt` 整体后移），`live = rows.slice(anchorIdx+1)` 含 L3 tail | `context-manager.test.ts` 回归守卫（见 §7） |
| AUDIT-002 | `http-request.tool.ts:161-170` | 出站请求头逐字发送，`maskHeaders` 仅用于回显/落库 | `http-request-auth.test.ts` |
| AUDIT-003 | `executor.service.ts:284-360` | `runHandler` 的 controller 转发任务级 `signal`，`ctx.signal` 随「停止」触发 | `executor.service.test.ts` |
| AUDIT-004 | `agent-loop.service.ts:123-463` | `run()` 包 `try/finally` 释放注册表，任何出口都不泄漏 session 槽位 | `agent-loop-e2e.test.ts` |
| AUDIT-005 | `executor.service.ts:110-216`（服务端） | `two_step` 模式需两次独立确认，单次 allow 不再能删空沙箱（服务端已强制） | `executor.service.test.ts` |
| AUDIT-005（客户端） | `client/src/stores/approvalStore.ts`（`upsert` 步进推导 + `ackPass` 锁定）、`client/src/components/agent/ToolApprovalBar.tsx`（「第 N/2 步」进度 + 非终步确认后禁用按钮） | 两步确认进度对用户可见；第一步确认后锁定按钮直到第二步挑战到达，避免重复提交已决令牌（409） | `client/tests/approval-store.test.ts`（新增 7 例） |
| AUDIT-021 | `agent-concurrency.ts:23` | 改消费已校验的 `config.maxConcurrentAgents`（zod int 1–16，默认 3），消除 `Number(process.env)` 的 NaN/0 死锁 | `agent-concurrency.test.ts`（新增） |
| AUDIT-022 | `rate-limit.ts`（`RateLimiter` 类） | 满桶时**有界淘汰**（先清过期、再淘汰单个最旧桶），不再 `buckets.clear()` 清零所有人 | `rate-limit.test.ts`（新增 AUDIT-022 describe） |
| AUDIT-023 | `.dockerignore:13-19` | 构建上下文排除 `.env` / `.env.*`，避免 `LLM_SERVER_API_KEY` 进镜像层 | 构建期排除（人工核对） |
| AUDIT-026 | `health.controller.ts` + `schema.ts:191-196` | 表数由 `EXPECTED_TABLE_COUNT` 推导（取代硬编码 7）；DB 路径用 `config.agentDbPath`（取代 `process.env`）；沙箱可写性以**真实写文件**判定 | `health.controller.test.ts`（新增） |
| AUDIT-034 | `server/package.json:7-9` | `engines.node` 改为 `>=22.5.0`，匹配 `node:sqlite` 真实下限 | `tsc` 通过 |
| AUDIT-032 | `docs/桌面端安装说明.md:11-12,99-100` | 安装包大小与 SHA256 已更正为实测值 `129,617,021` / `80293c784150…2435`，与 `sha256sum` 实测一致 | 人工核对文件 |
| AUDIT-033 | `.gitignore:13-22` | 已排除 `data/`、`*.db`、`*.db-shm`、`*.db-wal`、历史 `desktop/release-final*` 打包残留 | 人工核对文件 |

### 6.2 AUDIT-005 客户端收尾（已解决）

服务端 fail-closed 强制 `two_step` 双确认（不可逆的删沙箱根需两次确认，缺第二次确认则任务阻塞）已落地；本轮补齐**客户端第二次确认的呈现**，使两端闭环：

- `approvalStore.upsert` 现在按 `callId` 识别 two_step 的「第二步」（不同 `approvalId` 即 +1），在 VM 上记录 `pass` / `totalPasses`（固定 2）；`soft`/`hard` 不计数。
- `ToolApprovalBar` 渲染「两步确认 · 第 N/2 步」进度点（已完成步显示 ✓），并在第一步确认后调用 `ackPass` 把 `awaitingNextStep` 置真，**禁用决策按钮**，直到第二步挑战到达（`upsert` 把 `awaitingNextStep` 复位）。这同时消除了两步之间的按钮复位窗口——此前若第二步挑战因网络稍迟到达，用户会对同一已决令牌重复提交，触发 `APPROVAL_ALREADY_DECIDED`（409）报错。
- 配套 `client/tests/approval-store.test.ts`（7 例）覆盖：首步计数、第二步 +1、幂等（同 id 不 +1）、`ackPass` 锁定、第二步到达解除、`soft`/`hard` 不计数。

**AUDIT-031 产品定位待你拍板（非缺陷）**：本轮只校正了 README 的事实性错误（「对话存在浏览器 / 无服务端数据库」→ 服务端 SQLite 持久化）。但「对话由服务端持久化存储」本身是一个**产品隐私定位决策**，之前对外宣称是浏览器本地。是否维持服务端持久化、是否需要在 UI 明示留存期与删除能力，需在需求侧确认——代码已如实反映现状，文案方向请定夺。

## 7. 决策日志

```
[2026-10-26] Phase 审计 - 三路并行取证 + 总监逐条复核 - 39 条入册，撤案 5 项
[2026-10-26] 门禁裁决 - AUDIT-001 三路独立印证且现有单测锁住错误行为 → 最高优先，修复须同改测试断言
[2026-10-26] 门禁裁决 - lucide-react 版本存疑经 npm 实测证伪 → 撤案，防止误报写进结论
[2026-10-26] 采纳改判 - DiffView 初判「可删」经 PRD 决策原文复核后撤回 → 升格为承诺未兑现
[2026-10-26] 门禁裁决 - AUDIT-025/018/028 属契约级改造 → 单独立项，不混入缺陷修复批次
[2026-10-26] 修复执行 - AUDIT-001/002/003/004/005/021/022/023/026/034 全部落地，服务端 vitest 31 文件 270 例通过、tsc 0 错
[2026-10-26] 回归修正 - 前轮 context-manager 测试编辑遗留 2 例失败（桩摘要缺证据 + P2-5 用例 usage 行种错位置）：
            ① 给 nineSectionSummary 桩补数字/路径证据以通过保真门槛（非放宽生产断言）；
            ② P2-5 用例将 seedWithUsage 调到 seed 之前，使 30k usage 真正落在锚点前、被压缩覆盖；
            ③ AUDIT-021 并发闸原裸读 process.env → 改消费已校验 config（'abc' 启动即报错、'0' 被 min(1) 兜住，不再静默失效）
[2026-10-26] 报告复核 - 逐文件核对真实产物，发现 AUDIT-032（安装说明 SHA 已 = 实测）、AUDIT-033（.gitignore 已覆盖 data/*.db）**实际已修复**，但 §6 误标「未执行」→ 更正为「已完成」；AUDIT-031 README 经核对仍含「无服务端数据库 / 对话存在浏览器」失实表述 → 维持「未执行 / 待立项」。报告新增 §5.5 修复状态总览，消除「39 条全 open」的误导
[2026-10-26] 修复执行（续） - AUDIT-005 客户端收尾：approvalStore 加 two_step 步进（pass/totalPasses）+ ackPass 锁定，ToolApprovalBar 渲染「第 N/2 步」进度并在非终步确认后禁用按钮防重复提交（409）；新增 client/tests/approval-store.test.ts（7 例）。AUDIT-031 README 事实性校正（浏览器存储 → 服务端 SQLite），产品隐私定位留待确认
[2026-10-26] 验收 - 客户端 tsc --noEmit 0 错；vitest 全量通过（含新增 7 例 approval-store）；服务端此前 31 文件 270 例维持通过
```

---

*每条均可通过 `文件:行号` 复核。凡标「高危」者缺实测复现路径，不作结案依据。*

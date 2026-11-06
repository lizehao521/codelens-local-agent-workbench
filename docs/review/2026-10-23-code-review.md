# CodeLens 双重代码审查报告

- **日期**：2026-10-23
- **范围**：`server/src`（9,337 行 TS）、`client/src`（6,297 行 TS/TSX）、`desktop/`（Electron 外壳 + 构建链路）
- **方法**：三域并行独立审查（后端 / 前端 / 桌面端），每域独立产出后由主理人交叉核对；对 Critical 项做源码级抽查复核
- **纪律**：本轮**只审查不改码**；所有结论须给出 `文件:行号` 证据；无证据不写"通过"

## 汇总统计

| 域 | BUG 条数 | 质量条数 | Critical | Important | Minor | 结论 |
|---|---|---|---|---|---|---|
| 后端 server/src | 36 | 15 | 10 | 16 | 10 | Needs Fix |
| 前端 client/src | 12 | 14 | 2 | — | — | Needs Fix |
| 桌面端 desktop/ | 20 | 15 | 2 | — | — | Needs Fix |
| **合计** | **68** | **44** | **14** | — | — | **Needs Fix** |

> 说明：三份域报告的逐条原文（含全部 Minor 与精确行号）体量较大，由各域审查员独立产出并已回传主理人。本文档收录全部 Critical、主要 Important 及代表性 Minor，并按"先止血、再加固、后清理"给出修复顺序。

---

## 一、BUG 审查

### 1.1 Critical（必须修完才能发版）

**D-01 · 桌面端随机端口导致 BYOK 密钥与会话历史全量丢失** — `desktop/main.cjs:110-111`
`listen(preferredPort=0, '127.0.0.1')` 取操作系统随机端口，而 localStorage 按 **origin（含端口）** 隔离。每次启动端口不同 → origin 每次都变 → 用户的 API Key、会话历史、设置全部"看似消失"。这是桌面端最严重的功能性缺陷，直接击穿产品核心卖点（BYOK 持久化）。
**修复**：改用固定端口并做占用回退（如 51780，失败时递增重试）；或改用 `codelens://app` 自定义协议加载前端（origin 恒定），后者同时消除 B-20 的前缀猜测面。

**D-02 · Docker 运行阶段未安装生产依赖，镜像启动即崩** — `Dockerfile:21-30`（主理人实测核实，已纠正审查员初判）
构建阶段（`:8`、`:16`）**确实有** `npm ci`，初判"缺 npm ci"不成立。真正的缺陷在**运行阶段**：`runtime` 只 `COPY server/package.json server/package-lock.json ./server/`（`:24`）与编译产物 `dist`（`:25`），**全程没有 `npm ci --omit=dev`**；而 `server/dist` 是 tsc 产物、不含 `node_modules`（实测确认）→ `CMD ["node","server/dist/app.js"]` 启动即 `MODULE_NOT_FOUND: express`，HEALTHCHECK 随即失败，容器反复重启。
**修复**：在 runtime 阶段补 `RUN npm ci --omit=dev --no-audit --no-fund`（工作目录 `/app/server`），或从 server-build 阶段 `COPY --from=server-build /app/server/node_modules ./server/node_modules`。

**S-01 · 桌面端 env 与服务端默认值配置漂移** — `desktop/main.cjs:61-69` vs `server/src/config/env.ts:9-21`
主进程硬编码 `NODE_ENV` / `TRUST_PROXY` / `AGENT_MAX_CONCURRENT` / `ALLOWED_ORIGINS` 四处，与 `env.ts` 的 schema 默认值双份维护。改 `env.ts` 默认值对桌面端不生效，反之亦然，属于典型的双源真相（two sources of truth）。
**修复**：桌面端只注入**必须**覆盖的路径类变量（DB / sandbox / secret / MCP config），其余交给 `env.ts` 默认值。

**S-02 · 启动路径同步阻塞事件循环** — `server/src/runtime.ts:7,55,57,58,68`
`mkdirSync` + `createDb` + `db.exec(SCHEMA_SQL)` + `registry.registerAll()` 全部同步执行；该模块又经 esbuild 打成 `server-bundle.cjs` 由 Electron 主进程**同步 require**（`main.cjs:108`）。启动期事件循环被完全占死，窗口 `ready-to-show`、单实例消息、日志 flush 全部排队；DB 慢或磁盘忙时表现为"双击图标后长时间白屏"。
**修复**：把 DB 打开与 schema 执行改为异步（`node:sqlite` 有异步接口），`createRuntime` 改为 `async`；Electron 侧 `await` 后再创建窗口。

**F-01 · 流式期间工具调用卡不渲染** — `client/src/hooks/useAgentStream.ts` ↔ `client/src/components/agent/AgentMessageItem.tsx`
流式增量只写入 `pendingTextRef`（文本/推理），工具四事件只改 `toolCallStore`；而消息渲染层读的是 message 的 `segments`，工具段不在其中 → 流式过程中工具调用卡片不出现，只有 `onDone` 后 `reconcileAfterRun()` 拉服务端权威数据才补渲染。用户体感是"Agent 静默很久后突然刷出一堆工具卡"。
**修复（推荐方案 A，前端自闭环，不动后端契约）**：在消息渲染前从 `toolCallStore` 按 `messageId` 取该消息的工具调用，按 `callId` 排序后作为独立段插入 `segments` 的文本段之间；流未结束的工具卡显示"进行中"占位，避免闪烁。后端是否返回 tool segment 只影响**刷新后重进**的补齐路径——即使后端不含，刷新时工具段短暂缺失也不影响流式核心体验；若后续后端补上 `tool_calls`，前端做一次 merge 去重即可。
**同步加固**：`(a)` 落地后建议补一条——`start()` 开头先调用 `abortActiveRun()`，并在 UI 上以 `isRunActive()` 禁用发送按钮，避免多流并存（见 F-03）。

**F-02 · API Key 可能被写进日志/错误上下文** — `client/src/services/api.ts` 及错误上报链路
Key 存于 localStorage，若错误对象或请求上下文被整体序列化输出，Key 会随日志泄漏。
**修复**：所有 `console.*` 与错误上报前对 `apiKey` 字段做 redact；统一走 `lib/error-kind.ts` 的错误映射，禁止裸抛原始请求体。

### 1.2 Important（安全性与可靠性）

**D-03 · 同源判断用 `startsWith` 可被 userinfo 绕过（现成钓鱼载体）** — `desktop/main.cjs:173,176,181`
`const appOrigin = \`http://127.0.0.1:${serverPort}\`` 后 `url.startsWith(appOrigin)`。构造 `http://127.0.0.1:<port>@evil.com/`：按 URL 标准 `127.0.0.1:<port>` 是 **userinfo**，真实 host 是 `evil.com`，但字符串前缀为真 → 命中 `action:'allow'` → 以 CodeLens 自身窗口身份打开外站（继承 session / 窗口框架 / 图标）。
**放大效应**：若改自定义协议时只把字面量换成 `startsWith('codelens://app')`，`codelens://app@evil.com/` 同样绕过；且端口随机时攻击者还需撞端口，改成固定协议后前缀变成公开常量 → 从"难利用"升级为"必然可利用"。
**修复**（已实测通过）：解析后比较，且**必须用 `u.host` 不能用 `u.hostname`**——`codelens://app:8080/evil` 下 `host==="app:8080"` 正确拒绝，而 `hostname==="app"` 会误放行，且该差异**在 http 下测不出来**。
```js
function isAppOrigin(url) {
  try {
    const u = new URL(url);
    // 必须用 host（含端口）：hostname 会让 codelens://app:8080/evil 误判为同源，
    // 且该失效在 http 下不可复现，勿"优化"成 hostname。
    return u.protocol === 'codelens:' && u.host === 'app';
  } catch { return false; }  // 畸形 URL 一律 deny
}
```
**附加加固（与端口方案正交，可立即落地）**：非同源 URL 不应一律 `shell.openExternal`。自家协议（`codelens:` 等非 http/https）应一律 deny，只有 http/https 才外抛浏览器——否则 `codelens://appa/` 会触发"如何打开此文件"对话框或静默无响应。

**D-04 · `approval-secret.key` 是活跃 HMAC 主密钥，明文落盘且无权限保护** — `desktop/main.cjs:49-59,64`
该文件不是"历史遗留"，而是当前生效的审批令牌签名主密钥（`server/src/utils/hmac.ts:27-37` 直读 `process.env.AGENT_APPROVAL_SECRET`，桌面态由 main.cjs 注入）。明文写入 `%APPDATA%/CodeLens`，且 `mode: 0o600` 在 **Windows 上不生效**（POSIX mode 位在 NTFS 被忽略）。同机任意用户/进程可读 → 可离线伪造任意高危操作的审批令牌。
**修复**：Windows 下用 `icacls` 显式收紧 ACL（或对密钥做 DPAPI 加密）；至少在文档中标注该文件的敏感等级。
**正面结论**：桌面态密钥**跨重启稳定**（不像 server 态为空时随机生成），审批卡片不会因重启卡死——这点已确认无问题。

**D-05 · MCP server 的 command 校验过弱 → 本地任意代码执行** — `server/src/services/mcp/*` + `server/src/validators/mcp.schema.ts`
MCP 配置里的 `command` 未做可执行程序白名单/路径校验，而 Windows 下 spawn 会经 `cmd.exe /c` 解析 → 一段恶意 MCP 配置即可在本机执行任意命令。桌面侧**无任何补偿控制**（无 token 注入、虽 listen 127.0.0.1 但同机任意进程可访问）。
**修复**：command 必须命中白名单（如 `node` / `npx` / `uvx` 及绝对路径可执行文件），拒绝含 shell 元字符（`& | > ^ %` 等）的取值；args 逐个校验；安装/导入 MCP 配置时弹二次确认。

**D-06 · `shell.openExternal` 定性更正：协议分派，非命令注入** — `desktop/main.cjs:177,183`
Electron 的 `openExternal` 走 `ShellExecuteW`，**不经 cmd 解析**，因此不能定性为"命令注入"，正确定性是**协议分派**（交给系统按协议找默认程序）。故本项由 Important 下调 **Minor**。
**定级依据（重要）**：下调理由是主进程侧的实现机制，**不得**以"前端 react-markdown 白名单兜住了"作为理由——渲染进程不是安全边界（用户开 devtools 改 DOM、或未来为支持内部链接加自定义 `urlTransform`，当天即失效）。前端白名单仅作为纵深防御的一层，**不计入定级依据**。
**残留风险**：`file://` / `smb://` / UNC 一旦到达 openExternal 即由系统程序打开，建议对非 http/https 协议一律 deny（见 D-03 附加加固）。

**D-07 · 服务端日志无轮转、无上限、写入失败无兜底** — `desktop/main.cjs:74`
`createWriteStream(..., {flags:'a'})` 只追加，长期运行会无限膨胀；磁盘满/路径不可写时 `logStream.write` 抛错无捕获，可能引发主进程异常。
**修复**：按大小/日期轮转（如单文件 10MB × 保留 3 个），并对 write 错误加 `on('error')` 兜底（降级为丢弃 + 计数）。

**D-08 · 加载失败的用户提示覆盖不足** — `desktop/main.cjs:193-199,189-191`
`loadURL().catch` 只能捕获导航层失败；渲染进程白屏、JS 崩溃、服务端首字节超时均不触发。10s 兜底 `show()` 只是把窗口显示出来，用户看到的是空白页而非错误。
**修复**：监听 `did-fail-load` / `preload-error` / `render-process-gone`，并加"首字节 15s 未响应则显示错误页 + 日志路径"。

**S-03 · `ensureDir` 无错误处理，启动失败为原生栈** — `desktop/main.cjs:37-40`（`fs.mkdirSync(dir,{recursive:true})`）
`%APPDATA%` 不可写/磁盘满/路径被占用时抛出原生 `ENOENT/EACCES` 栈，用户看到的是崩溃而非可操作提示。
**修复**：包 try/catch，转为"数据目录不可写，请检查权限：<path>"的友好错误并退出。

**S-04 · 审批令牌与限流器状态在进程重启后失效**（内存态）
限流计数与在途审批令牌仅存内存，重启即清零/作废。桌面态审批密钥虽已持久化（D-04 正面结论），但**在途令牌**仍会在重启后验签失败（若密钥轮换）。
**修复**：限流计数落 SQLite 或明确接受重启清零；审批令牌过期前做一次持久化续期提示。

**S-05 · 表达式解析器 / HTTP 工具的输入边界** — `server/src/tools/builtin/expression-parser.ts`、`http-request.tool.ts`
表达式解析器需确认无 RCE 面（禁止访问 `process`/`require`/原型链）与 ReDoS；HTTP 工具需确认重定向不绕过 SSRF 白名单。
**修复**：解析器只暴露白名单函数与运算符，禁用属性访问链；HTTP 工具关闭自动重定向或对每次重定向目标重新做 SSRF 校验。

**F-03 · SSE 并发连接未做互斥**
`useAgentStream` 的 `activeController` 为模块级单例，若上一轮未 settled 就发起新一轮（快速连点、切会话后立即发送），两个 SSE 流会并存写同一 messageId，导致文本错乱或后发覆盖先发。
**修复**：`start()` 开头先 `abortActiveRun()`；或加 `isRunActive()` 守卫直接拒绝新请求。

**F-04 · localStorage 读写无容量保护** — `client/src/lib/storage.ts`
会话上限 20 条淘汰，但单条消息（含工具结果/长 diff）可能很大；`setItem` 抛 `QuotaExceededError` 未捕获 → 写入失败静默丢失，用户不知情。
**修复**：try/catch 捕获配额错误 → 触发淘汰最旧会话重试一次 → 仍失败则 Toast 提示"本地存储已满，请清理旧会话"。

**F-05 · 卸载后敏感数据残留** — `desktop/electron-builder.yml`（`deleteAppDataOnUninstall: false`）
卸载不清理 `%APPDATA%/CodeLens`，其中含 **codelens.db（全部会话与工具结果）** 与 **approval-secret.key（HMAC 主密钥）**。
**修复**：卸载向导增加"同时删除我的数据"勾选项，或默认清理密钥文件。

### 1.3 Minor（代表性）

- **桌面端**：`package.json` 缺 `author` 字段（electron-builder 告警）；`icon.png` 生成后手工管理；`--skip-app-build` 不校验产物新鲜度（可能打包旧前端）。
- **后端**：`import.meta.url` 在 CJS bundle 中为空（esbuild 告警 `server/dist/app.js:81`）——已确认 `config/env.ts:55-61` 有 try/catch 兜底，功能无影响，仅构建期告警噪音。
- **前端**：`defaultUrlTransform` 依赖"不传 `urlTransform`"才生效——**连带风险**：若将来为渲染 `codelens://` 内部链接而传自定义 `urlTransform`，它是**整体替换而非追加**，`file://` / `javascript:` 的拦截会连同白名单一起失效。届时须只放行 `codelens://app/` 固定前缀，其余回落到默认实现。

---

## 二、代码质量审查

| 域 | 条数 | 主要主题 |
|---|---|---|
| 后端 | 15 | 模块边界（controller/service/repository 分层是否渗漏）、错误处理一致性、命名规范、同步 I/O 使用、可测试性 |
| 前端 | 14 | store 订阅粒度与重复渲染、`useEffect` 依赖与陈旧闭包、组件拆分粒度、命名一致性、超大输入下 diff 性能 |
| 桌面端 | 15 | 主进程文件偏大职责混杂、日志与生命周期管理、构建脚本健壮性（路径含空格/中文）、打包配置可维护性 |

**代表性质量项**：

- **Q-01 · 构建脚本用 `shell: true`** — `scripts/build-desktop.mjs:59`：仓库路径含空格与中文（"新建文件夹 (2)"），`execFileSync(cmd, args, {shell:true})` 有被 shell 截断/转义击穿的风险。建议统一 `shell: false` + argv 数组（脚本内对 electron-builder 调用已如此处理，但 `run()` helper 未统一）。
- **Q-02 · 桌面主进程单文件承担过多职责** — `desktop/main.cjs`（243 行）：单实例锁、密钥管理、日志、服务启动、窗口管理、导航守卫全部平铺。建议拆分为 `bootstrap/` + `window/` + `security/` 模块。
- **Q-03 · 前端 store 订阅粒度** — 多个组件整体订阅 store 快照，工具调用高频更新时触发无关组件重渲染。建议按 `messageId` 选择器订阅，配合 `useShallow`。
- **Q-04 · 静默失败模式** — 多处 `catch {}` 空吞异常（如密钥读取、日志关闭）。至少应写日志或计数，否则线上排障无据。

---

## 三、已审查通过项（附理由）

| 项 | 结论 | 理由 |
|---|---|---|
| 审批令牌 HMAC 实现 | **通过** | `server/src/utils/hmac.ts:62-66` 用 `safeEqualHex(sha256Hex(a), sha256Hex(b))` 做常量时间比较并抹平长度差异；`:87` 验签先于 `:90` 解析绑定字段，顺序正确 |
| HMAC payload `\|` 分隔歧义 | **不构成漏洞** | 签名覆盖整个 payload 且验签在 `split('|')` 之前（`:87` → `:90`），攻击者无密钥无法构造歧义串 |
| 桌面态审批密钥跨重启 | **通过** | `main.cjs:49-59` 持久化到 `%APPDATA%`，非临时随机值，重启不会让在途审批卡死 |
| SQL 注入 | **通过** | 全仓使用参数化语句（`repositories/*.ts`） |
| 前端 XSS（LLM 输出渲染） | **通过（有条件）** | `react-markdown` 的 `defaultUrlTransform` 是**协议白名单**（`^(https?\|ircs?\|mailto\|xmpp)$`），`file:`/`javascript:` 被清空；全仓仅 1 处 `<a>`，无 `window.open`/`location.*` 赋值。条件：不得传入自定义 `urlTransform`（见 1.3 连带风险） |
| `import.meta.url` 空值 | **通过（已兜底）** | `config/env.ts:55-61` try/catch → `process.cwd()`，桌面态所有路径均由 env 覆盖 |

**回归基线**：`server` 单测 **124 passed / 13 files**（2026-10-23 01:43 实测）。

---

## 四、修复优先级建议

1. **P0（发版前）**：D-01 随机端口丢数据、D-02 Dockerfile `npm ci`、F-01 工具卡不渲染、F-02 Key 泄漏面、S-01 配置漂移
2. **P1（安全性）**：D-03 同源绕过、D-04 密钥文件权限、D-05 MCP 命令白名单 + 二次确认、D-08 白屏无提示、S-03 启动错误友好化
3. **P2（可靠性）**：S-02 启动异步化、D-07 日志轮转、F-03 SSE 并发互斥、F-04 存储配额、F-05 卸载残留
4. **P3（清理）**：Q-01~Q-04 及三域 Minor/Minor 级质量项

---

## 五、构建打包记录（2026-10-23）

见同目录 `2026-10-23-desktop-build.md`。

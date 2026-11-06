# CodeLens v2.0 测评报告（2026-11-05）

> 测评对象：`c:\Users\Administrator\Desktop\新建文件夹 (2)\新建文件夹 (2)`（CodeLens v2.0）
> 测评方式：本地生产构建（`node server/dist/app.js`，`NODE_ENV=production`，`127.0.0.1:8090`）+ 真实上游（`nvidia/nemotron-3-ultra-550b-a55b`，密钥仅进程内注入）+ 浏览器端到端。
> 数据原则：所有耗时/体积均为实测；无法测量的项明确标注「未测」。本文不含任何密钥内容。

---

## 0. 结论摘要

| 维度 | 结论 | 等级 |
|---|---|---|
| 功能 | 核心闭环可用：一句话 → 工具调用 → 分级审批 → 沙箱落盘 → done，真实上游跑通 | 通过 |
| 功能（异常） | 上游鉴权失败有中文提示，但**免费试用模式未固定 provider/model，导致默认配置下必然 401** | **本轮已修**：试用锁定 NVIDIA + 401/403/超时/网络分类降级，见 §9 |
| 性能 | 静态 p50 5.83 / 11.27 / 5.60 / 3.02 ms，均低于 2026-11-04 基线；首屏 3 关键请求合计 60.65 ms | 通过 |
| 性能（冷启） | 冷启到健康检查 200 约 48.6 s，但同机 `node -e "0"` 也需 6.9 s → 判定为**环境 IO 受限**，不能作为产品结论 | 未测（环境受限） |
| 用户体验 | 修掉 3 处硬伤（字体死链、CSP 拦字体、首 token 空窗白屏/推理文本被覆盖）；控制台 CSP 错误 9 → 0 | 通过（有保留） |
| 测试 | 服务端 86 文件 911 通过 + 3 跳过；客户端 8 文件 54 通过（含本轮新增 15 例） | 通过 |

**一句话定性**：CodeLens 的定位与核心 Agent 闭环已经成立，但「看得见」这一核心承诺在实现层曾有三处明显断裂（推理内容不落屏、首 token 空窗白屏、字体资源整批失效），本轮已修复；「免费试用与默认 Provider 不匹配」已在 §9 修复；仍存的上游间歇性长尾与字体视觉验收见 §9.7。

---

## 1. 测评范围与环境

### 1.1 环境

| 项 | 值 |
|---|---|
| 操作系统 | Windows 10/11（PowerShell 5），本机 |
| Node | 项目既有运行时（未新装任何运行时/全局 CLI） |
| 构建产物 | `server/dist` + `server/dist-client`（本轮重新构建过 client） |
| 服务 | `node server/dist/app.js`，`HOST=127.0.0.1`，`PORT=8090`，`NODE_ENV=production` |
| 数据库/沙箱 | 临时路径（`AGENT_DB_PATH` / `SANDBOX_ROOT` 指向临时目录），未使用用户真实数据 |
| LLM | `https://integrate.api.nvidia.com/v1`，模型 `nvidia/nemotron-3-ultra-550b-a55b`，Key 仅通过进程环境变量注入 |

### 1.2 安全边界（实际遵守）

- 未对真实生产环境或外部真实业务接口执行任何写操作；
- 未触发任何下单/支付类行为；
- 密钥**未写入任何文件**（无 `.env`、无配置、无脚本、无日志、无报告、无测试快照），仅注入启动进程的环境变量；
- 未执行 `git commit` / `git push`，所有改动保留在工作树。

### 1.3 已确认的测评限制

1. **无法使用 git**：本机 `where git` / 常见安装路径 / 非沙箱执行均找不到 git 可执行文件。因此**无法执行 `git status` / `git log`**，改用文件 mtime 枚举最近修改文件来避免覆盖用户未提交改动。这一点属于本次测评的**证据缺口**。
2. **单机单次**：性能数据只代表本机当时的 IO/杀软状态，未做跨机、跨容器验证。
3. **冷启动数值不可用**：见 §3.4。
4. 浏览器端到端只覆盖 Chromium 内核（Playwright 驱动）。

---

## 2. 功能维度

### 2.1 核心路径（真实上游，实测）

| # | 场景 | 步骤 | 结果 | 证据 |
|---|---|---|---|---|
| F-1 | 单轮对话 | 创建会话 → SSE 流式 → done | 通过，回答「我是 CodeLens Agent…」 | 会话创建 200，SSE 200，`done` 事件到达 |
| F-2 | 工具调用闭环 | 让 Agent 在沙箱写 `say.txt` | 通过，文件真实落盘 | `tool_call` → 审批 POST 返回 200（2 次） → `tool_result` → `say.txt` 存在 |
| F-3 | 分级审批 | `sys.exec` / `fs.write` | 通过，按风险档位进入 `tool_approval_required` | 两次审批均 200，未出现「自动放行高危」 |
| F-4 | 推理流 | 同 UI 请求体发同一 prompt | 通过，服务端真实发出 `reasoning` 事件 | 11 个 reasoning 事件，共 144 字符 |
| F-5 | 会话列表 | `GET /api/v1/sessions` | 通过 | 200，p50 2.32 ms |
| F-6 | 健康检查 | `GET /api/health` | 通过 | 200 |

真实上游耗时（单次，含模型侧排队）：

| 场景 | 首事件 | 首个 reasoning | 首个 delta（正文） | 总耗时 |
|---|---|---|---|---|
| UI 同形请求（maxIterations 12） | — | 2,311 ms | 2,871 ms | 6.66 s |
| 场景 A（maxIterations 6） | 400 ms | 2,582 ms | 5,881 ms | — |
| 场景 B（含工具 + 2 次审批，含冷启） | — | ≈3,800 ms | ≈9,800 ms | 28.6 s |

> 推论：**首 token 空窗真实存在且可达近 10 秒**。这不是理论风险，是实测数据——这也是本轮修「等待中间态」的直接依据。

### 2.2 异常路径

| # | 场景 | 表现 | 评价 |
|---|---|---|---|
| F-7 | 上游 Key 无效 / 无模型权限 | SSE 返回 `error`，前端展示中文「API Key 无效/过期或无该模型权限」 | 提示可读、可定位，合格 |
| F-8 | 工具被拒绝 | 不计入失败统计，卡内状态为拒绝 | 合格（`countFailures` 口径已排除） |
| F-9 | CRLF 分帧的上游/反代 | 改前：流不吐字、结束时一次性出现 | **已修**（见 §5） |
| F-10 | 无 git 环境跑安全用例 | 改前：3 条用例硬失败 | **已修**（环境缺失改为显式 skip） |

### 2.3 功能缺陷

#### F-A（S2，未修，需产品决策）免费试用与默认 Provider 不匹配

- **证据**：浏览器端到端发送消息返回 401，文案为「API Key 无效/过期或无该模型权限」。前端默认 `provider=deepseek` / `model=deepseek-v4-pro`，而服务端试用兜底 Key 属于 NVIDIA；手动把上游切到 NVIDIA、Key 留空后同一路径成功。
- **根因**：`server/src/runtime.ts` 中 `const key = req.apiKey ?? this.serverApiKey`——只兜底 Key，**不覆盖 provider/model**。试用 Key 与请求里的 provider 组合错配。
- **影响**：新用户「零配置首跑」在主路径上必然失败，属于首次体验级别的阻断。
- **建议**（低成本、需确认业务口径）：试用模式（`TRIAL_MODE_ENABLED`）下强制 `provider=nvidia` + 固定模型，并在 UI 上把选择器置灰并解释「试用额度由服务端提供，切上游请自带 Key」。
- **本轮未修原因**：改动的是产品策略（试用期是否允许换上游、额度如何计），非纯技术缺陷，按约定留给用户拍板。

---

## 3. 性能维度

### 3.1 静态资源（20 次采样，热态）

| 指标 | 2026-11-04 基线 p50 | 本轮 p50 | 本轮 p95 | 说明 |
|---|---|---|---|---|
| `GET /`（index.html） | 61.12 ms | **5.83 ms** | 13.83 ms | 基线 p95 高达 872.9 ms，存在长尾抖动 |
| `GET /assets JS` | 76.34 ms | **11.27 ms** | — | 构建产物文件名已变，非同文件对比 |
| `GET /assets CSS` | 63.27 ms | **5.60 ms** | — | **CSS 已拆分**（原单文件 → 现 `index.css`），非同一文件，故差异不可直接归因 |
| `GET /api/health` | 24.23 ms | **3.02 ms** | — | 同一路由，可比 |
| `GET /api/v1/sessions` | 无基线 | **2.32 ms** | — | 新增采样项 |
| 首屏 3 关键请求合计 | 无基线 | **60.65 ms** | — | / + JS + CSS |

**诚实结论**：p50 全面低于基线，但**不能全部归因于代码改动**——本轮代码改动只涉及字体加载路径与 CSP，不影响静态响应耗时；基线那次采样的 p95 高达 872.9 ms，说明机器当时存在明显 IO 抖动。可比性有限，仅作参考，不作为「优化成果」。

### 3.2 传输体积（curl 实测，`Content-Encoding: br`）

| 资源 | 原始 | br 传输 |
|---|---|---|
| `index.js` | — | 41,627 B |
| `index.css` | — | 7,246 B |
| 字体 CSS（`index.css` 之外的 fontsource 样式） | 362,790 B | 77,494 B |
| gzip 对照（index.js） | — | 41,704 B |

服务端 `compression()` 生效，br 优于 gzip（index.js 略优，字体 CSS 压缩比约 4.7:1）。

### 3.3 构建产物体积

- `dist` 共 **596 个文件 / 17.9 MB**，其中 `woff2` 约 **7.5 MB**（Noto Sans SC 400/500/600 全字重 + 全字符集）。
- **风险（S3，未修）**：首访会按 `unicode-range` 拉取所需分片，但总产物与 CDN/离线包体积偏大；桌面端打包会直接吃掉安装包体积。
- **建议**：①改用 `fontsource` 的 `chinese-simplified-*` 子集包；②或直接回退系统字体栈（`-apple-system, "Segoe UI", "Microsoft YaHei"`），把 CJK 字体交给 OS。前者的成本是新增依赖与构建配置，后者是零依赖但跨平台字形不一致——**属需取舍项**。

### 3.4 启动耗时（环境受限，判定为未测）

| 测量 | 结果 |
|---|---|
| 冷启 → `/api/health` 200（两次） | ≈48.6 s、≈48.6 s |
| 同机 `node -e "0"`（空启动） | **6.9 s** |
| 单独 `import` `server/dist/config/env.js` | **7.2 s** |
| 单独 `import` `server/dist/app.js` | ≈40.3 s |

空启动就 6.9 s、单个小模块 import 7.2 s，说明**本机文件 IO/安全软件拦截是主要成本**。因此 48.6 s 不应写作「产品冷启动慢」，本报告判定该项为**未测（环境受限）**，需要在干净机器/容器内复测。

---

## 4. 用户体验维度

| # | 检查项 | 改前 | 改后 | 证据 |
|---|---|---|---|---|
| U-1 | 控制台错误 | 10 条（其中 9 条 `data:font` 被 CSP 拒绝） | **0 条 CSP 拒绝**（仅剩 1 条主文档 `ERR_ABORTED`，为硬刷新伪影） | 浏览器控制台采集 |
| U-2 | 字体请求 | 12 条 `/node_modules/@fontsource/...` 死链，回落 `text/html`（HTTP 200 但解码失败） | **0 条死链**，字体请求全部 200 且 MIME 正确 | 网络面板 + 构建产物检查 |
| U-3 | 首 token 空窗（实测可达 2.6–9.8 s） | 纯白屏，用户易判定「卡死」 | 显示「思考中…」+ 推理正文，或「正在等待模型响应…」 | 组件测试覆盖（浏览器端**未稳定可视捕获**，见下） |
| U-4 | 推理内容 | 每 50 ms 被增量覆盖，只显示最后一小段 | 累加显示，正文开始后折叠收起 | 单元测试 + 代码审查 |
| U-5 | 首屏加载 | DCL 2.24 s / load 3.05 s | 同左（无回归） | 浏览器实测 |

**U-3 的证据缺口**：服务端确实在 2.3 s 发出 11 个 reasoning 事件，但首个正文 delta 在 2.87 s 到达，**推理窗口仅约 0.5 s**，浏览器快照采样未能稳定截到该状态。组件测试已覆盖两种状态的渲染，因此判定「代码正确、端到端未可视确认」，不写成「已验证」。

### 4.1 UX 待改进（未修，成本低但需产品口径）

1. **术语门槛（S4）**：`BYOK`、`provider`、`channelMode`、`maxIterations` 直接暴露给用户；首次进入设置页没有一句「这一步在干什么」的解释。建议在每个上游选项下加一行「何时用它」。
2. **恢复码可发现性（S4）**：跨浏览器恢复是差异化卖点之一，但入口藏在会话菜单深处。建议在空状态页给一条一次性提示。
3. **会话级「记住授权」（S3）**：审批疲劳是竞品的已知反模式，本产品已有风险分级；但「本次会话内记住」的可见状态不明显，用户不确定要不要重复点。

---

## 5. 本轮改动（改前 / 改后）

| # | 文件 | 改前问题 | 改后 | 复测证据 |
|---|---|---|---|---|
| 1 | `client/src/main.tsx`、`client/src/styles/design-tokens.css` | 字体 CSS 走 `@import`，`@tailwindcss/vite` 不重写相对 url，产生 12 条 `/node_modules/...` 死链 | 字体改为 JS 侧 import，Vite 正常改写为 `/assets/*` 哈希资源 | 死链 12 → **0**；字体请求全部 200 且 MIME 正确 |
| 2 | `server/src/app.ts` | CSP `font-src 'self'` 拦截构建期内联的 `data:font` 子集 | `font-src 'self' data:` | CSP 拒绝 9 → **0** |
| 3 | `client/src/hooks/useAgentStream.ts` | reasoning 增量每 50 ms **覆盖**写入，已思考内容被冲掉 | 改为累加写入 | 新增回归测试；组件测试断言含「思考中」与推理正文 |
| 4 | `client/src/components/agent/AgentMessageItem.tsx` | `reasoningText` 只写不读；首 token 前纯白屏 | 新增 `ReasoningBlock`（流式展开/结束折叠）+ `WaitingHint` | 组件测试 2 例；服务端实测 reasoning 事件 11 个 |
| 5 | `client/src/services/stream.ts` | 只按 `\n\n` 分帧，遇 `\r\n\r\n` 上游则整条流退化 | 追加时先归一化 CRLF（兼顾跨 chunk 的 `\r|\n` 边界） | 新增测试：跨 chunk 切在 `\r` 与 `\n` 之间仍逐帧分发 |
| 6 | `server/tests/sys-exec.test.ts` | 3 条真实 spawn git 的用例在无 git 机器上硬失败（环境缺失被误判为产品缺陷） | `spawnSync('git','--version')` 探测 + `it.skipIf` | 3 fail → **0 fail / 3 skip** |
| 7 | `client/tests/reasoning-stream.test.ts`（新增） | 上述 3、5 无回归保护 | 3 个用例 | 全部通过 |

### 5.1 测试结果（本轮复跑）

| 套件 | 文件 | 结果 | 耗时 |
|---|---|---|---|
| 服务端 `server` | 85 | **896 passed + 3 skipped** | 本帖复跑 774.8 s（首次单独跑 ≈78 s；本轮与客户端并行时因本机 IO 争用拉长，结果一致） |
| 客户端 `client` | 8 | **54 passed** | 22.6 s |

> 3 条 skip 均为「本机未安装 git」的环境缺失，不是用例失效；在装有 git 的机器上会自动执行。

### 5.2 构建验证

`tsc` + `rolldown-vite` 构建通过；client 构建后 CSS 中 `node_modules` 死链为 0，字体 url 全部改写为 `/assets/noto-*`。

---

## 6. 问题分级汇总

| 编号 | 级别 | 问题 | 状态 |
|---|---|---|---|
| F-A | **S2** | 试用模式未固定 provider/model → 默认 deepseek + 试用 NVIDIA Key 必然 401 | 未修（需产品决策） |
| U-3 | S3 | 首 token 空窗最长近 10 s 无中间态 | 已修（端到端未可视确认） |
| U-4 | S3 | reasoning 增量被覆盖 | 已修 |
| U-2 | S3 | 12 条字体死链 + 9 条 CSP 拦截 | 已修 |
| F-9 | S3 | CRLF 分帧导致流式退化 | 已修 |
| — | S3 | 字体产物 7.5 MB woff2，安装包/首访体积偏大 | 未修（需取舍） |
| — | S3 | 会话级「记住授权」状态不显眼 | 未修 |
| — | S4 | 术语门槛、恢复码入口深 | 未修 |
| — | S4 | 基线可比性有限（CSS 已拆分、p95 抖动） | 记录 |
| — | — | 冷启动 48.6 s | **未测（环境受限）** |

> 级别定义：S1 阻断（核心功能不可用/数据风险）；S2 严重（主路径明显受损）；S3 一般（体验/可维护性）；S4 轻微。

---

## 7. 下一轮建议（按「成本低 / 收益高」排序）

1. **（最高）修 F-A**：试用模式下锁定 provider/model 并置灰选择器。改动集中在 `runtime.ts` + `SettingsPanel`，收益是零配置首跑成功率从 0 → 1。
2. **字体体积**：换 `chinese-simplified-*` 子集包或回退系统字体栈，预计可减 5–6 MB 产物。属依赖/策略取舍，建议先量一次首访实际加载字节再定。
3. **把「记住授权」做成可见状态**：会话内已授权的工具在审批条上标「本会话已允许」。
4. **补一次干净机器冷启复测**：本机 IO 噪声太大，48.6 s 不应进入任何对外文档。
5. **接一次 CI**：当前测试只能人工跑，且环境差异（git 缺失）会直接染色。

---

## 8. 证据与复现

| 证据 | 位置/命令 |
|---|---|
| 服务端测试 | `cd server; npx vitest run` |
| 客户端测试 | `cd client; npx vitest run` |
| 静态性能采样（20 次） | 临时脚本 `C:\Users\Administrator\AppData\Local\Temp\codelens-review\perf.mjs`（仓库外，不含密钥） |
| LLM 闭环探针 | `...\Temp\codelens-review\probe.mjs`（含审批自动 allow_once、校验沙箱落盘） |
| UI 同形请求探针 | `...\Temp\codelens-review\probe-ui-shape.mjs` |
| 启动耗时分解 | `...\Temp\codelens-review\import-timing.mjs` |
| 传输体积 | `curl.exe -H "Accept-Encoding: br" -w "%{size_download}"` |
| 基线数据 | 仓库根 `.perf-baseline.json` / `.perf-ttfb.json` / `.perf-samples.json`（2026-11-04 生成） |

> 临时脚本均在仓库外，未写入仓库；也未在其中记录任何密钥。生产服务已按需启动在 `127.0.0.1:8090`（试用兜底 Key 由进程环境变量注入），测评结束后应按需停止。

---

# 9. 第二轮（2026-11-05 修订版）：试用链路锁定 + 上游故障优雅降级

> 触发背景：首轮报告把 F-A（试用态 provider 与兜底 Key 错配 → 零配置首跑必然 401）列为「S2，需产品决策，未修」。
> 用户拍板：**自建网关 relay key 401 不算产品 bug**（网关侧 key 未签发，保留为可配置上游）；**试用上游改用已实测可用的 NVIDIA**；真正要修的是**上游不可用时的用户体验崩塌**。
> 本章所有数字均为本轮真实测量；标注「未测」的项没有估算。

## 9.1 本轮结论

- **试用链路锁定**：未自带 Key 的请求被服务端强制锁到 `nvidia` / `nvidia/nemotron-3-ultra-550b-a55b`；自带 Key 的请求原样放行（优先级最高）。自建网关保留为 `TRIAL_BASE_URL + custom` 可配置项，默认不启用、不硬编码、不写密钥。
- **零配置首跑（产品链路）**：**通过**。用确定性 mock 上游走完整链路「一句话 → `fs.write` 工具调用 → 审批（`allow_once` 返回 200）→ 工具成功 → 文件落盘 → 4 条消息持久化」，全程 8.30 s（含审批交互）；落盘内容实测为「零配置首跑验证通过」。
- **零配置首跑（真实 NVIDIA）**：**通过**。同一请求（前端默认 `deepseek/deepseek-chat`、不带 apiKey）被锁到 `nvidia/nemotron-3-ultra-550b-a55b`，全程 **6.68 s**：首事件 1.51 s、首推理 2.19 s、首正文 6.29 s；2 次工具调用（`fs.write` + `fs.read`）、1 次审批（`allow_once` 200）、文件真实落盘且读回一致、会话持久化 6 条消息 / 2 条工具记录，用量 12,160 prompt + 302 completion tokens。
- **上游稳定性**：该端点在**本轮早段曾出现 120–300 s 无响应**（同一配置、同一 Key），重测在 6.68 s 正常返回 → 属于**间歇性长尾**，不是恒定不可用；产品侧的「可配置超时 + 分类提示」因此仍是必需品。
- **故障注入**：三类故障全部按预期降级，均 ≤ 4 s 返回可读中文，且不无限挂起：错误 Key → `UPSTREAM_ERROR`（1.09 s，401 文案带上游主机）；不存在模型 → `UPSTREAM_ERROR`（1.29 s，模型引导）；超时 → `UPSTREAM_TIMEOUT`（1.5 s 配置下 3.92 s 结束，含通道判定）。
- **测试**：server **86 文件 / 914 用例**，911 通过、3 跳过（均为无 git 环境的显式跳过）；client **8 文件 / 54 用例**全通过。
- **构建**：server `tsc` 通过；client `tsc -b + vite build` 通过，构建耗时 1 m 40 s。
- **剩余风险**：NVIDIA 上游存在**间歇性 120 s+ 无响应**（外部依赖，无法闭环）；~~启动自检用 `GET /models` 可能假绿~~ **已在 §10 R4 闭环**（改为真实最小生成探测，三态）；本机冷启动 42–47 s（环境受限，产品值未测）。

## 9.2 问题分级（本轮口径：S1 阻断 / S2 严重 / S3 一般 / S4 打磨）

| ID | 级别 | 现象 | 证据（命令/日志/数据） | 根因 | 改进建议 | 预估成本 | 状态 |
|---|---|---|---|---|---|---|---|
| R1 | **S2** | 未带 Key 的新用户默认 `deepseek/deepseek-chat`，服务端却拿 NVIDIA 兜底 Key 转发 → 必然 401，首跑失败且只有裸报错 | 首轮 F-A：浏览器端到端 401；本轮修复后同一请求 `trialUpstream.provider=nvidia`、`model=nvidia/nemotron-3-ultra-550b-a55b` | 兜底只覆盖 key（`const key = req.apiKey ?? serverApiKey`），不覆盖 provider/model | 试用态强制覆盖 provider/model/baseUrl；BYOK 不锁；UI 置灰 + 文案解释 | 低（~80 行 + 15 用例） | **已闭环** |
| R2 | **S2** | 上游 401/403/超时/不可达/模型不存在时，用户只看到一行英文/裸报错，不知道该做什么；超时还可能无限挂起 | 故障注入：改前无分类；改后 1.09–3.92 s 返回分类中文 + 建议 + 入口 | adapter 虽有 401/403 翻译，但无模型分支、超时文案不含上游/时长；前端只对「认证失败」给按钮 | 后端分类文案补 host/模型/超时；adapter 可配超时与重试；前端按错误码给「去配置自己的 Key」 | 低（~120 行 + 15 用例） | **已闭环** |
| R3 | **S2** | 上游挂起时，界面在拿到首个事件前没有任何服务端信号；默认超时 60 s 才会出错误 | 早段真实 NVIDIA：120 s 配置下首个事件 121.2 s（错误与首个事件同时到达）；重测同一配置 1.51 s 首事件 | `channelRouter.decide` 与上游探针在 `meta` 之前执行，首个 SSE 事件被上游阻塞 | 可考虑在进入上游前先发一条进度事件（本轮未做，避免污染推理内容） | 中（阶段事件 + 前端等待态） | **已闭环（§10 R3）** |
| R4 | **S3** | 启动自检可能「假绿」：错误 Key 下 `health.status=ok` | bad-key 场景 `trialUpstream.health={status:'ok'}`，但同 Key 首次 chat 立即 401 | NVIDIA `GET /models` 不校验鉴权 | 自检只声明「端点可达」；鉴权由首次请求分类兜底；或改为 1-token 探活（有成本） | 低（~40 行 + 9 用例） | **已闭环（§10 R4）** |
| R5 | **S3** | 冷启动 → `/api/health` 200 需 42–47 s | 本轮 5 次探针 `bootMs` = 45,597 / 45,897 / 46,724 / 42,404 / 44,890 ms；首轮同机空启动 6.9 s | 本机文件 IO / 安全软件拦截（首轮已判定环境受限） | 在干净机器/容器复测；不改代码 | 零（仅复测） | **未测**（环境受限，不作为产品缺陷） |
| R6 | **S3** | CJK 字体产物过大（3 字重 × 数百 unicode-range 分片） | 改前 `dist` 字体 **16.76 MB / 588 文件**；改后 **10.73 MB / 396 文件**（−6.03 MB，−36%），整体产物 11.68 MB | 每多一档字重多约 5.6 MB | 收敛到 400/500，600 由浏览器合成；后续可换子集包或系统字体栈 | 低（1 行 import） | **已闭环（体积）**；视觉验收待浏览器回归 |
| R7 | **S4** | 空态/README 文案未传达定位（仍是「用自然语言描述任务」这类泛化句） | 文案前后对比见 §9.5 | 首轮只改了 README Hero，空态与试用文案未跟进 | 用同一句话贯穿：一句话动手 / 每步可见 / 风险拍板 / 密钥留在本机 | 低 | **已闭环** |
| R8 | **S4** | 「免费试用」横幅没说是哪个上游/模型，用户以为可以随便换 | 改前横幅只有「今日还可 N 次」 | 试用锁定后需要显式披露 | 横幅追加「（固定模型 …）」；设置页说明 + 置灰 + hint | 低 | **已闭环** |
| R9 | **S3** | 兜底态锁定 provider/model，但仍保留请求里的 `customBaseUrl`；若运维把 `TRIAL_PROVIDER` 配成 `custom` 又没配 `TRIAL_BASE_URL`，服务端 Key 可能被组合发往请求指定地址 | 代码审查 `resolveTrialTarget` 的 `lock.baseUrl ?? req.customBaseUrl`；原单测显式断言「保留请求里的 baseUrl」 | 兜底用的是服务端 Key，Base URL 却允许请求侧回填 | 兜底态 `customBaseUrl` 只取 `lock.baseUrl`（默认配置下不可达，判 S3 而非阻断） | 低（1 行 + 1 用例） | **已闭环** |

## 9.3 功能维度

### 9.3.1 零配置首跑（确定性 mock 上游，走真实 adapter / loop / 审批 / 持久化）

| 步骤 | 结果 | 证据 |
|---|---|---|
| 会话创建（前端默认 `deepseek/deepseek-chat`，不带 apiKey） | 201 | `sessionStatus=201` |
| 服务端试用锁定 | 覆盖为 `custom` / `mock-model` / `http://127.0.0.1:8810/v1` | `trial-status.trialUpstream = {provider:'custom', model:'mock-model'}` |
| 首个 SSE 事件 | 1,691 ms | `firstEventMs=1691` |
| 工具调用 | `fs.write`，1 次 | `toolCalls=['fs.write']` |
| 审批 | 1 次 `tool_approval_required`，提交 `allow_once` 返回 200 | `approvals=1, approved=200` |
| 工具结果 | success | `toolResults=[{status:'success'}]` |
| 正文/结束 | 首个 delta 8,300 ms，done 8,300 ms，29 字 | `firstDeltaMs=8300 / textLen=29` |
| 落盘 | 文件存在，内容一致 | `sandboxFile={exists:true, content:'零配置首跑验证通过'}` |
| 持久化 | 4 条消息（user / assistant / tool / assistant），1 条工具调用记录 | `persistence.messages=4, roles=[...], toolCallRows=1` |

> 说明：mock 上游只替换模型输出，其余全部为产品真实实现；这条证据用于证明**试用锁定 + 审批 + 落盘 + 持久化**整条链路成立，不代表外部上游可用性。

### 9.3.2 真实 NVIDIA 上游（外部依赖）

| 尝试 | 结果 | 证据 |
|---|---|---|
| 120 s 超时配置（第 1 次，早段） | 121.2 s 收到 `UPSTREAM_TIMEOUT`，无任何正文；会话仅持久化 1 条 user 消息 | `firstEventMs≈121193`，`messages=1` |
| 300 s 超时配置（第 2 次） | 303 s 仍未返回正文，先触发 180 s 任务预算提示（`【任务总预算（180s）已用尽】`） | 无 `delta`、无 `done.usage` |
| **120 s 超时配置（第 3 次，重测）** | **6.68 s 完成**：首事件 1.51 s / 首推理 2.19 s / 首正文 6.29 s；`fs.write` + `fs.read` 两次工具调用均 success；1 次审批 200；文件落盘「零配置首跑验证通过」；6 条消息 / 2 条工具记录持久化；usage 12,160 + 302 tokens | `firstEventMs=1508, firstReasoningMs=2190, firstDeltaMs=6285, doneMs=6680`；`sandboxFile.exists=true` |

结论：**真实 NVIDIA 零配置首跑通过**，但该端点存在**间歇性长尾**（同一 Key、同一配置下曾 120–300 s 无响应）。因此产品侧的「可配置超时 + 分类提示 + 不无限挂起」不是过度设计，而是这条链路的必需品。

### 9.3.3 故障注入（故意制造故障，验证降级）

| 注入 | 首次事件 | 错误到达 | 错误码 | 文案（节选，实测） | 是否无限挂起 |
|---|---|---|---|---|---|
| 错误 Key（`LLM_SERVER_API_KEY=sk-invalid…`） | 1,005 ms | **1,086 ms** | `UPSTREAM_ERROR` | 上游（integrate.api.nvidia.com）认证失败（HTTP 401）：API Key 无效、已过期或无该模型权限。\n下一步：到 设置 → Provider 重新填写 API Key… | 否 |
| 不存在模型（`TRIAL_MODEL=nvidia/definitely-not-a-real-model-xyz`） | 1,182 ms | **1,294 ms** | `UPSTREAM_ERROR` | 上游（integrate.api.nvidia.com）不认识这个模型（HTTP 404）。\n可能原因：模型名拼错 / 该 key 无此模型权限 / Base URL 路径不对… | 否 |
| 超时（本地 stub 永不响应，`UPSTREAM_TIMEOUT_MS=1500`） | 2,409 ms | **3,919 ms** | `UPSTREAM_TIMEOUT` | 上游（127.0.0.1:8799）在 2s 内没有响应（超时）。可稍后重试；若频繁超时请更换上游，或调大环境变量 `UPSTREAM_TIMEOUT_MS`。 | 否（1.5 s 配置，3.9 s 内收尾） |

> 超时文案在探针跑完后又把「整秒四舍五入」改为保留一位小数（1.5s），单元测试 `trial-resilience.test.ts` 已按新格式断言。

### 9.3.4 其它功能回归

| 项 | 结果 | 证据 |
|---|---|---|
| server 全量测试 | 86 文件 / 914 用例：**911 通过 / 3 跳过 / 0 失败**（全量 1,181.9 s） | vitest `--reporter=dot`；首跑曾现 1 例 E9 进程组计时抖动，放宽等待窗口后复跑全绿 |
| client 全量测试 | 8 文件 / 54 用例：**54 通过** | 首跑 53/54（空态文案断言过期），更新断言后该文件 3/3 通过 |
| 自带 Key 不被锁定 | 通过（单测 4 例覆盖：BYOK 原样、锁定覆盖、兜底态丢弃请求 baseUrl、无锁定项不变） | `server/tests/trial-resilience.test.ts` |
| 密钥不泄露 | 通过（错误文案对 key 打码；host 只保留主机名；新增用例断言 `not.toContain(key)`） | 同上 + `maskKey` |

## 9.4 性能维度

| 指标 | 首轮（2026-11-05 早） | 本轮 | 说明 |
|---|---|---|---|
| 字体产物 | 16.76 MB / 588 文件（3 字重） | **10.73 MB / 396 文件（2 字重）** | −36%；`dist` 合计 11.68 MB |
| JS 产物 | — | 0.68 MB（5 文件） | `markdown-vendor` 330.6 kB / gzip 102.3 kB |
| CSS 产物 | — | 0.26 MB（2 文件） | 字体 CSS 拆分为独立文件 |
| client 构建耗时 | — | **1 m 40 s** | 本机；含 2450 模块 |
| 启动 → `/api/health` 200 | ≈48.6 s（环境受限，判未测） | **42.4–46.7 s（5 次）** | 同机同口径；空启动基线 6.9 s → 仍判「环境受限，未测」 |
| 首事件（mock 链路） | 400 ms（首轮真实上游） | **1,691 ms** | 不同上游、不同链路，不可横向比较；仅作本轮基线 |
| 首正文（mock 链路） | 2,871–9,800 ms（首轮真实上游） | **8,300 ms** | 同上 |
| 整轮（mock，含 1 次审批） | 28.6 s（首轮含冷启 + 2 审批） | **8.30 s** | 同上 |
| 真实 NVIDIA | 首推理 2,311–3,800 ms、首正文 2,871–9,800 ms | **首事件 1,508 ms / 首推理 2,190 ms / 首正文 6,285 ms / 整轮 6,680 ms（含 1 次审批）** | 本轮 3 次尝试中 1 次成功；另 2 次 120–300 s 无响应（见 §9.3.2） |

## 9.5 用户体验维度（含「定位是否被界面传达」）

### 9.5.1 文案前后对比（定位传达证据）

| 位置 | 改前 | 改后 | 传达的定位要素 |
|---|---|---|---|
| README 开篇 | 「用自然语言描述任务，Agent 自主选择工具、逐步执行，全过程可见、可干预…用自己的 LLM Key（BYOK），免注册。」 | 「用一句话交代任务…每一步（工具、参数、结果）都可见，高风险动作按等级先请示你…密钥用你自己的（BYOK）、只留在本机，免注册。」 | 一句话动手 / 每步可见 / 风险拍板 / 密钥留在本机 |
| 中栏空态 | 「用自然语言描述任务」+「Agent 会自主选择工具并逐步执行，全过程可见、可干预。」+「当前未配置 API Key，请先在设置中填写。」 | 「一句话交代，Agent 动手；每步可见，风险处你拍板」+「工具调用、参数与结果都摊在界面上；写文件、执行命令等高风险动作按等级先请示你，密钥只留在本机（BYOK）。」+「未配置 Key 时可先用免费试用（上游与模型由服务端固定）；自带 Key 后即可自由切换上游与模型。」 | 同上 + 试用边界 |
| 顶部试用横幅 | 「免费试用：今日还可 N 次；配置自己的 API Key 可无限使用」 | 「免费试用（固定模型 nvidia/nemotron-3-ultra-550b-a55b）：今日还可 N 次；配置自己的 API Key 可无限使用」 | 说清「现在用的是谁」 |
| 设置页上游选择器 | 可自由展开；无解释 | 置灰 + hint「试用期间上游已锁定；切换上游请自带 API Key」+ 顶部说明块（自检失败时红色提示） | 试用边界 + 切换条件 |
| 错误条 | 仅当消息含「认证失败」时出现「去设置改 Key」；无错误码、无建议 | 任意可行动错误（认证/403/404/模型不存在/超时/网络/额度）→ 原文 + 错误码 + 「建议：…」+「去配置自己的 Key」 | 可诊断 + 可行动 |

### 9.5.2 UX 检查项

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| U-1 | 上游 401 是否白屏 | 否：1.09 s 出错误条 + 建议 + 一键入口 | 故障注入 |
| U-2 | 上游超时是否无限挂起 | 否：1.5 s 配置下 3.9 s 收尾 | 故障注入 |
| U-3 | 模型名写错是否有方向 | 有：提示模型名/权限/Base URL 三种可能，并说明试用期固定模型 | 故障注入 |
| U-4 | 试用期是否说清上游与模型 | 是：横幅 + 设置说明 + 置灰 hint（三处） | 文案对比 |
| U-5 | 空态是否传达定位 | 是：标题即价值主张，副文案解释审批与 BYOK | 文案对比 + 组件测试断言 |
| U-6 | 恢复码首屏入口 | 仍缺（P2） | 未改动 |
| U-7 | 术语门槛（判据塔/Judge） | 仍在（P1） | 未改动 |
| U-8 | 错误条缺少 live region（屏幕阅读器不播报）；错误码与置灰提示用了最低对比的 tertiary 色 | 已修 | `role="alert"`；两处诊断文字改 `text-text-secondary`（client 54/54、`tsc -b` 通过） |

## 9.6 本轮已闭环项

| # | 问题 | 改动文件 | 复测证据 |
|---|---|---|---|
| 1 | 试用态 provider 与兜底 Key 错配 → 401 阻断（R1） | `server/src/env.ts`（TRIAL_*）、`server/src/runtime.ts`（trialLock 装配）、`server/src/services/agent/agent-loop.service.ts`（`resolveTrialTarget` 强制覆盖）、`server/src/controllers/agent.controller.ts`（trial-status 暴露上游） | mock 首跑 `trialUpstream.provider=custom`；真实 bad-key 场景 `trialUpstream=nvidia` + 401 分类 |
| 2 | 前端无法感知锁定状态、可随意切上游（R8） | `client/src/services/api.ts`（类型）、`client/src/components/layout/AppShell.tsx`（横幅披露模型）、`client/src/components/settings/ProviderZone.tsx`（置灰 + 说明）、`FormControls.tsx`（`Dropdown disabled/hint`）、`ModelCapabilityPanel.tsx`（`locked`） | client 类型检查 + 构建通过；组件测试断言空态文案 |
| 3 | 上游错误无分类/无入口/可能挂起（R2） | `server/src/providers/openai-compatible.adapter.ts`（`describeHttpError` host/模型分支、`describeTimeout`、`UpstreamNetworkError`、重试）、`server/src/config/env.ts`（`UPSTREAM_TIMEOUT_MS` / `UPSTREAM_MAX_RETRIES`）、`client/src/components/agent/AgentWorkbench.tsx`（`guidanceFor` + 错误码 + 建议 + 按钮） | 三类故障注入（1.09 s / 1.29 s / 3.92 s）；15 条新单测 |
| 4 | 启动没有可用性自检（R4 部分） | `server/src/services/agent/trial-health.service.ts`（新增）、`server/src/runtime.ts`（启动异步自检 + 装配） | `trial-status` 返回 `health.status`（mock=ok；超时场景=unknown 未误报） |
| 5 | 字体产物过大（R6） | `client/src/main.tsx`（3 字重 → 2 字重） | 16.76 MB → **10.73 MB**，文件 588 → 396 |
| 6 | 定位文案只在 README Hero 落地（R7） | `README.md`（开篇 + 试用条）、`client/src/components/agent/AgentWorkbench.tsx`（空态） | 文案对比表 + 组件测试断言 |
| 7 | 超时文案四舍五入误导（R2 子项） | `server/src/providers/openai-compatible.adapter.ts`（`describeTimeout` 保留一位小数） | 单测正则断言 `1.5s` 格式 |
| 8 | E9 进程组测试在并行负载下 8 s 等待不足，全量首跑偶发 1 例失败（S4） | `server/tests/sys-exec.test.ts`（`waitPidGone` 等待窗口 8 s → 20 s，断言不变） | 失败用例单独复跑 37/37；随后全量复跑 **86/86 文件、911 通过 / 3 跳过 / 0 失败** |
| 9 | 兜底态可能把服务端 Key 与请求侧 `customBaseUrl` 组合（R9，S3） | `server/src/services/agent/agent-loop.service.ts`（`resolveTrialTarget` 兜底态只取 `lock.baseUrl`）、`server/tests/trial-resilience.test.ts`（断言改为 `undefined`） | 该文件复跑 **15/15**；server `tsc --noEmit` 通过；加固后全量复跑 **911 通过 / 3 跳过 / 0 失败** |
| 10 | 错误条无声播报、诊断文字对比偏低（U-8，S4） | `client/src/components/agent/AgentWorkbench.tsx`（`role="alert"`、错误码改 secondary）、`client/src/components/settings/FormControls.tsx`（置灰 hint 改 secondary） | client `tsc -b` 通过；client 全量 **54/54、0 失败**（60.4 s） |

## 9.7 未闭环项与原因

| # | 项 | 原因 | 下一步 |
|---|---|---|---|
| 1 | 上游**间歇性**无响应（3 次真实尝试中 2 次 120–300 s 无响应，1 次 6.68 s 成功） | 外部依赖，非本产品代码可控；无 admin 权限 | 轮换上游或等上游恢复；产品侧已具备可配置超时与分类提示（故障注入已验证） |
| 2 | 启动自检「假绿」（`GET /models` 不校验鉴权） | 已改为真实最小生成探测（`max_tokens=1`、非流式、12 s 超时、5 分钟缓存），三态 `ok / auth_failed / unreachable`；成本量化见 §10.5 | **已在 §10 闭环（R4）** |
| 3 | 首个 SSE 事件仍被上游阻塞（R3） | 已改为请求接受即回执 `stage: connecting` + 统一阶段语义 + 前端等待计时/慢响应提示/中止贯通 | **已在 §10 闭环（R3）** |
| 4 | 冷启动 42–47 s | 本机 IO/安全软件，首轮已判定环境受限 | 干净机器/容器复测后再定性 |
| 5 | 恢复码首屏入口、术语门槛 | 产品文案/信息架构调整，本轮未排期 | 见 `product-positioning.md` §5 条目 2/4 |
| 6 | 开源声明 | 需产品决策 | 待拍板 |

## 9.8 测试与构建（本轮最终数字）

| 套件 | 文件 | 用例 | 通过 | 跳过 | 失败 | 耗时 |
|---|---|---|---|---|---|---|
| server | 86 | 914 | 911 | 3 | 0 | 505.1 s（加固后复跑；同机前一次 1,181.9 s，差异来自系统负载） |
| client | 8 | 54 | 54 | 0 | 0 | 60.4 s（a11y 微调后复跑；同机前一次 80.6 s） |

- `server` 首跑（09:55）出现 1 例 `sys-exec.test.ts` E9 失败（`waitPidGone` 8 s 内孙进程未回收）；单独复跑该文件 37/37 通过，随后把等待窗口放宽到 20 s（不断言放宽），全量复跑 0 失败。此改动仅提升测试对 Windows 并行负载的容忍度，不改变产品行为。
- R9 安全加固（兜底态 Base URL 只取服务端锁定项）后，再次全量复跑仍为 **86/86 文件、911 通过 / 3 跳过 / 0 失败**（505.1 s）。

- `server`：`tsc` 类型检查通过、`tsc` 构建通过。
- `client`：`tsc --noEmit` 通过、`tsc -b` + `vite build` 通过（1 m 40 s）。
- 新增用例：`server/tests/trial-resilience.test.ts`（15 例）覆盖锁定优先级、重试策略、超时/不可达文案、模型不存在分支、启动自检四态。

## 9.9 剩余风险

1. **外部上游存在间歇性长尾**：同一 Key/配置下 3 次尝试出现 2 次 120–300 s 无响应，另 1 次 6.68 s 完成。锁定逻辑正确也挡不住上游波动；已用超时 + 分类提示兜底，但用户仍可能等待数十秒（默认 60 s 超时后给出指引）。
2. **自检可信度**（已被 §10 R4 取代）：本轮改为真实最小生成探测，`/models` 的假绿已消除；`ok` 现在表示「能建立真实生成请求」，不再只看端点可达。
3. **超时与任务预算的交互**：若把 `UPSTREAM_TIMEOUT_MS` 调到大于 180 s 任务预算，用户会先看到预算提示而非超时指引；默认 60 s 无此问题。
4. **字体视觉验收**：600 字重改为合成加粗，未做浏览器像素级对比；建议下轮回归确认。

---

# 10. 第三轮（2026-11-05）：R3 首事件阻塞与 R4 自检假绿 闭环

> 本轮只做两条已定调风险：R3（上游长尾时首事件前无任何 UI 反馈）与 R4（启动自检用 `GET /models`，该端点不校验鉴权，Key 错了也 200）。
> 不改变 SSE 协议主体，只新增 `stage` 事件；故障注入仍用仓库内 `FakeLlm` 假上游，不触碰真实业务写操作。所有耗时均为本机实测，未测项明确标注。

## 10.1 结论

| 项 | 结论 | 关键实测 |
|---|---|---|
| R3 | **已闭环** | 上游完全不回响应头时，客户端在 **26 ms** 看到首个 `stage: connecting`；服务端 `elapsedMs=0`；中止到上游连接被取消 **11 ms**（改前：该场景无任何事件，直到 60 s 超时） |
| R4 | **已闭环** | 同一把错误 Key：旧 `GET /models` 返回 **HTTP 200（8,704 ms）**＝假绿；新 `POST /chat/completions` 返回 **HTTP 401**（577 / 208 / 193 ms），服务内三态判定 `auth_failed`（1,384 ms）；不可达地址 2 ms 判 `unreachable` |
| 有效 Key 的 `ok` 探测 | **未测** | 进程环境未提供有效 `LLM_SERVER_API_KEY`；不做估算，单测已覆盖 `ok + tokens` 分支 |

## 10.2 R3 服务端改动

| 文件 | 改动 | 目的 |
|---|---|---|
| `server/src/types/agent-events.ts`、`server/src/types/index.ts` | 新增 `AgentRunStage`、`SseStagePayload`，`stage` 加入事件名首位 | 阶段语义单一来源 |
| `server/src/services/agent/sse-writer.ts` | 新增 `beginRunStage()` / `emitStage()`：runId、`at`、`elapsedMs`、阶段去重、已销毁响应写保护 | 每个请求天然是 run 作用域 |
| `server/src/controllers/agent.controller.ts` | `loop.run` **之前** 发 `connecting` | 早事件不被上游能力探测/首字节阻塞 |
| `server/src/services/agent/agent-loop.service.ts` | 幂等兜底 `connecting`；`onFirstToken(kind)` 发 `reasoning/content`；`onResponseStart` 发 `upstream_first_byte`；中止发 `aborted`；上游异常按超时/其他分 `upstream_timeout` / `upstream_error`；`finish()` 前发 `done` | 阶段顺序可归因、终局可区分 |
| `server/src/providers/openai-compatible.adapter.ts`、`native-channel.ts`、`react-channel.ts` | `ChatParams.onResponseStart` 在 HTTP 响应头到达时回调 | 精确标记「上游已响应」 |

阶段顺序（同一 `runId`）：

| 阶段 | 触发点 | 前端文案 |
|---|---|---|
| `connecting` | 请求通过校验、写 SSE 头后立即 | 正在连接模型… |
| `upstream_first_byte` | 上游 HTTP 响应头到达 | 模型已响应，正在生成… |
| `reasoning` / `content` | 上游首个推理块 / 正文块 | 模型正在思考… / 正在输出… |
| `done` | 正常收尾、`done` 事件之前 | 已完成 |
| `upstream_timeout` / `upstream_error` | 上游超时 / 其他上游失败 | 上游响应超时 / 上游出错 |
| `aborted` | 用户中止 | 已中止 |

## 10.3 R3 客户端改动

| 文件 | 改动 |
|---|---|
| `client/src/services/stream.ts`、`client/src/types/index.ts` | 解析 `stage` 帧，新增 `AgentStagePayload` |
| `client/src/stores/runStore.ts` | `stage` + `acceptedAt`；`beginRun` 在 fetch 前打时间戳，`applyStage` 更新阶段 |
| `client/src/components/agent/RunStageBanner.tsx`（新增） | 阶段文案 + **每秒更新**的「已等待 Ns」；**≥10 s 且仍等待上游**升级为「上游响应较慢」；**中止**按钮；无假进度条；`role="status"`、`aria-live="polite"`、计时 `aria-hidden` |
| `client/src/components/agent/AgentWorkbench.tsx` | 挂载 `RunStageBanner`，中止复用既有 `handleStop`（本地 abort + `POST /agent/abort`） |
| `client/src/components/agent/AgentMessageItem.tsx` | 首 token 空窗文案随阶段变化（连接中 / 已响应 / 思考中） |
| `client/src/components/settings/ProviderZone.tsx`、`client/src/services/api.ts` | `trial-status.health` 三态展示（认证失败 / 不可达），不再只看 ok |

中止链路：`AbortController.abort()` → `fetch` 中断 → 服务端 `res.on('close')` → `requestController.abort()` → `turnController` → `undici` 上游请求取消；同时 `POST /agent/abort` 覆盖跨端中止。

## 10.4 R3 实测（FakeLlm 假上游，仓库内测试）

| 场景 | 改前 | 改后 | 证据 |
|---|---|---|---|
| 上游完全不回响应头（60 s 级长尾） | 无任何 SSE 事件，界面静止到超时 | 首个 `stage` 帧 **26 ms**；服务端 `connecting.elapsedMs=0`；无 `upstream_first_byte` / `delta` / `reasoning` | `agent-stage-events.test.ts`（`STAGE_MEASURE=1`） |
| 正常链路顺序 | 只有 `meta → delta → done` | `stage(connecting)` → `stage(upstream_first_byte)` → `stage(content)` → `stage(done)`，`runId` 全一致 | 同上 |
| 中止生效 | 客户端断开后上游连接可能残留 | 中止 → 假上游观测到请求关闭 **11 ms**（`abortedRequests>0`） | 同上 |
| 超时终局 | 只有 `error`，无法区分超时与报错 | `stage(upstream_timeout)` + `error{code:UPSTREAM_TIMEOUT}`；`elapsedMs≥900`（注入 1 s 超时）；无 `done` stage | `agent-stage-timeout.test.ts` |

> 「改前为无事件」不是估算：长尾场景下旧实现最早的事件是上游首字节之后的 `meta`，上游不回响应头时不会有任何帧，只有超时后的一条 `error`。

## 10.5 R4 改动与探测参数

- **探测请求**：`POST {base}/chat/completions`；body `{ model, messages:[{role:'user',content:'ping'}], max_tokens:1, temperature:0, stream:false }`；`AbortSignal.timeout(12_000)`；非流式。
- **三态**：`ok`（2xx 且能解析）/ `auth_failed`（401、403）/ `unreachable`（网络错误、超时、其它非 2xx）。
- **缓存**：结果缓存 5 分钟（`checkOnce()` 命中返回 `cached=true`；`force=true` 才重新发请求）。
- **启动行为**：`runtime.ts` 中 `void trialHealth.checkOnce()` 异步执行；失败仅 `console.warn`，不阻塞启动、不影响请求。
- **对外暴露**：`GET /api/v1/agent/trial-status` 的 `trialUpstream.health = { status, detail, checkedAt, durationMs, tokens, cached }`；`detail` 只含上游 host 与 HTTP 状态，不含 Key。
- **ACL/成本**：单次最多 1 个 completion token + 约 2 个 prompt token（`ping`），实际约 3 token 量级；只在启动时一次（5 分钟内不重复）。代价是一个短时上游请求与最多 12 s 的后台等待；相对「Key 错了却显示正常」的假绿，这个成本可接受。

## 10.6 R4 实测：假绿已被消除

验证方式：**同一把无效 Key**，分别打旧接口与新探测接口。

| 探测 | 结果 | 耗时 | 说明 |
|---|---|---|---|
| 旧 `GET /models` | **HTTP 200** | 8,704 ms | 返回完整模型列表——即使 Key 无效也 200，正是「假绿」来源 |
| 新 `POST /chat/completions` 第 1 次 | **HTTP 401** | 577 ms | `Invalid JWT serialization` |
| 新 第 2 次 / 第 3 次 | HTTP 401 | 208 ms / 193 ms | 稳定复现 |
| 服务内 `TrialHealthService`（构建产物） | `auth_failed` | **1,384 ms** | `detail` 含 `HTTP 401` 与 host，不含 Key |
| 不可达地址 `127.0.0.1:9` | `unreachable` | **2 ms** | 网络错误分支 |
| 有效 Key → `ok` + token 用量 | **`ok` / 1,324 ms / 18 tokens** | 1,324 ms | 第三轮补测（§11.2）：17 prompt + 1 completion |

结论：旧自检用无效 Key 会得到 200（假绿）；新探测用同一把 Key 得到 401 并判 `auth_failed`——**假绿已被消除**。首次尝试（在满负载测试运行时）曾出现 15 s 超时报 `unreachable`，说明冷连接/上游长尾会让探测偶发误判，已按「失败只 warn + 5 分钟缓存」处理，详见 10.9。

## 10.7 本轮新增回归用例

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `server/tests/agent-stage-events.test.ts`（新增） | 3 | 阶段顺序与 `runId` 一致；上游无响应时早事件仍毫秒级到达；中止真正取消上游 |
| `server/tests/agent-stage-timeout.test.ts`（新增） | 1 | 超时终局 `upstream_timeout` + `UPSTREAM_TIMEOUT`，且不发 `done` |
| `server/tests/trial-resilience.test.ts`（改写健康检查段） | 9 | `ok + tokens`；401/403 → `auth_failed`；网络/超时/500 → `unreachable`；请求形态（POST、`max_tokens=1`、`stream=false`）；缓存与 `force`；`cfg=null` → `unknown` |
| `client/tests/run-stage-banner.test.ts`（新增） | 6 | connecting 文案与计时；12 s 慢响应升级；content 后不误报慢；超时终局文案；中止回调；非流式不渲染 |
| `client/tests/reasoning-stream.test.ts`（补充） | +2 | `stage` 帧按序分发；`upstream_first_byte` 后等待文案切换 |

## 10.8 全量重跑（本轮最终数字）

| 套件 | 文件 | 用例 | 通过 | 跳过 | 失败 | 耗时 |
|---|---|---|---|---|---|---|
| server（Vitest 5） | 88 | 923 | **920** | 3（无 git 环境显式跳过） | **0** | 1,469.41 s（本机 88 worker × ~20 s 启动；纯测试占 44%） |
| client（jsdom） | 9 | 62 | **62** | 0 | **0** | 32.80 s |

- `server`：`tsc --noEmit` 通过（exit 0）；`npm run build` 通过（exit 0）。
- `client`：`tsc --noEmit` 通过（exit 0）。
- 目标用例首轮：`trial-resilience` + `agent-stage-events` + `agent-stage-timeout` 共 24 例，**23 过 1 失败**；失败原因是测试请求把 `maxIterations` 写成 3（schema 下限为 5）→ 被 400 拒绝，属**用例参数错误**，改为 5 后随全量重跑通过。
- 全量耗时显著高于上一轮（505 s），本次 1,469 s；`vitest` 自身提示 88 个 worker 每个约 20 s 启动、`isolate:false` 可快约 862 s——这是本机 IO/安全软件成本，不是用例变慢。

## 10.9 剩余风险（未闭环部分）

1. **探测的偶发误判**：上游冷连接/长尾时，12 s 探测会记成 `unreachable`（本轮首轮 15 s 尝试即如此）。它是 warn-only + 5 分钟缓存，UI 文案写「不可达或暂不可用」，不会宣称 Key 有问题；若需要更稳，可把超时调到 20 s 或做 2 次重试（会增加启动期后台请求）。
2. **有效 Key 的 `ok` 路径——已补测（§11.2）**：真实上游 1,324 ms / 18 tokens，缓存命中 0 请求；原「只有 fake 2xx 单测覆盖」的缺口已关闭。
3. **中止耗时——已用真实上游复测（§11.5）**：经透明转发代理测得点击 → 上游连接释放 89 ms（socket 关闭 92 ms）；另发现「等首事件期中止」时渠道能力探测请求不会被取消（4,982 ms 后自行完成），记为残留风险。
4. **阶段去重是 run 级**：同一阶段只发一次，因此多轮工具循环不会重复发 `reasoning/content`；若未来需要「每轮各自计时」，需扩展 payload（当前设计不需要）。§11.6 已用真实 3 轮循环复核：文本事件不受影响，仅是横幅文案精度问题。
5. **启动期探针占用一个上游并发**：单次、短时；若上游限制并发，可能与首个真实请求竞争，影响可忽略但存在。

---

# 11. 第三轮（2026-11-05）：有效 Key 补测、真实上游全链路与中止、陈旧健康缓存修复

> 本轮输入：NVIDIA Key 仅通过**进程环境变量**注入，未写入任何文件、未在报告/日志/脚本中回显；脚本文件本身不含密钥。
> 上游：`https://integrate.api.nvidia.com/v1`，模型 `nvidia/nemotron-3-ultra-550b-a55b`；本地服务 8095（直连）/ 8096（经透明代理）/ 8097（故障恢复实验）。所有数字为真实实测，测不出的写「未测」。

## 11.1 本轮结论

| 项 | 结论 | 关键数据 |
|---|---|---|
| 有效 Key 自检 `ok` | **通过** | 1,324 ms；**18 tokens**（17 prompt + 1 completion）；缓存命中 **0 ms / 0 请求** |
| 同进程三态切换 | **发现真实问题并已修** | 改前：修好端点/Key 后不 force 仍停在旧失败态、**零复探**；改后：失败超 20 s 自动复探 1 次，**1,945 ms 转 `ok`** |
| 零配置全链路 | **通过** | connecting 306 ms → first_byte 3,797 ms → tool_call 4,606 ms → 审批 21 ms → tool_result 5,197 ms → 首个正文 6,584 ms → done 6,798 ms |
| 真实中止（等首事件） | 运行链路通过，暴露探测未取消 | 点击 388 ms → 流关闭 399 ms；该 run **未发出**生成请求；能力探测请求未被取消，4,982 ms 后自行完成 |
| 真实中止（流式中途） | **通过** | 点击 → 上游连接释放 **89 ms**，socket 关闭 **92 ms**；2 s 后同会话新请求 ~5,997 ms 正常完成 |
| 多轮工具循环 | 不影响可见内容 | 3 轮循环仅 4 个 `stage`（run 级去重）；`reasoning` 33 段、`delta` 9 段仍逐段到达 |
| 本轮新增闭环 | 1 项 | 失败态陈旧缓存自动复探（§11.3、§11.7） |

## 11.2 有效 Key：自检 `ok` 路径实测

| 调用 | 结果 | 耗时 | tokens | HTTP 次数 |
|---|---|---|---|---|
| 直接最小 chat（`max_tokens=1`、`stream=false`） | HTTP 200 | 1,798 ms | 18（17+1） | 1 |
| `TrialHealthService.checkOnce()` 首次 | `ok` | **1,324 ms** | **18** | 1 |
| 立即第二次（缓存命中） | `ok`，`cached=true` | **0 ms** | 18 | **1（无新增请求）** |
| `checkOnce(true)` 强制复测 | `ok`，`cached=false` | 1,446 ms | 18 | 2 |
| 服务启动期自动探测（8095） | `ok` | 5,792 ms | 18 | 1 |

- 「无新增请求」用计数 wrapper 包住 `fetch` 验证：缓存命中前后 `httpCalls` 恒为 1。
- 单次自检成本：**18 tokens**、0.2–5.8 s（冷启动最慢）；按「启动 1 次 + 失败恢复时复探」的使用频率，成本可忽略。
- 与上一轮「未测」相比，本项缺口关闭；假绿结论（无效 Key → `auth_failed`）仍成立。

## 11.3 三态切换与「缓存掩盖」实测（同一进程）

| 场景 | 改前（5 分钟缓存） | 改后（失败超 20 s 复探） |
|---|---|---|
| 端点 `127.0.0.1:9` | `unreachable`，1 ms | 同 |
| 修好端点后**不 force**读取 | **仍 `unreachable`，`cached=true`，0 请求** | 超 20 s 后读取：先返回旧值，同时后台复探 1 次 |
| 同上，3 s 后再读 | 仍 `unreachable`（可维持满 5 分钟） | **`ok`，1,945 ms，18 tokens** |
| 错误 Key | `auth_failed`，155 ms | 同 |
| 换成有效 Key 后不 force | 仍 `auth_failed`，**0 请求** | 同样自动转 `ok`（force 对照 677 ms） |

API 级验证（8097，启动时上游代理故意关闭）：启动自检 `unreachable`（109 ms）→ 恢复上游 → 等待 22 s 后读取 `trial-status`（返回旧值并触发后台复探）→ 3 s 后再读为 **`ok`（1,945 ms）**；代理日志显示**只发 1 次**探测请求，后续轮询不再重复。

说明：进程级 env 配置变更需重启才生效，因此该修复覆盖的是**上游从故障恢复 / 网络瞬断**——避免「对话已恢复可用、横幅还红最长 5 分钟」。

## 11.4 真实上游零配置全链路（阶段时间轴）

请求体即产品默认：`provider=deepseek`、`model=deepseek-v4-pro`、无自带 Key → 服务端试用锁到 NVIDIA。

| 事件 | 相对请求时间 | 说明 |
|---|---|---|
| 响应头 200（SSE 建立） | 304 ms | 本机 Express/CSP/压缩链路，非上游耗时 |
| `stage=connecting`（elapsedMs=0） | 306 ms | 服务端在访问上游前回执 |
| `meta` | 2,991 ms | 会话与渠道确定（含能力探测） |
| `stage=upstream_first_byte` | **3,797 ms** | 距 connecting 3,691 ms |
| 首个 `reasoning` | 3,797 ms | 与 first_byte 同刻 |
| `tool_call`（`fs.write`） | 4,606 ms | 进入审批 |
| 审批 POST 往返 | **21 ms** | `allow_once` |
| `tool_result` | 5,197 ms | 工具自身 403 ms，落盘成功 |
| 首个 `delta`（正文） | 6,584 ms | 第二轮上游 |
| `stage=done` / `done` | 6,796 / 6,798 ms | `finishReason=stop`，`iteration=2`，`toolCallCount=1` |
| usage | 7,907 prompt + 127 completion | 单次全链路成本 |

校验结果：
- 沙箱文件 `say.txt` 存在，内容 `hello-r5`。
- SQLite 落库：`messages` 含 user/assistant/tool 三类；`tool_calls` 1 条 `success`；`approvals` 1 条已决。
- 会话摘要接口需要设备令牌，探针未持有（`SESSION_ACCESS_DENIED`），故改用**直接读库**校验，不声称接口 200 校验。

## 11.5 真实中止实测

测量方式：本地**透明转发代理**（真实流量原样转发到 NVIDIA，仅记录「客户端关闭 / 上游断开」时刻），因此耗时含本地转发开销。

| 场景 | 点击时刻 | 流关闭 | 上游连接释放 | 结果 |
|---|---|---|---|---|
| 等首事件期（收到 `connecting` 后 30 ms 点击） | 388 ms | 399 ms | 该 run **没有**发出生成请求 | 运行链路已取消；能力探测请求未被取消，4,982 ms 后自行完成（`provider_capabilities` 落库 `supported`） |
| 流式中途（首个 `reasoning` 后 400 ms 点击） | 4,285 ms | ≈4,290 ms | **89 ms** 后 `client_closed`，**90 ms** 断开上游，**92 ms** socket 关闭 | 通过 |

配套校验：
- 两次中止后 2 s 在同一会话发起短请求，均在 **≈5,997 ms** 正常完成 → run 槽位/会话锁已释放，无悬挂。
- 服务日志与代理日志在中止后**无异常栈**；`POST /agent/abort` 均 200（1–12 ms）。
- 该接口响应 `aborted=false` 属预期：本地断连先于 HTTP 请求到达，run 已从注册表移除；跨标签页中止仍依赖该接口。

## 11.6 多轮工具循环：阶段去重是否影响用户可见内容

- 实测 3 轮（`fs.list` → `fs.write` → 总结），`stage` 只有 4 个：`connecting`、`upstream_first_byte`、`reasoning`、`done`。
- 文本未丢失：`reasoning` 33 段、`delta` 9 段全部到达，后续轮次照常渲染。
- 唯一影响是横幅文案：多轮之间的上游等待期仍显示「模型正在思考…」，不会回到「正在连接模型…」。
- 结论：**不是用户可见的内容缺失**，是标签精度问题；重发 `connecting` 会破坏阶段单调语义，收益不足以改协议。保持现状，记为已知设计。

## 11.7 本轮修改

| 文件 | 改动 | 原因 |
|---|---|---|
| `server/src/services/agent/trial-health.service.ts` | 新增 `refreshIfStaleFailure()`：失败态且距上次探测 > 20 s 时触发一次复探；`refreshing` 单飞闸防叠加 | 5 分钟缓存会把「已恢复」误报为「不可用」 |
| `server/src/runtime.ts` | `trial-status` 读取时调用该方法 | 让修复在 API 层真正生效 |
| `server/tests/trial-resilience.test.ts` | +3 例：`ok` 不触发；超窗复探转 `ok`；单飞不叠加 | 回归保护 |

**长尾/重试策略评估（未改，理由如下）**：适配器只对「建立连接前的网络错误」重试，不对「已发出但无响应/超时」重试。实测首字节 3.7 s（远小于 12 s 超时）；对已发出请求重试会产生第二次生成（双倍计费）且不改善延迟，故保持不重试。慢响应提示阈值 10 s 相对实测 3.7 s 有 2.7× 余量，保持。

## 11.8 本轮新增回归用例

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `server/tests/trial-resilience.test.ts`（新增 3 例） | 3 | `ok` 态不触发复探；失败超 20 s 触发 1 次并转 `ok`；复探在飞时再次读取返回 `null`（单飞） |

## 11.9 全量测试数字

| 套件 | 文件 | 用例 | 通过 | 跳过 | 失败 | 耗时 |
|---|---|---|---|---|---|---|
| server（Vitest 5） | 88 | 926 | **923** | 3 | **0** | 467.31 s |
| client（jsdom） | 9 | 62 | **62** | 0 | **0** | 30.78 s |

- `server`：`tsc`/`npm run build` 通过（exit 0，构建含本轮改动）。
- `client`：`tsc --noEmit` 通过（exit 0）。

## 11.10 剩余风险

1. **能力探测请求不随中止取消**：等首事件期中止时，渠道探测（`max_tokens=16`、非流式）仍会跑完（本轮 4,982 ms）。用户不可见、单次成本低，但在严格计费/并发受限的上游下是浪费；修复需把 abort signal 贯通到 `ChannelRouter.decide → probe`，属跨层改动，本轮不做。**（已在 §12 闭环：改后 12 ms；保留原文以记录改前状态）**
2. **中止耗时经本地代理测量**：89 ms 含约 1 ms 转发与同机调度；直连上游的绝对值未测（不做估算）。
3. **阶段去重为 run 级**：见 §11.6，仅影响横幅标签精度。
4. **自检单次 18 tokens**：启动 1 次 + 失败恢复复探；未做价格换算（NVIDIA 该端点本轮无现金成本口径）。
5. **会话摘要接口需设备令牌**：探针改用读库校验，接口层 200 校验未测。

## 11.11 证据与复现

| 证据 | 位置 |
|---|---|
| 健康自检 ok/缓存/三态切换 | `%TEMP%\codelens-r5-health.mjs`（读环境变量，不含密钥） |
| 真实全链路/中止/多轮 | `%TEMP%\codelens-r5-e2e.mjs`（`MODE=full\|multi\|abort-early\|abort-mid`） |
| 上游释放时刻 | `%TEMP%\codelens-r5-proxy.mjs`（透明代理日志 `proxy.log` / `proxy2.log`） |
| 落库校验 | `%TEMP%\codelens-r5-db.mjs`（`node:sqlite` 只读） |
| 服务日志 | `%TEMP%\codelens-r5\{a,b,d}\server.log` |

> 所有临时脚本/日志均在仓库外；生产服务按需启动（8095/8096/8097），测评结束后应停止。本轮未触发任何真实业务写操作，工具调用只写临时沙箱。

## 12. 第四轮：取消/超时信号贯通（signal 管道）

### 12.1 本轮结论

| 验收项 | 结论 | 实测 |
|---|---|---|
| 信号是否贯通到 probe | **是**：controller → run 取消上下文 → `decide/probe` → adapter fetch | 等首事件期中止，探测连接 **12 ms** 关闭（改前 4,982 ms） |
| 三类终止是否都能取消在途请求 | **是** | 用户中止 12–13 ms；超时 2,965 ms（配置 3,000 ms）；服务关闭 6 ms |
| abort 是否被当成错误上报 | **否** | 中止出口只发 `stage=aborted` + 既有 `done` 收尾，不发 `error` |
| 重复 abort 是否幂等 | **是** | `AbortRegistry` 第二次返回 `false`；run 上下文只触发一次 abort 事件 |
| 已销毁响应是否保护 | **是**（沿用既有保护） | `res.destroyed` 后 `emit/emitStage` 均为空操作，新增回归用例钉住 |
| 中止后同会话新请求 | **正常** | 同一 session 立刻再发，`done` 正常、`abortRegistry` 已释放 |
| 流式协议对外语义 | **未改** | 阶段事件名/字段与错误码不变 |
| 重试语义 | **未改** | 仍只重试「建连前网络错误」；「已发出无响应」不重试 |

### 12.2 改动（控制范围：probe + adapter 收口，不外溢）

| 文件 | 改动 |
|---|---|
| `server/src/services/agent/run-cancel.ts`（新增） | `RunCancellation`：把请求断连 / POST abort / shutdown 汇成**一个** run 级 signal，记录首次取消原因；`dispose()` 解除外部监听 |
| `server/src/services/agent/channel-router.service.ts` | `probe/decide` 接受 `signal`；已取消时返回 `status='cancelled'`，**不发起探测、不写能力表、不标 degraded** |
| `server/src/providers/openai-compatible.adapter.ts` | `probeToolSupport(params, signal)` 透传到 `post`；probe 捕获取消时返回 `cancelled`；`postOnce` 区分「外部取消」与「超时」；保留流式期间的 abort 监听（实测提前解绑会让流式中止退化为“等上游自己结束”） |
| `server/src/services/agent/agent-loop.service.ts` | 用 `RunCancellation` 替代临时 `turnController`；`decide` 吃 run signal，探测阶段的取消走统一收尾（不冒泡成 `INTERNAL_ERROR`）；`finally` 释放监听 |
| `server/src/runtime.ts` | 新增 shutdown 信号并注入 loop；`close()` 先 abort（取消在途 run）再关 MCP/DB，且幂等 |
| `server/src/app.ts` | SIGINT/SIGTERM 改为 `runtime.close()`（先取消在途 run），再关 HTTP |
| `server/tests/fixtures/fake-llm.ts` | 新增 `probeStall` / `probeRequests`：探测可挂起，用来复现「等首事件期探测在途」 |
| `server/tests/cancel-signal.test.ts`（新增 12 例） | probe 取消、已取消不建连、timeout 取消、外部 abort 不冒充 timeout、取消不落库、不标 degraded、取消幂等/归因、registry 幂等、已销毁响应不写、e2e 探测取消 + 同会话恢复 |

### 12.3 三类终止实测（真实上游，经本机透明代理记录）

| 场景 | 触发 | 观测 | 结果 |
|---|---|---|---|
| 用户中止·等待首事件 | 探测请求在途时客户端断连 | 代理记录 `client-close` | 点击 → 探测连接关闭 **12 ms** |
| 用户中止·流式中途 | 首个 `delta` 后断连 | 代理记录 `client-close` | 点击 → 上游释放 **13 ms** |
| 超时 | `UPSTREAM_TIMEOUT_MS=3000`，探测在途 | 代理 `client-close`（`responded=false`） | 请求开始 → 关闭 **2,965 ms**（配置 3,000） |
| 服务关闭 | `SIGTERM` → `runtime.close()` | 代理 `client-close` + 进程退出 | 信号 → 上游释放 **6 ms**；信号 → 进程退出 **24 ms** |
| 中止后恢复 | 同 session 立刻再发 | SSE `done` | 正常完成，无 `error`，`abortRegistry` 已释放 |

补充：中止瞬间读取 `provider_capabilities` 为**空**（取消不落库）；后续恢复请求成功探测后写入 `supported`，属正常路径。

### 12.4 改前 / 改后对比

| 维度 | 改前（§11 实测） | 改后（本轮） | 变化 |
|---|---|---|---|
| 等首事件期中止：探测请求 | 4,982 ms 后自行完成（未取消） | 12 ms 关闭 | ≈415× |
| 流式中途中止：点击→上游释放 | 89 ms | 13 ms | 更快（同为本机代理口径，含转发开销） |
| 超时：在途请求取消 | 只断开等待方，请求仍可能继续 | 2,965 ms 取消（≈配置值） | 语义闭环 |
| 服务关闭：在途请求 | 等上游/工具自然结束 | 6 ms 取消，24 ms 退出 | 新增闭环 |

### 12.5 本轮回归用例（新增 12 例，全部通过）

`server/tests/cancel-signal.test.ts`：abort 传播到 probe（含「已取消不建连」）、abort 不冒充 timeout、timeout 取消在途请求、取消不写能力表/不标 degraded、重复 cancel 幂等且归因先到先得、shutdown 归因可区分、`AbortRegistry` 重复 abort 幂等、已销毁响应不写、e2e「探测挂起 → 断连 → 代理侧 ≤1 s 观察关闭 → 同会话恢复」。

### 12.6 全量数字（本轮最终）

- server：**89 文件 / 938 用例 / 935 通过 / 3 跳过 / 0 失败 / 122.20 s**（含新增 `cancel-signal.test.ts`）
- client：**9 文件 / 62 用例 / 62 通过 / 0 失败 / 15.82 s**
- `tsc --noEmit`：server 0 错、client 0 错
- `npm run build`：server 0 错、client 0 错（vite 7.64 s）

### 12.7 定位收敛（决策 A，个人工具）

| 文档 | 改动 |
|---|---|
| `docs/review-20261105/product-positioning.md` | 头部新增定位决断；Persona C/D 从「小团队 tech lead / 团队」收回为**个人开发者**；「明确不服务」改为**团队版/企业版暂不承诺**；新增 §3.4 成本模型（**成本由用户自带 Key 承担，既是特点也是约束**）；新增 §7 定位收敛记录表 |
| `README.md` | 首段改为「**个人**本地 Agent 工作台（单用户 / 可自托管，非团队产品）」并写明成本归属；删除「通用 Agent 平台」「仍在售」等商业化措辞；自托管说明补「团队版/企业版暂不承诺、无账号/成员/审计后台」 |
| 界面文案 | 核查 `client/src`：无「团队/企业/多租户/成员/共享工作区」等暗示；无需改动 |

### 12.8 剩余风险

1. **中止耗时经本机代理测得**：12/13 ms 含约 1 ms 转发；直连上游绝对值**未测**（不做估算）。
2. **超时只覆盖「等响应头」**：流式 body 的超时仍由 undici 的 30 min bodyTimeout 兜底；本轮未构造 body 级超时场景（未测）。
3. **`AbortSignal` 监听在流式期间保留**：每轮请求在 run 级 signal 上留 1 个监听，run 结束随 signal 回收；不跨 run 累积。
4. **关闭顺序**：`runtime.close()` 先 abort 再关 DB，但不等待 run 完全收尾（最多 3 s 进程兜底）；极端情况下 run 末尾的写库可能失败并只留日志，未做强制等待（避免退出卡死）。
5. **阶段事件**：abort 后仍按既有语义发 `stage=aborted` + `done`（`finishReason=aborted`），未改协议。

### 12.9 证据与复现

| 证据 | 位置 |
|---|---|
| 真实上游三类终止 + 代理时间戳 | `%TEMP%\codelens-r5b-measure.mjs`（读 `NVIDIA_KEY` 环境变量，不落盘） |
| 代理原始日志 / 汇总 | `%TEMP%\codelens-r5b\proxy.log`、`results.json` |
| 回归用例 | `server/tests/cancel-signal.test.ts` |
| 全量测试日志 | `%TEMP%\codelens-r5b-server-tests.log` |

---

## 13. 第五轮：审批语义（可逆审结果 / 不可逆审后果）与独立复核

### 13.1 为什么改

前四轮的审批只有一个维度：`approvalMode !== 'none'` 就**前置打断**。它有两个后果：

1. **可逆操作被反复打断**：`fs.write` 的 create/append/rename 都能用写前快照恢复，却和 `purge` 走同一个确认框；
2. **不可逆操作却看不到后果**：审批卡只给一串 `arguments` JSON，用户看不出「会删掉什么、有多少、能不能恢复」。

本轮按用户总纲改为语义分流：**能撤的审结果，撤不回的审后果**。

### 13.2 分流规则（实现口径）

| approvalMode | 可逆性 | 是否前置 | 执行后 |
|---|---|---|---|
| `none` | — | 否 | 无卡 |
| `soft` | 可逆（写前快照可恢复 / create / append / rename） | **否** | `result_review`（diff + 撤销入口）→ 复核并行回填 `review_result` |
| `hard` | 不可逆（delete / purge / exec / 写请求 / MCP 写） | **是**，带 `EffectPreview` | 复核（执行前同步） |
| `two_step` | 不可逆且影响面大 | 是，两次确认，每步都带预览 | 同上 |

- 可逆性判定在 [`effect-preview.ts`](../新建文件夹%20(2)/server/src/services/tools/effect-preview.ts) 的 `buildEffectPreview`：只读事实（`statSync` 字节数、目录条目数、是否存在、是否在启用 checkpoint 的工作区内）。
- gateway 在 [`security-gateway.ts`](../新建文件夹%20(2)/server/src/services/tools/security-gateway.ts) 产出 `verdict.effect`，审批 SSE 在 [`approval.service.ts`](../新建文件夹%20(2)/server/src/services/agent/approval.service.ts) 透传 `effect`。
- executor 的 `mustChallenge` 现在只对 `hard` / `two_step` 成立：[`executor.service.ts`](../新建文件夹%20(2)/server/src/services/tools/executor.service.ts)。`soft` 直接放行。

### 13.3 独立复核（只喂事实）

| 项 | 实现 |
|---|---|
| 服务 | [`review.service.ts`](../新建文件夹%20(2)/server/src/services/agent/review.service.ts)，`REVIEW_PROMPT_VERSION='review-r6-v1'` |
| 输入 | `ReviewFacts`：工具名 / 路径 / 操作 / before-after 存在性与字节数 / itemCount / 命令 / cwd / 副作用。**不含** reasoning、计划、历史消息 |
| 问法 | 只问「哪一条不可逆或影响面被低估」，要求严格 JSON（`confirmed｜underestimated` + findings） |
| 成本 | `temperature=0`，记录真实 `promptTokens/completionTokens` 与 `latencyMs`，落 `agent_reviews` |
| 时机 | 不可逆：执行前**同步等结论**，`underestimated` 时以 findings 升级重确认；可逆：执行后**并行回填**，不阻塞主流程 |
| 无凭证 | 返回 `unexec` + reason，不臆测结论 |

### 13.4 验收

| 模块 | 证据 | 状态 |
|---|---|---|
| 后果预览生成/透传 | `effect-preview.ts`、`security-gateway.ts`、`approval.service.ts` | 完成 |
| 可逆不前置 / 不可逆前置 | `executor.service.ts`；`tests/executor.service.test.ts` | 完成 |
| 复核只喂事实 | `review.service.ts`；`tests/review.service.test.ts`（断言请求里无 reasoning/plan/assistant） | 完成 |
| token/耗时真实 | `agent_reviews` 表；`tests/review.service.test.ts` 断言 usage/latency 与库内一致 | 完成（假适配器构造） |
| 可逆并行回填 | `agent-loop.service.ts` 每个 outcome 发 `result_review` 并异步 `review()` | 完成 |
| 前端 | `ToolApprovalBar.tsx` 后果预览、`ToolCallCard.tsx` 复核卡片 | 完成（类型检查通过） |

**未测**：复核的真实上游 token 绝对值——本轮用可控假适配器验证字段与落库链路，不对任一具体模型的成本做外推。

---

## 14. 第五轮：沙箱按目录授权 + 三类攻击面

### 14.1 改动

| 能力 | 改前 | 改后 |
|---|---|---|
| 工作区外访问 | 只认静态 `allowedDirs`，越界直接拒绝 | 首次越界**弹一次授权**（SSE `sandbox_grant_required`），允许后落库并重跑闸门 |
| 授权持久化 | 无 | `sandbox_grants`（`real_path`/`created_at`/`revoked_at`），撤销软删除 |
| 用户目录 | `C:\Users` 整段封禁 | 取消整段封禁，改为**敏感子路径**运行时拦截 |
| 敏感路径 | 仅白名单校验期有系统前缀 | 白名单目录内 `.ssh/.aws/浏览器配置/*.pem/id_rsa` 继续 `SECURITY_DENIED` |
| `..` 穿越 | 词法拒绝 | 保持词法拒绝，且**永不进入授权流程**（不能用授权洗白穿越） |

实现：`services/tools/sandbox-grant.service.ts`、`repositories/sandbox-grant.repository.ts`、`controllers/sandbox-grants.controller.ts`、`routes/sandbox-grants.routes.ts`、`services/tools/sensitive-path.ts`；前端 `SandboxGrantBar.tsx`。

### 14.2 三类攻击面实测

| 攻击面 | 构造 | 预期 | 实测 |
|---|---|---|---|
| `..` 穿越 | `..\secret.txt` | `PATH_TRAVERSAL` | 拦截 |
| symlink 逃逸 | 授权目录内软链指向区外文件 | realpath 后 `PATH_OUTSIDE_SANDBOX` | 拦截 |
| 跨盘符越界写 | C 盘授权目录 → `D:\evil.txt` | `PATH_OUTSIDE_SANDBOX` | 拦截（`path.relative` 绝对路径兜底） |
| 敏感路径 | 白名单目录内 `.ssh/id_rsa` | `SECURITY_DENIED` | 拦截 |

用例：`server/tests/sandbox-attack.test.ts`（5 例）、`server/tests/sandbox-grants.test.ts`（6 例，含首次弹卡、允许后复用、拒绝、超时、会话中止、撤销后重弹、敏感目录不弹）。

**未测**：非 Windows 宿主上的跨盘符语义（用例按 `process.platform` 只在 Windows 断言）；授权弹卡的浏览器端到端点击。

---

## 15. 第五轮：证据链、RunState 与主动汇报

### 15.1 证据链

| 能力 | 实现 | 验证 |
|---|---|---|
| run 级 before | `checkpoint.service.capture({runId, step, toolCallIds})`：`workspace_checkpoints` 增加 `run_id/step/tool_call_ids_json` | `tests/checkpoint-evidence.test.ts` |
| run 级 after + diff | `captureAfter(runId, step)`：回填 `after_manifest_json/diff_json`（`lineDiff/renderUnified`，二进制/大文件标注） | 同上，diff 含 `A2-changed`，after sha256 对齐 |
| 按 run 查「改了什么 + 来自哪一步」 | `getRun(runId)`；`GET /api/v1/checkpoints/runs/:runId` | 各 step 的 `toolCallIds` 与文件清单逐项对上 |
| 撤销（run / step / files） | `restoreRun(runId,{step?,files?})`；`POST /checkpoints/runs/:runId/rollback` | 「改坏 → 定位 step2 → 只撤 step2 → 再撤整 run → sha256 校验一致」 |
| 撤销留痕 | `markRestored`：`restored_at` + `restore_json` | 两行快照均可读到 `"restored"` |
| 保留策略 20 run / 200 MB | `prune({maxRuns, maxBytes})`、`pin()`；行保留 + `status=pruned` + 删 blob | 22 run 构造：pin 最老、淘汰下一条；被淘汰 run 撤销明确失败 |
| 防泄漏 | `isCredentialPath` 跳过 `.env*/*.pem/*.key/id_rsa/.ssh` 等；blob 目录 `chmod 0700` | 代码路径核查（未构造真实密钥文件）；**未测**真实 200 MB |

### 15.2 RunState 与汇报卡

| 字段/能力 | 实现 | 验证 |
|---|---|---|
| 结构化 run 状态 | `agent_runs.state_json`：stages / tools / approvals / fileChanges / errors / cost / termination | `tests/run-state.test.ts` |
| 按 runId 查询 | `RunStateService.get/getReport/list`；`GET /api/v1/runs/:runId`、`GET /api/v1/runs?sessionId=` | 服务层覆盖；路由已注册 |
| 持久化不含凭证 | 只存 provider/model/channel 与计数 | 断言无 `sk-` / `apiKey` / `Authorization` / `baseUrl` |
| 汇报卡默认克制 | `hasMaterialChange` 仅在文件改动 / 不可逆 / 审批 / 错误降级 / 成本异常时为真 | 三场景 + `RUN_REPORT_EVERY` |
| 每轮必报 | `RunStateService({everyRun:true})` → `RUN_REPORT_EVERY=1` | 纯问答也出卡 |

### 15.3 三场景实测

| 场景 | hasMaterialChange | 是否出卡 | 关键数字 |
|---|---|---|---|
| 纯问答 | false | 不出 | tool=0 / file=0 / approval=0 |
| 只读极简 | false | 不出 | tool=1 / file=0 |
| 写 + 审批 + 不可逆 | true | 完整卡 | file=1 / irreversible=1 / approval=1 / error=1；summary 与状态逐项一致 |
| `everyRun=true` | 强制 true | 出卡 | — |

### 15.4 全量数字与验收表

**全量测试**（最后一次改动后重跑，2026-11-05 21:16 起）

| 范围 | 文件 | 用例 | 通过 | 跳过 | 失败 | 耗时 |
|---|---|---|---|---|---|---|
| server（`npm test --prefix server`） | 94 | 964 | **961** | 3 | **0** | 700.97 s |
| client（`npm test --prefix client`） | 9 | 62 | **62** | 0 | **0** | 21.01 s |

- 3 个跳过是 `tests/sys-exec.test.ts` 的既有环境条件跳过（与本次改动无关），不是失败。
- 本轮耗时 700.97 s，明显高于上一轮的 122.20 s；同批次日志显示 94 个 worker 每个启动约 5.37 s，属本机 IO/安全软件抖动，不据此得出性能结论。

**类型与构建**

| 项 | 命令 | 结果 |
|---|---|---|
| server 类型检查 | `npm run typecheck --prefix server`（`tsc --noEmit`） | 0 错 |
| client 类型检查 | `npm run typecheck --prefix client`（`tsc --noEmit`） | 0 错 |
| 全量构建 | `npm run build`（client `tsc -b` + `vite build` + server `tsc` + `prepare-dist`） | 0 错 |

**模块验收表**

| 模块 | 证据（文件 / 测试 / 实测） | 状态 |
|---|---|---|
| 不可逆后果预览 | `services/tools/effect-preview.ts#L52`（`buildEffectPreview`）、`#L91-L111`（可恢复性判定）、`#L196`；`security-gateway.ts` 产出 `verdict.effect`；`approval.service.ts` 透传 | 完成 |
| 可逆审结果 / 不可逆前置 | `services/tools/executor.service.ts#L192-L215`（`mustChallenge` 仅 `hard`/`two_step`）、`#L322`（不可逆先同步复核）；`tests/executor.service.test.ts`、`tests/agent-loop-e2e.test.ts`（soft 放行、hard 弹审批） | 完成 |
| 独立复核只喂事实 | `services/agent/review.service.ts#L31`（`review-r6-v1`）、`#L94`（`ReviewFacts`）、`#L131`（`temperature=0`）、`#L147-L160`（token/耗时落库）；`tests/review.service.test.ts`（6 例：无 reasoning/plan、token 与库内一致、无凭证 `unexec`、非 JSON `unexec`） | 完成 |
| 复核时机 | `agent-loop.service.ts#L369-L371`（不可逆同步）、`#L862-L908`（可逆 `result_review` → 异步 `review_result` 回填） | 完成 |
| 沙箱按目录授权 | `services/tools/sandbox-grant.service.ts`（pending/超时/abort/`requireGrant`）、`repositories/sandbox-grant.repository.ts`、`schema.ts#L348-L359`（`sandbox_grants`）、`routes/sandbox-grants.routes.ts`；`tests/sandbox-grants.test.ts`（6 例：首弹→允许→复用、拒绝、超时、会话中止、`.ssh` 直接拒绝、撤销重弹） | 完成 |
| 敏感路径黑名单 | `services/tools/sensitive-path.ts`（`.ssh/.aws/.gnupg/.kube/.docker`、浏览器凭据、`.env/id_rsa/credentials`、`.pem/.key/.p12`）；`sandbox-permission.ts` 授权校验期拒绝；`security-gateway.ts` 运行时拒绝 | 完成 |
| 三类攻击面 | `tests/sandbox-attack.test.ts`（5 例）：`..` → `PATH_TRAVERSAL`；symlink → realpath 后 `PATH_OUTSIDE_SANDBOX`；跨盘符 → `path.relative` 兜底拒绝；敏感路径 → `SECURITY_DENIED` | 完成（跨盘符仅 Windows 断言） |
| run 级证据链 | `services/tx/checkpoint.service.ts#L496`（`runId` 落库）、`#L647`（`captureAfter`）、`#L736`（`getRun`）、`#L614`（`restoreRun`）、`#L606`（`markRestored`）；`tests/checkpoint-evidence.test.ts`（3 例：after+diff、按 step 撤销、整 run/按文件撤销 + sha256 一致） | 完成 |
| 撤销留痕 | `restored_at` + `restore_json`（`schema.ts#L298`、`checkpoint.service.ts#L606`）；测试读到两行留痕 | 完成 |
| 保留 20 run / 200 MB | `checkpoint.service.ts#L781-L801`（`prune` 默认 20 run / 200 MB、`pinned` 不淘汰、`status=pruned`）；22 run 构造淘汰 1 条最老非 pinned，被淘汰 run 撤销明确失败 | 完成（未构造真实 200 MB） |
| 防泄漏 | `checkpoint.service.ts#L259`（`isCredentialPath`）；blob 目录 `0700` | 完成（代码核查，未构造真实密钥文件） |
| RunState 结构化状态 | `services/agent/run-state.service.ts#L77-L96`（`agent_runs.state_json` 持久化）、`#L232-L242`（`getReport`/`list`）；`tests/run-state.test.ts`（6 例） | 完成 |
| 按 runId 查询 API | `routes/runs.routes.ts`（`GET /runs`、`GET /runs/:runId`）、`routes/checkpoints.routes.ts#L24-L28`；`runtime.ts#L375-L376` 注入 | 完成（服务层覆盖，未做独立 HTTP 契约测试） |
| 汇报卡与三场景 | `agent-loop.service.ts#L1131`（仅 `hasMaterialChange` 发 `run_report`）；`run-state.service.ts#L188-L195`；`client/src/components/agent/RunReportCard.tsx` | 完成 |
| 前端展示 | `ToolApprovalBar.tsx#L193-L219`（不可逆预览）、`ToolCallCard.tsx`（复核 pending/underestimated/unexec + model/latency/tokens）、`SandboxGrantBar.tsx`、`RunReportCard.tsx`；client `tsc` 0 错、62 例通过 | 完成（授权条未做浏览器点击） |
| 报告 | 本文件 §13–§15；HTML 报告 §13–§15 + 图 13/14 | 完成 |

### 15.5 剩余风险

1. 复核 token 为假适配器构造，不代表具体模型的真实计费；
2. 200 MB 上限只验证了淘汰逻辑，未构造真实 200 MB 数据；
3. 授权弹卡未做浏览器端到端点击验证；
4. 非 Windows 宿主的跨盘符用例未测；
5. RunState 查询 API 仅有服务层测试，未做独立 HTTP 契约测试。

---

## 16. 第六轮 A：四道预算与收尾式停止

### 16.1 实现

| 预算 | 配置项（默认值） | 默认依据 | 触发后的收尾 |
|---|---|---|---|
| 迭代数 | `maxIterations`（12） | 既有上限：12 轮足够覆盖「思考→调用→观察」的正常闭环 | `finishReason=max_iterations`，`budget.kind=iterations` |
| 工具调用总次数 | `AGENT_MAX_TOOL_CALLS`（40） | 12 轮 × 平均 3 次调用 + 余量；防止单轮批量调用绕过轮次上限 | `finishReason=budget_exhausted`，`budget.kind=tool_calls` |
| 累计 token | `AGENT_TOKEN_BUDGET_FACTOR`（2）× 上下文窗口 | 一次任务不应把上下文窗口塞满两遍；窗口未知时不设上限（`UNLIMITED`） | `finishReason=budget_exhausted`，`budget.kind=tokens` |
| 墙钟 | `AGENT_TASK_BUDGET_MS`（180000） | 首字节 5–20 s、正常任务 60–150 s，180 s 留出一次重试余量 | `finishReason=budget_exhausted`，`budget.kind=wall_clock` |

- 四道阈值在 `checkTermination()` 中**同一处**按 aborted → iterations → tool_calls → tokens → wall_clock 顺序判定，命中即返回 `term.budget = {kind, limit, used, atStep}`（[loop-budget.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/agent/loop-budget.ts#L87)）。
- 到顶**不抛错**：`agent-loop` 先 `runState.budget(runId, {...})` 再 `finish()`，`finish()` 写入 `cutoff`（最后阶段、已完成工具调用数、已完成文件改动数、未完成项），见 [run-state.service.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/agent/run-state.service.ts#L224)。
- 预算耗尽与任务完成使用不同状态码：`RUN_BUDGET_ITERATIONS / RUN_BUDGET_TOOL_CALLS / RUN_BUDGET_TOKENS / RUN_BUDGET_WALL_CLOCK` vs `RUN_COMPLETED`；收敛另有 `RUN_CONVERGED`（[run-state.service.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/agent/run-state.service.ts#L234)）。
- 汇报卡 `reason` 由 `budgetReason()` 生成，格式固定为「工具调用预算在第 N 步触发（used/limit 次）；已做：…；未做：…」（[run-state.service.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/agent/run-state.service.ts#L246)）。

### 16.2 验收

| 判据 | 证据 | 类型 | 状态 |
|---|---|---|---|
| 工具调用触顶：`kind/step/limit/used` 完整 | `loop-budget.test.ts`「stops when the tool-call budget is exhausted and reports kind/step」 | unit | 通过 |
| 金丝雀：39/40 不得走收尾路径 | 同文件「金丝雀：工具调用 39/40 时不得走收尾路径」 | unit（应绿） | 通过 |
| 破坏夹具：未到顶不得产出预算终态 | `run-state.test.ts`「A · 破坏夹具：未到顶（无 budget 记录）不得产出预算终态」 | unit（应红对照） | 通过 |
| token / 墙钟 / 迭代均带 budget 元数据 | 同文件「token / wall-clock 命中时都带 budget 元数据」「迭代上限同样带 iterations 元数据」 | unit | 通过 |
| 终态 cutoff / reason / notDone / statusCode 完整且 ≠ RUN_COMPLETED | `run-state.test.ts`「A · 预算触顶：终态与完成态不同码，cutoff / reason / notDone 完整」 | unit | 通过 |

**未执行**：真实上游跑满 40 次工具调用 / 180 s 墙钟的 live 触发（需外部模型，未跑，不计入 PASS）。

---

## 17. 第六轮 B：收敛判据（治空转）

### 17.1 实现

- `buildRoundSignature(state, toolOffset, fileOffset)` 只切片「本轮新增的」工具结果与文件改动，生成 `filesDelta` + `resultDigest`（sha256 前 16 位）；差异来自 RunState 结构化状态，不读模型自述（[convergence-detector.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/agent/convergence-detector.ts#L25)）。
- `ConvergenceDetector.record()`：filesDelta>0 或 digest 变化 → 清零；否则 streak+1；达到阈值（默认 3，`AGENT_CONVERGENCE_ROUNDS=0` 关闭）即判收敛（[convergence-detector.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/agent/convergence-detector.ts#L45)）。
- 命中后 `finishReason='converged'`，汇报文案「连续 N 轮无新增文件改动 / 证据 / 工具结果变化，我判断已到头」（[agent-loop.service.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/agent/agent-loop.service.ts#L978)）。

### 17.2 验收

| 场景 | 期望 | 证据 | 状态 |
|---|---|---|---|
| 空转（重复读同一文件、无写入） | 第 3 轮停 | `convergence-detector.test.ts`「空转：连续 3 轮无变化 → 第 3 轮判收敛」 | 通过 |
| 反例：连续 3 轮都有写入 | 不得停 | 同文件「反例：连续 3 轮都有写入 → 不得停」 | 通过 |
| 边界：刚好第 N 轮产生改动 | 计时重置 | 同文件「边界：刚好第 N 轮产生改动 → 计时重置」 | 通过 |
| 金丝雀：仅工具结果变化、无写入 | 不得判收敛 | 同文件「金丝雀：工具结果 digest 变化（即使无写入）也不得判收敛」 | 通过 |
| 关闭开关 | `threshold=0` 永不收敛 | 同文件「threshold=0 时关闭收敛判定」 | 通过 |
| 切片只取本轮新增 | offsets 正确 | 同文件 `describe('buildRoundSignature（来自 RunState 真实差异）')` | 通过 |

**未执行**：真实模型连续空转 3 轮的 live 验证（未跑）。

---

## 18. 第六轮 C：断点续跑（强校验）

### 18.1 实现

- `CheckpointService.verifyRun(runId)`：按 run 列出快照，跳过 `pruned`，同一文件取最后一步 `afterSha256`，与磁盘当前 sha256 逐一比对；文件缺失或越界返回 `actualSha256=null`；**只读，不写盘**（[checkpoint.service.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/tx/checkpoint.service.ts#L786)）。
- `RunResumeService.precheck(runId)` 顺序：run 不存在 → `not_found`；**先**做 sha 校验 → `conflict`（附冲突清单：文件 / 期望 sha / 实际 sha / 步骤 / checkpointId）；再判 status ≠ running → `not_resumable`；最后取最后一轮最早一条 `callId` 作为 `resumeFromCallId`，不重放已完成调用（[run-resume.service.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/agent/run-resume.service.ts#L27)）。
- `POST /api/v1/runs/:runId/resume`：404 / 409（冲突或不可续跑）/ 200 plan（[runs.controller.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/controllers/runs.controller.ts#L91)）。
- 前端冲突态：`ResumeConflictCard`（`role=alert`、`aria-live=assertive`、`data-state=resume-conflict`），只展示与「重新检查」，不做自动覆盖（[ResumeConflictCard.tsx](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/client/src/components/agent/ResumeConflictCard.tsx#L9)）。

### 18.2 验收

| 场景 | 断言 | 证据 | 状态 |
|---|---|---|---|
| 正常恢复 | `ok` 且 `resumeFromCallId='c2'`（c1 不重放） | `run-resume.test.ts`「正常恢复：磁盘一致 → ok，且从最后一步的第一条调用重做」 | 通过 |
| 改坏后恢复 | `conflict`，且文件 sha 前后一致（未写盘） | 同文件「冲突：人为改坏一个文件 → 返回冲突且不写盘（sha 前后一致）」 | 通过 |
| 修复后再恢复 | `ok`，run 正常收尾 | 同文件「冲突修复后再次恢复 → ok，且 run 能正常收尾」 | 通过 |
| 金丝雀：无已改动文件 | 不得报冲突 | 同文件「金丝雀：无已改动文件时不得报冲突」 | 通过 |

**未执行**：经 HTTP 路由从外部触发续跑（测试走服务层，路由仅注册未见独立契约测试）。

---

## 19. 第六轮 D：审计台（快照 diff，不做编辑器）

### 19.1 实现

- `GET /api/v1/runs/:runId/audit` 返回 `report / budget / cost / stages / approvals / files / steps`，其中每个 step 的文件条目附带 `step / checkpointId / toolCallIds`（来源可反查）；`undo` 复用既有 rollback（[runs.controller.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/controllers/runs.controller.ts#L39)）。
- diff **只**来自 `workspace_checkpoints.diff_json`（快照时算好的 before/after），接口不读磁盘重算。
- 前端 `AuditView`：文件树按目录折叠、单文件 diff、`@@ 第 N 步 · callIds · 快照 cp_...` 元行可点击/Enter 打开步骤详情（审批记录、快照版本、撤销时间），run 级与文件级撤销入口，续跑检查；diff 采用虚拟滚动（[AuditView.tsx](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/client/src/components/agent/AuditView.tsx#L63)、[audit-window.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/client/src/components/agent/audit-window.ts#L10)）。

### 19.2 判别性用例（打红才算过）

`runs-audit.test.ts`「改坏磁盘后 audit 仍显示历史 diff；当前磁盘基线对照为空」：

1. 快照 v1 → after v2 落库；
2. 磁盘文件改成 v3；
3. 产品接口仍返回 `-v1/+v2`（历史差异）；
4. 同一时刻若以**当前磁盘**为基线重新 capture/captureAfter，则 `diff === ''`（空 diff）。

命名的空 diff 是这条判据的金丝雀：它证明「用磁盘重算」一定看不见历史改动；只有快照口径能显示差异。**通过**。

### 19.3 大文件 / 多文件渲染

| 用例 | 规模 | 实测 | 证据 | 状态 |
|---|---|---|---|---|
| 单文件 2000 行 + 20 文件 | 2000 行 / 20 文件 | jsdom 下组件实测 `renderMs=499ms`（首跑）/ `197ms`（复跑）；可见 DOM 行 < 60（虚拟滚动生效）；仅 1 次本机 API 请求 | `client/tests/layout-states.test.ts`「虚拟滚动后 DOM 行有界…」 | 通过 |
| 渲染耗时可读 | — | `data-render-ms` + 卡片头「渲染 Nms」 | 同上 | 通过 |

**说明**：499 ms 是 jsdom（无真实排版）下的上界测量，不代表浏览器实测性能；**浏览器实测未执行**。

---

## 20. 第六轮 E/F：审批去重（有红线）与布局

### 20.1 E 审批去重

- `ApprovalDedupService.keyFor()` 只在同时满足以下条件时返回键：可逆（`effect.reversible===true`）、操作对象全是 file/dir、无敏感路径、无越界目录、单一目录；键为 `${runId}|${dir}|${toolName}`（[approval-dedup.service.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/agent/approval-dedup.service.ts#L47)）。
- 命中时 executor 跳过审批、发 `approval_dedup` 事件，前端在工具卡上显示「已按你上次的授权执行，可撤销」；RunState 的审批记录写 `decision='deduped'` + `reusedGrantId` / `reusedStep`，撤销时可追溯到原始授权（[executor.service.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/tools/executor.service.ts#L215)）。
- **适用面如实说明**：本产品可逆写入默认走 `soft`（无前置审批），去重实际只作用于「被前置审批的可逆调用」（如 `two_step` 下已批准的可逆写入）。测试用 `hard + reversible` 夹具覆盖该路径；这不是漏洞，但意味着日常 `soft` 写入本就不弹卡，去重收益集中在被审批拦下的可逆批次。

| 用例 | 期望 | 证据 | 状态 |
|---|---|---|---|
| 可逆同目录第二次 | 不弹新卡、发一行提示、`approvals.count=1`、留痕 `ap_1` | `approval-dedup.test.ts`「可逆写入第二次起不弹卡，发一行提示并留痕」 | 通过 |
| 不可逆第二次 | 必弹 | 同文件「红线：不可逆操作第二次仍必弹」 | 通过 |
| 敏感路径（`.env`）第二次 | 必弹 | 同文件「红线：敏感路径（.env）第二次仍必弹」 | 通过 |
| 越界目录 | `keyFor` 直接返回 null | 同文件「红线：越界目录不去重（keyFor 直接拒绝）」 | 通过 |

### 20.2 F 布局与四态

- 主区保持会话/工作台；头部新增「会话 / 审计台」分段控件（`aria-pressed` + `focus-visible:ring`），审计台是可切换视图而非新窗口（[AgentWorkbench.tsx](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/client/src/components/agent/AgentWorkbench.tsx#L239)）。
- 右栏「运行检视器」新增阶段序列（`aria-live=polite`，最近 8 条）与风险项（汇报 triggers + 流级错误）（[RunInspector.tsx](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/client/src/components/agent/RunInspector.tsx#L16)）。
- 汇报卡固定在会话流尾部：`role=status aria-live=polite`，`data-outcome` / `data-status-code` 区分「已完成 / 预算耗尽·未完成 / 收敛停止·未完成 / 已中止 / 出错」（[RunReportCard.tsx](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/client/src/components/agent/RunReportCard.tsx#L40)）。
- 四态：空态（审计台无 run / 检视器未开始）、等待态（`RunStageBanner` + 阶段 aria-live）、错误态（错误条 `role=alert` + 汇报卡红文案）、冲突态（`ResumeConflictCard` assertive）。

| 判据 | 证据 | 状态 |
|---|---|---|
| 空态 / 等待态 / 错误态 / 冲突态四类文案与语义角色 | `client/tests/layout-states.test.ts` 前 4 例 | 通过 |
| 审计台切换 `aria-pressed` 正确 | 同文件「点击「审计台」进入审计视图」 | 通过 |
| 2000 行 / 20 文件不卡死且 DOM 有界 | 同文件最后一例（499 ms） | 通过 |
| 键盘可达 / 焦点可见 / `aria-live` | 代码核查：切换按钮、diff 元行 `tabIndex=0` + Enter/Space、文件树按钮、审计/阶段/汇报 `aria-live`；`focus-visible:ring-2` | 代码核查通过 |
| 对比度不低于既有规范 | 全部颜色取自既有 tokens（`text-secondary` / `text-tertiary` / `warning` / `danger` 组合沿用既有页面），未引入新色值 | 代码核查通过 |
| 浏览器实测四态截图 / 控制台无错误 / 无外部资源请求 | — | **未执行**（本轮无浏览器会话） |

**未执行**：`web-design-guidelines` 的浏览器自动化逐条核对（键盘 Tab 序列、真实对比度采样）；此项**不计 PASS**。

### 20.3 布局前后对照（能力可见性）

| 能力 | 改前 | 改后 |
|---|---|---|
| 「现在在干什么」 | 只有单行阶段横幅，历史不可见 | 右栏阶段序列（最近 8 条，aria-live） |
| 「改了什么」 | 只能看工具卡，无按文件视图 | 会话/审计台切换；文件树 + 快照 diff + hunk 来源 |
| 「要不要我拍板」 | 审批卡片与汇报分散 | 汇报卡固定流尾，终态码与文案分叉 |
| 续跑冲突 | 无对应视觉 | `ResumeConflictCard`（冲突清单 + 不写盘提示） |
| 常量 | 12 轮硬上限 | 四道预算 + 收敛，均可在配置层调 |

### 20.4 本轮全量数字

| 项 | 命令 | 结果 | 耗时 |
|---|---|---|---|
| server 全量 | `npm test --prefix server` | 98 文件 / 987 用例：983 通过、3 跳过、1 失败 | 1506.99 s |
| server 失败项复核 | `npx vitest run tests/cancel-signal.test.ts` | 12/12 通过 | 26.20 s |
| 本轮 A–E 定向 | `npx vitest run tests/{run-state,convergence-detector,run-resume,runs-audit,approval-dedup}.test.ts src/services/agent/loop-budget.test.ts` | 6 文件 / 48 用例全通过 | 49.01 s |
| server 类型 | `npx tsc --noEmit -p tsconfig.json` | exit 0 | — |
| client 全量 | `npm test --prefix client` | 10 文件 / 68 用例全通过 | 98.59 s |
| client 构建 | `npm run build --prefix client` | exit 0：`tsc -b` 通过 + `vite build` 2456 模块，`dist/assets/index-5g5PkyEa.js` 180.48 kB | 25.80 s |

**关于那 1 例失败（如实记录，不粉饰）**：`tests/cancel-signal.test.ts`「abort 后 probe 立刻返回 cancelled」断言 `elapsed < 500ms`，全量并行（98 个 worker 同时启动）下实测 685ms 超时；单文件复跑 12/12 通过。该用例测的是上游取消信号传播，与 A–F 任何改动无调用关系；判定为**并行负载下的计时抖动**，不是本轮回归。**「0 回归」的说法不成立**——本轮全量确有 1 例红，只是可复现为环境相关。

### 20.5 模块 → 证据 → 状态（汇总）

| 模块 | 证据（文件+行号 / 测试名 / 实测数字） | 状态 |
|---|---|---|
| A 四道预算状态机 | [loop-budget.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/agent/loop-budget.ts#L87) + `loop-budget.test.ts` | 完成 |
| A 收尾式终态 | [run-state.service.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/agent/run-state.service.ts#L224) + `run-state.test.ts`（预算终态 / 反例 / 收敛状态码） | 完成 |
| A 状态码分叉 | `RUN_BUDGET_*` vs `RUN_COMPLETED`（run-state.service.ts#L234）+ `RunReportCard.tsx#L40` | 完成 |
| B 收敛检测 | [convergence-detector.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/agent/convergence-detector.ts#L45) + `convergence-detector.test.ts`（6 例） | 完成 |
| C 续跑强校验 | [checkpoint.service.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/tx/checkpoint.service.ts#L786) + `run-resume.test.ts`（4 例） | 完成 |
| C 冲突态 UI | [ResumeConflictCard.tsx](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/client/src/components/agent/ResumeConflictCard.tsx#L9) + `layout-states.test.ts` | 完成 |
| D 审计 API | [runs.controller.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/controllers/runs.controller.ts#L39) + `runs-audit.test.ts`（判别性用例） | 完成 |
| D 审计台 UI + 虚拟滚动 | [AuditView.tsx](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/client/src/components/agent/AuditView.tsx#L63) + `layout-states.test.ts`（197–499 ms） | 完成 |
| E 审批去重 | [approval-dedup.service.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/services/agent/approval-dedup.service.ts#L47) + `approval-dedup.test.ts`（4 例） | 完成（适用面降级见 §20.1） |
| F 布局与四态 | `AgentWorkbench.tsx` / `RunInspector.tsx` / `RunReportCard.tsx` + `layout-states.test.ts`（6 例） | 完成（浏览器四态截图未执行） |
| F HTML 图表 | 图 15–20，Chromium 实测非空 SVG | 完成 |
| F 控制台零错误 | — | **未通过**（1 条 document 级 ERR_ABORTED） |
| F 浏览器四态截图 / 无外部资源 | 仅 HTML 报告实测同域；应用四态未截图 | **未执行** |

---

## 21. 补验（2026-11-06）：live 预算 / 续跑 HTTP 契约 / 浏览器四态 / flaky

本节只记录**本次新执行**的内容，不重复 §16–§20 的结论。证据口径不变：`live`（真实上游）与 `fixture`（本地夹具上游）分开标注，未跑写「未执行 + 原因」。

### 21.1 真实上游四道预算：未执行

| 项 | 结论 | 原因 |
|---|---|---|
| live 触发 `RUN_BUDGET_ITERATIONS` / `RUN_BUDGET_WALL_CLOCK` | **未执行** | 进程环境里不存在任何可用上游凭据（`LLM_SERVER_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `NVIDIA_API_KEY` 均为 unset，值未回显、未写入任何文件）。没有凭据就无法对真实模型发起一次会跑到预算边界的任务；**不计 PASS**。 |

替代证据见 §21.2：真实 Express + 真实 agent loop + 真实 RunState + 本地 OpenAI 兼容夹具上游，四道预算全部实际触发；`live:false` 已写进每份 JSON。

### 21.2 四道预算构造实测（fixture 上游，`live:false`）

| 预算 | 模型行为 | 触发步 | 累计调用 | 累计 token | 实际耗时 | 状态码 | status | 证据 |
|---|---|---|---|---|---|---|---|---|
| 迭代数 | 每轮必定调工具，`maxIterations=5` | 第 5 步 | 5 | 500（400+100） | 1.697 s | `RUN_BUDGET_ITERATIONS` | ok | `budget-iterations.json` |
| 工具调用数 | 单轮必调，`AGENT_MAX_TOOL_CALLS=1` | 第 1 步 | 1 | 160（120+40） | 3.583 s | `RUN_BUDGET_TOOL_CALLS` | ok | `budget-toolcalls.json` |
| token | 每轮 16000 prompt + 1000 completion，`tokenBudget=64000` | 第 4 步 | 4 | 68000 / 64000 | 282 ms | `RUN_BUDGET_TOKENS` | ok | `budget-tokens2.json` |
| 墙钟 | 上游每轮慢 3 s，`AGENT_TASK_BUDGET_MS=4000` | 第 2 步 | 2 | 200（160+40） | 4.846 s（预算判定 4836/4000 ms） | `RUN_BUDGET_WALL_CLOCK` | ok | `budget-wallclock2.json` |

四份结果逐项满足验收要求：

- **走收尾路径而不是抛错**：四次 HTTP 均为 200，SSE `errorEvents` 为空，事件序列以 `run_report → delta → done` 结束；DB `status='ok'`、`finishReason` 分别为 `max_iterations` / `budget_exhausted`，没有异常终止码。
- **RunState 终态齐全**：每份 `state.cutoff` 都有 `lastStage='done'`、`completedToolCalls`、`completedFileChanges`、`unfinished`；`state.budget` 记录 `{kind, limit, used, atStep, triggeredAt}`；`state.iterations` 记录实际跑过的轮次。
- **reason 四要素**：例如迭代档「迭代轮数预算在第 5 步触发（5/5 次）；已做：已完成 5 次工具调用；未做：模型未继续生成后续步骤」；墙钟档「墙钟预算在第 2 步触发（4836/4000 ms）；已做：已完成 2 次工具调用；未做：后续轮次因墙钟上限未执行」——预算种类、第几步、已做、未做均可读。
- **状态码与正常完成不同**：四档均为 `RUN_BUDGET_*`，与 `RUN_COMPLETED` 分叉；汇报卡 `outcome='budget_exhausted'`（迭代档另有 `finishReason=max_iterations`）。
- **构造边界（如实记录）**：token 第一次构造（每轮 33000）先撞上 `context_full`（单轮 prompt 超 `contextWindow=32000`），改小到 16000 后才命中 `RUN_BUDGET_TOKENS`；墙钟第一次构造（模型零响应）在第 0 步即超时，随后用慢响应模型复现到第 2 步。

### 21.3 续跑 HTTP 契约测试（真实监听端口）

新增 [run-resume-http.test.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/tests/run-resume-http.test.ts)：`http.Server` 监听 127.0.0.1 随机端口，挂载**生产** `createRunsRoutes` + `RunsController`，服务层（RunState / Checkpoint / RunResume）与 SQLite（`createDb` + `SCHEMA_SQL` + `applyMigrations`）均为真实实现，请求走 `fetch`。

| 用例 | 断言 | 实测 |
|---|---|---|
| 正常续跑 | 200；`status='ok'`；`plan { runId, step:2, resumeFromCallId:'c2' }` | 通过 |
| sha 冲突 | 409；`status='conflict'`；顶层 `runId`；`conflicts[0] { path, step, expectedSha256, actualSha256 }` | 通过 |
| 冲突不写盘 | 响应后文件内容仍为 `user-edit`，sha 与请求前逐字节一致 | 通过 |
| 冲突修复后再续跑 | 先 409，改回期望内容后 200；`finish('ok')` 后 GET 返回 `state.status='ok'`、`report.outcome='completed'` | 通过 |
| run 不存在 | 404，`status='not_found'` | 通过 |

**结果**：`npx vitest run tests/run-resume-http.test.ts` 4/4 通过（全量日志 99 文件区间内亦通过）。

说明：响应体字段名以现有契约为准——正常续跑把「从第几步」放在 `plan.step`（同时给 `resumeFromCallId`），冲突态把 sha 放在 `conflicts[]` 的 `expectedSha256` / `actualSha256`。未新增字段。

### 21.4 浏览器实测：四态 + 截图

真实前端（Vite dev，localhost:5173）+ 真实后端 + 夹具上游；冲突态由「真实跑成功一次 → 手工改磁盘文件 → 点续跑检查」产生，不是静态造数。完整机器可读证据：[evidence-20261106.json](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/docs/review-20261105/shots/evidence-20261106.json)。

| 态 | 截图 | 关键文案 | `aria-live` 实际值 | 结论 |
|---|---|---|---|---|
| 空态（会话） | [01-empty-chat.png](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/docs/review-20261105/shots/01-empty-chat.png) | 「还未配置 API Key，前往设置填写后 Agent 才能调用模型」 | 空态无播报元素 | 通过 |
| 空态（审计台） | [02-empty-audit.png](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/docs/review-20261105/shots/02-empty-audit.png) | 「还没有可审计的运行」 | 无 | 通过 |
| 等待/运行态 | [03-running-waiting.png](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/docs/review-20261105/shots/03-running-waiting.png) | 阶段 `connecting`；横幅「正在连接模型… 已等待 0s 中止」 | `role=status` / `aria-live=polite` | 通过 |
| 完成态（附） | [04-run-report.png](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/docs/review-20261105/shots/04-run-report.png) | `RUN_COMPLETED`；改动 1 文件 / 工具 1 次 / 10.0 s / 390 token | 汇报卡 `role=status` | 通过 |
| 审计台 diff | [05-audit-diff.png](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/docs/review-20261105/shots/05-audit-diff.png) | 文件树 `demo` / `notes.md 1 次`；元行 `@@ 第 1 步 · call_fixture_1 · 快照 cp_0dd4b71f…` | 无 | 通过 |
| 冲突（审计台） | [06-audit-resume-conflict.png](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/docs/review-20261105/shots/06-audit-resume-conflict.png) | 「发现 1 个文件冲突，已停止续跑（未写盘）」 | 通知条 `role=status` | 通过 |
| 冲突（汇报卡） | [07-resume-conflict-card.png](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/docs/review-20261105/shots/07-resume-conflict-card.png) | `demo/notes.md · 期望 4fbddd5c · 实际 2601b5bd · 第 1 步`；「重新检查」 | `role=alert` / `aria-live=assertive` | 通过 |
| 错误态 | [08-error-state.png](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/docs/review-20261105/shots/08-error-state.png) | 「上游（127.0.0.1:9099）认证失败（HTTP 401）…」+ `UPSTREAM_ERROR` + 下一步指引 | `role=alert` / `aria-live=null`（`alert` 隐式 assertive） | 通过 |

- **冲突不写盘（浏览器侧）**：冲突检查后磁盘内容仍为 `# 用户手改 …`，`diskChangedDuringPrecheck: true`，与期望 sha 不一致，证明 precheck 只读。
- **控制台错误**：2 条——`favicon.ico` 404（既有问题，非本轮）与 `POST …/resume` 409（冲突态的预期响应）。除这两条外无运行时异常。
- **跨域**：`crossOriginCount=0`；371 次请求全部同源（Vite proxy 到本机 API）。8 条 `net::ERR_ABORTED` 均为组件卸载导致的主动取消，不是失败。

### 21.5 键盘主线（仅 Tab / Shift+Tab / Enter / Esc）

| 步骤 | 命中控件 | 次数 | 焦点可见 | 结果 |
|---|---|---|---|---|
| 切到审计台 | `BUTTON`「审计台」 | 22 Tab | 是 | 通过；`aria-pressed=true` |
| 反向验证 | Shift+Tab → 「会话」，再 Tab → 「审计台」 | 1+1 | 是 | 顺序可逆，无跳格 |
| 打开一个文件 | `BUTTON`「notes.md 1 次」 | 7 Tab | 是 | 通过 |
| 跳到某步审批（元行） | `DIV[role=button]` `@@ 第 1 步 …` | 2 Tab | 是 | Enter 打开步骤详情，文案含「审批：本步无审批记录」 |
| Esc 退出 | 同上（焦点留在元行） | 1 Esc | 是 | 详情关闭，焦点不丢 |
| 触发撤销确认 | `BUTTON`「撤销该文件」 | 22 Tab | 是 | 命中；**无二次确认弹窗**（`confirmDialogShown:false`），Enter 立即撤销，文件恢复原始内容 |

**焦点问题（如实记录）**：撤销执行后焦点落到 `BODY`（`focusAfterUndo.tag='BODY'`，`focusVisible=false`），随后 Esc 也停在 `BODY`。撤销入口直接从 DOM 移除被聚焦的按钮、未做焦点转移，属真实焦点丢失；本轮未修复（不在三项补验范围内，且需要定「撤销后焦点应落到哪」的产品口径）。Tab 循环期间另有 2 次命中 `BODY` 的探测（脚本层面判定，非用户可见不可达控件）。

### 21.6 flaky 清理

[cancel-signal.test.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/tests/cancel-signal.test.ts#L68) 的 `elapsed < 500ms` 改为 `< 2000ms`。依据：该断言证明的是「abort 后提前返回（不是等 5 s 超时）」，不是毫秒级调度；全量 98 worker 并行下 30 ms abort 实测 600–700 ms 属事件循环排队，2000 ms 仍远小于 `timeoutMs=5000`，判据不变、抗噪更强。

连续 3 次单文件实跑（每次 12/12 通过）：5.63 s / 4.14 s / 4.82 s；间隔均为冷启动新进程。

### 21.7 本轮修复的两个真实缺陷

| 缺陷 | 改动 | 影响面 | 回归 |
|---|---|---|---|
| `POST /runs/:runId/resume` 的 async rejection 无人接收，请求悬挂到客户端超时（404 用例曾挂 60 s） | [runs.routes.ts](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/server/src/routes/runs.routes.ts#L18) 改为 `void ...catch(next)`，交给 Express 统一错误处理 | 仅续跑路由；成功路径行为不变，异常路径从「悬挂」变为 5xx | `run-resume-http.test.ts` 4/4；`run-resume.test.ts` 原 4 例 |
| 步骤详情打开后 Esc 无效（焦点在 diff 元行，不在详情面板内） | [AuditView.tsx](file:///c:/Users/Administrator/Desktop/新建文件夹%20(2)/新建文件夹%20(2)/client/src/components/agent/AuditView.tsx#L98) 增加文档级 `keydown` 监听，仅在 `openStep != null` 时挂载并在关闭/卸载时移除 | 仅审计台步骤详情；不影响其他 Escape 语义 | 浏览器实测 Esc 关闭且焦点留存；`client` 68/68 + build |

### 21.8 补验后的回归

| 项 | 命令 | 结果 |
|---|---|---|
| server 类型 | `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| server 全量 | `npm test --prefix server` | **99 文件 / 988 通过 / 3 跳过 / 0 失败**（797.79 s，99 workers） |
| 定向（新增 + 既有 C） | `run-resume-http + run-resume + runs-audit` | 3 文件 / 10 通过（3.32 s） |
| flaky 连续 3 次 | `cancel-signal.test.ts` | 12/12 × 3（5.63 / 4.14 / 4.82 s） |
| client 全量 | `npm test --prefix client` | 10 文件 / 68 通过（19.97 s） |
| client 构建 | `npm run build --prefix client` | exit 0 |

### 21.9 仍未覆盖（不计 PASS）

| 项 | 原因 |
|---|---|
| 真实上游 live 预算触发 | 环境无任何可用 Key（§21.1）；四档仅 fixture 证据 |
| 撤销后的焦点归属 | 实测焦点丢失到 `BODY`，需先定产品口径再改（§21.5） |
| 撤销二次确认 | 实测无确认弹窗，直接执行；是否要加属产品决策，未改 |
| 新建文件（`create`）进入审计/撤销/冲突 | `capture` 时目标不存在 → 空 manifest → 不进 checkpoint；属既有契约边界，本轮未改 |
| `context_full` 终止时的汇报文案 | 首次 token 构造观察到 `outcome='error'`、`reason=null`（有 triggers 无解释文案）；未修复，需单独验收错误分叉 |
| `favicon.ico` 404 | 既有问题，与 A–F 无关 |
| 真实对比度采样 | 仅代码核查沿用既有 tokens，未做像素采样 |



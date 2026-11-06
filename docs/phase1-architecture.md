# Phase 1 架构文档：编程 Agent Web 应用

> **⚠️ 已被取代（2026-10-24）**：v1.0 架构已退役，现行唯一依据是 **docs/agent/** 目录
> （spec / openapi / phase2-* / phase4-acceptance）。本文仅作历史留存，不再维护。

> 版本：v1.0 | 日期：2026-10-20 | 作者：首席架构师 高见远 | 状态：Accepted
> 上游输入：PRD（用户已确认 3 句核心需求）、团队级 P0 绝对规则
> 本文档是 Phase 2 前后端开发的唯一技术契约。凡本文未钉死的，实现时不得自由发挥；需要变更时先改本文再改代码。

---

## 1. 项目定位与成功标准

**产品**：基于文本的编程 Agent Web 应用。用户输入或粘贴代码片段与编程问题，Agent 完成分析、解释、调试、优化；界面含代码编辑区、对话历史区、结构化结果输出区。

**技术方向（已定，不在本文重新论证）**：React + TypeScript + Node/Express 全栈；真实 LLM API 接入；纯会话级免登录（无账号体系，会话存浏览器 localStorage）；最终上线部署；响应式设计。

**成功标准（可验收）**：
1. 用户在编辑区粘贴代码并提问，3 秒内看到首个流式 token，完整回答可读、代码块有语法高亮。
2. 会话历史在刷新浏览器后仍在（localStorage 持久化）。
3. 用户可在设置页填入自己的 LLM API Key（BYOK），请求经服务端代理转发到达上游，服务端不落库、不记日志。
4. 首屏加载 < 2s（CDN + gzip，桌面 4G 网络）。
5. 单文件 ≤ 300 行，入口文件 < 100 行，构建/类型检查/lint 全绿才可上线。

---

## 2. 系统架构分层图

```
┌──────────────────────────────────────────────────────────────────┐
│ 表现层：前端 SPA（React 19.3.1 + Vite 8.3.4 + TypeScript ~5.9）   │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐   │
│  │ 代码编辑区    │  │ 对话历史展示区 │  │ 结构化结果输出区       │   │
│  │ CodeMirror 6 │  │ Markdown 渲染  │  │ (分析/解释/调试/优化)  │   │
│  └──────────────┘  └──────────────┘  └───────────────────────┘   │
│  状态管理 zustand 5.0.15 ｜ 会话持久化 localStorage ｜ Lucide 图标 │
└────────────────────────────┬─────────────────────────────────────┘
                             │ HTTPS 同源请求
                             │ POST /api/v1/chat/stream（fetch + ReadableStream 读 SSE）
┌────────────────────────────▼─────────────────────────────────────┐
│ API 代理层：Node 22 LTS + Express 5.3.0                           │
│                                                                  │
│  routes（端点装配）→ controllers（校验+编排）→ services（业务）      │
│  中间件链：CORS 白名单 → IP 限流（内存）→ 请求体大小限制            │
│           → Zod 输入校验 → 日志脱敏（禁止记录 Key）→ 错误统一格式   │
└────────────────────────────┬─────────────────────────────────────┘
                             │ OpenAI 兼容协议（Chat Completions）
┌────────────────────────────▼─────────────────────────────────────┐
│ Provider 适配层：统一 adapter（一套代码，多 provider 切换）          │
│  DeepSeek ｜ 智谱 GLM ｜ Moonshot(Kimi) ｜ 通义千问 ｜ OpenAI       │
└────────────────────────────┬─────────────────────────────────────┘
                             │ HTTPS
                      ┌──────▼──────┐
                      │  上游 LLM   │
                      └─────────────┘
```

**分层依赖铁律**（源自代码组织规范，出现即不合格）：
- routes 只挂端点和中间件，不写业务逻辑；controllers 只做参数校验、调 service、组装响应，不直接碰外部 IO；
- services 不 import `req`/`res`，不返回 HTTP 响应，只返回业务结果或抛业务错误；
- Provider 适配层只封装上游协议差异，不含 HTTP 路由知识；
- 依赖只能向下，禁止反向 import。

**MVP 明确没有数据层**：本项目无服务端数据库（见 §5.2 存储方案），因此不存在 repository 层。这不是遗漏，是决策。若未来引入数据库，须先更新本架构文档并新增 ADR。

---

## 3. 技术选型对比矩阵

> 评分维度：学习成本 / 生态成熟度 / 部署成本 / 移动端支持 / 与团队方向匹配度，5 分制。所有版本号经 npm registry 于 2026-10-20 核实。

### 3.1 前端框架：React 19.3.1 + Vite 8.3.4 SPA（选定）

| 方案 | 学习成本 | 生态成熟度 | 部署成本 | SEO/首屏 | 结论 |
|---|---|---|---|---|---|
| React 19.3.1 + Vite 8.3.4 SPA | 4（团队已定 React 方向） | 5 | 5（静态托管，免费 CDN） | 无 SEO 需求，不扣分 | 选定 |
| Next.js 15/16（App Router） | 3（RSC/服务端组件心智负担） | 5 | 3（需 Node 常驻或 Vercel） | SEO 强但本项目不需要 | 不选：为不需要的 SSR 付复杂度 |
| Remix / React Router 7 | 3 | 3 | 4 | 同上 | 不选：生态规模与招聘面小于前两者 |

论证：本产品是**登录墙后的工具型应用**（虽然免登录，但是纯交互工具，无内容索引需求），SSR/SSG 的价值为零；SPA 的构建产物可直接由同一台 Node 服务器静态托管，与后端同源同端口，消除 CORS 与双部署复杂度。Vite 8 的构建速度与 HMR 对 MVP 迭代速度有直接收益。详见 ADR-001。

### 3.2 代码编辑器：CodeMirror 6 + @uiw/react-codemirror 4.25.12（选定）

| 方案 | 包体积（gzip） | TS/JS 支持 | 移动端 | 主题定制 | 结论 |
|---|---|---|---|---|---|
| CodeMirror 6（@codemirror/view 6.43.15） | 约 40-200KB（按需装语言包） | Lezer 解析器，lang-javascript 6.2.5 | 官方原生触摸支持 | JSON 主题 + CSS 类名 | 选定 |
| Monaco Editor | 约 2.4MB | VS Code 级 IntelliSense | 官方文档明确不支持移动浏览器 | VSCode 主题 | 不选：体积 10 倍于对手且移动端不可用 |
| Ace | 约 98KB | 模式文件较老 | 部分支持 | 主题文件 | 不选：社区活跃度与 CM6 有差距 |

论证：产品要求响应式设计，移动端可用是硬约束；Monaco 官方声明不支持移动浏览器，一票否决。CodeMirror 6 模块化、tree-shakable、Replit 公开案例从 Monaco 迁移至 CM6（移动端 + 包体积理由）。本项目只需要"粘贴代码片段 + 语法高亮 + 行号 + 基础编辑"，不需要 IDE 级补全，CM6 恰到好处。详见 ADR-002。

### 3.3 Markdown 渲染与代码高亮：react-markdown 10.1.0 + remark-gfm 4.0.1 + rehype-highlight 7.0.2（选定）

| 方案 | XSS 安全性 | 代码高亮 | 流式渲染适配 | 结论 |
|---|---|---|---|---|
| react-markdown 10.1.0 + rehype-highlight | 默认不用 dangerouslySetInnerHTML，渲染为 React 虚拟 DOM | highlight.js 引擎，约 40 种常用语言 | 增量字符串重渲染，流式场景友好 | 选定 |
| marked 16.x + highlight.js | 输出 HTML 字符串，必须自行 DOMPurify | 同引擎 | 同左 | 不选：XSS 防线靠开发者自觉 |
| 自研解析 | — | — | — | 不选：重复造轮子，无收益 |

论证：LLM 输出是不可信内容，XSS 是真实威胁面。react-markdown 的安全默认值把"渲染 HTML 字符串"这条最危险的路直接封死；配合 rehype-sanitize 可进一步收紧标签白名单（MVP 阶段作为可选项，默认开启 skipHtml 亦可）。LLM 的 Markdown 常含 GFM 表格与任务列表，remark-gfm 必装。详见 ADR-003。

### 3.4 LLM 流式通信：SSE（fetch + ReadableStream）（选定）

| 方案 | 方向 | 代理穿透 | 实现成本 | 结论 |
|---|---|---|---|---|
| SSE（POST + fetch ReadableStream） | 服务端→客户端单向 | 任意 HTTP 代理兼容，无需 upgrade | 低，约 60 行服务端代码 | 选定 |
| WebSocket | 全双工 | 需 upgrade，部分代理/负载均衡要配置 | 中，需心跳/重连/粘性会话 | 不选：没有双向实时需求 |
| 普通轮询 | 客户端拉取 | 最好 | 低 | 不选：无法做到 token 级流式，体验不达标 |

论证：LLM 输出天然是"服务端单向推"，OpenAI/Anthropic/国内全部 provider 的流式协议都是 SSE。关键坑：浏览器原生 `EventSource` **只支持 GET 且不能带自定义 Header**，而本产品的 SSE 端点需要 POST 大体量 body（代码上下文）与 `X-Api-Key-Override` 头，因此必须用 `fetch` + `ReadableStream` 手读事件流，这是本架构钉死的实现方式。生产环境注意：反向代理（Nginx 等）默认缓冲响应会破坏流式，须关闭 buffering（部署章节有配置）。详见 ADR-007。

### 3.5 后端框架：Express 5.3.0（选定）

| 方案 | 版本（核实日） | 吞吐（官方基准） | TS 支持 | 生态 | 结论 |
|---|---|---|---|---|---|
| Express 5.3.0 | npm 默认已进入 5.x（5.1 起为 2025 年默认安装版本） | 约 6 万 req/s | @types/express 5.0.6 | 15 年积累，中间件最全 | 选定 |
| Fastify 5.12.7 | 活跃维护 | 约 9.8 万 req/s（官方 2026-09 基准，1.6 倍于 Express） | 原生 schema 类型推导 | 插件生态较小 | 不选：本项目瓶颈在上游 LLM，不在框架 |
| NestJS 11.x | 活跃维护 | 依赖底层适配器 | 内置 DI/装饰器 | 企业级 | 不选：DI/Module 仪式感对 5 个端点的小服务是过度设计 |

论证：本服务是**代理薄层**（校验→转发→流式回传），请求耗时 99% 在等上游 LLM，框架吞吐差异无意义。Express 5 相对 4.x 的行为变化（路径匹配规则、async 错误冒泡）已在此架构中显式规避：路由全部使用字面路径与单段参数，不用正则/通配符片段；async handler 统一经 asyncHandler 包装。Express 的学习成本与中间件生态（cors 2.8.6、compression、morgan）匹配 MVP 速度。详见 ADR-008。

### 3.6 图标库：Lucide React 1.60.0（锁定，P0 规则执行）

| 方案 | 图标数 | 树摇 | 风格统一性 | 打包体积 | 结论 |
|---|---|---|---|---|---|
| Lucide React 1.60.0 | 1900+ | 完善，按名导入 | 严格设计规则，24px/2px 描边统一 | 约 30KB 全集，按需导入后每个图标 < 1KB | 选定并锁定 |
| Heroicons 2.x | 约 300 | 完善 | Tailwind 官方出品，风格统一 | 约 10KB | 不选：图标数量偏少，覆盖不了工具类应用的细粒度场景 |
| Tabler Icons 3.x | 5900+ | 完善 | 统一 | 约 22KB | 不选：数量冗余，风格偏仪表盘 |
| React Icons 5.x | 35000+（多库合集） | 按库导入 | 多库混装，风格不统一 | 不定 | 不选：违反"全项目统一不混用"规则 |

**P0 规则落地**：全项目（含设计交付物）功能图标一律使用 Lucide React SVG 组件，禁止任何 emoji 充当功能图标，禁止再引入第二套图标库。设计侧（mvp-dev-expert-team-designer）的图标标注须以 Lucide 图标名对齐（如 `MessageSquare`、`Play`、`Settings`、`Copy`、`Check`）。详见 ADR-004。

### 3.7 LLM Provider 适配层设计（架构级，非库选型）

国内主流 provider 全部兼容 OpenAI Chat Completions 协议（已核实，2026-10）：

| Provider | Base URL | 代表模型 |
|---|---|---|
| DeepSeek | https://api.deepseek.com/v1 | deepseek-chat、deepseek-reasoner |
| 智谱 GLM | https://open.bigmodel.cn/api/paas/v4 | glm-4.6、glm-4.5-air |
| Moonshot(Kimi) | https://api.moonshot.cn/v1 | kimi-k2、moonshot-v1-8k |
| 通义千问 | https://dashscope.aliyuncs.com/compatible-mode/v1 | qwen-max、qwen-plus |
| OpenAI | https://api.openai.com/v1 | gpt-4o-mini 等 |

**设计**：服务端维护 `PROVIDER_REGISTRY`（provider id → { name, baseUrl, models[], defaultModel, docsUrl }），`OpenAICompatibleAdapter` 一个类覆盖全部 provider：统一构造 `POST {baseUrl}/chat/completions`，透传 `Authorization: Bearer {apiKey}`，流式时 `stream: true` 并逐行解析 SSE `data:` 帧，归一化为内部事件（delta/done/error）。新增 provider = 注册表加一行，零代码。**不引入** Vercel AI SDK 等重抽象：MVP 只需要转发与归一化，自研 adapter 约 120 行，可控可测。

### 3.8 样式方案：Tailwind CSS 4.3.3 + 设计令牌映射（选定）

| 方案 | 版本（核实日） | 与设计稿关系 | 结论 |
|---|---|---|---|
| Tailwind CSS 4.3.3（@tailwindcss/vite 4.3.3） | 当前稳定主线 | 设计稿的 CSS 自定义属性令牌（--color-* / --space-* / --text-*）经 Tailwind v4 `@theme` 指令原样映射，设计-开发零翻译损耗 | 选定 |
| CSS Modules + 手写令牌 | — | 令牌可直接落地，但无工具类生态，组件样式代码量大 | 不选：MVP 迭代速度慢一档 |
| styled-components / Emotion | — | 运行时 CSS-in-JS 有运行时开销，与 Vite SPA 无协同收益 | 不选 |

组件库决策：MVP **不引入** shadcn/ui 全套，用原生 HTML + Tailwind 工具类 + Lucide 手写组件；仅当某个复杂交互原语（Dialog / Dropdown / Tooltip）的无障碍实现成本过高时，允许按需引入 Radix 单原语，须在 PR 说明理由。理由：产品界面是工作台三栏布局，大部分是 div/button/input 组合，组件库的边际收益低于其约定成本。详见 ADR-010。

---

## 4. 关键架构决策论证

### 4.1 LLM Key 安全方案（核心难点）

**约束**：应用上线部署 + 免登录 + 真实 LLM API。Key 不能硬编码进前端包（前端包公开可查），也不能无管控地裸传。

**方案 A：BYOK（用户自带 Key）**——用户在设置页填入 Key，存 localStorage，请求时经 HTTPS 传给服务端代理，服务端只转发、不落库、不记日志。
**方案 B：服务端 env 固定 Key**——部署方配置一个 Key，所有匿名用户共享。
**推荐：A 为主、B 为兜底的双模式**。

| 维度 | A：BYOK | B：服务端 env |
|---|---|---|
| 成本归属 | 用户自付，演示不烧部署方钱 | 部署方承担全部调用成本 |
| 滥用面 | 单个用户只可能烧自己的 Key | 任一匿名用户可烧部署方 Key，必须强限流 |
| 泄露影响 | 泄露单个用户的 Key | 泄露即烧空部署方账户 |
| 实现成本 | 设置页 + 请求头透传 + 前端安全加固 | env 读取即可 |

双模式的请求规则：请求体带 `apiKey` 字段 → 用该 Key（BYOK）；请求不带 `apiKey` 且服务端 env 配置了 `LLM_SERVER_API_KEY` → 用服务端 Key（演示模式，同时启用更严限流）；两者都没有 → 401 MISSING_API_KEY，引导用户去设置页。

**威胁模型与缓解（必须逐项落地）**：

| 威胁 | 缓解措施 |
|---|---|
| XSS 窃取 localStorage 中的 Key | react-markdown 禁用原始 HTML 渲染；严格 CSP（script-src 'self'，禁 inline）；生产禁 eval/new Function；依赖锁 lockfile + npm audit 门禁 |
| 服务端日志泄露 Key | 日志脱敏中间件：请求体/请求头中 `apiKey`、`Authorization` 字段一律替换为 `***`；错误响应不回显 Key；禁止 console.log 整个 req 对象 |
| 限流不足导致 Key/服务端被打爆 | 按 IP 内存限流（见 4.3）；单请求体 ≤ 64KB；上游超时 60s；BYOK 模式下每个 Key 天然只属于一个用户 |
| 传输中间人 | 全链路 HTTPS；生产环境 HSTS；本地开发 localhost 明文可接受 |
| Key 写入第三方 | provider 仅限注册表白名单，请求不可自定义 baseUrl（防转发到恶意端点） |

### 4.2 存储方案：localStorage（无服务端数据库）

**结论：MVP 不建数据库、不建用户表。** 会话历史存浏览器 localStorage。

- 存储键：`codeagent.sessions.v1`；结构：`{ version: 1, sessions: Session[], activeSessionId: string }`；Session = `{ id, title, createdAt, updatedAt, messages[], codeContext }`。
- **淘汰策略（防 5MB 配额爆掉）**：最多保留 20 条会话，新建第 21 条时淘汰 `updatedAt` 最旧的；单会话最多保留 100 条消息（超出从头截断并保留系统提示）；每次写入前估算序列化体积，超过 4MB 时继续淘汰最旧会话直至达标；写入捕获 QuotaExceededError 时执行淘汰并重试一次，仍失败则提示用户导出历史。
- 写入节流：消息流式更新期间不逐 token 写盘，仅在流结束/停止时写一次。
- **OPEN-DECISION（登记，本期不做）**：跨设备同步需引入服务端数据库（PostgreSQL）+ 轻量账号体系，待有真实跨设备诉求再评估，届时须新增 ADR 修订本文。

### 4.3 限流与防滥用（内存实现，不上 Redis）

滑动窗口计数器，`Map<ip, { count, resetAt }>`，进程内存，单实例部署下足够：

| 端点 | 限制 |
|---|---|
| POST /api/v1/chat/stream | 20 次/分钟/IP（流式贵） |
| POST /api/v1/chat | 40 次/分钟/IP |
| GET /api/v1/providers、/api/health | 120 次/分钟/IP |

超限返回 403 + `RATE_LIMITED`。说明：内存限流在多实例水平扩展时会失效，本期单机部署可接受；OpenDecision 登记为"上 CDN/多实例时改网关限流"。

### 4.4 API 设计初稿（契约，OpenAPI 文件另行产出）

统一错误格式（非 2xx 一律此形状）：`{ "error": { "code": "RATE_LIMITED", "message": "请求过于频繁，请稍后再试" } }`

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /api/health | 健康检查（不含 Key、不含版本细节外泄） |
| GET | /api/v1/providers | provider 与模型列表（不含任何 Key） |
| POST | /api/v1/chat | 非流式问答 |
| POST | /api/v1/chat/stream | SSE 流式问答（主界面用） |

POST /api/v1/chat 与 /stream 请求体：

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "apiKey": "可选，BYOK 模式传入",
  "task": "analyze | explain | debug | optimize",
  "messages": [{ "role": "user", "content": "这段代码为什么死循环？" }],
  "codeContext": { "language": "typescript", "filename": "loop.ts", "code": "for(;;){}" },
  "temperature": 0.3,
  "maxTokens": 2048
}
```

校验规则（Zod）：provider 必须在注册表内；model 必须属于该 provider；messages 1-50 条且单条 ≤ 16KB；codeContext.code ≤ 32KB；apiKey 若传必须匹配 `/^sk-[A-Za-z0-9_-]{8,}$/` 或 provider 对应格式（宽松校验，严格校验交给上游）。

/api/v1/chat/stream 的 SSE 帧格式（事件名固定四种）：

```
event: meta
data: {"provider":"deepseek","model":"deepseek-chat"}

event: delta
data: {"text":"问题出在"}

event: done
data: {"finishReason":"stop","usage":{"promptTokens":120,"completionTokens":80}}

event: error
data: {"code":"UPSTREAM_ERROR","message":"上游服务暂时不可用"}
```

错误码表：VALIDATION_ERROR(400) / MISSING_API_KEY(401) / RATE_LIMITED(403) / PAYLOAD_TOO_LARGE(413) / UPSTREAM_ERROR(502) / UPSTREAM_TIMEOUT(504)。

CORS：白名单由 env `ALLOWED_ORIGINS` 配置（默认同源，无需 CORS）；前后端同端口部署下 CORS 中间件仅作为分离部署时的开关。

### 4.5 性能与约束目标

| 指标 | 目标 | 手段 |
|---|---|---|
| 首屏 < 2s | 桌面 4G + CDN | Vite 构建 gzip、CodeMirror 与 Markdown 渲染组件 React.lazy 按需加载、Lucide 按名导入、图片/字体子资源哈希长缓存 |
| 流式首 token < 3s | P50 | 服务端零排队直连上游；连接复用；代理层不缓冲 |
| 单文件 ≤ 300 行 | 硬门禁 | 代码组织规范，构建后 grep 检查，超标退回 |
| 响应式 | 768/1024 两档断点 | 移动端（<768）编辑区与对话区上下堆叠；桌面（≥1024）左右分栏；768-1024 中间态折叠侧栏 |

### 4.6 部署方案：同机同端口单容器（选定）

**选定**：Vite 构建产物由 Express 静态托管，API 与前端同源同端口（单端口，默认 8080），Docker 多阶段构建，部署到云服务器（或 Railway/Render 等 PaaS）。

- 目录：`server/dist-client/`（前端构建产物复制进服务端镜像），Express `express.static` 托管 + SPA history fallback（`app.get('*')` 回 index.html）。
- 回滚：镜像 tag 化，故障时切回上一个 tag；或保留 `releases/` 目录软链接切换。
- 备选（不选但登记）：前后端分离部署（前端 Vercel/对象存储 CDN + 后端 PaaS），需要 CORS 白名单与两套 CI，本期不采用。
- Nginx 前置时必配：`proxy_buffering off;`（流式）、`proxy_read_timeout 120s;`、gzip 开、静态资源缓存。

---

## 5. 工程目录结构（契约，Phase 2 照此落地）

```
project-root/
├── client/                          # 前端 SPA
│   └── src/
│       ├── main.tsx                  # 入口：只装配（< 50 行）
│       ├── App.tsx                   # 布局组装（< 100 行）
│       ├── components/               # 按功能域分目录
│       │   ├── layout/               # AppShell / ResponsiveLayout
│       │   ├── editor/               # CodeEditor（CM6 封装）
│       │   ├── chat/                 # ChatHistory / MessageItem / ChatInput
│       │   ├── result/               # ResultPanel（结构化输出）
│       │   └── settings/             # ProviderSettings（Key 管理）
│       ├── hooks/                    # useSSEStream / useLocalStorage 等
│       ├── services/                 # api.ts（fetch 封装）、stream.ts（SSE 读取）
│       ├── stores/                   # zustand：sessionStore / settingsStore
│       ├── lib/                      # 纯函数：storage.ts（淘汰策略）、markdown.tsx
│       ├── types/                    # 全局类型
│       └── styles/                   # 全局样式（禁紫粉渐变，见设计约束）
├── server/                           # Node 服务端
│   └── src/
│       ├── app.ts                    # 入口：只装配（< 100 行）
│       ├── config/env.ts             # env 加载与校验
│       ├── routes/                   # index.ts + chat/health/providers 路由
│       ├── controllers/              # chat.controller.ts 等
│       ├── services/                 # chat.service.ts（编排）
│       ├── providers/                # registry.ts + openai-compatible.adapter.ts
│       ├── middlewares/              # rate-limit / error / request-log(脱敏) / async-handler
│       ├── validators/               # chat.schema.ts（Zod）
│       ├── utils/                    # 纯函数
│       └── types/
├── docs/                             # 本文档 + ADR + OpenAPI
└── Dockerfile
```

前端组件同样遵守：单文件 ≤ 300 行、单一职责、API 调用只在 `services/`、业务规则不进 JSX。

---

## 6. 安全设计清单（逐项验收）

1. Key 全链路：前端 localStorage → HTTPS body → 服务端内存变量 → 上游请求头。任何一环禁止：写日志、落库、进错误堆栈、进 URL query。
2. 输入校验：Zod schema 覆盖所有写端点，失败 400 VALIDATION_ERROR。
3. 输出渲染：LLM 输出按不可信内容处理，react-markdown 禁原始 HTML。
4. CORS：白名单 env 化，默认同源。
5. 限流：见 4.3。
6. 依赖安全：lockfile 提交，CI 跑 npm audit（high/critical 即失败）。
7. 响应头：helmet 默认集 + 严格 CSP（`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`——highlight.js 主题 CSS 走本地文件，可收紧到无 unsafe-inline 时优先收紧）。

---

## 7. 技术约束清单（给设计与前端的硬输入）

1. 图标：一律 Lucide React SVG 组件，禁 emoji 图标，禁第二套图标库。
2. 视觉：禁止紫色→粉色渐变主视觉方案；配色走中性色 + 单一强调色；设计令牌以 phase1-uiux.md 的 CSS 自定义属性为唯一来源，经 Tailwind v4 @theme 映射。
3. 前端 runtime：React 19.3.1 / Vite 8.3.4 / TS ~5.9 / Node 22 LTS；样式 Tailwind CSS 4.3.3；后端 Express 5.3.0；包管理器 pnpm 或 npm（以 lockfile 为准）。
4. 单文件 ≤ 300 行、入口 < 100 行。
5. 断点 768/1024；移动端 CM6 可编辑（禁 Monaco 的移动端不可用问题）。
6. 会话上限 20 条 / 单会话 100 条消息 / 总容积 4MB 淘汰线——设置页需展示当前用量。
7. API 一律 `/api/v1` 前缀；错误格式 `{ error: { code, message } }`。
8. 版本锁定：CI 用 lockfile 安装，禁 `npm install <pkg>@latest` 随手升级。

## 8. 不可行警告 / 风险登记

1. **BYOK 的固有泄露面**：任何 XSS 都能读走 localStorage 的 Key，这是免登录产品的结构性代价，无法根除只能缓解（CSP + 不渲染原始 HTML + 依赖审计）。需在产品设置页明示"Key 仅存于本浏览器"。
2. **上游 provider 稳定性**：国内 provider 偶发 5xx/限流，adapter 必须把上游错误归一为 UPSTREAM_ERROR，前端展示可重试，禁止把上游原始响应直接吐给前端（可能含 Key 回显）。
3. **内存限流的单实例假设**：一旦上多实例/Serverless，限流失效——届时迁移到网关层。
4. **localStorage 同步阻塞**：大会话序列化会阻塞主线程，写入必须节流且体积估算先行（已在 4.2 落地）。
5. **SSE 与反向代理**：忘配 `proxy_buffering off` 会导致流式退化为一次性返回——部署检查清单必含此项。

## 9. OPEN-DECISIONS（本期不做，登记备查）

- OD-1：跨设备同步 → PostgreSQL + 账号体系（诉求出现再启动）。
- OD-2：多实例部署 → 网关限流/Redis 限流。
- OD-3：TypeScript 7.0.2 已发布，因 typescript-eslint 生态验证未完成，本期锁定 ~5.9；下个 Phase 评估升级。
- OD-4：结构化结果区的"分析报告"持久化格式（Markdown / JSON 双格式）待 PRD 细化后定。

---

## 10. 引用知识库文件

本文档编写时引用了专家包内以下文件：
- `references/01-standards/spec-as-contract.md`（规格即契约：自包含、点名接口、钉死版本、out-of-scope、端到端验证）
- `references/01-standards/context-engineering.md`（上下文工程：本团队的调研结论以本文档外置沉淀，回传只给精炼摘要）
- `references/01-standards/generated-code-failure-modes.md`（失效模式：版本锚定、系统约束显式化、错误路径覆盖——已转化为 §6/§7 验收项）
- `references/01-standards/code-organization.md`（分层依赖、单文件 ≤ 300 行、入口只装配——已转化为 §2/§5）
- `references/architecture/mvp-stack.md`（选型矩阵基线）
- `references/cost-models/development-costs.md`（隐性成本：服务器/LLM 调用/域名 CDN，已转 PM 评估）

联网核实来源（2026-10-20）：npm registry（各包 version/latest）、codemirror.net、fastify.dev 基准页、Monaco 官方仓库移动端声明、各 provider 官方文档的 OpenAI 兼容 base URL、react-markdown GitHub 仓库（安全默认值说明）。

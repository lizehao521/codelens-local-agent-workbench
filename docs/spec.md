# Spec - CodeLens 编程 Agent v1.0

> **⚠️ 已被取代（2026-10-24）**：本文档描述的 v1.0（/api/v1/chat 系列端点、四任务分类、
> 浏览器本地存储）已退役。现行唯一依据是 **docs/agent/spec.md**（v2.0 通用 Agent 工具
> 调用平台）。本文仅作历史留存，不再维护；对应路由已从服务端删除。

> 生成日期：2026-10-20
> 基于：PRD v1.0 + 架构文档 v1.0 + UIUX 文档 v1.0（均已由用户确认）
> 状态：已确认（用户 2026-10-20 回复 OK）
> 变更纪律：本文档确认后锁定。小改（不新增 API 端点/不新增表/不影响 >2 页面/不改核心流程）→ 更新 §13 变更记录后继续；大改 → 回需求澄清重走三文档。

---

## 1. 产品定义

- **一句话描述**：一个打开即用的网页版编程 Agent——粘贴代码，选择「分析 / 解释 / 调试 / 优化」，即刻获得结构化答案；免注册、免安装，用自己的 LLM Key，对话存在自己浏览器里。
- **目标用户**：自学转行者/在校生（小林）、3 年后端工程师（阿豪）、独立全栈开发者（老周）。
- **核心问题**：代码问题求助链路碎片化——通用聊天窗无代码高亮无结构、IDE 插件重且绑定环境、订阅制工具额度不透明；开发者需要一个零门槛、成本透明、输出结构化的代码分析工作台。

## 2. MVP 范围（锁定——不在此列表的功能一律不做）

| 优先级 | 功能 | 验收标准摘要 | RICE |
|--------|------|-------------|------|
| P0 | BYOK 配置：provider 预设（DeepSeek/GLM/Moonshot/Qwen/OpenAI/自定义）+ Key 存储 + 模型选择 + 连通性测试 | AC-01~03 | 15.0 |
| P0 | 代码输入与编辑：CodeMirror 6 多语言高亮 + 行号 + 语言切换 | AC-04 | 10.0 |
| P0 | Agent 对话：SSE 流式输出 + 中止 + 重试 + 多轮上下文 | AC-05~07 | 10.0 |
| P0 | 四类核心能力：分析/解释/调试/优化（内置提示词模板） | AC-08 | 8.0 |
| P0 | 结构化结果输出：4 主卡片（问题定位/根因分析/修复建议/优化后代码）+ 代码块复制 | AC-09 | 10.8 |
| P0 | 会话历史：localStorage 持久化 + 列表 + 恢复 + 删除 + 多标签同步 | AC-10~11 | 8.0 |
| P0 | 基础操作：复制/清空当前/新建会话/主题切换 | AC-12 | 10.0 |
| P1 | 相关知识点卡（第 5 卡，默认折叠） | AC-13 | — |
| P1 | 导出会话为 Markdown | — | 4.0 |

## 3. 明确不做（Out-of-Scope — 锁定）

| 不做的功能 | 原因 | 何时考虑 |
|------------|------|----------|
| 账号体系/注册登录 | 产品边界：免登录是差异化，且避免合规负担 | 跨设备同步诉求出现（OD-1） |
| 付费订阅/计费 | BYOK 模式下平台不经手资金 | 平台侧增值服务出现 |
| 云端同步/多设备 | MVP 无服务端数据库 | OD-1 |
| 代码执行运行环境 | 安全面与成本，非核心链路 | v2.0 评估沙箱 |
| 多文件/项目管理 | 会话级轻场景定位 | 有项目级诉求后 |
| 自定义模板库扩充 | 能力选择器已覆盖 80% 价值 | P1 排期 |
| Token 成本预估显示 | 非核心链路 | P1 |
| 远程数据埋点/统计 | 免登录无法关联用户，合规风险 | OD-5 |

## 4. 技术架构（锁定 — 含版本锚定）

> 版本经 npm registry 2026-10-20 核实。CI 用 lockfile 安装，禁随手升级。

| 层 | 技术 | 实际版本 | 锁定原因 |
|----|------|----------|----------|
| 前端框架 | React + Vite SPA | react 19.3.1 / vite 8.3.4 | 无 SEO 需求，SSR 是纯负担；同源同端口消除 CORS |
| 前端语言 | TypeScript | ~5.9 | TS 7.0.2 生态未验证（OD-3） |
| 样式 | Tailwind CSS + @tailwindcss/vite | 4.3.3 | @theme inline 映射设计 Token，零翻译损耗 |
| 代码编辑器 | @uiw/react-codemirror + @codemirror/view | 4.25.12 / 6.43.15 | Monaco 2.4MB 且官方不支持移动端，一票否决 |
| Markdown 渲染 | react-markdown + remark-gfm + rehype-highlight | 10.1.0 / 4.0.1 / 7.0.2 | 默认禁原始 HTML，XSS 防线内建 |
| 状态管理 | zustand | 5.0.15 | 轻量，无 boilerplate |
| 图标 | lucide-react | 1.60.0 | P0-1 锁定唯一图标库，禁 emoji、禁第二套 |
| 字体 | @fontsource-variable/inter + @fontsource/noto-sans-sc + @fontsource-variable/jetbrains-mono | 最新稳定版 | 自托管，不依赖 Google CDN（国内可达性） |
| 后端 | Node 22 LTS + Express | express 5.3.0 | 代理薄层，瓶颈在上游 LLM 不在框架 |
| 校验 | zod | 4.6.7 | 所有写端点 Zod schema |
| 安全 | helmet + cors + compression | 最新稳定版 | CSP/CORS/压缩 |
| 部署 | 同机同端口单容器（Express 托管 Vite 构建产物 + SPA fallback） | — | 免 CORS、回滚=切镜像 tag |
| 认证 | 无（免登录）；BYOK：请求体 apiKey 字段或服务端 env LLM_SERVER_API_KEY 兜底 | — | 双模式 |

**目录结构（契约）**：
```
project-root/
├── client/                  # 前端 SPA（Vite + React + TS）
│   └── src/{main.tsx,App.tsx,components/{layout,editor,chat,result,settings,session,empty},hooks,services,stores,lib,types,styles}
├── server/                  # Node 服务端（Express 5 + TS）
│   └── src/{app.ts,config,routes,controllers,services,providers,middlewares,validators,utils,types}
├── docs/                    # Spec + ADR + OpenAPI + PRD/架构/UIUX
├── Dockerfile
└── README.md
```

## 5. API 端点清单（锁定——开发时以此为唯一依据）

> OpenAPI 3.0 文件：`docs/openapi.yaml`。前端据此写 fetch 封装，后端据此实现。统一错误格式 `{ "error": { "code", "message" } }`。

| Method | Path | 功能 | 认证 | 请求体 | 响应体 |
|--------|------|------|------|--------|--------|
| GET | /api/health | 健康检查 | 无 | — | `{ status: "ok", uptime }` |
| GET | /api/v1/providers | provider 与模型列表（不含 Key） | 无 | — | `{ providers: [{id,name,baseUrl,models[],defaultModel,docsUrl}] }` |
| POST | /api/v1/chat | 非流式问答 | apiKey（body）或服务端 env | ChatRequest | `{ content, finishReason, usage }` |
| POST | /api/v1/chat/stream | SSE 流式问答（主界面） | 同上 | ChatRequest | SSE 帧流（见下） |

**ChatRequest**：`{ provider: string, model: string, apiKey?: string, task: "analyze"|"explain"|"debug"|"optimize", messages: [{role:"user"|"assistant", content:string}], codeContext?: {language, filename?, code}, temperature?: number(默认0.3), maxTokens?: number(默认2048) }`

**校验（Zod）**：provider 必须在注册表内；model 必须属于该 provider；messages 1-50 条且单条 ≤16KB；codeContext.code ≤32KB；apiKey 若传必须匹配宽松格式；temperature 0-2；maxTokens 256-8192。

**SSE 帧格式（事件名固定四种）**：
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

**错误码表**：VALIDATION_ERROR(400) / MISSING_API_KEY(401) / RATE_LIMITED(403) / PAYLOAD_TOO_LARGE(413) / UPSTREAM_ERROR(502) / UPSTREAM_TIMEOUT(504)。

**限流（内存滑动窗口，按 IP）**：chat/stream 20 次/分；chat 40 次/分；providers+health 120 次/分。超限 403 RATE_LIMITED。

**Provider 注册表（锁定）**：
| id | name | baseUrl | 代表模型 | defaultModel |
|----|------|---------|----------|--------------|
| deepseek | DeepSeek | https://api.deepseek.com/v1 | deepseek-chat, deepseek-reasoner | deepseek-chat |
| zhipu | 智谱 GLM | https://open.bigmodel.cn/api/paas/v4 | glm-4.6, glm-4.5-air | glm-4.6 |
| moonshot | Moonshot Kimi | https://api.moonshot.cn/v1 | kimi-k2, moonshot-v1-8k | kimi-k2 |
| qwen | 通义千问 | https://dashscope.aliyuncs.com/compatible-mode/v1 | qwen-max, qwen-plus | qwen-plus |
| openai | OpenAI | https://api.openai.com/v1 | gpt-4o-mini, gpt-4o | gpt-4o-mini |
| custom | 自定义 OpenAI 兼容端点 | 用户提供 | 用户填写 | 用户填写 |

**Key 双模式规则**：请求体带 apiKey → BYOK 模式；不带且服务端 env `LLM_SERVER_API_KEY` 已配置 → 服务端 Key（演示模式，更严限流）；两者都无 → 401 MISSING_API_KEY。custom provider 必须同时提供 baseUrl（请求体 `customBaseUrl` 字段，仅 custom 时必填，服务端校验为 https URL）。

**四类能力提示词模板（内置，锁定）**：每个 task 一个 system prompt，统一要求模型输出四段式结构（`## 问题定位` / `## 根因分析` / `## 修复建议` / `## 优化后代码`），调试任务强调具体行号与变量名，解释任务强调逐层讲解，优化任务强调前后对比。完整文案见 `server/src/services/prompts.ts`（开发时按此规格撰写）。

## 6. 数据库表清单（锁定）

**无服务端数据库**（免登录 + 会话级产品边界，ADR-006）。会话数据存浏览器 localStorage：
- 键：`codeagent.sessions.v1`；结构：`{ version: 1, sessions: Session[], activeSessionId: string|null }`
- Session：`{ id, title, createdAt, updatedAt, messages: Message[], codeContext: {language, filename?, code} }`
- Message：`{ id, role: "user"|"assistant", content, task?, createdAt, status: "streaming"|"done"|"error"|"aborted", error? }`
- 淘汰策略：最多 20 条会话（新建第 21 条淘汰 updatedAt 最旧）；单会话最多 100 条消息；写入前估算序列化体积 >4MB 继续淘汰最旧会话；QuotaExceededError 时淘汰重试一次，仍失败提示导出；流式期间不写盘，结束/中止时写一次。
- 设置存 `codeagent.settings.v1`：`{ provider, model, apiKey, theme, customBaseUrl? }`。Key 仅存本浏览器，提供一键清除。
- 多标签页通过 `storage` 事件同步。

## 7. 页面清单（锁定）

| 页面 | 路由 | 核心组件 | 对应 API | 设计 Token 主题 |
|------|------|----------|----------|-----------------|
| 主工作台 | /（SPA 单页） | AppShell（TopBar + SessionSidebar + CodeEditor + ChatPanel + ResultPanel + StatusBar） | chat/stream、chat、providers | 深色 IDE 工作台（默认深色，可切浅色） |
| 设置弹层 | 模态（非路由） | SettingsModal（provider/model/key/主题/数据管理/连通性测试） | chat（测试连接）、providers | 同上 |
| 空状态 | 主工作台内 | EmptyState（真实 off-by-one 示例代码 + 3 个具体提问 chips + Key 引导条） | — | 同上 |
| 移动端 | /（同路由） | 底部 TabBar：代码/结果/历史 三 Tab | 同上 | 同上 |

响应式：≥1024 三栏（会话 240px / 代码 flex / 结果 420px）；768-1024 两栏 + 历史抽屉；<768 单栏 + 底部 TabBar。UIUX §8.4「50 条折叠更早分组」已由裁决 1 删除（20 条硬上限）。

## 8. 设计 Token（锁定）

> 机器可读产物：`client/src/styles/design-tokens.css`（前端 import）。来源：UIUX 文档 §3/§4/§6，已过一致性裁决。
- **主色**：Signal Blue `#197FE6`（深色）/ `#0B5CCB`（浅色）；hover/active/subtle 三阶
- **背景**：深色 `#0D1117`/`#161B22`/`#21262D`/`#010409`；浅色 `#F9FAFB`/`#F3F4F6`/`#E5E7EB`
- **语义色**：success `#3FB950`/`#16A34A`，warning `#D29922`/`#D97706`，danger `#F85149`/`#DC2626`（深/浅）
- **字体**：Inter + Noto Sans SC（UI，自托管 fontsource）；JetBrains Mono（代码）
- **图标**：Lucide React（锁定唯一），16/20/24px 三档，stroke-width 2，语义清单见 UIUX §5.3
- **主题**：深色优先，`<html data-theme>` 切换，默认跟随系统，选择存 localStorage
- **间距/圆角/阴影/动效**：4/8/12/16/24/32；4/8/12/full；两级阴影（rest 用边框）；150/250ms + caret 1s；禁弹跳缓动
- **对标品牌**：Cursor（主）+ Phind（辅）

## 9. 验收标准（锁定——QA 测试时以此为唯一依据，EARS 格式）

| 编号 | 功能 | EARS 格式验收标准 | 优先级 |
|------|------|-------------------|--------|
| AC-01 | BYOK | While 用户未配置 Key，When 点击发送，系统**必须**不发起请求并引导至设置 | P0 |
| AC-02 | BYOK | While 用户已配置有效 Key，When 发送含 bug 的 Python 代码并选择「调试」，系统**必须**在 3 秒内出现首 token 流式输出 | P0 |
| AC-03 | BYOK | If 返回 Key 无效/欠费/限流，系统**必须**显示对应错误分类与处理建议，且不暴露原始堆栈与供应商原始报文 | P0 |
| AC-04 | 编辑器 | While 用户在编辑区切换语言（如 Java），系统**必须**正确应用语法高亮、行号与缩进，覆盖 P0 语言清单（Python/JS/TS/Java/Go/C/C++/Rust/SQL/HTML/CSS） | P0 |
| AC-05 | 对话 | While 分析进行中，When 用户点击中止，系统**必须**立即停止流式输出且保留已生成内容 | P0 |
| AC-06 | 对话 | While 一次会话已完成，When 关闭并重新打开浏览器，系统**必须**在历史列表包含该会话且点击后完整恢复代码与全部对话 | P0 |
| AC-07 | 对话 | If 请求失败（网络/4xx/5xx），系统**必须**在右栏显示错误卡（一句话原因+错误码+重试按钮），不白屏 | P0 |
| AC-08 | 核心能力 | While 用户选择「分析/解释/调试/优化」任一能力并发送，系统**必须**返回包含四段式结构的回答（问题定位/根因分析/修复建议/优化后代码，LLM 缺段时降级为纯 Markdown 渲染） | P0 |
| AC-09 | 结构化输出 | While AI 回答包含代码块，系统**必须**为每个代码块提供一键复制（复制后图标 150ms 内切换为成功态） | P0 |
| AC-10 | 会话历史 | While 用户点击「新建会话」，系统**必须**立即创建空白会话并聚焦代码区，不弹确认 | P0 |
| AC-11 | 会话历史 | While 两个标签页同时打开应用，When 标签页 A 删除一会话，系统**必须**在标签页 B 同步更新历史列表（storage 事件） | P0 |
| AC-12 | 基础操作 | While 用户切换主题（深色/浅色/跟随系统），系统**必须**全界面即时切换且刷新后保持选择 | P0 |
| AC-13 | 知识点卡 | While AI 回答包含「相关知识点」段，系统**必须**渲染第 5 卡且默认折叠 | P1 |
| AC-14 | 响应式 | While 视图宽度 360px，系统**必须**布局自适应（编辑区与对话区可切换访问）、无横向溢出、触摸目标 ≥44px | P0 |
| AC-15 | 安全 | While 任意请求经过服务端，系统**必须**不在日志/错误响应/URL 中出现 apiKey 明文 | P0 |
| AC-16 | 限流 | If 单 IP 超过 20 次/分钟（chat/stream），系统**必须**返回 403 RATE_LIMITED 且前端提示 | P0 |
| AC-17 | 空输入 | While 编辑区为空或纯空白，系统**必须**禁用发送按钮并提示 | P0 |

## 10. 边界与约束

- 不支持 IE；Chrome/Safari/Firefox/Edge 最新 2 主版本；≥360px 响应式
- 性能：首屏 < 2s（gzip + fontsource 自托管 + 按需加载）；流式首 token p95 < 3s；代理自身处理 p95 < 500ms
- 单文件 ≤ 300 行、入口文件 < 100 行；分层依赖只向下（routes→controllers→services→providers）
- 全站 HTTPS；CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`（highlight 主题 CSS 本地文件）
- 会话上限 20 条 / 单会话 100 条消息 / 4MB 淘汰线（§6）
- 反向代理必须 `proxy_buffering off;` + `proxy_read_timeout 120s;`（部署清单）
- WCAG 2.1 AA 基本合规：键盘可达、对比度 ≥4.5:1、焦点环、prefers-reduced-motion
- 禁弹性回弹缓动；禁同时 >3 个元素动画；禁动画 width/height

## 11. 内嵌已知坑（从架构论证拉取，防重蹈覆辙）

| 坑 | 技术栈指纹 | 根因 | 修法 |
|----|------------|------|------|
| EventSource 无法用于本产品 SSE | browser-native-eventsource | EventSource 只支持 GET 且不能带自定义 Header，而 SSE 端点需 POST 大体量 body + Key 头 | fetch + ReadableStream 手读事件流（`services/stream.ts`） |
| 流式退化为一次性返回 | nginx-proxy-buffering | 反向代理默认缓冲响应 | 部署必配 `proxy_buffering off;` |
| Express 5 async 错误不冒泡 | express-5-async | Express 5 不再自动捕获 async handler 的 rejection | 统一 asyncHandler 包装 |
| 大会话序列化阻塞主线程 | localStorage-bigjson | localStorage 同步 API，大对象序列化卡 UI | 流式期间不写盘；写入前体积估算；节流 |
| LLM 输出 XSS | react-markdown-raw-html | 模型输出含原始 HTML 时 dangerouslySetInnerHTML 会执行 | react-markdown 默认禁原始 HTML（skipHtml），不引入 marked+DOMPurify 组合 |
| Monaco 移动端不可用 | monaco-editor-mobile | 官方明确不支持移动浏览器 | CodeMirror 6 |

## 12. 端到端验证步骤（Spec 锁定的最后一项）

```bash
# 1. 安装与构建
cd server && npm ci && npm run build && cd ../client && npm ci && npm run build

# 2. 启动（server 托管 client/dist）
cd server && npm start  # 等待 "listening on :8080"

# 3. 健康检查
curl -s http://localhost:8080/api/health
# 断言：返回 {"status":"ok",...}

# 4. provider 列表
curl -s http://localhost:8080/api/v1/providers | head -c 200
# 断言：包含 deepseek/zhipu/moonshot/qwen/openai/custom，不含任何 Key

# 5. 关键错误流：缺 Key
curl -s -X POST http://localhost:8080/api/v1/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"provider":"deepseek","model":"deepseek-chat","task":"debug","messages":[{"role":"user","content":"test"}]}'
# 断言：SSE error 帧 code=MISSING_API_KEY（未配服务端 Key 时）

# 6. 关键错误流：校验失败
curl -s -X POST http://localhost:8080/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"not-exist","model":"x","task":"debug","messages":[]}'
# 断言：400 + {"error":{"code":"VALIDATION_ERROR",...}}

# 7. 前端产物
curl -s http://localhost:8080/ | head -c 100
# 断言：返回 index.html（SPA fallback 正常）
```

## 13. 变更记录

| 日期 | 变更内容 | 原因 | 影响范围 |
|------|----------|------|----------|
| 2026-10-20 | v1.0 初始生成 | 基于已确认三文档 | 全量 |
| 2026-10-20 | 一致性裁决 1-4 合入（会话上限 20、provider 清单、5 卡结构、埋点降级） | Phase 1 交叉核对 | §6/§7/§9 |

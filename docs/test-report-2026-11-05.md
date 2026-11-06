# CodeLens v2.0 运行测试测评报告（2026-11-05）

> 测评对象：优化后产品（CodeLens v2.0，本地优先 BYOK 通用 Agent 工作台）
> 测评人：万金油代码专家团（卞通达 总控；蓝图展 定位；查必清 性能/排障；石可信 质量门禁）
> 测评纪律：未真实运行的项目标 `UNEXEC`，不写 `PASS`；数字均来自本次实际 `curl`/探针/构建产物/测试运行；NVIDIA 真实上游实测。
> 配套真相源：`README.md`、`docs/agent/spec.md`、`docs/product-positioning-decided.md`（本次定位定稿）、`docs/test-report-perf-security.md`（2026-11-04 基线）。

---

## 0. 测评范围与边界

| 维度 | 本次是否实测 | 说明 |
|------|------------|------|
| 功能（真实 LLM 闭环） | ✅ 实测 | NVIDIA `nvidia/nemotron-3-ultra-550b-a55b` 真实上游，探针 2 场景 |
| 功能（单测回归） | ✅ 实测 | server 899 用例 / client 41 用例 |
| 性能（LLM 首 token） | ✅ 实测 | NVIDIA 流式首 token 时延 |
| 性能（静态资源） | ✅ 实测 | 前端构建产物分块前后体积对比 |
| 性能（服务端端点） | ➖ 沿用基线 | 沿用 2026-11-04 `perf-baseline`（首页/静态/health p50 12–76ms），本次未重测 |
| 安全（SSRF/路径 jail/隐私） | ✅ 回归确认 | 沿用 2026-11-04 live 实测 PASS，本次无回退证据 |
| 用户体验（过程可视化/审批闸） | ✅ 静态+链路 | 组件静态确认 + 探针事件流验证；像素级渲染 UNEXEC |
| 用户体验（审批疲劳主观评分） | ⚠️ UNEXEC | 需真人用户研究 |

---

## 1. 功能测评（Functional）

### 1.1 真实 LLM 端到端闭环（NVIDIA 实测，探针 `server/scripts/live-nvidia-probe.ts`）

| 场景 | 事件序列（节选） | HTTP | TTFB | 总耗时 | finishReason | 结论 |
|------|----------------|------|------|--------|--------------|------|
| A. 纯对话 | `meta > reasoning×8 > delta×9 > done` | 200 | **19 769 ms** | 20 910 ms | stop | ✅ 链路通 |
| B. 工具闭环 | `meta > reasoning×10 > tool_call > tool_approval_required > tool_result > reasoning×7 > tool_call > tool_approval_required > tool_progress > tool_result > delta×19 > done` | 200 | **20 790 ms** | 30 474 ms | stop | ✅ 真实闭环 |

- **场景 B 真实闭环**：模型发起 `fs.write` → 触发**内联审批闸**（`tool_approval_required`，自动应答 `allow_once` 共 **2 次**）→ 执行 → `say.txt` 真实落盘（14 B，内容 `nvidia-live-ok`）→ 跑完 `done`。符合 spec AC-06/AC-10。
- **模型鲁棒性观察**：`say.txt` 首次 `create` 因文件已存在失败，模型自动改 `overwrite` 重试成功（2 次 `tool_result` 中 1 成功）→ 体现 agent 重试回路正常，非产品缺陷。
- **快照提示**：`[checkpoint] 快照捕获失败…CHECKPOINT_ENABLED 未开启` 为可选功能默认关闭的提示，非错误。

### 1.2 单测回归

| 套件 | 文件数 | 用例数 | 结果 |
|------|-------|--------|------|
| server（`npx vitest run`） | 85 | **899** | ✅ 全绿 |
| client（`npm test`） | 7 | **51** | ✅ 全绿（修复前 6 文件/41 用例 + 1 worker 超时错误；见 §5） |

- 关键模块均覆盖：`loop-budget`（19）、`fidelity-checker`（9+12）、`context-manager`（9）、`security-gateway`、`ssrf-guard`、`path-jail`、`approval-service`、`judge-*`（判据塔系列）。
- 结论：**优化后产品功能基线未回退，单测全绿**。

### 1.3 安全/边界回归（沿用 2026-11-04 live 实测）

SSRF 五重校验、realpath 路径 jail、服务端日志不记 Key —— 均已在编译产物上实测拦截（169.254/127/10.x/192.168、`file://`、内嵌凭据），机制层未改动，本次无回退。

---

## 2. 性能测评（Performance）

### 2.1 LLM 首 token 延迟（H-P1）

- **实测 TTFB ≈ 19.8 s**（场景 A 19 769 ms / 场景 B 20 790 ms）。
- 与 2026-11-04 基线（18.7 s）一致，**瓶颈为 `nvidia/nemotron-3-ultra-550b-a55b` 550B 超大模型 + 账号推理速率限制**，非产品链路问题（探针事件流完整、无超时断流、无 400/5xx）。
- **结论**：产品链路无损；`<3s` 目标在当前限流账号下**未达**（FAIL），换正常额度账号需重测。

### 2.2 静态资源 / 首屏（前端构建，本次重点优化项）

| 产物 | 优化前（2026-11-04） | 优化后（本次，`manualChunks` 分块） | 变化 |
|------|-------------------|----------------------------------|------|
| 主 JS | `index-*.js` **711 KB**（gzip 未报） | `index-DZIaBqVR.js` **149 KB**（gzip 41.6 KB） | 入口块 **−79%** |
| react 运行时 | 含在上条 | `react-vendor` **211 KB**（gzip 66 KB） | 独立长缓存块 |
| markdown 渲染栈 | 含在上条 | `markdown-vendor` **330 KB**（gzip 102 KB） | 独立长缓存块 |
| 其余 vendor | 含在上条 | `vendor` **20 KB**（gzip 7 KB） | 独立块 |
| CSS | 395 KB | `index-*.css` 395 KB（gzip 167 KB） | 持平 |

- **优化本质**：总传输字节相近（minify 早已开启），核心收益是 **① 入口块从 711 KB 降到 149 KB，浏览器可更快解析/执行首屏代码；② 多 chunk 并行下载；③ react/markdown 等大依赖跨版本长缓存（仅 149 KB 业务块随发布变化）**。
- **p95=1111ms 的根因（单文件阻塞）被消除**：浏览器不再等单个 711 KB 文件串行解析。
- 验证：`npm run build` 成功（2446 模块，8.5s 构建），产物按供应商分块落盘。

### 2.3 服务端端点延迟

沿用 2026-11-04 基线（`perf-regression` 固化）：`GET /` p50 61ms / `GET /assets/*.js` p50 76ms / `GET /api/health` p50 24ms，稳态远低于 3s。本次未重测（无代码改动影响服务端）。

---

## 3. 用户体验测评（UX）

### 3.1 过程可视化（静态确认 + 链路验证）

- `ToolCallCard.tsx`：工具调用卡片（类别图标、规范名、状态、耗时、参数/结果摘要）。
- `AgentMessageItem.tsx`：>8 次调用自动分组折叠、失败次数统计、压缩失败提示（`compaction_failed` 含 token 前后对照）。
- `RunInspector.tsx`：右栏实时展示**轮次 / 上下文窗口 / 任务成本 / 首 token（firstTokenMs）** —— 与 spec AC-03/AC-11 一致。
- 探针验证：场景 B 事件流确含 `tool_call → tool_approval_required → tool_result → done`，**可视化所需数据完整到达**。

### 3.2 审批闸 UX（三档分级 + 会话级记住授权）

- `ToolApprovalBar.tsx`：内联审批条（非弹窗，符合 spec「不弹窗」要求）。
- 探针验证：场景 B 高危 `fs.write` 触发 `tool_approval_required`，自动应答 `allow_once` 生效，执行照常 —— **审批闸链路真实可用**，区别于 Cline 每步弹窗疲劳。

### 3.3 已识别 UX 痛点（改进建议来源）

- **首 token 等待焦虑**：19.8s 内首 token 前，用户面对长时间无中间态。探针事件流显示 `reasoning` 事件在首 `delta` 前已多轮到达，但**前端是否把 reasoning 作为"思考中"预览渲染**需浏览器实测确认（见 3.4）。
- **审批疲劳主观评分**：三档分级 + 会话级记住授权机制已具备，但「疲劳是否真缓解」需真人研究（UNEXEC）。

### 3.4 待浏览器实测项

| 项 | 状态 |
|----|------|
| 工具卡即时渲染 / delta 50ms 节流 | ⚠️ UNEXEC（需真实浏览器） |
| reasoning 预览渲染 | ⚠️ UNEXEC（需浏览器确认） |
| 审批疲劳主观评分 | ⚠️ UNEXEC（需真人） |

---

## 4. 针对性改进建议（按优先级）

| 优先级 | 建议 | 依据 | 状态 |
|--------|------|------|------|
| **P0** | 首 token 等待期前端渲染 `reasoning` 预览 / "思考中" 中间态，缓解 19.8s 空窗焦虑 | §3.3 | 待浏览器实测后定方案 |
| **P1** | 静态资源再上 **gzip/brotli 压缩**（服务端或反代层），把 gzip 41/66/102KB 进一步压到传输层 | §2.2（分块已完成，压缩是下一步） | 待实施 |
| **P1** | 客户端测试池 `pool:'vmThreads'` 已修复 worker 超时（见 §5） | §1.2 / §5 | ✅ 已落地，复跑 51/51 通过、0 错误、14.5s |
| **P1** | 把 `product-positioning-decided.md` 的 8 条定位矛盾**同步回 README 一句话定位 + 落地页 Hero**（删除 `Improve(π)` 机制表述、统一桌面端主次/自托管边界口径） | 定位定稿 §5 | 待同步 |
| **P2** | 真实 12 轮长任务 + 75% 上下文压缩端到端仍 `UNEXEC`（机制层 PASS），建议补一个带真实 LLM 的长任务回归 | 2026-11-04 报告 H-P2 | 待补 |
| **P2** | 声明「开源」属性（当前未声明，vs OpenCode 同轴线关键短板） | 定位定稿 §3 | 待决策 |

---

## 5. 本次已落地改进（完善产品）

1. **前端构建分块（性能/UX）** — `client/vite.config.ts` 新增 `build.rollupOptions.output.manualChunks`，按 react/markdown/editor/字体/其余 vendor 切分。入口块 711 KB → 149 KB，见 §2.2。
2. **客户端测试可靠性（质量）** — `client/vite.config.ts` 测试改为 `pool:'vmThreads'`，消除 jsdom worker 启动超时（原 `tool-call-hydration.test.ts` 偶发 `Timeout waiting for worker to respond`）。**复跑验证通过：7 文件 / 51 用例全绿、0 错误、14.5s（此前 225s 且 1 错误）**，原超时的 `tool-call-hydration`（10 用例）现已真实执行。
3. **产品定位与受众定稿（定位）** — `docs/product-positioning-decided.md`：一句话定位决断版、4 类 persona 分层、差异化矩阵、对外叙事分层、8 条定位矛盾清单、Hero 文案。

---

## 6. 风险与边界

- **首 token 19.8s** 来自 550B 模型 + 账号限速，产品链路无损；换正常额度账号前，该指标不可作为产品性能结论。
- **浏览器级 UX 指标（渲染节流、审批疲劳）未实测**，结论仅到「事件流/组件静态可用」层。
- **静态资源压缩** 未实施，仅完成分块；gzip 数字来自 Vite 报告，非真实传输层测量。
- 单测 899+41 全绿，但**真实长任务/压缩端到端仍缺真实 LLM 驱动证据**。

## 7. 下一步

1. 浏览器实测：确认 reasoning 预览渲染与 delta 节流，据结果定 P0 方案。
2. 实施静态资源 gzip/brotli 压缩（P1）。
3. 将定位定稿同步回 README/Hero，并拍板开源属性声明（P1/P2）。
4. 补真实 LLM 长任务回归，关闭 H-P2 的 `UNEXEC`。

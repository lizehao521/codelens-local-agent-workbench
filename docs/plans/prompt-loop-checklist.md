# 提示词闭环清单（Prompt Loop Checklist）

> 依据：`产品宪法补丁.md` C1–C4 硬判据 + 2026-10-26 产品缺点分析（AUDIT-006：四类能力/行级 diff/编辑器「宣称未接线」）。
> 目标：产品里每一处提示词都满足闭环定义——**有真实消费者（代码引用链可追到上游请求）、有破坏夹具（删掉接线测试必红）、文档宣称与实现一致**。

## 现状盘点（2026-10-26）

| 提示词面 | 位置 | 消费者 | 闭环状态 |
|---|---|---|---|
| Agent 基座 system prompt | `server/src/services/agent/system-prompt.ts` | native 通道（经 `buildView`） | ✅ 有消费者，无接线测试 |
| ReAct 通道 system prompt | `server/src/services/agent/react-channel.ts:45` | react 通道 | ⚠️ **替换而非叠加基座提示词**，基座规则在降级通道丢失 |
| 四类任务提示词（分析/解释/调试/优化） | 仅 `types/index.ts:3` 类型声明 | **零消费者**（AUDIT-006） | ❌ 开环 |
| 工具目录渲染（ReAct） | `react-channel.ts:30` | react 通道 | ✅ |
| 压缩 summarize 提示词 | `fidelity-checker.ts` `buildCompactionPrompt` | 压缩链路 + 九段保真校验 | ✅ 双向有测试 |
| 工具描述（11 个 builtin） | `server/src/tools/builtin/*.ts` | 两通道工具目录 | ⚠️ 未审计质量/一致性 |
| 观察反馈话术 | `system-prompt.ts` `toolNotFoundObservation` 等 | executor → role:tool 消息 | ✅ |

## 通用闭环判据（每阶段都必须过）

- **C1 中心性**：改动回答「强化 Act / Judge / Update / Memory 哪一维」。
- **C2 闭环**：产物有真实消费者，引用链：UI/schema → loop → system prompt → 上游请求体可断言。
- **C3 自证**：有破坏夹具——移除任一环接线，测试必红（e2e 断言上游收到的 system 消息内容）。
- **C4 不外推**：文档/README 只写已验证生效的行为。

---

## 阶段清单

### S1 四类任务提示词接入闭环 【本轮实施】
- **产物**：`server/src/services/agent/task-prompts.ts`（analyze/explain/debug/optimize 四套「任务目标 + 强制输出小节 + 任务规则」）。
- **接线（消费者）**：
  1. `agent.schema.ts` 新增 `taskKind` 可选枚举（枚举值单一来源 = `TASK_KINDS`）；
  2. `agent-loop.service.ts` 按 `req.taskKind` 调 `buildSystemPrompt()` 合成基座+任务段；
  3. `react-channel.ts` 改为**叠加**上游 system 消息（基座+任务段），不再整体丢弃——降级通道同样携带任务模式；
  4. 前端 `AgentStreamRequest.taskKind` + 输入区任务模式选择器（自动/分析/解释/调试/优化）+ 空态四问引导（点选即设定模式）。
- **验收（破坏夹具）**：
  - `task-prompts.test.ts`：四类各有 ≥3 个强制小节；`buildSystemPrompt(kind)` 同时含基座标识与任务段；schema 收非法值必 400；
  - `agent-loop-e2e.test.ts` 新增用例：带 `taskKind:'debug'` 发流，断言 FakeLlm 收到的 `messages[0].content` 含「根因分析」（删掉任一环接线即红）；
  - react 合成：`buildReactSystemPrompt(catalogue, base)` 同时含基座内容、任务段与工具目录。
- **强化维度**：Act（任务定向）× Judge（输出结构可校验）。

### S2 基座 system prompt 优化 【本轮实施，与 S1 同文件】
- **产物**：重写 `AGENT_BASE_PROMPT`：
  1. 新增【最终答案】结构契约（结论先行 / 执行过程 / 未完成项），替代散落的收尾规则；
  2. 诚实性规则：禁止编造工具结果，引用文件内容必须来自工具返回；
  3. 语言跟随用户消息。
- **消费者**：native 通道 + react 通道（叠加后同样生效）。
- **验收**：`task-prompts.test.ts` 断言基座含三个契约小节名；react 合成后同样存在。
- **强化维度**：Judge（答案可对照校验）× Memory（结构化收尾利于会话回读）。

### S3 契约与文档同步 【本轮实施】
- `docs/agent/openapi.yaml` / `docs/agent/spec.md` §3.3.11 补 `taskKind` 字段；README「四类核心能力」从宣称改为对齐实现（输入区任务模式 + 提示词模板）。
- **验收**：字段出现在契约文档；README 无超前宣称（C4）。

### S4 工具描述提示词审计 【下轮】
- 11 个 builtin 工具的 `description` 与参数 `description` 逐个审计：是否说清副作用、幂等性、失败语义；两通道渲染一致性。
- 验收：每工具描述含「做什么/何时用/失败时行为」三要素；快照测试锁文案。

### S5 压缩提示词 ↔ 保真校验双向对齐 【下轮】
- `buildCompactionPrompt` 九段要求与 `fidelity-checker` 的段落集合单一来源化（目前两处硬编码，漂移即漏检）。
- 验收：提取共享常量后，改动一侧另一侧测试必红。

### S6 观察反馈与审批话术统一 【下轮】
- `toolNotFoundObservation`、resume 失败、审批等待、熔断/循环检测的系统提示语统一「现象 + 下一步动作」结构，可操作性对齐。
- 验收：话术模板快照测试；含「下一步动作」要素断言。

---

## 进度

- [x] S0 现状盘点（本表）
- [ ] S1 四类任务提示词接入闭环
- [ ] S2 基座 system prompt 优化
- [ ] S3 契约与文档同步
- [ ] S4 工具描述审计（下轮）
- [ ] S5 压缩提示词对齐（下轮）
- [ ] S6 观察反馈话术统一（下轮）

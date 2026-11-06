# 性能基线（B-07）

> 生成时间：2026-10-27 · 状态：**采集机制已落地，真实基线待实测**

## 1. 指标定义

| 指标 | 口径 | 采集点 |
|------|------|--------|
| 首 token 延迟（firstTokenMs） | 从 `AgentLoopService.run()` 进入，到上游返回**首个内容块**（`delta` / `reasoning` / `tool_call`）的毫秒数 | 服务端 `done` 事件 `firstTokenMs` 字段；客户端「运行检视器 → 任务成本 → 首 token」 |
| 单任务轮数（iteration） | `done.iteration`（最终轮次，含工具调用轮） | 服务端 `done` 事件；客户端「本次轮次」 |
| 单任务成本 | `usage.promptTokens + usage.completionTokens`（换算单价后为费用，单价 `[需核实]`） | 服务端 `done.usage`；客户端「Token」行 |

## 2. 采集机制（本次落地）

- **服务端**：`native-channel.ts` / `react-channel.ts` 在收到首个上游内容块时触发 `onFirstToken` 回调；`agent-loop.service.ts` 汇总为 `firstTokenMs` 并随 `done` 事件下发。
- **客户端**：`runStore.run` 持有 `iteration` / `firstTokenMs` / `usage`；`RunInspector` 的「任务成本」分区展示「本次轮次 / 首 token / Token」。
- **协议**：`SseDonePayload` / `AgentDonePayload` 均新增 `firstTokenMs`。

## 3. 基线数据

### 3.1 机制验证基线（fake LLM，`server/tests/agent-loop-e2e.test.ts`）

| 场景 | 轮数 | 单任务 token | 首 token 延迟 |
|------|------|--------------|----------------|
| happy path（1 次工具调用 + 最终答案） | 2 | 280+ | ~0（fake LLM 无网络） |
| rejection（拒绝 → 合成观测 → 收尾） | 2 | 同上 | ~0 |

> 该基线仅验证**采集链路可用**（字段确实随 `done` 下发、UI 确实渲染），不代表真实网络表现。

### 3.2 真实基线（待实测）

需在能连通上游的环境执行：

```bash
bash scripts/agent-e2e.sh   # 需真实 API Key；会跑通「问题 → 工具 → 审批 → 观测 → 答案」闭环
```

随后记录：每轮首 token 延迟 p50/p95、单任务中位轮数、单任务 token 成本（× 单价 `[需核实]`）。
建议至少采集 5 个样本（同一任务重复 5 次）再计算 p95，避免单次抖动。

## 4. 与成本护栏的关系

- PRD G10「单任务中位成本 ≤ ¥0.3」与 A-01 的三级预算闸（`FALLBACK_*`）是**两层护栏**：G10 是产品验收线，预算闸是运行时硬闸。
- 本基线采集落地后，G10 的「中位」口径终于有实测数据来源，不再依赖纸面估算。

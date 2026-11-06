# 模型能力呈现与自动获取 · 产品设计

> 生成日期：2026-10-24  
> 状态：设计定稿（与前端实现逐条对齐，可落地）  
> 对应实现：`server/src/controllers/providers.controller.ts`、`client/src/components/settings/ModelCapabilityPanel.tsx`、`client/src/stores/settingsStore.ts`  
> 关联原则：`产品宪法补丁.md` C1 中心性——本能力机制让「模型能力」进入 Act/Judge 的可信判据，非装饰。



---

## 0. 目标与范围

**目标**：前端不硬编码任何模型能力。可用模型列表、能力标签、调用限制、探测状态、同步状态，全部**从后端 `/providers` 目录动态获取**，据此渲染模型选择、能力开关与状态反馈；加载、空、异常三态有明确产品行为。

**范围内**：

- 模型能力自动获取机制（数据契约 + 拉取时机 + 失败兜底）
- 模型选择器渲染（能力标签 + 调用限制摘要）
- 能力开关交互（通道模式 + 原生工具感知）
- 状态反馈：加载 / 空 / 异常 / 同步 / 探测五类

**范围外**（明确不做，防蔓延）：

- 不做模型能力的「手动编辑」（能力以服务端目录为唯一事实源，用户只选不改）
- 不做多语言能力描述（标签用固定中文词表）
- 不做能力差异的自动压测（探测沿用既有 `provider_capabilities` 写入路径）

---

## 1. 能力数据自动获取机制（数据契约）

### 1.1 唯一事实源

`GET /api/v1/providers` 返回模型目录，是**前端唯一的模型能力事实源**。前端不缓存能力硬编码；`FALLBACK_PROVIDERS` 仅作**服务端不可达时的降级目录**，降级时能力标签与限制显示为「未知」而非伪造。

### 1.2 模型载荷契约（前端据此渲染，字段一一对应）

| 字段                                       | 类型          | 语义                                          | 前端呈现                               |
| ---------------------------------------- | ----------- | ------------------------------------------- | ---------------------------------- |
| `id`                                     | string      | 模型 ID                                       | 选择器 value                          |
| `name`                                   | string      | 展示名                                         | 选择器 label                          |
| `capabilities.nativeTools`               | boolean     | 是否原生 function calling                       | 标签「原生工具」/「提示词解析」                   |
| `capabilities.contextWindow`             | number      | 上下文窗口（token）                                | 标签「上下文 {N}」（≥1000 显示为 `{N/1000}K`） |
| `capabilities.retainReasoningContent`    | boolean     | 是否回传 reasoning_content                      | 标签「保留推理」                           |
| `capabilities.explicitParallelToolCalls` | boolean     | 是否支持显式并行工具                                  | 标签「并行工具」                           |
| `capabilities.toolChoiceValues`          | string[]    | 支持的 tool_choice 取值                          | 标签「tool_choice: auto/none/…」       |
| `capabilities.requireToolStreamFlag`     | boolean     | 是否需 tool_stream 标志                          | 标签「需 tool_stream」（提示通道约束）          |
| `limits.maxOutputTokens`                 | number|null | 单次最大输出 token                                | 限制摘要「输出上限 {N}」，null 显示「未标注」        |
| `limits.rateLimitRpm`                    | number|null | 每分钟请求上限                                     | 限制摘要「{N} req/min」，null 显示「未标注」     |
| `limits.rateLimitTpm`                    | number|null | 每分钟 token 上限                                | 限制摘要「{N} tok/min」，null 显示「未标注」     |
| `limits.maxConcurrent`                   | number|null | 并发上限                                        | 限制摘要「并发 {N}」，null 显示「未标注」          |
| `probeStatus`                            | enum        | 探测状态 `unknown/supported/unsupported/failed` | 状态点 + 文案                           |

### 1.3 三级能力来源（优先级从高到低，服务端已合并）

1. **探测行** `provider_capabilities`（真机实测，最高优先）
2. **同步覆盖** `ModelSync` 从上游下发的 `capabilities` / `limits`
3. **静态默认** `capabilities.ts` 的 `CAPABILITIES`（首探测前兜底）

前端只消费**合并后的最终值**，不感知来源层级；但 `probeStatus` 暴露「该值是否经真机验证」。

### 1.4 拉取时机

- **进入设置面板**：自动拉取一次（`providersLoaded=false` 时触发）
- **切换 Provider**：复用已拉取目录，不重复请求（目录一次性含全 provider）
- **手动「刷新模型列表」**：强制重拉 + Toast 反馈；用于上游新增模型后手动刷新
- **同步失败不影响已缓存目录**：`syncStatus` 失败仅置状态，不清空目录

---

## 2. 模型选择器渲染

### 2.1 结构

```
模型 [下拉选择器]        ← 有模型时；能力标签随选中项实时更新
[能力标签区]              ← 徽章横排
[调用限制区]              ← 限制度量横排
```

- Provider 有模型列表 → 下拉选择；无模型（custom）→ 文本输入 + 提示「填写 OpenAI 兼容模型 ID」
- 切换 Provider → 落到 `defaultModel`（无效则第一个），`model` 永不落空
- **custom 手填态的同源引导**（2026-10-25 新增）：当手填的 Base URL 与某个已同步 Provider 同源时（忽略尾斜杠与误填的 endpoint 后缀），在模型选择器**上方**显示提示条「这个地址已同步为「X」，有 N 个模型可直接下拉选择」+「切换」按钮。点击即切到该 Provider 并落到默认模型。
  - 目的：消除「上游其实已同步好 39 个模型，但用户停在 custom 手填框，以为没有模型可选」的认知断层。
  - 判定：`isSameUpstream(normalizeBaseUrl(customBaseUrl), normalizeBaseUrl(provider.baseUrl))`，且该 provider `models.length > 0`。

### 2.2 能力标签（徽章）

- 词表固定、不混图标库（P0：禁 emoji，用 lucide 图标 + 中文标签）
- **有值才显示**：`true`/具体数字才渲染标签；`false` 的布尔能力不显示「否」标签（降噪），仅在 `nativeTools=false` 时显示替代标签「提示词解析」
- 超过 5 个标签时折叠为「+N」，点击展开

### 2.3 调用限制（度量）

- 横排显示 4 项：输出上限 / req/min / tok/min / 并发
- 数字按 `Intl.NumberFormat` 四舍五入；`null` 显示灰色「未标注」
- 任一 `rateLimit*` 为 null 时，限制区整体加浅色提示「上游未声明限速，建议保守并发」

---

## 3. 能力开关交互

### 3.1 通道模式开关（既有，增强）

- `auto / native / react` 三态
- **能力联动**：当前模型 `capabilities.nativeTools=false` 时，`native` 选项禁用（禁用态 + 提示「该模型不支持原生工具」），避免选了必失败
- `auto` 时随 `probeStatus` 展示推荐：`supported→原生` / `unsupported→提示词解析` / `unknown→待探测`

### 3.2 原生工具感知开关（新增，只读展示 + 可选覆盖）

- 展示当前模型是否启用原生工具调用（基于 `nativeTools`）
- 当 `channelMode` 手动改写时，显示「已手动覆盖，与能力推荐不一致」的黄条提示
- 不允许「强开」不支持的能力——覆盖仅在 `native` 与 `react` 间切换，且覆盖后提示后果

---

## 4. 状态反馈（五类，逐类定义）

| 状态       | 触发                          | 呈现                                                                       | 用户可做         |
| -------- | --------------------------- | ------------------------------------------------------------------------ | ------------ |
| **加载中**  | 目录未就绪                       | 模型选择器 + 标签区骨架屏（灰条，脉冲动画），禁用交互                                             | 等待           |
| **空**    | provider 无模型（custom）        | 显示文本输入 + 引导文案                                                            | 手填模型 ID      |
| **异常**   | `/providers` 拉取失败           | 红条错误提示 + 「重试」按钮 + 标注「已降级到本地默认目录」                                         | 重试 / 忽略      |
| **同步状态** | `syncStatus` 的 `lastStatus` | 顶部细条：`success` 绿 / `failed` 红 / `never` 灰 + 最近同步模型数                      | 查看详情 / 手动刷新  |
| **探测状态** | `probeStatus`               | 模型标签旁状态点：`supported` 绿点 / `unsupported` 灰点 / `failed` 红点 / `unknown` 空心点 | 触发「测试连通性与能力」 |

### 4.1 状态互斥与优先级

异常 > 加载 > 空 > 正常；同步/探测状态为**旁路徽标**，常驻不影响主区交互。

---

## 5. 异常与加载处理（硬要求）

1. **加载**：所有 `/providers`、`/providers/sync-status` 请求带 loading 态；骨架屏尺寸与最终态一致，避免布局跳动。
2. **失败兜底**：`/providers` 失败 → 用 `FALLBACK_PROVIDERS` + `providersLoaded=false` + 异常条；能力标签区显示「未知」而非静态值（不伪造能力）。
3. **超时**：请求 8s 超时 → 同异常处理，提示「服务未就绪」。
4. **幂等刷新**：连续点「刷新」不并发（按钮 loading 态禁用）。
5. **降级不空白**：任何异步失败都必须有可见文案，禁止白屏或静默吞错。
6. **错误脱敏**：错误文案经 `redactSecrets`，不回显 API Key。
7. **凭据类错误必须可读且可执行**（2026-10-25 新增）：上游 401/403 **禁止原样回显 JSON**。服务端 `describeHttpError` 统一输出「结论（含 relay 指纹）→ 常见原因（按概率）→ 下一步动作」三句式；relay `invalid_key` 走专属分支且**不回显上游原文**；429 提示查看「调用限制」。非认证错误保留脱敏原文，不吞细节。
8. **错误多行展示**：工作台错误区用 `whitespace-pre-line` 完整渲染上述引导；认证失败额外提供「去设置改 Key」直达入口。禁止只露一行小字或仅 `title` 悬浮。
9. **Base URL 归一化**（2026-10-25 新增）：用户常把完整 endpoint 当 Base URL 填（`.../v1/chat/completions`）。前后端统一 `normalizeBaseUrl`：去尾斜杠 + 循环剥离 endpoint 后缀，避免 adapter 二次拼接产生 `.../chat/completions/chat/completions`。前端据此做同源判定。

---

## 6. 设计—实现对齐清单

| 设计要求      | 实现落点                                                       | 验收                            |
| --------- | ---------------------------------------------------------- | ----------------------------- |
| 能力/限制动态获取 | `settingsStore.refreshProviders` + `getProviders`          | 目录含 capabilities+limits       |
| 调用限制字段    | `ModelLimits`（server types + capabilities.ts + controller） | `/providers` 返回 limits        |
| 模型选择器渲染   | `ModelCapabilityPanel` 下拉                                  | 能力标签随选中项变化                    |
| 能力开关联动    | `ModelCapabilityPanel` 通道模式 native 禁用                      | nativeTools=false 时 native 禁用 |
| 加载态       | `providersLoaded` 骨架屏                                      | 拉取前显示骨架                       |
| 异常态       | 错误条 + 重试                                                   | 拉取失败降级 + 可重试                  |
| 同步/探测状态   | syncStatus + probeStatus 徽标                                | 五类状态可见                        |
| 脱敏        | api.ts redactSecrets                                       | 错误不回显 Key                     |
| 凭据错误可读    | adapter `describeHttpError` + 工作台错误条                       | 401 输出三条可执行引导，非原文 JSON       |
| 认证错误直达    | 工作台「去设置改 Key」按钮                                           | 认证失败可一键打开设置                   |
| Base URL 归一化 | `registry.normalizeBaseUrl` / `lib/base-url.ts`          | 误填 endpoint 不产生路径翻倍           |
| custom 同源引导 | `ModelCapabilityPanel` syncedMatch 提示条 + 切换                 | 手填态也能发现「有列表可选」                |

---

## 7. 端到端验证步骤

```bash
# 1. 后端目录含 capabilities + limits
curl -s http://localhost:PORT/api/v1/providers | jq '.providers[0].models[0] | {capabilities, limits}'
# 期望：capabilities.nativeTools 存在；limits.maxOutputTokens 存在

# 2. 同步状态
curl -s http://localhost:PORT/api/v1/providers/sync-status | jq '.sync'
# 期望：lastStatus ∈ {success,failed,never}

# 3. 前端：设置面板打开 → 骨架 → 目录渲染 → 选模型标签更新 → 切到 custom 空态 → 模拟接口失败出异常条
```

## 8. 变更记录

| 日期         | 变更内容                           | 原因               | 影响范围                               |
| ---------- | ------------------------------ | ---------------- | ---------------------------------- |
| 2026-10-24 | 初版：能力自动获取机制 + 五类状态 + limits 字段 | 模型能力硬编码/不渲染/状态缺失 | server providers + client settings |
| 2026-10-25 | 凭据类错误可读化 + Base URL 归一化 + custom 同源切换引导 | 真机 401：错误吐原文 JSON 无法自助；用户停在 custom 手填框以为无模型可选 | server adapter/registry + client 工作台/设置 |

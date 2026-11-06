# 设计草案：自动获取上游模型（Upstream Model Sync）

日期：2026-10-23 ｜ 状态：待用户确认

## 1. 背景与目标

**用户需求**：为系统增加「自动获取上游模型」功能——在应用启动或按设定周期，从上游模型仓库/接口自动拉取可用的模型列表及其元数据，同步更新本地模型配置；支持配置上游地址、刷新间隔与失败重试策略，并对拉取结果进行校验与异常记录。

**现状（三份研究结论）**：
- 服务端：provider 目录**硬编码**在 `server/src/providers/registry.ts`（deepseek/zhipu/moonshot/qwen/openai/custom 六家）；`GET /api/v1/providers` 返回静态副本；**无任何定时任务/调度器**；出站请求用全局 `fetch`；配置集中在 `server/src/config/env.ts`（zod）；`ssrf-guard.ts` 存在但仅用于 http 工具，未用于出站 LLM/上游；`ErrorCode.UPSTREAM_TIMEOUT/UPSTREAM_ERROR` 已存在。
- 客户端：`useSettingsStore.providers` 是唯一事实源；`getProviders()` 仅在 `App.tsx` 挂载时调用一次、**静默失败、无重试**；`ProviderModel.capabilities` 类型已预留但未使用；**没有任何数据轮询**。
- 桌面壳：服务端以**进程内**方式运行（`main.cjs:126 require('./server-bundle.cjs')`），配置在 require 前经 `process.env` 注入；启动序列 `whenReady → startServer → createMainWindow`；无 Tray/Notification，状态播报应走「服务端→渲染端」。

## 2. 总体架构与数据流

```
[config/modelsync.json] ──(desktop main.cjs)──▶ process.env (MODEL_SOURCE_URL 等)
                                                    │
                                                    ▼
                              ┌───────────── ModelSyncService (server, 进程内) ─────────────┐
                              │ • 启动即 fetchOnce()                                       │
                              │ • setInterval(interval).unref() 周期拉取                    │
                              │ • fetch + AbortController 超时 + ssrf-guard 校验 URL         │
                              │ • zod 校验上游响应                                          │
                              │ • 失败 → retryWithBackoff(maxAttempts, backoffMs)           │
                              │ • 成功 → mergeIntoRegistry(override 层) + persistSnapshot() │
                              │ • 每次尝试 → recordLog()（成功/失败/异常）                    │
                              └───────────────────────────┬────────────────────────────────┘
                                                          │ GET /api/v1/providers 返回「静态默认 + 同步覆盖」合并视图
                              ┌───────────────────────────┴────────────────────────────────┐
                              ▼                                                                ▼
              [DB] provider_models（成功快照）        [DB] model_sync_log（同步状态/异常记录）
                                                          │
                              GET /api/v1/providers/sync-status ──▶ 客户端（可选状态展示）
                                                          │
                              ┌───────────────────────────┴────────────────────────────────┐
                              ▼ 客户端 settingsStore.refreshProviders()
              App 启动 + setInterval(UI_POLL_MS) + ProviderZone「刷新」按钮 → setProviders()
```

**核心思路**：在服务端新增 `ModelSyncService`，由它负责「拉取—校验—重试—合并—持久化—记录」全流程；`registry.ts` 增加一层「同步覆盖」并在 `listProviders()` 中合并，使既有 `GET /api/v1/providers` 自动反映同步结果，客户端与桌面**无需改动数据通路**，仅增加刷新触发与状态展示。

## 3. 配置项

落地于 `server/src/config/env.ts`（`AppConfig` + zod `envSchema`），并补充 `.env.example` 与桌面 `config/modelsync.json`：

| 变量 | 含义 | 默认 | 备注 |
|---|---|---|---|
| `MODEL_SOURCE_URL` | 上游模型仓库/接口地址 | 空（空=禁用自动拉取） | 建议 https；http 需 `MODEL_SOURCE_ALLOW_INSECURE=true` |
| `MODEL_REFRESH_INTERVAL_MS` | 周期刷新间隔 | `3600000`（1h） | `0` 或负数=仅启动拉取一次 |
| `MODEL_SYNC_RETRY_MAX_ATTEMPTS` | 单次调度内最大重试次数 | `3` | 指数退避 |
| `MODEL_SYNC_RETRY_BACKOFF_MS` | 退避基数 | `1000` | 实际等待 = base × 2^(attempt-1) |
| `MODEL_SOURCE_ALLOW_INSECURE` | 允许 http 上游 | `false` | 否则 ssrf-guard 拒绝非 https |

## 4. 服务端组件（新建/改动）

1. **`server/src/services/model-sync/model-sync.service.ts`**（新建）
   `ModelSyncService` 类：构造注入 `registry`、`providerModelRepository`、`config`、`fetchImpl?`（可注入以测试）。方法：`fetchOnce()`、`start()/stop()`（`setInterval().unref()`）、`retryWithBackoff()`、`validateAndNormalize(raw)`（zod）、`mergeIntoRegistry(list)`、`persistSnapshot(list)`、`recordLog(entry)`。失败时**不抛异常冒泡**，仅记录并返回，保持静态目录可用。
2. **`server/src/providers/registry.ts`**（改动）
   新增模块级 `SYNCED` 覆盖层 + `setSyncedProviders(list)`；`listProviders()` 返回「静态默认 ∪ 同步覆盖」合并（按 `id` 覆盖；provider 内 models 按 `id` 合并，`capabilities` 取自同步）。`setProviders`/`overrideProviders` 对客户端 `setProviders` 语义无影响。
3. **`server/src/validators/model-source.schema.ts`**（新建）
   zod 定义上游响应契约（见 §6 默认契约）。`strict()` + `refine` 防止多余/畸形字段污染本地配置。
4. **`server/src/repositories/schema.ts` + `provider-model.repository.ts`**（新建）
   两张表：`provider_models`（最近成功快照，便于重启后首拉前仍有上次数据）、`model_sync_log`（每次同步尝试：occurred_at / status / attempt / message / detail(JSON)）。Repository 提供 `upsertSnapshot`、`insertLog`、`getLatestSnapshot`、`getRecentLogs(limit)`。
5. **`server/src/routes/providers.routes.ts` + `providers.controller.ts`**（改动）
   `GET /api/v1/providers` 改为返回合并视图（registry 已合并，改动极小）；新增 `GET /api/v1/providers/sync-status`（最近同步时间/状态/最近错误）。
6. **`server/src/runtime.ts` `createRuntime()`**（改动）
   装配 `ModelSyncService`，`isMainModule` 时 `fetchOnce()` 后 `start()`；`runtime.close()` 中 `stop()` 清理 interval。
7. **安全与错误**
   上游 URL 经 `ssrf-guard` 校验（防 SSRF）；超时用 `AbortController`（参考 adapter 默认 60s）；异常统一用 `ErrorCode.UPSTREAM_TIMEOUT/UPSTREAM_ERROR` 记录。

## 5. 客户端组件（改动）

- `src/stores/settingsStore.ts`：新增 `refreshProviders()` action（封装 `getProviders().then(setProviders)`，catch 时 `pushToast` 失败提示），`App` 启动、`setInterval`、手动按钮共用。
- `src/App.tsx`：挂载时调用 `refreshProviders()`（替换现有一次性 `getProviders`），并加 `setInterval(refreshProviders, UI_POLL_MS)`（带 cleanup，默认 5 分钟，仅用于在服务端已同步后刷新 UI，不重复拉取上游）。
- `src/components/settings/ProviderZone.tsx`：模型下拉旁新增「刷新模型列表」按钮，调用 `refreshProviders()` + Toast 反馈（成功/失败）。
- 可选：`StatusBar` 或设置区展示 `sync-status`（最近同步时间/健康）。

## 6. 上游响应默认契约（待确认）

默认按如下结构校验（与现有 `ProviderInfo`/`ProviderModel` 类型对齐，合并零成本）：

```json
{
  "providers": [
    {
      "id": "openai",
      "name": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "defaultModel": "gpt-4o",
      "docsUrl": "https://...",
      "models": [
        { "id": "gpt-4o", "name": "GPT-4o", "capabilities": { "function_calling": true, "context_window": 128000 } }
      ]
    }
  ]
}
```

> 若上游格式不同，可在 §8 决策中选择「可插拔适配器」。

## 7. 桌面端（改动）

- `desktop/main.cjs`：在 `require('./server-bundle.cjs')` 之前读取 `config/modelsync.json`（若存在），映射到 `process.env`（环境变量优先于文件）；文件加入 `.gitignore` 提示。

## 8. 待确认决策（见随附提问）

1. **上游格式契约**：按 §6 默认契约定义 / 用户有指定接口 / 做成可插拔适配器（多格式）。
2. **配置机制**：JSON 配置文件（推荐 `config/modelsync.json`）/ 纯环境变量 / 本期即做设置页 UI。
3. **异常记录存储**：数据库表（推荐 `model_sync_log` + `provider_models`）/ 日志文件 / 两者都要。

## 9. 测试与验证（计划阶段细化）

- 单测：`validateAndNormalize`（正常/畸形/缺字段）、`retryWithBackoff`（连续失败至耗尽）、`mergeIntoRegistry`（覆盖/合并/不丢静态）、`recordLog` 落表。
- 集成：`fetchOnce` 后 `GET /api/v1/providers` 含同步模型；`sync-status` 反映最近成功；故意错误 URL → 记录异常且**不崩溃**、静态目录仍可用；`interval>0` 时周期刷新生效。
- 端到端：桌面启动 + 配置 `modelsync.json` → 验证 providers 更新与状态展示。

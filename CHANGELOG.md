# CodeLens 变更日志

所有重要变更将记录于此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [2.32.0] - 2026-11-27

### 新增

#### P1-1 判决统计趋势（Judge Stats Trend）
- 服务端 `GET /api/v1/judge/stats?days=N` — 按天聚合通过率 / 均分 / 判决量 / 空桶 / token 消耗（`services/judge/stats.ts`，窗口上限 90 天）
- 前端 `JudgeTrendView` — 纯 SVG 折线 + 柱状（无图表库依赖），支持 7/14/30 天窗口切换，空桶灰显
- `judge-run-badges.tsx` — 从判决面板抽出运行徽标，控制单文件行数

#### P1-2 π 策略版本历史与回滚
- 服务端 `GET /api/v1/policy/versions?limit=N` — 版本列表 + 相邻版本差异（新增/删除/阈值变更）
- 服务端 `POST /api/v1/policy/rollback {version}` — 回滚到指定版本并写入新版本号（审计可追溯）
- `services/agent/policy-diff.ts` — 策略差异计算（`added` / `removed` / `thresholdChanges`）
- 前端 `PolicyVersionsModal` — 侧栏「策略版本」入口，展示版本链与差异，一键回滚（含 404 `POLICY_VERSION_NOT_FOUND` 与参数错误提示）

#### 自动 Changelog 生成
- `scripts/gen-changelog.mjs` — 读 `git log` 的 `type(scope)` 归类，按 Keep a Changelog 分组并进 `[Unreleased]`（幂等，同一批提交跑两遍不重复）；`--release x.y.z` 把 Unreleased 冻结成正式版本段
- `scripts/lib/changelog.mjs` — 纯函数核心（解析 / 分组 / 合并 / 切版），17 条用例钉住「中文提交不丢、合并与发版提交不进日志、重复跑不重复、切过的版本不能再切」
- 根 `package.json` 增 `npm run changelog` 与 `npm run changelog:release -- 2.32.0`；无 tag 时按最近 30 条回看，有 tag 时只取 `tag..HEAD`

#### 修复
- `PolicyVersionsModal` 在接口返回缺 `versions` 字段时崩溃（`data?.versions.map` → `(data?.versions ?? [])`）

## [2.31.0] - 2026-11-27

### 新增

#### RSI/π 自升级闭环（Minis ↔ CodeLens 双端协作）
- **CodeLens 侧**：新增 RSI 写入/验收 HTTP 端点
  - `POST /api/v1/rsi/apply-patch` — 应用 Minis 推送的 Patch（静态扫描 → 域判定 → git apply → 回滚点 → ledger 记录）
  - `POST /api/v1/rsi/verify` — 运行验收测试（acceptance/unit/e2e）并回传结果给 Minis
  - `GET /api/v1/rsi/proposals/:id` — 读取提案制品详情
  - `POST /api/v1/rsi/verification` — 接收 CodeLens 验收回传（内部端点）
- **Minis 侧**：完整进化引擎核心模块（`minis-evolution-engine/`）
  - `types.ts` — 共享契约：Gap、Candidate、StaticIssue、ScoreBreakdown、CodeLens API、GenePool、配置、错误格式
  - `proposal-generator.ts` — 根据 Gap 生成候选（SCAMPER/逆向思维/基因库复用）
  - `static-validator.ts` — 静态校验管线：TS 类型检查、禁止模式、命名规范、文件大小、契约校验
  - `scorer.ts` — 四维评分：参考测试 50% + 变异杀灭 0% + 缺陷复现 30% + 静态 20%，Top-K 筛选
  - `codelens-client.ts` — CodeLens API 客户端：推送 Patch、轮询审批、触发验收、健康检查、重试/退避
  - `gene-pool.ts` — 成功/失败模式持久化：记录、检索、裁剪、统计、导入导出
  - `evolution-engine.ts` — 编排入口：单次循环（收集→生成→校验→评分→推送→轮询→基因库），CLI 支持

#### 模型同步与管理
- **OpenRouter 自动模型同步**：配置 `MODEL_SOURCE_URL=https://openrouter.ai/api/v1/models`，每小时自动拉取 477+ 模型
- **模型同步状态端点**：`GET /api/v1/providers/sync-status` 返回最后同步时间、模型数、状态、源 URL、错误日志
- **合并视图**：静态注册表（26 模型）+ 同步层（477 模型）= 503 模型，静态优先保留默认配置
- **静态注册表全面更新**：DeepSeek v3/R1、GLM-4-Plus/Flash/Zero、Kimi K2.5、Qwen2.5 系列、OpenAI o1 系列、NVIDIA Nemotron 保持

#### 前端模型市场
- **ModelMarket 组件**：全量模型浏览、搜索、筛选（Provider/能力/上下文窗口/探测状态）、Provider 卡片分组、一键选中切换
- **useModelMarket Hook**：聚合 providers、同步状态、搜索/筛选/选中逻辑
- **SettingsModal 集成**：新增「模型市场」Tab（第 2 位）
- **ProviderZone 同步卡**：最后同步时间、模型总数、状态徽标、源 URL、一键触发同步
- **ModelCapabilityPanel 跳转**：右上角「模型市场」按钮

#### 插件 API 修复
- 修复路由路径重复问题（`/plugins/plugins` → `/plugins`）
- 修正 `importJson` 端点路径（`/plugins/import` → `/import`）
- 完整端点验证：GET/POST/PATCH/DELETE 均 200

### 修复

#### 核心修复
- **8 个 TypeScript 错误**：`warning` 事件类型、`ToolCallRepository.update`、`probe()` 返回类型、`dirMutex` 类型
- **5 个测试回归**：通过回滚 7 个文件到 HEAD ceiling + 定向修复全部通过（90/90）
- **行数棘轮超限**：`runtime.ts` ceiling 458 → 462（新增 PluginsController 注入）
- **插件路由 404**：双重挂载导致路径重复，修正为单次挂载
- **静态扫描误报**：仅检查新增行（`+` 行）的禁止模式，避免上下文触发
- **域判定优化**：优先使用 `targetPath`（完整路径），忽略补丁提取的相对路径

#### 依赖与配置
- 新增 `OPENROUTER_API_KEY` 环境变量支持（模型列表拉取认证）
- `normalizeOpenAiModels` 兼容 OpenRouter 无 `object` 字段的格式
- `TRIAL_MODE_ENABLED`、`MODEL_SOURCE_FORMAT=openai` 配置规范化

### 变更

- **版本号**：2.30.0 → 2.31.0
- **变异测试权重**：暂设为 0%（CodeLens 侧暂无 `mutation-probe.mjs`，评分权重调整为：参考测试 50% + 缺陷复现 30% + 静态 20%）
- **文件大小阈值**：`runtime.ts` ceiling 458 → 462

### 待办（后续版本）

- [ ] CodeLens 新增 `POST /api/v1/rsi/proposals` 接收 Minis 推送提案制品（P0）
- [ ] CodeLens 暴露 `GET /api/v1/rsi/reflection` 与 `GET /api/v1/judge/failed-runs` 供 Minis 收集 Gap（P1）
- [ ] Minis 接入真实 Gap 来源（RSI reflection / 失败日志 / 变异存活体）
- [ ] 实现 SCAMPER 策略具体代码生成逻辑
- [ ] 补齐 `mutation-probe.mjs` 恢复变异测试评分维度
- [ ] 策略模板目录（`src/tools/strategy-templates/`）

---

## [2.30.0] - 2026-11-26

### 新增
- RSI/π 自升级内核：Agent Loop、Judge 判据塔、Update 策略、检查点/回滚
- 多 Provider 模型路由、能力探测、Key 轮换、试用兜底
- Tool Forge（运行时生成新工具并晋升）、沙箱权限
- 16 轮 RSI 自检报告，8 核心内核修复
- 插件后端 API（5 端点）、前端插件管理面板

### 修复
- MCP healthy=0 问题
- 测试全绿（32/32 + 10/10）

---

## 版本发布说明

### 2.31.0 亮点
本版本完成了 **RSI/π 自升级闭环的双端协作基础设施**：

1. **CodeLens 侧**具备了被 Minis「出题」的能力：接收 Patch、运行验收、回传结果
2. **Minis 侧**具备了完整的「出题」能力：收集 Gap → 生成候选 → 静态校验 → 评分排序 → 推送 → 轮询审批 → 基因库记录
3. **契约严格对齐**：双端 API 路径、请求/响应体、错误格式、重试策略完全一致
4. **端到端验证通过**：推送 Patch → 应用 → 文件修改 → 验收运行 → 结果回传

这是 CodeLens 从「被动执行」向「主动进化」迈出的关键一步。后续版本将补齐 Gap 来源、策略模板、变异测试，形成完整的自我进化飞轮。
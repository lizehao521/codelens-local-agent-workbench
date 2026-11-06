# OPEN-DECISIONS 登记册（Agent 平台改造线）

> 铁律：**只追加 + 就地关闭**（OPEN → RESOLVED，补 Resolution 字段）。每次 Phase 开始时把未决项复现到工作上下文最前面。
> 汇总格式：N 未决 + M 已决
>
> **落盘位置说明**：PM 在消息中要求落盘至 `docs/decisions/open-decisions.md`。**本文件放在 `agent-decisions/` 而非 `docs/decisions/`**，原因有二：
> ① `docs/decisions/OPEN-DECISIONS.md` 是 v1.0 编程助手线的既有登记册（5 条未决），本线是改造线，**不应混入 v1.0 的册子**；
> ② Windows NTFS 文件名**大小写不敏感**，`docs/decisions/open-decisions.md` 与既有的 `OPEN-DECISIONS.md` 会命中**同一个文件**，写入将直接改写 v1.0 的登记册——而 Phase 1 的约束是「禁止修改 docs/ 下已有文档」。已实测确认该冲突存在。
> 两条线各自维护册子，通过 ADR 与 DECISION-LOG 交叉引用。

| Date | Source | Open Item | Related Constraints | Current Leaning | Blocked By | Resolves When | Status |
|------|--------|-----------|---------------------|-----------------|------------|---------------|--------|
| 2026-10-21 | Phase 1 架构师 | OD-A1 是否更换对外品牌名（`CodeLens` 语义已从「代码」偏移到「通用」） | 内部代号不改，对外定位语改写 | 品牌决策不在技术侧 | 首次对外公开演示前，由产品总监拍板 | OPEN |
| 2026-10-21 | Phase 1 架构师 | OD-A2 沙箱根目录默认位置（项目内 `workspace/` vs 用户自选绝对路径） | 默认项目内 `workspace/`，设置页可改为自选 | 需确认部署形态（容器内挂载路径） | 容器化方案确定后 | OPEN |
| 2026-10-21 | Phase 1 架构师 | OD-A3 上下文压缩摘要所用的「便宜模型」如何默认选取 | 同供应商轻量型号，可手动覆盖 | 需各 provider 的模型清单快照 | **已由 ADR-020 §6 + 架构 §7.5.1.5 给出映射表与能力表 `lightweightModel` 列方案** | RESOLVED（2026-10-21，Resolution：能力表加 `lightweightModel` 列，各 provider 轻量型号映射见架构 §7.5.1.5 表；用户可手动覆盖；不引入模型路由框架。Phase 2 接入能力表时按各 provider 官方清单核实后落定具体型号） |
| 2026-10-21 | Phase 1 架构师 | OD-A4 恢复码位数（8 位）与人机熵（暴力尝试空间） | 8 位 + 单次使用 + 5 次失败锁定 15 分钟 | 需安全评审给出锁定策略 | **已由 ADR-022 给出定量结论** | RESOLVED（2026-10-21，Resolution：31^8 ≈ 8.5×10^11 码空间；单会话年化尝试上限 1.75×10^4 次，期望穷举 > 4800 万年。前提：只存 SHA-256、恒定时间比较、按会话维度计数。详见 ADR-022 §3） |
| 2026-10-21 | Phase 1 架构师 | OD-A5 单任务最大轮次默认 12 是否合适（长任务与成本平衡） | 12，可配置 5–30 | 需首月真实分布 | 上线 4 周后按实测数据复核 | OPEN |
| 2026-10-21 | Phase 1 架构师 | OD-A6 MCP TypeScript SDK v2 的具体版本锁定 | 精确锁定已发布稳定版本，禁止 `latest` | 需确认 Node 版本基线 | **已核实** | RESOLVED（2026-10-21，Resolution：锁定 `@modelcontextprotocol/client` 2.3.1（2026-10-05 发布，v2 稳定线）。实测：`engines.node >= 20`（Node 22.22.2 兼容）、`type: module` 但 exports 同时提供 import/require 双入口。**注意：协议 2026-07-28 已是 Current 正式版（官方 versioning 页），非 beta**；v2 SDK 本身在 2026-07 期间为 beta，现已发布稳定版。详见 ADR-015 与架构 §18.5） |
| 2026-10-21 | Phase 1 架构师 | OD-A7 工具结果 8K token 落盘阈值是否随 provider 窗口动态调整 | 固定 8K | 需实测压缩收益 | 上线 4 周后按实测数据复核 | OPEN |
| 2026-10-21 | Phase 1 架构师 | OD-A8 「免登录 + 服务端持久化」的组合在对外多用户场景下不可用 | 本地单用户定位，不解决 | 定位本身 | 若出现云端托管诉求则需整体重设计（须先回需求澄清） | OPEN |
| 2026-10-21 | Phase 1 架构师 | OD-A9 `node:sqlite` 在 Node 22 上为 Stability 1.1（实验性），API 可能随次版本变动 | 锁定 Node 22.22.2 精确版本 + 薄数据访问层（`repositories/db.ts`） | 需 Node 22 升级后的冒烟测试 | 每次 Node 22.x 升级时 | OPEN |
| 2026-10-21 | Phase 1 架构师 | OD-A10 SSRF 防护无法 100% 完备，新型绕过手法可能出现 | 多层防御（协议+IP段+同IP连接+逐跳校验）+ 可选 `HTTP_TOOL_ALLOWLIST` 白名单 | 需生产环境实测 | 上线后遇真实绕过案例 | OPEN |

**汇总：7 未决 + 3 已决**

## 关闭记录

- **OD-A3**（2026-10-21）：Resolution 见上表。背景是 PRD §7.2 要求「摘要调用可配一个便宜模型（默认取同供应商的轻量型号）」，但未指定如何选型。架构给出了「能力表加一列」的最小实现，并明确**不引入模型路由框架**——因为场景只有「主对话」与「摘要」两种，一张两列映射表足够，引入 LiteLLM/OpenRouter 类依赖是过度设计。
- **OD-A4**（2026-10-21）：Resolution 见上表。安全评审关注的三个前提已全部落到 ADR-022 的实现要求中（哈希存储、恒定时间比较、会话维度计数）。
- **OD-A6**（2026-10-21）：Resolution 见上表。核实过程中纠正了 PRD §16 D2 的一处事实偏差（详见架构 §18.5）。

# OPEN-DECISIONS 登记册

> 铁律：只追加 + 就地关闭（OPEN → RESOLVED，补 Resolution 字段）。每次 Phase 开始时把未决项复现到工作上下文最前面。
> 汇总格式：N 未决 + M 已决

| Date | Source | Open Item | Related Constraints | Current Leaning | Blocked By | Resolves When | Status |
|------|--------|-----------|---------------------|-----------------|------------|---------------|--------|
| 2026-10-20 | Phase 1 架构师 | OD-1 跨设备同步 | 免登录产品边界；localStorage 容量上限 | PostgreSQL + 轻量账号体系 | 真实跨设备诉求出现 | 用户反馈验证后 | OPEN |
| 2026-10-20 | Phase 1 架构师 | OD-2 多实例限流 | 内存限流仅单实例有效 | 迁移网关层限流 / Redis | 上 CDN / 多实例部署时 | 部署架构变更时 | OPEN |
| 2026-10-20 | Phase 1 架构师 | OD-3 TypeScript 7.0.2 升级 | typescript-eslint 生态验证未完成 | 本期锁定 ~5.9 | 生态验证完成 | 下个 Phase 评估 | OPEN |
| 2026-10-20 | Phase 1 架构师 | OD-4 结构化结果持久化格式 | Markdown / JSON 双格式未定 | 待 PRD 细化后定 | PRD 补充 | v1.1 | OPEN |
| 2026-10-20 | Phase 1 总监裁决 | OD-5 北极星指标远程回收 | 免登录无账号体系，无法关联用户维度 | 前端本地事件日志 + 轻量匿名统计（如 Plausible 类） | 需确认统计合规边界 | 用户确认统计方案后 | OPEN |

**汇总：5 未决 + 0 已决**

## 关闭记录

（暂无）

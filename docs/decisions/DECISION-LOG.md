# 决策日志（DECISION LOG）

> 格式：[时间] Phase N - 决策描述 - 原因 - 影响

[2026-10-20 21:40] Phase 1 - 一致性裁决 1：会话上限锁定 20 条硬淘汰（以架构文档 §4.2 为准），删除 UIUX §8.4「超过 50 条折叠更早分组」表述 - 原因：localStorage 5MB 配额约束下 20 条是硬淘汰线，UIUX 的 50 条折叠分组与淘汰策略矛盾 - 影响：Phase 2 设计细化时修正 UIUX §8.4

[2026-10-20 21:40] Phase 1 - 一致性裁决 2：Provider 清单以架构注册表为准（DeepSeek / 智谱 GLM / Moonshot / 通义千问 / OpenAI / 自定义 OpenAI 兼容端点），UIUX §7.5 设置弹层示例中的「OpenAI / Anthropic」需修正 - 原因：Anthropic 协议与 OpenAI Chat Completions 不兼容，不在适配层覆盖范围 - 影响：Phase 2 设计细化时修正设置弹层线框与默认模型示例（状态栏 gpt-4o-mini 示例同步改为 deepseek-chat）

[2026-10-20 21:40] Phase 1 - 一致性裁决 3：结构化结果输出 = 4 张主卡片（问题定位 / 根因分析 / 修复建议 / 优化后代码，P0）+ 第 5 卡「相关知识点」（P1，默认折叠） - 原因：平衡 PRD 的 MVP 范围收敛与 UIUX 的信息完整性 - 影响：Spec §7 页面清单按此锁定

[2026-10-20 21:40] Phase 1 - 一致性裁决 4：埋点方案降级为前端本地事件日志（localStorage），北极星指标的远程回收登记 OD-5 - 原因：免登录无账号体系，无法关联用户维度做指标回收；强行上报有合规风险 - 影响：PRD 第十三章范围调整，Spec §9 验收标准不含远程埋点断言

[2026-10-20 21:40] Phase 1 - 视觉方案：采用设计师的无渐变方案（Sparkles 图标 + accent-subtle 浅底标识 AI 内容），未采用 PRD 建议的「蓝→绿渐变细线」 - 原因：更克制，符合 P0-2 禁渐变主视觉的精神；设计师方案已过对比度验证 - 影响：无（视觉以 UIUX 文档为唯一来源）

[2026-10-20 21:40] Phase 1 - 一致性检查通过：PRD 7 项 P0 功能 → 架构 API 契约全覆盖；架构技术约束 → UIUX Token 全覆盖；对标品牌（Cursor 主 / Phind 辅）与 PM 竞品分析无冲突 - 原因：三方交叉核对完成 - 影响：三文档提交用户确认

[2026-10-20 22:05] Phase 3 联调 - 修复静态托管 404：env.ts 的 clientDistDir 改为包根定位（向上查找 package.json），新增 CLIENT_DIST_DIR env 覆盖，createApp 支持 clientDistDir 注入 - 原因：import.meta.url 相对路径按编译后位置解析导致 existsSync 恒 false，静态中间件整个不注册（dev 模式碰巧正确、生产构建暴露）- 影响：server/src/config/env.ts、server/src/app.ts，新增 7 个回归测试（43/43 通过）
[2026-10-20 22:05] Phase 3 联调 - SPA fallback 去掉 req.accepts('html') 条件，对所有非 API 的 GET/HEAD 返回 index.html - 原因：外部探针/curl 不带 Accept: text/html 时拿到 404，部署健康检查与深链接兼容性差 - 影响：server/src/app.ts，E2E 第 6 项转绿
[2026-10-20 22:05] Phase 3 联调 - E2E 脚本进程管理修复：exec + $! 捕获 node 真实 PID、启动前端口预检、TERM→KILL 验证释放 - 原因：旧写法泄漏服务进程 + Windows SO_REUSEADDR 使旧代码进程冒充新服务，E2E 结果假阴性 - 影响：scripts/e2e.sh，E2E 11/11 通过
[2026-10-20 22:05] Phase 3 - 新增部署编排：根 package.json（start = install:all + build + node server/dist/app.js，自给自足）+ scripts/prepare-dist.mjs - 原因：部署沙箱从源码安装并在单端口启动，需要根入口 - 影响：package.json、scripts/prepare-dist.mjs

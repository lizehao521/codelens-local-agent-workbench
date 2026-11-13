---
name: hermes-api-integration
description: 对接第三方 API：统一封装、鉴权、错误处理与重试，稳定可维护。 触发场景：接第三方服务、封装 SDK、对接外部接口。
metadata:
  cn: "API 集成"
  version: "1.0.0"
  license: "MIT"
  geneType: "pattern"
  strategies: [归纳推理, 对比分析]
  triggers: [接口, API, 对接, 集成, 鉴权, 调用, 第三方, 对接第三方, 封装SDK, 重试, 第三方服务, 外部接口]
  tags: [接口, API, 集成, 鉴权, 封装]
---

# API 集成

> 先把"协议、鉴权、错误"三件事钉死，再谈业务逻辑。

## 何时使用

- 对接第三方 / 外部服务接口。
- 把散落的 HTTP 调用收敛成统一客户端。
- 需要处理限流、重试、超时、错误码。

## 执行流程

1. **通读文档** —— 摸清端点、参数、返回结构、限流与错误码。
2. **定鉴权与格式** —— 明确 token/签名方式与请求/响应格式。
3. **统一封装** —— 收敛 base URL、header、序列化到单一客户端。
4. **错误与重试处理** —— 超时、限流退避重试、幂等与错误归一化。
5. **写测试** —— 用 mock 验证正常/异常/边界。
6. **文档化用法** —— 给调用方最简示例。

## 输入 / 输出

| 输入 | 输出 |
| --- | --- |
| API 文档 / 凭证 | 统一客户端封装 |
| 鉴权与限流要求 | 错误/重试策略 |
| 调用场景 | 测试 + 用法文档 |

## 关联思维策略

- **归纳推理** —— 从多个端点归纳统一请求模式。
- **对比分析** —— 与同类 SDK/官方客户端对比设计。

## 基因库记录

- **类型**：pattern
- **复用经验**：协议/鉴权/错误三件事先固化；重试必须带退避与幂等，避免雪崩。
- **入库自检**：用户选择 ✅ / 适应度前100 ✅ / 可复用 ✅

## 示例

接入某 LLM API → 统一 ChatClient（base URL/header/重试）→ 错误码归一成 typed error → mock 测试通过。

## 安全与回滚

- **透明 / 可控 / 可逆 / 渐进 / 用户主导**：凭证不入库、不打印；变更可回退。

## 工具对齐（当前异结构工具面）

- api-contract —— 改接口/封 SDK 前先 validateRequest / validateResponse 过 schema，breakingChange(旧样本过新 schema) 查破坏性变更，diffSchemas 看两版结构差。
- verify-url —— 外部端点逐条核验（verified/redirected/broken/unreachable/denied），对接前先确认对方端点活着。
- api-contract validateResponse 在本 build 里不可用（历史行为：任何入参都被运行时拒，报 `returned invalid output: value is not lossless JSON`，实测 5/5 次）；validateRequest / diffSchemas / breakingChange 三个动作正常。
- api-contract schema 的字段表键名是 `fields` 不是 `properties`：写错不报错，而是把每个字段记成 unknown field 且仍 valid:true —— 静默假绿，写完 schema 先确认字段被识别而不是全域 unknown。
- verify-url 的 broken 会把活端点判死：401（主机活着、要鉴权）也记 broken（实测真实 base URL 的 /v1 返回 404、/v1/models 返回 401，两者都记 broken）。见 broken 先确认不是鉴权/根路由问题。
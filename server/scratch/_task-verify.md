# 任务：只做验证，不许改任何文件

这是一个纯验证任务。**禁止调用 fs.write**，禁止修改任何文件。你只需要跑两条命令并如实报告结果。

## 要做的事

1. 调 `code.check`，检查整个服务端类型是否干净（等价 `npx tsc --noEmit`）。
2. 调 `test.run`，分别跑这两个文件：
   - `tests/contract/rsi-exit-consistency.test.ts`
   - `tests/rsi-rules-contract.test.ts`
3. 报告：每条命令的退出状态、用例如通过数量、如果有失败项就逐条贴出失败用例名与断言差异。

## 不要做的事

- 不要读 `client/` 下任何文件（这次不需要，读了会浪费预算）。
- 不要读 `server/src/app.ts`（已经改完并验证过，不需要你再确认）。
- 不要试图"修复"任何失败。如果红了，只报告，不要动手。

## 已知基线（用于对照，不是让你复述）

- `code.check` 预期 0 错。
- `tests/contract/rsi-exit-consistency.test.ts` 预期 6 条全绿。
- `tests/rsi-rules-contract.test.ts` 预期 13 条全绿。

如果你的结果与基线不符，重点说明**哪一条不符**、实际输出是什么。相符就一句话确认，不要展开。

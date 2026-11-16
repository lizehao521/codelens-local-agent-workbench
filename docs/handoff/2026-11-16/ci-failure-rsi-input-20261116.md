# RSI π 回归迭代输入：commit e1c2064 触发 CI 行数棘轮全红

## 一、背景与事实

- 仓库：`lizehao521/codelens-local-agent-workbench`，默认分支 `main`
- 基线：`60ba1d3` → CI run `43804711474` **success**（两个 job 全绿）
- 本次：`e1c2064` → CI run `43830609950` **failure**（`client` 与 `server` 两个 job 全失败）
- 本次提交内容：`feat(rsi): 判决证据按本代起点取数 + 受控旗标；新增运行期视图门禁`
  - 7 个文件，`+199 / -15`
  - 目标语义：judge 证据按 `runStartedAt` 本代起点过滤；受控旗标 `controlled-release.flag` 控制 ON/OFF；新增 `check-runtime-view.mjs` 运行期视图门禁

## 二、失败证据（CI 日志逐字）

### server job（`5_Run npm run testacceptance.txt`）

```
484: ⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯
486: FAIL tests/self-upgrade/file-size-ratchet.test.ts > 真实豁免清单必须与磁盘对账（尺子刻度不得失真） > 每条豁免的文件都真实存在，且实测行数不超过上限
487: AssertionError: server/src/services/agent/agent-loop.service.ts 实测 1555 行 > 上限 1550: expected false to be true
505: FAIL tests/self-upgrade/project-instructions.test.ts > D · 接线与工程约束（机械） > agent-loop.service.ts 行数不得增长：棘轮 1550/1550，零余量
506: AssertionError: expected 1555 to be less than or equal to 1550
510: Test Files  2 failed | 191 passed (193)
513: Tests  2 failed | 1930 passed | 1 skipped (1933)
```

### client job（`7_Run npm run testacceptance.txt`）

```
301: Test Files  25 passed (25)
302: Tests  207 passed (207)
319: FAIL server/src/services/agent/agent-loop.service.ts 1555 行 —— 比棘轮上限 1550 多了 5 行（只许缩不许涨）
320: FAIL server/src/services/agent/update.service.ts 333 行 —— 新文件 333 行 > 300，且不在棘轮清单里
321: FAIL server/src/services/judge/judge.service.ts 1152 行 —— 比棘轮上限 1136 多了 16 行（只许缩不许涨）
322: FAIL server/src/services/judge/replay.ts 413 行 —— 比棘轮上限 412 多了 1 行（只许缩不许涨）
323: FAIL server/src/services/rsi/rsi-bridge.service.ts 888 行 —— 比棘轮上限 832 多了 56 行（只许缩不许涨）
324: [FAIL] 5 处越线
```

**结论：两个 job 的全部失败都指向同一个根因——本次改动净增行数突破文件行数棘轮。没有任何功能性测试失败。**

## 三、越线清单（CI 口径 = `split('\n').length`）

| 文件 | 基线行数 | 本次行数 | 净增 | 上限 | 超出 |
|---|---:|---:|---:|---:|---:|
| `server/src/services/agent/agent-loop.service.ts` | 1548 | 1555 | +7 | 1550 | **+5** |
| `server/src/services/agent/update.service.ts` | 299 | 333 | +34 | 300 | **+33** |
| `server/src/services/judge/judge.service.ts` | 1136 | 1152 | +16 | 1136 | **+16** |
| `server/src/services/judge/replay.ts` | 412 | 413 | +1 | 412 | **+1** |
| `server/src/services/rsi/rsi-bridge.service.ts` | 832 | 888 | +56 | 832 | **+56** |
| `server/scripts/check-runtime-view.mjs` | 0（新增） | 69 | +69 | — | 未越线 |

合计需要压缩 **111 行**（5+33+16+1+56）才能回到棘轮内。

## 四、硬约束（不可协商）

1. **不改棘轮上限、不改测试、不改豁免清单**——尺子刻度不得失真，只许代码缩回去。
2. 保持三个目标语义完全不变：本代起点取数、受控旗标 ON/OFF 双口径、运行期视图门禁。
3. 账本 append-only；不得读取 `hidden/` 或 `expected/`。
4. 补丁必须逐字节可回滚：`git apply` / `git apply -R` 双向通过。
5. 不碰 `.runtime_view/`，不上传 `aitl_pr/` 六个交付文件，零密钥落盘。

## 五、期望交付

- 逐字 `OLD` / `NEW` 块（带文件路径与行号），能直接 `git apply`。
- 每处注明压缩手法，以及为什么语义不变。
- 给出本地验收命令与预期输出：
  - `npm run typecheck` → 0
  - `npm run test:acceptance` → server 端 2 failed 归零、client 端 5 处越线归零
  - `git apply -R` 反向可回滚

## 六、材料位置（沙箱内只读引用）

- 本次代码：`/tmp/ci_repro`（commit `e1c2064`，`node_modules` 已装）
- 基线代码：`/tmp/ci_ab`（commit `60ba1d3`，`node_modules` 已装）
- CI 日志：`/tmp/ci_logs/server (typecheck + acceptance + krsi)/5_Run npm run testacceptance.txt`、`/tmp/ci_logs/client (tsc + vitest + ui-static + browser e2e)/7_Run npm run testacceptance.txt`
- 本地补丁归档：`/workspace/codelens-rsi-merge-e1c2064.patch`

> 注：沙箱内 `127.0.0.1:8080`（codelens）与 `127.0.0.1:8787`（api-relay）均不可达，二者运行在用户本机。本材料供转投使用。

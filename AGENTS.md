# CodeLens 项目操作规则

> 本文件是仓库级操作约定；权限与执行边界仍由运行时与 `docs/agent/spec.md` 决定，本文件不扩大任何权限。

## 1. 先读手册

开始任何任务前，先读 `docs/agent/CODELENS-MANUAL.md`（v2.11.0 运行态自述）：
工具清单与风险、沙箱边界、技能库开关、RSI 账本读数、验证面与已知缺口。

## 2. 契约与边界

- `docs/agent/spec.md` 是唯一契约来源；本文件只补操作约定。
- `tests/`、`judge/`、`krsi/`、`rsi/`、`eval/`、`scripts/`、`self-upgrade/` 是人所有：
  改动必须显式归因（attribution=human）并重锚 `.self-upgrade/baseline.json`。
- 采纳写 D4（判据、`tasks.json`）必须由人 promote；自动采纳只允许 D1（`src/tools/`、`src/utils/`、`client/src/components/`）。
- 不伪造证据：未执行写 UNEXEC；账本只追加可验证记录，重建条目必须标 `reconstructed: true`。

## 3. 验证

- server：`cd server && npm run test:acceptance`（含 typecheck / vitest / krsi / 套件地板 / C1 / 工具契约）。用例体量以实跑输出为准，别把某个数写死当规范：锚点 run #5 @ `4d6ed81` 在 Linux 上读到 162 文件 / 1512 passed + 1 skipped（skip 的那条依赖真实 `.env`，缺席即跳过，不算通过）。
- client：`cd client && npm test`。
- 端到端：`bash scripts/e2e.sh`（Git Bash；可用 `E2E_PORT` 指定端口）。
- 改动 `src/` 后必须重跑对应验证；未跑 = UNEXEC，不算通过。

## 4. 合并原则

- **带上后台产出**：合并时把 RSI 后台循环自然落盘的变动（`.self-upgrade/rejections.jsonl`、ledger、`server/candidates/` 的 candidate/draft 演进）一并提交，不要丢弃或只挑源码。改前留档 `.bak` 不入库。
- **不再抬尺子**：CI 再报行数棘轮（`check:file-size`）超标，优先压代码净增或拆分，**不再抬高 `scripts/file-size-baseline.json` 的 ceiling**。确需抬必须 `attribution=human` 且在 `_raisedReason` 写明不可压的理由；默认视为不通过。
- **账本 append-only 冲突**：ledger 冲突保留双方记录、按时间排序、去重，不做覆盖式合并。

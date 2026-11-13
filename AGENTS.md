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

- server：`cd server && npm run test:acceptance`（含 typecheck / 1507 用例 / 套件地板 / C1 / 工具契约）。
- client：`cd client && npm test`。
- 端到端：`bash scripts/e2e.sh`（Git Bash；可用 `E2E_PORT` 指定端口）。
- 改动 `src/` 后必须重跑对应验证；未跑 = UNEXEC，不算通过。

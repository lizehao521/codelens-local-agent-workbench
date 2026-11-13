# CodeLens 自述手册（v2.11.0）

> 最后核对：2026-11-13。本文只写**当前实例上跑过的**事实；未执行的会标 UNEXEC。
> `docs/agent/spec.md` 仍是唯一契约来源；本手册是“我是谁、我能做什么、我哪里还不行”的索引。

## 1. 一句话定位

**本地优先的 Agent host + 判据门禁下的自我演进（RSI）。**
引擎是 `Improve(π) = π --Act--> τ --Judge--> r --Update--> π'`；外壳是本地桌面、BYOK、多上游中继。

## 2. 30 秒上手

```bash
cd server && npm install && npm run build
node dist/app.js            # 默认 :8080
curl http://127.0.0.1:8080/api/health
```

- 前端：`cd client && npm run dev`
- 环境变量：`server/.env`（已被 gitignore；密钥只落本机）
- 健康检查返回 `db.ok / tables=23 / sandbox.writable`

## 3. 架构总览

| 层 | 位置 | 职责 |
|---|---|---|
| HTTP | `server/src/app.ts`、`routes/` | `/api/v1` 单出口；`/api/rsi` 为兼容双轨，字节一致 |
| 控制器 | `src/controllers/` | sessions / tools / skills / sandbox / runs / judge / checkpoints / rsi |
| Agent 循环 | `src/services/agent/agent-loop.service.ts` | `run()` 驱动流式对话、工具调用、循环检测 |
| 工具 | `src/tools/builtin/` | 17 个内置工具，注册表带 `name/wireName/risk` |
| 判据 | `src/services/judge/` | 判决、工具纪律三闸、归因 |
| RSI | `src/services/rsi/`、`server/self-upgrade/` | 题集、变更域、提议与采纳 |
| 存储 | SQLite `server/data/codelens.db` | 23 张表（会话、消息、工具调用、判决、技能、授权…） |
| 前端 | `client/src/` | React + Vite；工作台、RSI 面板、审批、审计 |

## 4. 能力面：17 个内置工具

| 工具 | 线上名 | 风险 | 用途 |
|---|---|---|---|
| `http.request` | `http_request` | low | HTTP 请求（受控） |
| `fs.read` | `fs_read` | low | 读文件；相对路径按沙箱根解析，授权目录可用绝对路径 |
| `fs.write` | `fs_write` | medium | 写/覆盖/追加/重命名/删除/清空/精确替换 |
| `fs.list` | `fs_list` | low | 列目录（可递归） |
| `calc.evaluate` | `calc_evaluate` | low | 表达式计算 |
| `time.now` | `time_now` | low | 当前时间 |
| `uuid.generate` | `uuid_generate` | low | UUID |
| `json.format` | `json_format` | low | JSON 格式化/校验 |
| `text.diff` | `text_diff` | low | 文本差异 |
| `sys.exec` | `sys_exec` | **high** | 执行命令（进程树回收） |
| `tool.forge` | `tool_forge` | medium | 工具铸造入口（受判据约束） |
| `web.search` | `web_search` | low | 联网检索 |
| `eval.run` | `eval_run` | medium | 评测运行 |
| `eval.propose` | `eval_propose` | medium | 评测提议 |
| `code.check` | `code_check` | low | 代码检查 |
| `test.run` | `test_run` | medium | 跑测试并回机器可读结果 |
| `type.check` | `type_check` | low | tsc 诊断（流式收集，避免截断漏计） |

**契约闸**：`scripts/assert-tool-registry-contract.mjs` 断言规范名/线上名唯一且可逆、`risk` 必填、`tool_calls.tool_name ⊆ 注册表`、`/api/v1/tools ⊇ 注册表`。

## 5. 沙箱模型

- **当前实例**：`SANDBOX_ROOT` = 仓库根（DSH 工作区模式）；默认仍是 `server/workspace`。
- **授权表**：`sandbox_permissions.allowDirs` 现有 7 条（`server/src`、`server/tests`、`docs`、`server/self-upgrade`、`.self-upgrade`、`agent-decisions`、`skills/dsh`）。
- **路径规则**：相对路径只在沙箱根下解析；授权目录内的文件必须传绝对路径。
- **高危写**：覆盖/删除/清空需要用户确认；`CHECKPOINT_ENABLED=true` 时 overwrite 前落快照，可回滚。
- **回滚**：`POST /api/v1/checkpoints/:id/rollback` 需 `x-codelens-confirm: rollback`；能力未开先 409，缺头 400。

## 6. 技能库

- **形态**：数据库行（`name / description / tags / steps ≤12 / matchScore`），不是文件索引。
- **接口**：`GET/POST /api/v1/skills`，`DELETE /api/v1/skills/:name`；总开关 `SKILL_LIBRARY_ENABLED`。
- **匹配**：分词后分档（完全相等 > 标签 > 描述 > 名称），阈值 0.15，topK ≤10；不引入向量依赖。
- **当前实例**：已开启；**47 条**（DSH 48 个 `SKILL.md` 中 1 条因名称过长触发密钥规则被拒，文件保留在 `skills/dsh/`）。
- **密钥规则**：技能内容命中 `sk-…`、32+ 位不透明串、`api_key/secret/token/password` 键值形态即拒写，不回显原文。

## 7. RSI：判据门禁下的自我演进

### 7.1 闭环

`π → Act → τ → Judge → r → Update → π'`；r 必须真的改 π'，π' 必须真的改下一次 Act。

### 7.2 变更域（谁可以自动改）

| 域 | 范围 | 无人值守 |
|---|---|---|
| D4 | `tests/`、`krsi/`、`src/services/{judge,rsi,eval}/`、`scripts/`、`self-upgrade/` | **永不**，必须人 |
| D3 | `package.json`、`app.ts`、`config/`、架构入口 | 需人批 |
| D2 | `services/`、`controllers/`、`routes/`、前端 stores/services | 首次需人 |
| D1 | `src/tools/`、`src/utils/`、`client/src/components/` | 可全自动（≤6 文件） |
| D0 | 只读 | 可全自动 |

### 7.3 题集与账本（当前读数）

- `server/self-upgrade/tasks.json`：**13 题，done 13**；`strengthens` = Act 9 / Judge 4 / **Update 0 / Memory 0**。
- `.self-upgrade/ledger.jsonl`：**7 行，覆盖 1/13**（历史数据丢失，不可恢复）。
- `.self-upgrade/exemplars.jsonl`：**不存在**（正例回灌缺失）。
- `server/candidates/`：**1 个待采纳候选**。
- `scripts/rsi-tick.mjs`（`npm run check:rsi-tick`）：任务开始前的只读体检，不采纳、不写盘。

### 7.4 采纳边界（重要）

`auto-adopt` 通过四闸后**必然写 D4**：`tests/<judge>`、`tasks.json`、账本、exemplars。
当前裁决：**采纳只写 staging（`server/candidates/<id>/`），人 `promote` 时才落 D4 并重锚基线**。
所以“工具层可无人值守”成立，“整套 RSI 无人值守闭环”不成立——最后一步必须是人。

### 7.5 自证

- `judge-audit.mjs`：每份判据至少 1 条反向断言、占比 ≥20%。
- `scripts/mutation-probe.mjs`：改坏实现→跑判据→必须非零；`finally` 还原并校验 sha256。
  当前 **2/2 杀死**（path-jail 越界、checkpoint 确认头）。
- 围栏 `scripts/check-self-upgrade.mjs`：受保护文件哈希、判据指纹、C1 元数据、靶子改动。
- 基线：**254 个受保护文件**；改 `tests/` 等必须人重锚。

## 8. HTTP API 地图（`/api/v1`）

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康、DB 表数、沙箱可写 |
| `POST /api/v1/sessions` / `GET /api/v1/sessions` | 会话创建/列表（`items`） |
| `POST /api/v1/agent/stream` | Agent SSE 流 |
| `GET /api/v1/tools` | 工具清单（模型可见面） |
| `GET/POST /api/v1/skills`、`DELETE /api/v1/skills/:name` | 技能库 |
| `GET/PUT /api/v1/sandbox-permissions` | 沙箱授权表 |
| `POST /api/v1/sandbox-grants/:id/decision` | 越界授权审批 |
| `GET /api/v1/runs...`、`/api/v1/checkpoints...` | 运行证据、快照与回滚 |
| `GET /api/v1/rsi/overview` | RSI 读数（`/api/rsi` 双轨同源） |
| `GET /api/v1/judge/...` | 判决、有效性、深判 |

**错误体**：统一 `{ error: { code, message } }`（17 处 legacy 已统一）；前端 `parseErrorResponse` 兼容对象与字符串。

## 9. 验证面（当前）

| 项 | 结果 |
|---|---|
| `server npm run test:acceptance` | exit 0；**1507/1507（161 文件）**；krsi 10/10；套件地板 3/3；C1 PASS；工具契约 PASS |
| client 测试 | 136/136 |
| e2e | 14/14 |
| 变异探针 | 2/2 杀死 |

改动后必须重跑；未跑 = UNEXEC，不算通过。

## 10. 已知边界（别假装没有）

- **无 CI**：仓库没有 `.github/workflows`，围栏/C1/契约都靠本地或 acceptance 触发。
- **Update/Memory 归属缺口**：两维代码与判据在，但 13 题中 0 题归属它们。
- **账本 1/13、exemplars 缺失**：历史归因不可复算。
- **调度未实现**：`src/` 内没有任何地方启动 `self-upgrade-loop.ts`；只有只读 `rsi-tick`。
- **DSH 19 个工具未安装**：它们是 `defineTool` 插件模块，需 DSH 宿主，不能当 CLI。
- **1 条 DSH 技能未入库**：`hermes-translation-loss-reduction`，名称 33 字符触发密钥规则。
- **无像素基线**：设计线只有结构判据与静态卫生门禁。

## 11. 关键文件地图

```
server/src/tools/builtin/          17 个工具
server/src/services/agent/         Agent 循环、循环检测
server/src/services/judge/         判决、工具纪律、归因
server/src/services/rsi/           变更域、RSI 服务
server/self-upgrade/tasks.json     题集（13 题）
server/scripts/                    self-upgrade-loop、auto-adopt、judge-audit
scripts/check-self-upgrade.mjs     围栏（七道闸 + C1）
scripts/check-task-metadata.mjs    C1 元数据（exit 3 UNEXEC）
scripts/mutation-probe.mjs         变异探针
scripts/rsi-tick.mjs               只读体检
scripts/assert-tool-registry-contract.mjs  工具契约
skills/dsh/                        48 个 DSH SKILL.md
docs/agent/spec.md                 唯一契约来源
```

## 12. 版本

- 版本：**2.11.0**；分支 `feat/rsi-self-upgrade-merge-2026-11-11`
- 近期提交：`def2f0f` rsi-tick、`8a37d8c` DSH 技能、`f0b4b08` 变异探针、`ea32028` 错误体护栏、`6d398e7` 错误体统一

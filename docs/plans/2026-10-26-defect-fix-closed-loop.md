# CodeLens 缺陷修复 · 强化闭环阶段清单

> 日期：2026-10-26
> 依据：当前代码实证审计（2026-10-26 三线取证复核），14 条现存缺陷
> 纪律：每阶段遵循 Act 修复 → Judge 对偶测试（改坏必红）→ Update 沉淀 lesson；无真实单测的判据显式声明「静态闸 + 手工复现」，绝不把 UNEXEC 冒充 PASS（C4 不外推）

## 0. 闭环提示词模板（每个阶段复用）

```
【任务 Phase-N】<标题>
【缺陷证据】<文件:行号 + 当前行为一句话>
【Act 改动】<精确到文件/函数的改动，先写对偶测试再改实现>
【Judge 判据】
  - 正常例（绿）：<改好后哪个测试应绿>
  - 破坏夹具（红）：<把哪里改坏、改坏什么，测试必须转红>
  - 无法写真实单测 → 声明「静态闸 + 手工复现」，标注 UNEXEC 不作 PASS
【Update 写回】<本轮 lesson 落到 docs/decisions/DECISION-LOG.md 或 agent-decisions/DECISION-LOG.md>
【完成判据】<目标测试绿 + tsc --noEmit 0 错（涉及 TS 时）+ lesson 已写>
```

## 1. 阶段总览

| Phase | 严重度 | 缺陷 | 主题 | Judge 类型 |
|-------|--------|------|------|-----------|
| 1 | P0 | D-04 | 桌面审批主密钥 Windows ACL 硬化 | 单测 + live icacls |
| 2 | P0 | D-05 | MCP command 可执行白名单 + args 校验 | 单测（白名单校验函数） |
| 3 | P0 | AUDIT-006 | 前端接线四类能力 + DiffView 双栏 + CodeMirror 裁决 | 前端单测 + 依赖清理 |
| 4 | P1 | AUDIT-018 | 会话列举越权 + 空哈希放行 | 单测（repository 过滤） |
| 5 | P1 | D-03 + F-05 | 桌面同源协议白名单 + 卸载数据清理 | D-03 单测 + F-05 静态 |
| 6 | P1 | AUDIT-019 | HTTP 4MB 截断显式分类 + 非幂等不重试 | 单测 |
| 7 | P1 | AUDIT-008 | overrideArguments 前端接线 | 前端单测 |
| 8 | P1 | D-08 | 桌面加载失败错误页兜底 | 静态闸 + 手工复现 |
| 9 | P2 | AUDIT-028 | token 预算 + usage 对账出口（契约级，先澄清） | 需求澄清后单测 |
| 10 | P2 | AUDIT-027 | ReAct 工具目录计入上下文占用率 | 单测 |
| 11 | P2 | AUDIT-036 | path-jail 异步化 + 性能回归 | 单测（异步 fs stub） |
| 12 | P2 | 一致性/卫生 | README 环境变量表校正 + .gitignore release/ | 静态断言 |

## 2. 各阶段详细提示词

### Phase 1 · D-04 桌面审批主密钥 Windows ACL 硬化

- 【缺陷证据】`desktop/main.cjs:49-63`：`fs.writeFileSync(secretFile, approvalSecret, { mode: 0o600 })`，但 Windows 忽略 mode 位、NTFS 继承目录 ACL，且非 Win 才 chmod；`server/src/utils/hmac.ts:27-40` 直读该明文作 HMAC 主密钥。
- 【Act】抽出纯函数 `desktop/lib/win-acl.cjs#buildIcalcsArgs(filePath, username)`；`main.cjs` 新增 `hardenSecretFileAcl()`，在日志通道就绪后调用，Win 用 `icacls /inheritance:r /grant:r <user>:F`，非 Win `chmod 0o600`；对「历史旧密钥」同样生效；失败 warn 落 server.log。
- 【Judge】`desktop/test/win-acl.test.cjs`：正常例=args 含 `/inheritance:r`+`/grant:r`+`<user>:F`；破坏夹具=①改成追加式 `/grant` 转红 ②去掉 `/inheritance:r` 转红 ③授 `Users/Everyone` 转红 ④空用户名/路径 `assert.throws`。live：本机跑 icacls 对临时文件收紧并回读 ACL 证据。
- 【Update】DECISION-LOG 记：Windows 上 POSIX mode 位无效，敏感文件必须 icacls ACL。
- 【完成判据】`node --test` 绿 + live icacls 回读仅剩当前用户 + lesson 已写。

### Phase 2 · D-05 MCP command 白名单

- 【缺陷证据】`server/src/validators/mcp.schema.ts:10,16,31` 仅字符正则，`cmd/powershell/bash` 均可过；`args` 未校验元字符。
- 【Act】新增可执行程序白名单（node/npx/uvx + 绝对路径可执行文件），拒绝 shell 元字符的 command 与 args；抽出纯校验函数供测试。
- 【Judge】校验函数单测：允许 `node`/`npx`/`/usr/bin/python3`；拒绝 `cmd`/`powershell`/`bash`/含 `&|>^%`/路径穿越。
- 【完成判据】vitest 绿 + tsc 0 错。

### Phase 3 · AUDIT-006 前端接线

- 【缺陷证据】四类能力服务端已接（`task-prompts.ts`）+ `agent.schema.ts` 的 `taskKind`，但 `client/src` 零消费；`DiffView.tsx` 死代码且单栏；`client/package.json:17-32` CodeMirror 依赖 0 import。
- 【Act】前端加任务选择器→`buildRequest` 带 `taskKind`；`DiffView` 改为 before/after 双栏并接入 SSE 数据；CodeMirror 裁决：接入或删除依赖。
- 【Judge】前端单测：选择任务后 `buildRequest` 含 `taskKind`；`package.json` 无未使用 CodeMirror 依赖。
- 【完成判据】client vitest 绿 + tsc 0 错 + 依赖清理核对。

### Phase 4 · AUDIT-018 会话越权

- 【缺陷证据】`server/src/controllers/sessions.controller.ts:59-72` LIST 无 token 时返回全部；`:108-115` 空哈希放行。
- 【Act】LIST 强制按 `device_token_hash` 过滤；空/缺 token 返回空集或 401；关掉空哈希放行。
- 【Judge】repository/controller 单测：无 token 返回 0 行；空哈希不匹配任意会话。
- 【完成判据】vitest 绿 + tsc 0 错。

### Phase 5 · D-03 + F-05 桌面安全

- 【缺陷证据】`desktop/main.cjs:289-299` 非同源 URL 一律 `shell.openExternal`，`codelens:`/`file:` 未 deny；`desktop/electron-builder.yml:38` `deleteAppDataOnUninstall:false`。
- 【Act】抽出 `isSafeExternalUrl(url)`：仅 http/https 外抛，其余 deny；卸载清理（yml + 卸载脚本）。
- 【Judge】D-03 抽出纯函数单测（`codelens:`/`file:`/`smb:` denied，http/https allowed）；F-05 静态（yml 值 + 卸载脚本存在）。
- 【完成判据】node --test 绿 + 静态核对 + 手工复现。

### Phase 6 · AUDIT-019 HTTP 4MB 截断

- 【缺陷证据】`server/src/tools/builtin/http-request.tool.ts:70-75` 超 CAP `req.destroy()` 后落入 catch 被归 `retryable:true`，截断标志未送达 LLM。
- 【Act】超 CAP 显式产出不可重试的「内容截断」错误，携带截断标志；非幂等方法不自动重试。
- 【Judge】单测：超大响应 → 错误分类为截断且 `retryable:false`；POST 不进入重试。
- 【完成判据】vitest 绿 + tsc 0 错。

### Phase 7 · AUDIT-008 overrideArguments

- 【缺陷证据】`client/src/components/agent/AgentWorkbench.tsx:153,161` 只发 `resumeFromCallId`；`server/src/validators/agent.schema.ts:27` 支持 `overrideArguments`；`ToolCallCard.tsx:60` 注释与签名矛盾。
- 【Act】前端重跑/重试填充并可传 `overrideArguments`；修正误导注释。
- 【Judge】前端单测：从某步重跑携带 `overrideArguments`。
- 【完成判据】client vitest + tsc 0 错。

### Phase 8 · D-08 桌面错误页

- 【缺陷证据】`desktop/main.cjs:253-323` 无 `did-fail-load`/`render-process-gone`/`preload-error` 监听。
- 【Act】监听三事件 + 首字节超时，失败显示错误页（含日志路径）。
- 【Judge】静态闸（事件处理器已注册）+ 手工复现（断网/坏 bundle）。
- 【完成判据】静态核对 + 手工复现通过。

### Phase 9 · AUDIT-028 token 预算/对账（契约级）

- 【缺陷证据】`server/src/services/agent/agent-loop.service.ts:238,369,587` usage 仅展示/落库，无预算上限、无对账端点。
- 【Act】先回需求澄清：预算上限策略 + usage 导出形态；再实现。
- 【Judge】需求澄清后单测（usage 累加/导出正确）。
- 【完成判据】澄清记录 + 单测绿。

### Phase 10 · AUDIT-027 ReAct 工具目录计上下文

- 【缺陷证据】`server/src/services/agent/agent-loop.service.ts:279-285` ReAct 通道传 `undefined`；`react-channel.ts:77-83` 之后才拼目录。
- 【Act】ReAct 工具目录 token 计入占用率估算。
- 【Judge】单测：ReAct 下估算值含工具目录。
- 【完成判据】vitest 绿 + tsc 0 错。

### Phase 11 · AUDIT-036 path-jail 异步化

- 【缺陷证据】`server/src/tools/builtin/path-jail.ts:9,21,63,73` 每次同步 `realpathSync`。
- 【Act】改 `realpath`（异步）或缓存求根；抽出可注入 fs 的解析函数。
- 【Judge】单测：异步解析结果一致 + 用异步 fs（stub 断言）。
- 【完成判据】vitest 绿 + tsc 0 错。

### Phase 12 · 一致性/卫生

- 【缺陷证据】`README.md:57-65` 环境变量表 7/22、`AGENT_DB_PATH` 默认写 `server/data/agent.db`（实为 `<pkg>/data/codelens.db`）；`.gitignore:14-22` 缺 `release/`；`desktop/` 残留 10 个 release 目录。
- 【Act】README 补齐 env 表并更正默认值；`.gitignore` 加 `desktop/release/`；手工清理残留目录。
- 【Judge】静态断言脚本：README env 项数 = env.ts 项数；gitignore 命中 release/。
- 【完成判据】静态断言通过 + 残留已清。

---

*每阶段完成后在 `docs/decisions/DECISION-LOG.md` 追加一行：`[2026-10-26] Phase-N <标题> 完成，对偶测试 <绿/红样例>，lesson 已写`。*
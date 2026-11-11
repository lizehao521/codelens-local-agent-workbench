# RSI 交接 · 2026-11-10（下午）

> 本文件取代 `server/docs/rsi-handoff.md`（那份是上午的，§5.1 / §5.2 / §6-3 有误，见 §7）。
> 固定名会被下一趟覆盖，这份用日期命名；引用它时按文件名引，不要写「最新」。

## 0. 一句话现状

g3 失败的两个真因（复核事实投影硬编码、写前快照开关关闭）**已修并配变异臂验证**；
g4 **还没跑**。卡点已经不是「要不要重启」，而是**服务已经停了**：PID 19928 在 15:22
之后某个时刻消失，现在 8080 无监听、无 `app.ts` 进程、无残留 watcher。
要跑 g4 得先把它启动起来，**启动这一步需作者点头**。

| 项 | 状态 | 一句话证据 |
|---|---|---|
| A：`plannedFacts` after 状态硬编码 | ✅ done | 10 条用例 8 绿基线；改回硬编码 → 7 红 1 绿 |
| B：`CHECKPOINT_ENABLED` + `KRSI_BIN_PATH` | 🟡 离线 done / 需随服务启动生效 | 配置真读进来；日志里 g2/g3 仍是「未开启」 |
| 2：g4 路径补快照 | 🟡 接线 done / 夹具未写 | `_drive-one.mjs` 已接 `afterRun()` |
| 3：restore 一致性 + 真 savedAt | 🟡 模块 done / 夹具未写 | 体检实测 `legacy`，16 文件 |
| 4：跑 g4 | ⛔ 阻塞 | 服务已停，等作者点头启动 |

## 1. 本轮授权范围

作者先说「1+2+3 一起做，做完再跑 g4」，随后我把第 1 项的**前提证伪**
（`plannedFacts` 不携带 content/diff，缩小 prompt 的 diff 对复核输入零影响），
作者改口「ab 都做」：

- **A** = 修 `plannedFacts` 真缺陷 + 破坏夹具（替代原第 1 项）
- **B** = 建 `server/.env` 开 `CHECKPOINT_ENABLED` + 指 `KRSI_BIN_PATH`

原第 2、3 项（g4 补快照、restore 校验）**没有被撤回**，仍在做；第 4 项仍是跑 g4。
重启活服务**不在**授权内，明说「重启由你点头」。

## 2. A：复核事实投影（已完成）

### 缺陷
`server/src/services/tools/executor.service.ts` 的 `plannedFacts()`（改前 142–154 行）
把执行后状态写死：

```ts
afterExists: false,   // 恒 false
afterBytes: null,     // 恒 null
```

后果不是「少个字段」，是复核拿到错事实：`overwrite` 被描述成「文件写完就没了」，
复核据此正确判成不可逆删除 → 升级人工确认 → 无人值守必然超时。
线上 `agent_reviews` 两条 `underestimated` 的指摘原文都在引用 `afterExists=false`。

### 修法
新增 `projectAfter(toolName, operation, args, it, index, items)`，按 operation 预测：

| operation | afterExists | afterBytes |
|---|---|---|
| create / overwrite | true | `Buffer.byteLength(content,'utf8')` |
| append | true | `beforeBytes + 上述` |
| delete | false | null |
| purge | true（目录保留下内容清空） | null |
| rename 源项 | false | null |
| rename 目标项 | true | 源项字节数 |
| 非 fs.write | 照原样（预览不预测） | 照原样 |

字节数按 **utf8 编码后**算，不是 `content.length`（用例里那段中文内容 42 字节 / 28 个码元，
用长度会把 42 写成 28，复核看到的就是错的字节数）。
现文件 `sha256=5df5cd3d…93ee`，33657 字节，779 行全 CRLF。

### 夹具与变异臂
`server/tests/review-facts-projection.test.ts`（10 条）。**走真实调用点**
`ToolExecutor.executeBatch → reviewIrreversible`，不直调 helper —— 投影改对但没接上调用点，这里照样红。

关键踩坑：复核分支的进入条件是「不前置挑战 + effect 不可逆」。
`hard`/`two_step` 的审批循环在 `executor.service.ts:394/404` **直接 return `runAndRecord`**，
压根走不到 421 行的复核。所以夹具用 `soft`（与线上那次 overwrite 同形）。

同一趟读数（一次性脚本，guaranteed restore）：

| 臂 | 改动 | green | red | 红的是谁 |
|---|---|---|---|---|
| baseline | — | 8 | 0 | — |
| A1 | 调用点改回 `afterExists:false, afterBytes:null` | 1 | 7 | 除 delete 外全红 |
| A2 | 只把 create/overwrite 的 `afterBytes` 改成 null | 6 | 2 | overwrite、create |
| restored | 从备份 cp 回 | 8 | 0 | sha256 `match=true` |

A1 唯一绿的 `delete` 正是**唯一该判 `afterExists=false`** 的操作 —— 臂打在坏法上，不是恒绿。
A2 只红两条，证明 append 的字节断言另有一根针，不是被 append 借绿。

全量：`npx vitest run` → **113 文件 / 1121 测试全绿**；`npx tsc --noEmit` → **rc=0**。
（tsconfig 只 include `src`，测试文件不走 tsc，靠 vitest 跑通为准。）

## 3. B：写前快照开关（离线已完成，活服务未生效）

`server/.env` 已建，内容两条：`CHECKPOINT_ENABLED=true`、`KRSI_BIN_PATH=…/server/krsi/krsi.exe`。

- **不会误提交**：`git check-ignore -v server/.env` → `.gitignore:6:.env`；`git status` 不列出它。
- **加载路径对**：`env.ts:19-30` 用 `findPackageRoot()` 从模块目录向上找 `package.json`，
  落在 `server/`，与 cwd 无关。`NODE_ENV=test` 时整段跳过 —— 这是单测不被污染的开关。
- **实测解析**（走真实 config 模块，不是自己重写 parseBool）：
  `config.checkpointEnabled = true`（boolean）；
  `KRSI_BIN_PATH` → `existsSync=true`，`4450304` 字节；
  `process.env.KRSI_BIN_PATH` 已被填充 —— `runtime.ts:214` 直接读 `process.env`，不读 config。
- **不覆盖已有进程变量**：实探 `process.loadEnvFile` 不回写已存在的同名 env。
  所以活服务里若已被 launcher 注入了 `KRSI_BIN_PATH`，`.env` 不会抢；`CHECKPOINT_ENABLED`
  当前没被注入，因此这一行必须随服务下一次启动才生效。

### 因果链已钉（不是「我写了个文件」）
新增两条用例，让**同一个 overwrite** 在开关两侧给出相反读数：

| checkpointEnabled | reversible | recoveryNote | 复核 | 结局 |
|---|---|---|---|---|
| false | false | 未开启写前快照 | **被调用** | （g3 走的就是这条） |
| true | true | 已有写前快照 | 不进入 | success |

变异臂：把 `effect-preview.ts` 的 `reversible = Boolean(ctx.checkpointEnabled)` 改成 `= false`
→ **恰好 1 红**（「开启」那条），`rc=1`，还原后 `sha256 match=true`、10/10 绿。
「关闭」那条保持绿，说明两根针各自锚在自己的条件上。

### 活服务实测（当时还没吃到改动）
约 15:22 `GET /api/v1/capabilities` → `checkpoint | enabled=false | wired=true`，`enabledCount=6/12`。
**接线在、只缺开关**。端口 8080 owner 当时已验为 PID 19928。

更硬的证据在 `server/dev-server.log`：g2/g3 两轮运行时各留下
`[checkpoint] 快照捕获失败，继续执行本轮工具: CHECKPOINT_ENABLED 未开启`
（共 3 条，第 1958 / 2223 / 2225 行）。这是服务自己说的，不是推断。

## 4. 进行中：g4 前置（第 2、3 项）

### 已抽出共享模块 `server/scripts/lib/eval-state.ts`（9732 字节）
为什么要抽：g4 走 `scratch/_drive-one.mjs`（单发），而快照机器只在 `seed-agent-loop.ts` 里。
两侧各写一份必漂。抽出后两侧共用，且**能被单测**（内联在千行脚本里的函数测不到）。

提供：`hashEvalTree`（规范化树哈希）、`inspectEvalState`（三态体检）、
`restoreEvalState`（corrupt 拒绝覆盖）、`snapshotEvalState`（原子写 meta）、
`latestLedgerGeneration`（从账本取代际，不手写）。

设计要点：
- 树哈希：按 **正斜杠相对路径码元排序**，不用 `localeCompare`（后者随机器 locale 变，等于把判据建在环境上）；
  内容带长度前缀 framing，避免「内容里含分隔符」的边界歧义。
- 三态，不塌成 bool：`consistent` / `legacy`（旧记录没 treeHash = **没量过**，不是量过且不符）/ `corrupt` / `absent`。
- `corrupt` 时**拒绝 restore**：宁可不续接，也不把来历不明的树盖掉本代已修好的实现。
- meta 走 `.part` + `renameSync`，中途被打断不会留半截 `latest.json`。
- 哈希与文件数从**落盘那一份**重算，且与 `copyTreeOverwrite` 的计数互相对账（不等就告警）。

### 接线状态
- `seed-agent-loop.ts`：已改为 import 模块，删掉本地 4 个函数（本地 `rmSync`/`writeFileSync` 随之变无用，已一并从 import 摘掉）。
  restore 现在打印三态结论（corrupt 走 `❌ 已拒绝 restore`），snapshot 打印真实 `savedAt`/`treeHash`。
- `scratch/_drive-one.mjs`：已加 `afterRun()` —— 跑完等 6s（Judge+RsiBridge 要收尾）→ `runEvalBattery` 复算 →
  从账本取代际 → `snapshotEvalState`；并在**发前**记一次 `genBefore`，跑完对比告警「本发没产生新代际」。
  文件头「不写 eval-state」的旧说法已改。`node --check` 通过；两个 TS 文件 `esbuild` 解析 0 错。
- **还没做**：`server/tests/eval-state.test.ts` 破坏夹具（列在 §6）。

### 只读体检实测（当前仓库真实状态）

```
status     = legacy        （旧 latest.json 没有 treeHash）
detail     = 旧记录没有 treeHash（没量过，不是量过且不符）
meta       = {generation:2, passed:58, total:126, score:0.46, savedAt:"2026-11-10T13:20:00.000Z"}
actualTree = 2ca5b81eb55c06462dddc7b41a6e1f735a33e16c30628e6539b9351d5522283f (16 files)
workspace/eval 独立复算 = 同一个哈希、同样 16 文件
latestLedgerGeneration(59cea154-…) = 3
```

即：快照内容 ≡ 工作区（已用哈希证实，不再只是口头「byte-for-byte」），
但**代际标签写 2、账本已经到 3** —— 正好是第 3 项要修的漂移。
另外 `savedAt` 是手写的：账本同代 ts 是 `05:20:53Z`（= 13:20:53 +0800），
该文件 mtime 是 14:38，且整分整秒 `.000Z` —— 三个特征同时指向「本地时间直接贴了 Z」。

## 5. 阻塞：服务已停（启动需作者点头）

原来的服务 PID **19928**，`127.0.0.1:8080`，CodeArts 自有 node runtime
（`…/CodeArts/resources/bin/runtimes/node/node.exe --import tsx ./src/app.ts`），12:16:53 起。

**现在它已经不在了**（观察于 16:16）：

- `netstat -ano | grep :8080` 无输出；`Get-Process -Id 19928` 无结果；无 `app.ts` 进程；无残留 `tsx watch`。
  （注意：用 `CommandLine -like '*app.ts*'` 查会自匹配到你自己的查询命令，要先确认 PID 是真实进程。）
- `dev-server.log` 最后一行 mtime **14:46:49**，末尾是正常 `GET /api/health 200`，**没有崩溃栈**；
  但该进程在约 **15:22** 还答过 capabilities（HTTP 200）。所以「日志停在 14:46」**不等于**「14:46 就挂了」。
- 停止原因**未归因**：本会话没有对 19928 发过任何信号（只读文件、跑 vitest、发 HTTP GET）；
  可能是 CodeArts 那边的会话停的。记事实，不下结论。

关于 watch（旧文档没说清）：这台服务当天大部分时间跑在 `tsx watch` 下，
日志里有很多 `[tsx] change … Restarting`，但**最后一次自动重启是 11:52:29**。
我改的 `executor.service.ts` mtime 是 **15:07:11**、`scripts/seed-agent-loop.ts` 是 **15:36:48**，
日志里都没有对应的 Restarting —— 今天的源码改动**没有**被热载过。

**启动前不要跑 g4**：跑的会是未修的 `plannedFacts` + 关闭的快照开关，等于重演 g3。

启动后三项验收（缺一不算过）：
1. `GET /api/health` ok；
2. 真做一次 `fs.write overwrite` 已有文件 → `workspace_checkpoints` 行数 > 0（当前是 0）；
3. `agent_reviews` 不再因 `afterExists` 报 `underestimated`；`GET /api/v1/capabilities` → `checkpoint enabled=true`；
   并且 `dev-server.log` 不再出现 `CHECKPOINT_ENABLED 未开启`。

## 6. 待办

1. **写 `server/tests/eval-state.test.ts` + 变异臂**（第 3 项的夹具，未做）：
   - 快照后 `inspect → consistent`；
   - 篡改 `eval-state/eval` 任一文件 → `corrupt`，且 `restore` 必须 `copied=0`、工作区不变；
   - 删掉 meta 的 `treeHash` → `legacy`（不是 corrupt），restore 照常；
   - 空目录 → `absent`；
   - `savedAt` 落在调用前后的时间窗内（真时间戳，不是手写整分）；
   - 同一批文件换插入顺序 → 树哈希不变；换 `/` 与 `\` 平台 → 不变；
   - `latestLedgerGeneration` 从合成账本取到最大值。
   破坏臂至少三根：哈希只看路径不看内容 / `inspect` 恒返回 consistent / corrupt 也照 copy。
2. **重新快照一次**，把 `legacy` 的 `latest.json` 换成带 `treeHash` + 真 `savedAt` + `generation=3` 的版本。
   建议放在 g4 之后一次性做，别手写两次。
3. **跑 g4**（第 4 项）：从 `client/.env.local` 注入 `RELAY_API_KEY/RELAY_BASE_URL/RELAY_MODEL` → `RSI_*`
   （覆盖 `_drive-one.mjs` 里那个明文 HTTP 兜底 `http://1.92.92.200:8787/v1`），
   向 session `59cea154-61db-4175-8f77-cf60776e767b` 发一条；然后复算账本链、通过率、
   快照一致性、`tool_success_rate`。
4. **推迟项**（作者尚未点头）：提交（旧文档 §7-3）、清 `scratch/`、
   统一 `seed-rsi-demo.ts:19` 的 `KRSI_PATH` → `KRSI_BIN_PATH`、修 `test:krsi` 的 Go PATH
   （`go` 不在 PATH，在 `C:/Users/Admin/sdk/go/bin/go.exe`，故 `npm test` 会在 `test:krsi` 挂）。

## 7. 旧交接文档 `server/docs/rsi-handoff.md` 的更正

1. **§5.1 工具调用字段报错**：实际 DB 是 `status=rejected` / `error_kind=revised` / `approval_mode=none`；
   文档写成 `status=revised` / `error_kind=timeout`（软失败）。按文档排查会找错地方。
2. **§5.2「fix B：缩小 diff 规避不可逆降级」前提为假**：`plannedFacts` 输入的
   `ReviewFacts` 只有路径/操作/存在性/条目数/命令，**没有 content 也没有 diff**。
   缩小 prompt 里的 diff 对复核零影响。真因是 `afterExists` 硬编码。
3. **§6 checklist 第 3 条无效**：「`CommandLine` 包含 `KRSI_BIN_PATH`」永远不可能成立 ——
   环境变量不出现在 `Win32_Process.CommandLine` 里。要看只能间接证（g2 的 `exit=0` 说明服务能 spawn krsi）。
4. **§5 通过率对比与账本不符**：文档写 43/126→58/126；账本 g1 的 `test_pass_rate=0.405`
   （43/126 应为 0.341），g2/g3 都是 0.46。g2→g3 的判决原文是
   `R5: 护栏指标 "tool_success_rate" 变差（1 → 0.923）`。

## 8. 复现 / 验收命令（照抄即可）

```bash
cd "C:/Users/Admin/Desktop/新建文件夹 (2)/server"

# A：投影夹具（应 10 passed）
npx vitest run tests/review-facts-projection.test.ts --reporter=verbose

# 全量 + 类型
npx vitest run            # 应 113 files / 1121 tests
npx tsc --noEmit          # 应 rc=0

# B：配置真读进来了吗（走真实 config 模块）
node --import tsx -e "import('./src/config/env.ts').then(m=>console.log({checkpoint:m.config.checkpointEnabled,krsi:process.env.KRSI_BIN_PATH}))"

# 活服务当前开关（服务已停，命令会拒连；起来之后再跑，此时应 enabled=true）
curl -s http://127.0.0.1:8080/api/v1/capabilities

# 快照三态 + 账本代际（当前应 legacy / 16 files / gen=3）
node --import tsx -e "import('./scripts/lib/eval-state.ts').then(m=>{const i=m.inspectEvalState(process.cwd());console.log({status:i.status,files:i.actualFileCount,treeHash:i.actualTreeHash});console.log('gen=',m.latestLedgerGeneration(process.cwd(),'59cea154-61db-4175-8f77-cf60776e767b'));})"

# .env 不会被提交
git check-ignore -v server/.env
```

## 9. 本轮新增/改动文件

| 文件 | 性质 | 说明 |
|---|---|---|
| `server/src/services/tools/executor.service.ts` | 改 | `projectAfter()` + `plannedFacts` 重写 |
| `server/tests/review-facts-projection.test.ts` | 新增 | 10 条，走真实调用点，含 CHECKPOINT 对立读数 |
| `server/.env` | 新增（**gitignore**） | `CHECKPOINT_ENABLED=true` + `KRSI_BIN_PATH` |
| `server/scripts/lib/eval-state.ts` | 新增 | 树哈希 / 三态体检 / 原子快照 / 账本代际 |
| `server/scripts/seed-agent-loop.ts` | 改 | 改为 import 模块，restore/snapshot 打印三态与真读数 |
| `server/scratch/_drive-one.mjs` | 改（未跟踪） | 加 `afterRun()`：复算 + 落快照 |
| `server/tests/eval-state.test.ts` | **未写** | §6-1 |

## 10. 关键新发现（不在本轮授权内，未修，待决策）

1. **最危险的操作反而没有执行前复核**：`hard`/`two_step` 的审批循环在
   `executor.service.ts:394/404` 直接 `return runAndRecord`，永远到不了 421 行的复核分支。
   即「两步确认删沙箱根」这类操作**从不进同步复核**。复核只对
   `soft`/`none`（或已有会话授权的 `hard`）+ 不可逆 effect 生效。
2. **`server/eval-state/` 是 untracked**（`git status` 显示 `??`），不是旧注释说的「版本库内目录」。
   它只能防「同一工作副本里 `workspace/` 被清」，**防不住 clone / 换机**。
   要真做跨沙箱续接，得把它提交（属于 §6-4 推迟项，需作者点头）。
3. `client/.env.local` 与 `server/.env` 是两份不同用途的配置；前者放中转凭据，后者放服务端开关。
   不要把 `RELAY_*` 抄进 `server/.env`（服务端不读这些名字，g4 是运行时注入成 `RSI_*`）。

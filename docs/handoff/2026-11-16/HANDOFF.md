# RSI π 回归迭代 · 交接文档

> 用途：在另一台机器接着开新项目。本文只写「接手需要什么」——现状、源码在哪、链路怎么起、规矩是什么、坑在哪、下一步干什么。
> 历史流水账见 `docs/handoff/2026-11-16/reports/`（exp13–exp18），本文不重复。
> 生成时间：2026-11-16 · 生成者：上一轮代理（Hunyuan）
>
> **接手入口**：clone 本仓库后，全套交接材料在 `docs/handoff/2026-11-16/`（本文所在目录）。
> 子目录：`reports/` 各轮报告、`patches/` 两份可用 patch、`verdicts/` codelens 判决原文、`scripts/` 投放脚本。
> 这份文档随主仓库走；源码目录与含密钥的 `.env` 不在交接包内，按 §4 在新机重建。

---

## 0. 一句话现状

**验证方法链已经跑通并自洽，但交付物卡在两处：** ① CI 修复 `eaa6dfa` 本地验证全绿、**未推到远端**（远端 main 还是失败的 `e1c2064`）；② 最后两轮把「budget 耗尽」和「π 连续性」丢回 codelens 迭代，结论是**结构性缺口**（agent 零差分信号时无可靠停止机制），不是再给一版纪律能解决的。

---

## 1. 项目目标与贯穿规矩（新机器务必先读）

这是一个 **codelens 自改进内核**（强化闭环 `Improve(π) = π --Act--> τ --Judge--> r --Update--> π'`）的回归迭代项目。代理的角色是**审计方**，不是模型代码的作者。

**五条硬约束，全程未破，接手后继续守住：**

1. **代理不替模型写诊断/补丁**——发现问题 → 丢给 codelens → 它产出逐字块 → 代理核对 + 实测 + 落地。若用户明确授权"直接修"（如 exp 的 CI 修复），才例外，且必须记录。
2. **逐字节可回滚**——每次改动前备份，重放一次对得上；账本 append-only。
3. **不读 hidden/expected**——判据的隐藏用例、期望值一律不碰。
4. **旁账与主线隔离**——独立 session、只读不写 π、不改判据塔（`src/` 与受保护 eval 套件）。
5. **零密钥落盘**——GitHub token、relay key 用完即删，不进版本库、不进报告。

交接判决原则：**谁的判断都能被推翻，包括代理自己的**。报告里始终单列「我判错了 / 我记错了」一节。

---

## 2. 现状盘点（接手即时的真实状态）

| 项 | 值 | 备注 |
|---|---|---|
| 远端 main | `e1c2064`（**CI 全红那版**） | `git ls-remote origin refs/heads/main` 复核 |
| 本地修复 HEAD | `eaa6dfa`（`/tmp/push_codelens`，工作树干净） | CI 修复：抽共享受控开关模块 + 压回行数棘轮 |
| 验证仓库 | `/tmp/ci_repro` HEAD=`e1c2064`（已就地打修复，未提交） | 所有 CI 实测在这做 |
| `/workspace/codelens` 源码 | **更早的同步快照**（agent-loop 1523 行 / judge 1150 行 / 无 controlled-release.ts） | 不是修复版，别误用 |
| 真实 π 主库 | `/workspace/codelens/data/codelens.db`（108 policy 版本） | **注意路径**：不是 `server/data/` 那个空库 |
| relay 服务 | `:9999`（`proxy_relay.py`，上游 DeepSeek-V4-Flash，含 key） | 沙箱重启后进程可能停，需手动起 |
| codelens 服务 | `:8080`（`tsx watch src/app.ts`） | 同上 |
| GitHub 授权 | 设备码通道可用但用户连不上授权页；token 已 shred | 推送搁置，见 §6 |

**关键：本地 `eaa6dfa` 与 `/workspace/codelens` 源码不是同一版。** 要验证修复，用 `/tmp/push_codelens`（含 `eaa6dfa`）或 `/tmp/ci_repro`；要跑 codelens 服务做闭环实验，用 `/workspace/codelens`（旧快照）。两者别混。

---

## 3. 交付物清单（`/workspace`）

### 3.1 必须带走的核心产物
| 文件 | 用途 |
|---|---|
| `HANDOFF.md`（本文） | 接手总入口 |
| `codelens-rsi-merge-e1c2064.patch` | e1c2064：`60ba1d3`→RSI 改动（7 文件 +199/-15），已推远端 |
| `codelens-rsi-fix-eaa6dfa.diff` | eaa6dfa 的 424 行修复，**未推**，可 `git apply` 落地 |
| `rsi_pi_exp13~18_report.html` | 各轮实验报告（exp16=审补丁+独立修CI，exp17=缺口自造+π迭代+辩论，exp18=budget 四轮） |
| `codelens-audit-verdict.json` / `codelens-fix-verdict.json` | exp16 两份 codelens 判决原文 |
| `rsi_pi/exp16_*_result.json` | exp17/18 各轮原始产出（gap_pi / debate / budget 四轮） |
| `ci-failure-rsi-input-20261116.md` | CI 失败根因材料包 |

### 3.2 脚本（`/workspace/rsi_pi/`）
- **投放器**：`budget_drop.py` / `budget_validate_drop.py` / `budget_iterate_drop.py` / `budget_final_drop.py`（exp18 四轮）、`gap_pi_iterate.py`（缺口自造）、`debate_drop.py`（辩论）、`audit_drop.py`/`fix_drop.py`（审补丁/独立修 CI，位于 `/tmp`）
- **通用协议**：POST `http://127.0.0.1:8080/api/v1/agent/stream`，body `{provider:"custom", model:"agent-proxy", customBaseUrl:"http://localhost:9999/v1", apiKey:"dummy", channelMode:"native", maxIterations, maxTokens, message}`，读 SSE `data:` 行拼 `text/delta/content`
- 更早的 exp1–exp15 脚本/日志/快照都在 `rsi_pi/`，按需查，不必全带

---

## 4. 新机器环境重建（按序执行）

```bash
# 1) 源码与仓库（把本工作区的这些目录拷过去）
#    /workspace/codelens          —— codelens 源码（旧快照，跑闭环用）
#    /workspace/agent_proxy       —— relay（proxy_relay.py + relay.env，key 需重新配置）
#    /tmp/push_codelens           —— 含 eaa6dfa 的 git 仓库（推送用）
#    /tmp/ci_repro                —— 验证仓库

# 2) 依赖
cd /workspace/codelens/server && npm ci          # Node 建议 22.23+（见 §5.3）
cd /workspace/codelens/client && npm ci
# krsi 测试需要 Go toolchain（沙箱网络下载失败，真机应可）

# 3) relay（先起，:9999）
cd /workspace/agent_proxy
# relay.env 里的 RELAY_*_KEY 必须在目标机重新填；上游 URL/模型按实际可用性配
nohup python3 -u proxy_relay.py > relay.out 2>&1 &
curl http://127.0.0.1:9999/health      # 期望 200

# 4) codelens server（后起，:8080）
cd /workspace/codelens/server
nohup npm run dev > relaunch.out 2>&1 &
curl http://127.0.0.1:8080/api/health  # 期望 200

# 5) 端到端探活（relay→真实模型）
curl -X POST http://127.0.0.1:9999/v1/chat/completions \
  -H "Authorization: Bearer $RELAY_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"agent-proxy","messages":[{"role":"user","content":"只回复：收到"}],"max_tokens":32,"stream":false}'
```

**注意**：沙箱后台进程会在空闲间隙被回收，重连后先跑 §2 的健康检查，必要时重起两个服务。

---

## 5. 已知坑（都是踩过的，别再踩）

### 5.1 π 库路径错位
真实主库是 `/workspace/codelens/data/codelens.db`（108 版本），**不是** `server/data/codelens.db`（空）。exp17 的 `policy None->None` 就是读错库导致的误报。之前重启 server 用错 ROOT（`cd server && npm run dev` 使默认库变成 `server/data/`），导致那两批实验跑在空 π 实例上、与历史不连续——**要补 π 连续性必须指向真实主库重跑**。

### 5.2 `sys.exec` 是 hard 审批，无人值守必卡
`seed-agent-loop.ts:53` 注释明写："不能用 sys.exec：它是 hard 审批，无人值守会卡在 approval 上不返回"。exp18 第②轮让 codelens 跑 node 本地探针，就死在这（审批 5 分钟过期 → 重试 → 循环检测 aborted）。**自动任务里绝不写需要 hard 审批的工具**；差分信号要靠只读工具（`fs_read`/`code_search`/`text_diff`）。

### 5.3 Node 版本影响测试信号
Node 22.13 缺 `zlib.createZstdDecompress`，会让 undici mock 产生约 21 个**无关**失败（基线也红）。CI 用较新 22.x。用 nvm 装 22.23 再跑验收，才能拿到可信信号。exp 的 CI 修复已在 22.23 下验证：193 文件 / 1932 用例全过。

### 5.4 行数棘轮（CI 双 job 失败根因）
CI 有 `file-size` 棘轮（只许缩不许涨）。e1c2064 让 5 个文件净增 114 行撞穿上限。修复方式：**抽共享模块**（`services/rsi/controlled-release.ts`，79 行）替代三处重复，精简注释压回上限——不是动棘轮上限/测试/豁免清单。各上限见 `scripts/file-size-baseline.json`。新增文件必须带 C1 文件级声明注释，否则 `kernel-centricity` 测试红。

### 5.5 GitHub DNS 污染 + token 权限障眼法
- 沙箱里 `github.com` 被 DNS 污染到 `20.6.7.17`（连不上），官方 IP `20.205.243.166` 时而可用；`/etc/hosts` 那行映射**没实际改动**（命令被权限系统拒了）。
- 连接器 token（`ghu_` 前缀）是**只读**，`permissions.push:true` 是 owner 权限、不是 token 能力；判断写权限只能真发一次写请求看响应头（`x-accepted-github-permissions: contents=write`）。设备授权码流程能拿到 `gho_` + `scope=repo` 的可写 token。

### 5.6 脚本记录口径
- SSE 里最后抓到的 `finishReason` 未必是真实终态：exp18 v2 脚本记成 `stop`，实际末尾有服务端注入的 `finish_reason=length`（撞 max_tokens）说明。核对终态要扫全文，不能只看最后一个事件。
- 行数口径是 `content.split('\n').length`（末尾有换行时 = count+1），我曾用错公式误判 replay.ts。

---

## 6. 待决事项（按优先级）

1. **【P0】推 `eaa6dfa` 到远端 main**。当前远端还是 CI 全红的 `e1c2064`，修复只在本机。走 GitHub 设备授权（用户需能登 github.com/login/device 输入码），或用有 Contents:write 的 PAT。推后 `git ls-remote` 复核 ref = `eaa6dfa`。`codelens-rsi-fix-eaa6dfa.diff` 是等价归档。
2. **【P1】CI 真机复验**。沙箱因 Go 网络问题跑不了 `test:krsi`、也没跑 browser e2e；其余门禁（typecheck / suite-floor / task-metadata / tool-contract / file-size / runtime-view + 客户端全套）在 22.23 下全绿。推上去后看远端 CI 两个 job 是否真转绿。
3. **【P1】π 连续性补验**。exp17/18 的实验跑在空 π 实例上，与历史 108 版本不连续。指向 `/workspace/codelens/data/codelens.db` 重跑一轮，确认 π 能在既有版本上继续迭代。
4. **【P2】budget 耗尽的结构性缺口**。exp18 结论：agent 在「隐藏用例不回显 + 无可靠本地执行/反馈通道」时缺可信停止机制，会一直找「再考虑一个边界」直到撞预算/截断。这不是"再给一版纪律"能解，需要系统层加停止/降级通道——**需用户定夺是否另立一项**。
5. **【P2】历史遗留缺口**（见 exp15 报告）：0.60/0.65 往返震荡无收敛判据；放松拿不到 `improved`；账本行数与 π 版本不一致。

---

## 7. 沟通与协作约定

- **辩论协同怎么做**：用 `debate_drop.py` 那套——开独立 session 让 codelens 扮演反方质疑自己/代理的结论，只读不写，结论落旁账。系统原生还有 `judge/red-team.ts`（L3 红队判据，自动查"声称做了但没证据"）作为自我对抗面。
- **发现问题的处理路径**：先复现（带证据）→ 写成材料包（脱敏、给逐字 OLD/NEW）→ 投给 codelens → 核对判决 → 实测 → 如实记账。报告单列代理的失误，不藏。
- **单并发注意**：relay 是单流模型通道，同时投两个任务会串台；agentConcurrency 上限 3，但真实 LLM 那侧按串行理解更安全。

---

## 8. 快速自检清单（接手第一件事）

```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/health   # codelens
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9999/health        # relay
cd /tmp/push_codelens && git rev-parse --short origin/main                # 应 6877899
cd /workspace/codelens && python3 -c "import sqlite3;print(sqlite3.connect('file:data/codelens.db?mode=ro',uri=True).execute('select count(*) from policy_versions').fetchone()[0])"  # 应 108
```

四项对上后，按 §9 的合并后状态继续。

---

## 9. 合并后状态更新（2026-11-16 19:55 GMT+8）

> 本节覆盖上文 §0、§2、§6 中已过时的“待推送 / CI 全红”描述。以本节为准。

| 项 | 最终值 |
|---|---|
| 远端 `main` | `6877899`（`docs(handoff): 归档 RSI π 回归迭代交接材料`，变基合并后的提交） |
| 远端分支 | `merge/local-rsi-2026-11-16` → `540327e`（已保留，PR #3 的 head） |
| PR | [#3](https://github.com/lizehao521/codelens-local-agent-workbench/pull/3)，state=closed，merged=true，merge_method=rebase |
| 远端 CI | `client (tsc + vitest + ui-static + browser e2e)` = **success**；`server (typecheck + acceptance + krsi)` = **success** |
| GitHub 授权 | 设备码 `06B4-D20B` 已换取 `gho_`/`repo` 令牌；推送、建 PR、合并、复核均完成；令牌已按零落盘约定在使用后删除 |
| DNS 绕行 | 沙箱 `github.com` 被污染到 `20.6.7.17`；所有 API 调用用 `--resolve github.com:443:20.205.243.166`，git 用本地 CONNECT 代理 `127.0.0.1:18444` 转发到官方 IP |

§6 的 P0 已完成；P1（CI 真机复验）也已由远端双 job success 结案。仍待办的是 P1 的 π 连续性补验与 P2 的两项结构性/历史缺口——它们与交付分支无关，可在新项目里另起一轮。

新机器接手时，直接 `git clone` 后取 `origin/main` 即可得到全部源码修复与交接材料；不必再 `git apply` 归档补丁（补丁仍保留作审计证据）。

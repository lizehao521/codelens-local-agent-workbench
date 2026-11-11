# RSI 判据治理报告（2026-11-11）

> 用「判据器会在哪里骗你」的六种失败模式，对 AgentRsi 判决链做一次体检。
> 结论先说：**M4 是真的，已被实测复现，已修**。其余五种已核对，两处仅存边界说明。

## 1. 体检对象

| 层 | 实现 | 职责 |
|---|---|---|
| 内核 | `server/krsi/main.go` | R1–R6 判决，6 态出口（0/1/2/3） |
| 判据 | `server/src/services/judge/eval-rate.ts` | `task.test_pass_rate` —— 代码修复族的唯一目标读数 |
| 桥接 | `server/src/services/rsi/rsi-bridge.service.ts` | verdicts → manifest → spawn krsi → 落链 |

## 2. 六模式逐条

### M1 把「读不到」记成「不合格」—— 合规，但发现一处活标本

判决链本身是三态的：`skipped` / `error` / `undecidable` 都带 `reasons`，且 `error` 不会被当成「没进步」。
`evalPassRateGate` 在「没调用过 eval.run」时返回 `null` 而不是 `unexec`，正是这条规矩的实现。

**但体检过程本身踩到了它**：新写的门禁用 `fs.existsSync(KRSI)` 判前置，返回 `false`，
而同一路径用 `execFileSync` 能正常启动（exit=2 是用法提示）。若照原样上线，
这道闸会把「可用的内核」判成「前置不可得」。
已改为**按可执行性判定**（`e.kind !== 'ENOENT'`），不用文件系统 API 当存在性的唯一真相。

### M2 假绿基线 —— 合规

门禁有三档退出码：`0` 通过 / `1` 有缺陷 / `2` 前置不可得。
「前置不可得」不会退化成绿，`check-suite-floor.mjs` 打印的是「这不是通过，也不是失败」。
`rsi:verify` 复算用 v2(canonical) 口径，历史链 4 代全部一致。

### M3 脆金丝雀 —— 已规避

新的地板门禁**不断言**「旧判据集下会判 improved」。那是当前缺陷，将来若被内核修掉，
这条断言就会变红，属于把故障钉死。门禁只钉结构性真值：

- 地板变差 + 目标变好 → 必须 `not_improved`
- 地板持平 + 目标变好 → 必须 `improved`（防误杀）

### M4 口径窄于风险 —— **实测成立，已修**

判据想防的风险：*Agent 在修一个套件时把另一个套件改坏，能力实际下降。*
判据实际量的量：`Σpassed / Σtotal`（136 例的整机率）。

聚合率对单元崩塌不敏感，13 个套件可以互相抵消。

**注入实验**（真实 krsi 二进制，prev/next manifest 只在临时目录构造）：

| 场景 | 读数 | 内核判决 |
|---|---|---|
| 基线无变化 | 0.691 → 0.691 | `not_improved`（1） |
| 真改进 +6 例 | 0.691 → 0.735 | `improved`（0）✅ |
| **一好一坏净 +1**（parse_query +6 / csv_import -5） | 0.691 → 0.699 | **`improved`（0）** ❌ 理由写「全部指标严格变好」 |
| 一好一坏净 0（+6 / -6） | 0.691 → 0.691 | `not_improved`（1） |

第三行就是假绿：一次真实的破坏被奖励成改进。这不是理论风险 ——
g4 那代把 `csv_import` 从 7/17 改到 1/17，只让整机率掉 0.044，
恰好没有另一套件上涨来抵消才被抓到。

**修复**：新增护栏判据 `task.suite_floor`（metric `suite_floor_ratio`，role `guard`）。
逐个套件比对上一代，任何套件通过率下降即 `fail`；不要求任何套件变好。

修复后同一注入场景：

```
[地板已存在] · suite_floor_ratio：1 → 0.923（变好=false）（护栏：不得变差）
判定：not_improved
理由：R5: 护栏指标 "suite_floor_ratio" 变差（1 → 0.923）
```

真改进仍判 `improved`（地板 1→1 不拦）—— **没有把真改进一起误杀**。

### M5 字段语义跨族不可比 —— 一处命名相近已排除

`evidence.verdicts[].data.suites` 里同时存在 `slugify`（7/7，基础题）与
`slugify_edge_cases`（4/7，边界题）。名字相近，但确实是两个套件、两张题面，
不是同一件事的两个名字，不构成口径分叉。

### M6 永真断言 —— 已做判别力自证

`tests/eval-suite.test.ts` 原有 5 条注入用例（正确实现拿满分 / 缺陷夹具真红 /
只打公开补丁被隐藏用例抓住 / 实现缺失报套件级错误 / 指纹可被打红）。

本次新增 `tests/rsi-suite-floor.test.ts` 17 条，覆盖：
回退必红、上涨不算回退、题数变化不可比、套件消失算回退、新增套件不进分母、
无基线不编造读数、写进 manifest 的 `role` 必须是 `guard`。

**端到端验收**（故意改坏，闸必须红）：

| 改坏方式 | 单测 | 契约门禁 |
|---|---|---|
| `task.suite_floor.role` 由 `guard` 改为 `objective` | 2 条红 ✅ | 14 项中 1 项 FAIL（指纹变）✅ |
| 还原 | 17/17 绿 | 14/14 PASS |

## 3. 判据集变更留痕

新增判据会改变 `criteria_sha256`，这是 R2 抓「偷改判据」的依据，必须显式记录：

```
8d567e31d898304983333702028601466582a2b370d996e93643de8c92b4616d  ← 变更前
522c3ddad8478b63d01074841fd2faaa68b5cef2d41fd0076f0003b51e11dee4  ← 新增 task.suite_floor(guard)
```

`check-rsi-contract.mjs` 的 `§6-7b` 固定指纹已同步，并在注释里写明变更原因。

## 4. 使用边界（必须知道）

1. **旧链不可接。** 判据集指纹变了，接着跑旧链会被 R2 拒收（`refused`）。
   `rsi:code` 必须从新会话起跑；历史链 907ef502 / 7d7876d4 仍可完整校验，但不再延长。
2. **地板首次加入的那一代无效。** 实测：prev 没有这条读数时，内核无从比较，
   仍判 `improved`。因此首代写成 `1.0` 并标注「确立基线」，
   让它成为下一代的基线 —— 代价是首代这一格是真空成立，不是测量结论。
3. **地板只挡「比上一代差」，不挡「一直差」。** 某套件如果连续多代都在低位，
   它不构成回退，地板不会告警。这是刻意的：那是 objective 的职责，混进去会让护栏变成第二个目标。

## 5. 本次落地

| 文件 | 改动 |
|---|---|
| `src/services/judge/eval-rate.ts` | 新增 `readSuiteScores` / `suiteFloor` / `suiteFloorVerdict` |
| `src/services/rsi/manifest-builder.ts` | `METRIC_MAP` 新增 `task.suite_floor`（guard），入 `SCORABLE_CRITERIA` |
| `src/services/rsi/rsi-bridge.service.ts` | 判决前读上一代 evidence，算地板并注入；首代确立基线 |
| `scripts/check-suite-floor.mjs` | 新门禁：3 项结构性断言，退出码 0/1/2 分离 |
| `scripts/check-rsi-contract.mjs` | `§6-7b` 固定指纹更新 + 变更留痕 |
| `tests/rsi-suite-floor.test.ts` | 17 条自证 |
| `package.json` | `check:suite-floor` |

回归：后端 115 files / 1146 tests 全绿；`test:krsi` 10/10；`check:rsi-contract` 14/14；
`check:suite-floor` 3/3；`rsi:verify` 历史链一致；双端 tsc exit 0。

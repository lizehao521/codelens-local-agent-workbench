# 任务：RSI 出口收敛到 /api/v1（全栈，一次交付）

仓库根：`C:/Users/Admin/Desktop/新建文件夹 (2)`。工作区已提交（HEAD=54b58a6），你可以放心改。

## 背景（先读，别猜）

当前 RSI 有**两套出口**并存：

- 旧：`server/src/app.ts` 里内联挂的 `GET /api/rsi/overview` 与 `GET /api/rsi/rules`（业务逻辑直接写在入口文件里）
- 新：`server/src/routes/rsi.routes.ts` 的 `/api/v1/rsi/{contract,iterations,decisions,...}`

结果：前端 `client/src/services/api.ts` 里 `getRsiOverview` 走 `/api/rsi/overview`、`getRsiRules` 走 `/api/rsi/rules`，而 `getRsiIterations` 走 `/api/v1/rsi/iterations` —— 同一块功能对着两套前缀，兜底逻辑被迫写两遍。

## 目标（后端 + 前端，必须一起改完）

### 后端

1. 把 `app.ts` 里的 `/api/rsi/overview`、`/api/rsi/rules` 两个 handler **原样搬进** `server/src/controllers/rsi.controller.ts`，新增 `overview(req,res)` 与 `rules(req,res)` 两个方法。搬的时候只允许改「取参方式」，**不允许改响应体任何字段**。
2. `server/src/routes/rsi.routes.ts` 新增 `GET /rsi/overview` 与 `GET /rsi/rules`，指向上面两个方法（最终路径即 `/api/v1/rsi/overview`、`/api/v1/rsi/rules`）。
3. `app.ts` 里旧的两条路径**保留为兼容出口**，但只留一行转发（复用 controller 的同名方法），不要再写业务逻辑。`app.ts` 是入口装配文件，迁完之后它里面不应再有 50 行的 overview 拼装代码。
4. 两个出口必须**同源**：都调用 `buildRsiRulesContract()`，返回的 rules 深度相等；`Cache-Control: no-store` 两条都要保留。

### 前端

5. `client/src/services/api.ts`：`getRsiOverview` 改指 `/api/v1/rsi/overview`，`getRsiRules` 改指 `/api/v1/rsi/rules`。错误码、异常类型、返回结构一个字都别动。
6. 顺手把这两处上方的注释改对（原文写着「注意：不是 /api/v1 前缀」）。
7. 不要改任何 `.tsx` 组件，不要动 `client/src/lib/rsi-rules.ts` 的兜底契约。

## 判据（必须新增，且只允许新增这一个文件）

8. 新建 `server/tests/contract/rsi-exit-consistency.test.ts`，至少断言：
   - `GET /api/v1/rsi/rules` 与 `GET /api/rsi/rules` 的状态码、`Cache-Control`、JSON 深度相等；
   - `GET /api/v1/rsi/overview?session=xxx` 与旧出口对同一会话返回同一结论（用不存在的 session 时两者都给 404 且 code 一致）；
   - 前端 `api.ts` 里已不存在 `/api/rsi/overview`、`/api/rsi/rules` 字面量（读文件 + 正则断言即可，防回归）。

## 硬约束（越界即失败）

- **不得修改 `server/tests/` 下任何既有文件**，只能新增上面第 8 条那一个文件。
- **不得删除任何「解释设计动机」的注释**（含「原来」「因为」「刻意」「纯浪费」这类）。迁移时注释跟着代码走。
- 单文件 ≤ 300 行；`app.ts` 迁完后应当更短，不是更长。
- 不改 `package.json` / `tsconfig.json` / `vitest.config.*`，不跑 `npm install`。
- **路径一律用绝对路径**：沙箱会把相对路径解析到 `server/workspace/`，用相对路径会写到错的地方。写文件请用形如 `C:/Users/Admin/Desktop/新建文件夹 (2)/server/src/app.ts` 的绝对路径。

## 完成标准（自己验，别只说做了）

1. `code.check` 通过（等价 `npx tsc --noEmit`，0 错）。
2. `test.run` 跑 `tests/rsi-iteration-gate.test.ts` 与 `tests/contract/rsi-exit-consistency.test.ts`，全绿。
3. 报告里写清：改了哪几个文件、每个文件改了什么、`app.ts` 从多少行到多少行、旧出口是否仍可用。

先读 `server/src/app.ts` 与 `server/src/controllers/rsi.controller.ts` 再动手。如果发现我描述的结构与实际不符，先说明差异再改，不要硬套。

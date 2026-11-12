# 任务（第 1 轮 / 共 2 轮）：后端 RSI 出口收敛

仓库根：`C:/Users/Admin/Desktop/新建文件夹 (2)`。工作区已提交（HEAD=54b58a6）。

**这一轮只改后端 4 个文件，不要读、不要改 `client/` 下任何文件**（前端在第 2 轮做）。

## 读什么（就这些，别扩展）

1. `C:/Users/Admin/Desktop/新建文件夹 (2)/server/src/app.ts`（约 316 行，可以整读）
2. `C:/Users/Admin/Desktop/新建文件夹 (2)/server/src/controllers/rsi.controller.ts`（约 169 行，整读）
3. `C:/Users/Admin/Desktop/新建文件夹 (2)/server/src/routes/rsi.routes.ts`（20 行，整读）

读完直接动手，不要为了「确认」再读第四遍。

## 改什么

### 1. `controllers/rsi.controller.ts`
新增两个方法，把 `app.ts` 里内联的两个 handler **原样搬过来**：

- `overview(req, res)` —— 对应 `GET /api/rsi/overview`。现有实现里那段「读迭代/归因/规则契约并拼装响应」的逻辑整体搬迁，**响应字段一个都不许改**，`Cache-Control: no-store` 保留。
- `rules(_req, res)` —— 对应 `GET /api/rsi/rules`。同样只做搬迁，仍调用 `buildRsiRulesContract()`。

搬的时候**注释跟着代码走**，尤其是解释「为什么要 no-store」「为什么两个出口要同源」的那几行，一行都不许删。

### 2. `routes/rsi.routes.ts`
新增两条：

```
router.get('/rsi/overview', (req, res) => controller.overview(req, res));
router.get('/rsi/rules', (_req, res) => controller.rules(_req, res));
```

注意顺序：`/rsi/overview` 与 `/rsi/rules` 是字面路径，要和已有的 `/rsi/contract` 等放在一起，**不要**放到 `/rsi/iterations/:id` 后面被当成 id 吃掉（文件里已有类似注释，照那个精神排）。

### 3. `app.ts`
- 删掉内联的那两大段 handler 实现（约 55 行）。
- 旧路径继续可用，但只留一行转发：`app.get('/api/rsi/overview', (req, res) => rsiController.overview(req, res));` 与 `/api/rsi/rules` 同理。
- `app.ts` 迁完必须**变短**。如果你的改动让它变长，说明搬错了地方。

### 4. 新增判据 `server/tests/contract/rsi-exit-consistency.test.ts`
只能新增这一个文件，**不得修改 `server/tests/` 下任何既有文件**。至少断言：

- `GET /api/v1/rsi/rules` 与 `GET /api/rsi/rules`：状态码相同、`cache-control` 都是 `no-store`、`JSON.stringify` 深度相等；
- `GET /api/v1/rsi/overview?session=<不存在的 uuid>` 与旧出口：都返回 404，且 `error.code` 一致；
- 读 `client/src/services/api.ts` 源文本，断言其中**不含** `/api/rsi/overview` 与 `/api/rsi/rules` 这两个字面量（防回归；第 2 轮改完后这条会转绿，现在允许先红，但请在文件里用 `it.todo` 或注释标明「第 2 轮启用」，不要留一个必然红的用例）。

测试怎么起服务：参考 `server/tests/rsi-rules-contract.test.ts` 里已有的做法（它已经在测 `/api/rsi/rules`），照抄它的 app 构造方式，不要自己发明。

## 硬约束

- **路径一律绝对路径**：沙箱把相对路径解析到 `server/workspace/`，用相对路径会写错地方。
- 不改 `package.json` / `tsconfig.json` / `vitest.config.*`，不跑 `npm install`。
- 单文件 ≤ 300 行。
- 不删任何解释设计动机的注释。

## 完成标准

1. `code.check` 通过（0 错）。
2. `test.run` 跑 `tests/rsi-rules-contract.test.ts` 与 `tests/contract/rsi-exit-consistency.test.ts` 全绿。
3. 报告里写：每个文件改了什么、`app.ts` 前后行数、旧出口是否仍可用。

如果实际结构与上面描述不符，先说明差异再改，不要硬套。

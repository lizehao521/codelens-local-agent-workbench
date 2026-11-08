# 内置工具能力清单

`BUILTIN_TOOLS`（`src/tools/builtin/index.ts`）是十个内置工具的唯一注册点，顺序即下表顺序。

| # | name | wireName | 类别 | 风险 | 审批模式 | 一句话用途 |
|---|------|----------|------|------|----------|------------|
| 1 | `httpRequestTool` | `http.request` | 网络 / 外部 IO | 高（SSRF、凭据外泄、数据外发） | 分级：`GET`/`HEAD` 直接执行；`POST`/`PUT`/`PATCH`/`DELETE` 需用户确认 | 向外部 HTTP/HTTPS 服务发起请求，经五重 SSRF 防护（协议白名单 → 拒绝凭据 → DNS 解析后逐条校验 → 只连已校验 IP → 手动重定向逐跳复检），响应体按字节截断。 |
| 2 | `fsReadTool` | `fs.read` | 文件系统（读） | 低（只读，路径受沙箱约束） | 直接执行 | 读取沙箱内文件内容，支持编码、行号窗口、关键字过滤与目录 glob。 |
| 3 | `fsWriteTool` | `fs.write` | 文件系统（写） | 中高（可破坏数据；`.git` 执行面被硬拒） | 分级：`create`/`append`/`rename` 直接执行；`overwrite`/`delete`/`purge` 需用户确认（soft 审批） | 在沙箱内新建 / 覆盖 / 追加 / 移动 / 删除文件，并拒绝写入 `.git/hooks` 与 `.git/config` 这类可被当作命令执行的路径。 |
| 4 | `fsListTool` | `fs.list` | 文件系统（读） | 低（只读，仅暴露目录结构） | 直接执行 | 列出沙箱内目录内容（名称 / 类型 / 大小），可选递归与条目上限。 |
| 5 | `calcEvaluateTool` | `calc.evaluate` | 计算 | 低（纯函数，无副作用） | 直接执行 | 计算数学表达式（含 sqrt/log/三角等函数与 pi/e 常量），同时给出十进制与指定进制结果。 |
| 6 | `timeNowTool` | `time.now` | 时间 | 低（纯查询） | 直接执行 | 获取当前日期时间，支持格式串、UTC/本地时区、日期偏移与指定时刻换算。 |
| 7 | `uuidGenerateTool` | `uuid.generate` | 生成 | 低（无副作用） | 直接执行 | 用密码学随机源批量生成 UUID v4（1–100 个）。 |
| 8 | `jsonFormatTool` | `json.format` | 数据处理 | 低（纯文本变换） | 直接执行 | 对 JSON 做美化 / 压缩 / 键排序 / 校验，并可用 JSON Pointer 提取子片段。 |
| 9 | `textDiffTool` | `text.diff` | 数据处理 | 低（纯文本变换） | 直接执行 | 逐行对比两段文本，输出 unified diff 与新增 / 删除统计。 |
| 10 | `sysExecTool` | `sys.exec` | 命令执行 | 最高（等价于在沙箱内执行代码） | 强管控：命令白名单 + 需用户确认（hard / two_step 档） | 在沙箱目录内以白名单命令执行程序，不经 shell（`|`、`&&`、`>` 均为字面字符），只收 `{ command, args[] }`，超时杀整个进程组，非 0 退出码仍算「命令执行成功」。 |

## 说明

- 风险与审批模式取自各工具源文件头部注释与工具 schema 描述；`sys.exec` 的 hard / two_step 审批档由 `fs-write.tool.ts` 中「绕过 sys.exec 的 hard/two_step」注释交叉印证。
- 本次按指令只读了 `index.ts` 与 3 个 `*.tool.ts` 的头部（共 4 个文件上限），其余 7 个工具的行为描述来自其运行时 schema，未逐行核对源码实现细节。

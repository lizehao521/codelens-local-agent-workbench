/**
 * MCP `command` 允许/拒绝判定（D-05）。
 *
 * spawn 走 shell:false（SDK stdio transport），因此 args 不会被 shell 解释；
 * 本模块关闭的是「把 cmd/powershell/bash 等解释器或 LOLBin 直接当 command」的经典 RCE 面。
 *
 * 诚实边界（C4 不外推）：受信任运行时（node/python/npx…）本身能通过 args 执行任意代码，
 * 命令白名单挡不住「受信任运行时 + 恶意 args」——那条属于 trust model（ADR-019：配置 MCP
 * 即授权本机用户权限，必须 UI 明示 + 导入时二次确认），不在本函数职责内。
 */

import path from 'node:path';

export interface McpCommandVerdict {
  ok: boolean;
  reason?: string;
}

// 允许经 PATH 解析的裸命令运行时（不含解释器 shell；python/node 是合法 MCP 运行时）。
const RUNNER_ALLOWLIST = new Set([
  'node', 'node.exe',
  'npx', 'npx.cmd', 'npx.exe',
  'uv', 'uv.exe', 'uvx', 'uvx.cmd', 'uvx.exe',
  'npm', 'npm.cmd', 'npm.exe',
  'pnpm', 'pnpm.cmd', 'pnpm.exe',
  'bun', 'bun.exe',
  'deno', 'deno.exe',
  'python', 'python.exe', 'python3', 'python3.exe',
]);

// 能执行任意代码的解释器 / Windows LOLBin / 下载原语。按 basename（小写）拒绝，
// 即使出现在绝对路径里也一样拒绝（如 C:\Windows\System32\cmd.exe）。
const INTERPRETER_DENYLIST = new Set([
  // shell
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'bash', 'bash.exe', 'sh', 'sh.exe', 'dash', 'dash.exe',
  'zsh', 'zsh.exe', 'fish', 'fish.exe', 'ksh', 'csh', 'tcsh',
  'wsl', 'wsl.exe', 'wslhost', 'wslhost.exe',
  // Windows script hosts / LOLBins
  'cscript', 'cscript.exe', 'wscript', 'wscript.exe', 'mshta', 'mshta.exe',
  'rundll32', 'rundll32.exe', 'regsvr32', 'regsvr32.exe',
  'certutil', 'certutil.exe', 'bitsadmin', 'bitsadmin.exe',
  // 下载/传输原语（shell:false 下不能直接执行，但作为纵深防御一并拒绝）
  'ftp', 'ftp.exe', 'telnet', 'telnet.exe', 'curl', 'curl.exe', 'wget', 'wget.exe',
]);

const COMMAND_RE = /^[A-Za-z0-9._\-\\/:]+$/;

export function isAllowedMcpCommand(command: string): McpCommandVerdict {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: 'command 不能为空' };
  if (!COMMAND_RE.test(trimmed)) {
    return { ok: false, reason: 'command 不允许包含 shell 元字符' };
  }

  const base = path.basename(trimmed).toLowerCase();
  if (INTERPRETER_DENYLIST.has(base)) {
    return { ok: false, reason: `command 不允许将解释器 ${base} 作为 MCP 服务命令` };
  }
  if (RUNNER_ALLOWLIST.has(base)) return { ok: true };

  // 绝对路径且 basename 未命中拒绝名单 → 允许自定义 MCP 服务端可执行文件。
  if (path.isAbsolute(trimmed)) return { ok: true };

  return { ok: false, reason: 'command 必须是受信任运行时（node/npx/uvx/python…）或可执行文件的绝对路径' };
}
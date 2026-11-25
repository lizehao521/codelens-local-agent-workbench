/**
 * rsi.exec — 免审批执行白名单命令，专供 RSI 自升级循环使用。
 * 复用 sys.exec 的 handler（不经 shell / path-jail / 杀进程树），
 * 只是 approvalMode=none，且白名单更窄、超时上限锁 60000。
 */
import { sysExecTool } from './sys-exec.tool.js';
import type { ToolDefinition, ToolOutcome } from '../../types/tool.js';

/** rsi.exec 自己的硬上限：inputSchema 的 maximum 只在网关层生效，handler 被直调时必须自己再拦一道。 */
export const RSI_EXEC_MAX_TIMEOUT_MS = 60000;
/** 比 sys.exec 更窄：自动化循环只需要这几条命令。 */
const RSI_ALLOWLIST = new Set(['node', 'npm', 'npx', 'git', 'tsc', 'vitest']);

export const rsiExecTool: ToolDefinition = {
  ...sysExecTool,
  name: 'rsi.exec',
  wireName: 'rsi_exec',
  displayName: 'RSI 命令执行（免审批）',
  description: '在沙箱内执行白名单命令（node/npm/npx/git/tsc/vitest），免人工审批，仅供自动化循环使用。超时上限 60000ms。',
  approvalMode: 'none',
  risk: 'medium',
  timeoutMs: 60000,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '逻辑命令名（basename），如 node / npx / npm / git / tsc / vitest', maxLength: 64 },
      args: { type: 'array', description: '按字面传递的参数数组', items: { type: 'string', maxLength: 4096 }, maxItems: 64 },
      cwd: { type: 'string', description: '沙箱内相对工作目录', maxLength: 512 },
      timeoutMs: { type: 'number', description: '超时（ms），硬上限 60000', minimum: 1, maximum: 60000 },
    },
    required: ['command'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolOutcome> => {
    // 1) timeoutMs 硬上限：直调 handler 时网关的 inputSchema.maximum 不生效，这里必须自己拦。
    if (args.timeoutMs !== undefined && Number(args.timeoutMs) > RSI_EXEC_MAX_TIMEOUT_MS) {
      return {
        ok: false,
        summary: `timeoutMs 超过 rsi.exec 硬上限 ${RSI_EXEC_MAX_TIMEOUT_MS}ms`,
        error: {
          code: 'TOOL_INVALID_ARGS',
          kind: 'invalid_args',
          message: `timeoutMs=${args.timeoutMs} 超过上限 ${RSI_EXEC_MAX_TIMEOUT_MS}`,
          retryable: false,
        },
      };
    }
    // 2) 收窄白名单：sys.exec 允许的命令集比自动化循环需要的宽，这里只放行 RSI_ALLOWLIST。
    const command = String(args.command ?? '');
    if (command && !RSI_ALLOWLIST.has(command)) {
      return {
        ok: false,
        summary: `命令 ${command} 不在 rsi.exec 白名单`,
        error: {
          code: 'TOOL_SECURITY_DENIED',
          kind: 'security',
          message: `命令 ${command} 不在 rsi.exec 白名单（${[...RSI_ALLOWLIST].join('/')}）`,
          retryable: false,
        },
      };
    }
    // 3) 其余（path-jail / 不经 shell / 杀进程树）复用 sys.exec 的安全 handler。
    return sysExecTool.handler!(args, ctx);
  },
};
/**
 * Security gateway — the SINGLE policy decision point (architecture 10.0).
 * Every tool call passes through here before execution: schema validation,
 * sandbox path checks, SSRF pre-checks, and the runtime risk verdict that may
 * escalate the baseline (e.g. POST is high/hard, GET is low/none). The verdict
 * travels with the tool_call SSE event; the frontend never infers risk (C-5).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolDefinition, RiskVerdict } from '../../types/tool.js';
import { resolveInSandbox } from '../../tools/builtin/path-jail.js';
import { evaluateExecCommand, execRequiresTwoStep } from '../../tools/builtin/sys-exec.policy.js';
import { inspectUrl } from '../../utils/ssrf-guard.js';
import { compileInputSchema, validateArgs } from './schema-validator.js';
import type { AutoApproveConfig } from './sandbox-permission.js';
import { buildEffectPreview } from './effect-preview.js';
import { isSensitivePath } from './sensitive-path.js';

export type GatewayVerdict =
  | { ok: true; verdict: RiskVerdict; args: Record<string, unknown> }
  | { ok: false; code: 'INVALID_ARGS' | 'SECURITY_DENIED'; message: string; issues?: Array<{ path: string; message: string }> };

export interface GatewayContext {
  sandboxRoot: string;
  /** 沙箱外允许目录（白名单，已校验 + realpath 的绝对目录）。传入时允许这些目录内的绝对/相对路径。 */
  allowedDirs?: string[];
  /** 自动放行配置：仅影响审批档（approvalMode），绝不绕过 jail/SSRF 硬拒绝。 */
  exemptions?: AutoApproveConfig;
  /** 写前快照是否启用：决定 overwrite 是否标为可恢复。 */
  checkpointEnabled?: boolean;
}

const HTTP_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FS_DELETE_OPERATIONS = new Set(['delete']);
// 清空目录内容（保留目录本身）属于批量销毁，需两步确认（two_step）。
const FS_PURGE_OPERATIONS = new Set(['purge']);

/**
 * Runtime risk upgrade table (architecture 7.4.2 — locked).
 * fs.write needs filesystem facts, so `fileExists` is injected.
 */
export function assessRisk(
  def: ToolDefinition,
  args: Record<string, unknown>,
  ctx: GatewayContext,
): RiskVerdict {
  const baseline: RiskVerdict = { risk: def.risk, approvalMode: def.approvalMode };

  if (def.name === 'http.request') {
    const method = args.method === undefined ? 'GET' : String(args.method).toUpperCase();
    if (HTTP_WRITE_METHODS.has(method)) {
      return { risk: 'high', approvalMode: 'hard', reason: `${method} 请求会改变外部状态` };
    }
    return { risk: 'low', approvalMode: 'none' };
  }

  if (def.name === 'fs.write') {
    const operation = String(args.operation ?? '');
    const jail = resolveInSandbox(ctx.sandboxRoot, String(args.path ?? ''), true, ctx.allowedDirs);
    const targetExists = jail.ok && existsSync(jail.absolutePath);

    if (FS_PURGE_OPERATIONS.has(operation)) {
      // 清空目录内容（保留目录）属于批量销毁，需两步确认。
      // 沙箱根会被 path-jail 拒绝（forWrite 时相对路径为空），故 purge 根不可达。
      return { risk: 'high', approvalMode: 'two_step', reason: '清空目录内容属于批量销毁，需要两步确认' };
    }
    if (FS_DELETE_OPERATIONS.has(operation)) {
      // 删除操作一律 high/hard。说明：写入沙箱根本身已被 path-jail 拒绝
      // （path-jail.ts:80-85，forWrite 时 relative==='' 直接 ok:false），
      // 故「删除沙箱根」不会先到此处。two_step 审批档现已由 purge（清空目录）真实触达，
      // 由 executor.service.ts:111 的 TWO_STEP_PASSES 进行两步确认。
      return { risk: 'high', approvalMode: 'hard', reason: '删除操作不可逆' };
    }
    if (operation === 'overwrite') {
      if (targetExists) {
        return { risk: 'high', approvalMode: 'hard', reason: '覆盖已有文件不可逆，需要确认' };
      }
      return { risk: 'medium', approvalMode: 'soft', reason: '写入新文件' };
    }
    if (operation === 'rename' || operation === 'append') {
      return { risk: 'medium', approvalMode: 'soft', reason: '文件变更操作' };
    }
    if (operation === 'create') {
      if (targetExists) {
        return { risk: 'high', approvalMode: 'hard', reason: '目标已存在，create 不覆盖' };
      }
      return { risk: 'medium', approvalMode: 'soft', reason: '创建新文件' };
    }
    return baseline;
  }

  if (def.name === 'sys.exec') {
    // 常量基线：sys.exec 的「是否高危 / 要不要审批」绝不根据 args 决定。
    // 参数驱动的升级表在重构时极容易被反过来读成「降级入口」
    // （加一个 `if (command === 'git') return low/none` 就全线沦陷），
    // 所以这里只有两个可能值：hard、two_step —— 单向升级，无降级分支。
    const command = String(args.command ?? '');
    const execArgs = Array.isArray(args.args) ? args.args.map((value) => String(value)) : [];
    if (execRequiresTwoStep(command, execArgs)) {
      return {
        risk: 'high',
        approvalMode: 'two_step',
        reason:
          command.trim().toLowerCase() === 'node'
            ? '执行 node 等同于允许 Agent 运行任意代码，需要两步确认'
            : '该 git 子命令会重写历史或丢弃工作区改动，需要两步确认',
      };
    }
    return { risk: 'high', approvalMode: 'hard', reason: '命令执行可以改变宿主机状态' };
  }

  if (def.source === 'mcp') {
    // P2-1: the baseline IS the verdict. MCP risk is graded once in the adapter
    // from the server's annotations (readOnly → low/none, destructive →
    // high/hard, plain write → medium/soft); re-escalating every MCP call to
    // high/hard here is what caused blanket approval fatigue (AC-03).
    return baseline;
  }

  return baseline;
}

/** 判定绝对路径是否在工作区之外（用于「白名单目录里的敏感路径」兜底）。 */
function outsideSandbox(sandboxRoot: string, absolutePath: string): boolean {
  const rel = path.relative(path.resolve(sandboxRoot), absolutePath);
  return rel.startsWith('..') || path.isAbsolute(rel);
}

/**
 * Full pre-execution gate: schema → sandbox → network. The executor calls this
 * exactly once per attempt; revise paths call it again with the new arguments.
 */
export function runGateway(def: ToolDefinition, args: Record<string, unknown>, ctx: GatewayContext): GatewayVerdict {
  const compiled = compileInputSchema(def.inputSchema);
  const validated = validateArgs(compiled, args);
  if (!validated.ok) {
    return {
      ok: false,
      code: 'INVALID_ARGS',
      message: `参数不合法：${validated.issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`,
      issues: validated.issues,
    };
  }
  const data = validated.data;

  // Filesystem tools: path jail runs even for reads (defense in depth).
  if (def.category === 'file' && typeof data.path === 'string') {
    const jail = resolveInSandbox(ctx.sandboxRoot, data.path, def.name === 'fs.write', ctx.allowedDirs);
    if (!jail.ok) {
      return { ok: false, code: 'SECURITY_DENIED', message: jail.message };
    }
    // 目录授权 ≠ 交出秘密：白名单目录里的凭证/密钥路径仍然拒绝。
    // 只在「工作区之外」生效，工作区里的 .env 是项目自身配置，允许 Agent 修改。
    if (outsideSandbox(ctx.sandboxRoot, jail.absolutePath) && isSensitivePath(jail.absolutePath)) {
      return { ok: false, code: 'SECURITY_DENIED', message: `敏感路径（凭证/密钥/浏览器配置）拒绝访问：${jail.absolutePath}` };
    }
  }

  // HTTP tools: syntactic SSRF pre-check (DNS re-check happens inside the tool).
  if (def.name === 'http.request' && typeof data.url === 'string') {
    const verdict = inspectUrl(data.url);
    if (!verdict.ok) {
      return { ok: false, code: 'SECURITY_DENIED', message: verdict.message ?? '目标被安全策略拒绝' };
    }
  }

  // Command execution: 静态形态拦截（白名单 + 解释器兜底拒绝）。
  // 放在这里而不是只放在 handler 里，是因为 gateway 是「执行前总闸」：
  // 被拒的调用连进程都不该被 spawn 出来（工具本体还会再查一次，纵深）。
  if (def.name === 'sys.exec') {
    const command = String(data.command ?? '');
    const execArgs = Array.isArray(data.args) ? data.args.map((value) => String(value)) : [];
    const check = evaluateExecCommand(command, execArgs);
    if (!check.ok) {
      return { ok: false, code: check.code, message: check.message };
    }
    // cwd 也要在闸门内先判一次：越界的 cwd 连 handler 都不该进。
    // forWrite=false —— cwd 是「进入的目录」，允许沙箱根本身（relative==='' 时 jail 放行）。
    if (typeof data.cwd === 'string') {
      const cwdJail = resolveInSandbox(ctx.sandboxRoot, data.cwd, false, ctx.allowedDirs);
      if (!cwdJail.ok) {
        return { ok: false, code: 'SECURITY_DENIED', message: `工作目录被沙箱策略拒绝：${cwdJail.message}` };
      }
      if (outsideSandbox(ctx.sandboxRoot, cwdJail.absolutePath) && isSensitivePath(cwdJail.absolutePath)) {
        return { ok: false, code: 'SECURITY_DENIED', message: `敏感目录（凭证/密钥/浏览器配置）拒绝进入：${cwdJail.absolutePath}` };
      }
    }
  }

  const verdict = applyExemptions(def, data, assessRisk(def, data, ctx), ctx.exemptions);
  // fail-closed 兜底断言：任何时候 sys.exec 落到 none 都按拒绝处理。
  // 这行是给「未来的重构者」写的：豁免逻辑再怎么改，exec 也不可能被静默放行。
  if (def.name === 'sys.exec' && verdict.approvalMode === 'none') {
    return { ok: false, code: 'SECURITY_DENIED', message: '命令执行工具不允许免审批执行（安全策略兜底拒绝）' };
  }
  // 后果预览：审批/结果卡的主视图。豁免后的 none 不需要预览；
  // hard/two_step 与可逆写操作都带上，供前端按可逆性分流。
  const effect =
    verdict.approvalMode === 'none' && def.name !== 'fs.write'
      ? null
      : buildEffectPreview(def, data, ctx, verdict);
  return { ok: true, verdict: effect ? { ...verdict, effect } : verdict, args: data };
}

/**
 * 豁免：把被豁免的高危操作 approvalMode 降级为 none（不再弹审批条）。
 * 仅当 verdict 本就需要审批时生效；jail/SSRF 的 SECURITY_DENIED 在此之前已由 runGateway 拦截，
 * 不会被豁免绕过（越界与危险 URL 仍被拒绝）。
 */
function applyExemptions(
  def: ToolDefinition,
  args: Record<string, unknown>,
  verdict: RiskVerdict,
  exemptions?: AutoApproveConfig,
): RiskVerdict {
  if (!exemptions || verdict.approvalMode === 'none') return verdict;
  const category = exemptCategory(def.name, args);
  if (category && exemptions[category]) {
    return { ...verdict, approvalMode: 'none', reason: `${verdict.reason ?? ''}（已按沙箱权限配置自动放行）`.trim() };
  }
  return verdict;
}

/**
 * 判定操作所属的高危类别（对应 AutoApproveConfig 的键）。
 * 参数是工具名而非 ToolDefinition：它只是「名字 → 类别」的映射，导出给判据/测试锁定。
 */
export function exemptCategory(toolName: string, args: Record<string, unknown> = {}): 'fsDestructive' | 'purge' | 'httpWrite' | null {
  // 硬约束：sys.exec 永不返回豁免类别 —— 自动放行配置在**结构上**无法豁免它。
  // 禁止为 exec 新增豁免键（AutoApproveConfig 只允许 fsDestructive / purge / httpWrite）。
  // 理由：exec 的语义是「启动任意程序」，不存在「这一类可以少看一眼」的细分，
  // 任何豁免键都等于一次点击换来永久 RCE。
  if (toolName === 'sys.exec') return null;
  if (toolName === 'fs.write') {
    const op = String(args.operation ?? '');
    if (FS_PURGE_OPERATIONS.has(op)) return 'purge';
    if (FS_DELETE_OPERATIONS.has(op) || op === 'overwrite') return 'fsDestructive';
  }
  if (toolName === 'http.request') {
    const method = args.method === undefined ? 'GET' : String(args.method).toUpperCase();
    if (HTTP_WRITE_METHODS.has(method)) return 'httpWrite';
  }
  return null;
}

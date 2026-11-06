/**
 * Call resolver: turns one turn's ToolCallIR list into executable items.
 * Handles the four pre-execution outcomes that must NOT consume retry budget
 * (AC-08): hallucinated tool names, disabled tools, invalid arguments, and
 * security denials — each still gets an audit row and SSE events so the
 * timeline stays complete, plus a synthetic observation fed back to the LLM.
 */

import path from 'node:path';
import type { ToolDefinition } from '../../types/tool.js';
import type { ToolCallRow } from '../memory/tool-call.repository.js';
import type { ToolCallRepository } from '../memory/tool-call.repository.js';
import type { ToolRegistry } from '../tools/registry.service.js';
import type { ExecuteItemInput } from '../tools/executor.service.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { runGateway } from '../tools/security-gateway.js';
import type { AutoApproveConfig } from '../tools/sandbox-permission.js';
import type { SandboxGrantService } from '../tools/sandbox-grant.service.js';
import { isSensitivePath } from '../tools/sensitive-path.js';
import type { SseWriter } from './sse-writer.js';
import type { ToolCallIR } from './turn-ir.js';
import { argsDigest } from '../../utils/digest.js';
import { resolveCanonical } from '../../utils/tool-name.js';
import { toolNotFoundObservation } from './system-prompt.js';

export interface ResolvedCall {
  items: ExecuteItemInput[];
  /** Synthetic outcomes for calls that never reached the executor. */
  feedback: Array<{ callId: string; toolName: string; observation: string; errorKind: string }>;
  /** Tools blocked by the circuit breaker this turn (synthesized results). */
  circuitBlocked: string[];
}

export interface ResolverDeps {
  registry: ToolRegistry;
  toolCalls: ToolCallRepository;
  sse: SseWriter;
  sandboxRoot: string;
  /** 沙箱外允许目录（白名单）。传入时允许这些目录内的绝对/相对路径。 */
  allowedDirs: string[];
  /** 审批豁免配置（仅降级 approvalMode，绝不绕过 jail/SSRF 硬拒绝）。 */
  exemptions?: AutoApproveConfig;
  /** 写前快照是否启用：决定 overwrite 是否标为可恢复。 */
  checkpointEnabled?: boolean;
  /** 工作区外按目录授权：首次越界访问弹一次，记住后并入 allowedDirs。 */
  grants?: SandboxGrantService;
  reverseIndex: ReadonlyMap<string, string>;
  breaker: CircuitBreaker;
}

export class CallResolver {
  constructor(private readonly deps: ResolverDeps) {}

  async resolve(calls: ToolCallIR[], sessionId: string, messageId: string | null, iteration: number, channel: 'native' | 'react'): Promise<ResolvedCall> {
    const items: ExecuteItemInput[] = [];
    const feedback: ResolvedCall['feedback'] = [];
    const circuitBlocked: string[] = [];
    const available = this.deps.registry.canonicalNames();

    for (const call of calls) {
      // ── unparseable arguments (stream cut mid-JSON) ────────────────────────
      if (call.parseError === 'INVALID_JSON') {
        const row = this.deps.toolCalls.insert({
          sessionId,
          messageId,
          callId: call.id,
          toolName: call.name || '(unknown)',
          toolWireName: call.name || 'unknown',
          displayName: call.name || '未知调用',
          category: 'compute',
          source: 'builtin',
          risk: 'low',
          approvalMode: 'none',
          channel,
          iteration,
          argsJson: call.rawArguments || '{}',
          argsDigest: argsDigest({}),
        });
        this.deps.toolCalls.markFinished(row.id, {
          status: 'failed',
          errorKind: 'invalid_args',
          errorMsg: '工具调用的参数 JSON 不完整',
        });
        this.deps.sse.emit('tool_call', {
          callId: row.call_id,
          name: row.tool_name,
          displayName: row.display_name,
          category: 'compute',
          arguments: {},
          risk: 'low',
          approvalMode: 'none',
          source: 'builtin',
          iteration,
          status: 'pending',
        });
        this.deps.sse.emit('tool_result', {
          callId: row.call_id,
          name: row.tool_name,
          status: 'failed',
          summary: '工具调用的参数 JSON 不完整',
          data: null,
          truncated: false,
          durationMs: 0,
          resultId: '',
          error: {
            code: 'TOOL_ARGS_INVALID',
            kind: 'invalid_args',
            message: '上游返回的工具调用参数 JSON 不完整，无法解析',
            retryable: false,
          },
        });
        feedback.push({
          callId: row.call_id,
          toolName: row.tool_name,
          observation: `工具调用失败：参数 JSON 不完整（${call.rawArguments.slice(0, 80)}），请重新发起调用并提供完整参数。`,
          errorKind: 'invalid_args',
        });
        continue;
      }

      // ── hallucinated tool name: no budget consumption (AC-08) ──────────────
      const canonical = resolveCanonical(this.deps.reverseIndex, call.name);
      if (!canonical) {
        const row = this.insertSynthetic(sessionId, messageId, call, iteration, channel, 'not_found', `工具 "${call.name}" 不存在`);
        this.deps.sse.emit('tool_call', {
          callId: row.call_id,
          name: call.name,
          displayName: call.name,
          category: 'compute',
          arguments: call.arguments,
          risk: 'low',
          approvalMode: 'none',
          source: 'builtin',
          iteration,
          status: 'pending',
        });
        this.deps.sse.emit('tool_result', {
          callId: row.call_id,
          name: call.name,
          status: 'failed',
          summary: `工具 ${call.name} 不存在`,
          data: null,
          truncated: false,
          durationMs: 0,
          resultId: '',
          error: {
            code: 'TOOL_NOT_FOUND',
            kind: 'not_found',
            message: `工具 "${call.name}" 不在注册表中`,
            retryable: false,
          },
        });
        feedback.push({
          callId: row.call_id,
          toolName: call.name,
          observation: toolNotFoundObservation(call.name, available),
          errorKind: 'not_found',
        });
        continue;
      }

      const def = this.deps.registry.get(canonical);
      if (!def) {
        const row = this.insertSynthetic(sessionId, messageId, call, iteration, channel, 'not_found', `工具 ${canonical} 不可用`);
        feedback.push({
          callId: row.call_id,
          toolName: canonical,
          observation: toolNotFoundObservation(canonical, available),
          errorKind: 'not_found',
        });
        continue;
      }

      // ── disabled tool ──────────────────────────────────────────────────────
      const enableCtx = { sandboxRoot: this.deps.sandboxRoot, mcpConnected: false };
      if (!this.deps.registry.isEnabled(def, enableCtx)) {
        const row = this.insertSynthetic(sessionId, messageId, call, iteration, channel, 'not_found', `工具 ${canonical} 已禁用`, canonical);
        this.deps.sse.emit('tool_result', {
          callId: row.call_id,
          name: canonical,
          status: 'failed',
          summary: `工具 ${canonical} 已被禁用`,
          data: null,
          truncated: false,
          durationMs: 0,
          resultId: '',
          error: {
            code: 'TOOL_DISABLED',
            kind: 'not_found',
            message: `工具 ${canonical} 已被用户禁用`,
            retryable: false,
          },
        });
        feedback.push({
          callId: row.call_id,
          toolName: canonical,
          observation: `工具 ${canonical} 已被禁用，请换用其它工具或告诉用户如何开启。`,
          errorKind: 'not_found',
        });
        continue;
      }

      // ── gateway: schema + sandbox + SSRF + runtime risk ────────────────────
      // allowedDirs 每次现取：用户在本次 run 中新授权的目录必须立即生效。
      const allowedDirs = [...this.deps.allowedDirs, ...(this.deps.grants?.activeDirs() ?? [])];
      let gate = runGateway(def, call.arguments, {
        sandboxRoot: this.deps.sandboxRoot,
        allowedDirs,
        exemptions: this.deps.exemptions,
        checkpointEnabled: this.deps.checkpointEnabled,
      });
      // 工作区外首次访问：不直接判死，弹一次目录授权；允许后重跑闸门。
      // 只对「绝对路径」开放这条路径：`..` 穿越永远不弹授权（它是攻击面，不是需求）。
      if (!gate.ok && gate.code === 'SECURITY_DENIED' && this.deps.grants) {
        const targetDir = this.grantTarget(def, call.arguments);
        if (targetDir && !isSensitivePath(targetDir)) {
          const decision = await this.deps.grants.requireGrant(
            sessionId,
            targetDir,
            (req) =>
              this.deps.sse.emit('sandbox_grant_required', {
                requestId: req.grantId,
                dir: req.dir,
                sensitive: req.sensitive,
                reason: `工作区外目录首次访问：${req.dir}`,
                expiresAt: req.expiresAt,
              }),
          );
          if (decision === 'allow') {
            gate = runGateway(def, call.arguments, {
              sandboxRoot: this.deps.sandboxRoot,
              allowedDirs: [...this.deps.allowedDirs, ...this.deps.grants.activeDirs()],
              exemptions: this.deps.exemptions,
              checkpointEnabled: this.deps.checkpointEnabled,
            });
          }
        }
      }
      if (!gate.ok) {
        const kind = gate.code === 'SECURITY_DENIED' ? 'security' : 'invalid_args';
        const row = this.insertSynthetic(
          sessionId,
          messageId,
          call,
          iteration,
          channel,
          kind,
          gate.message,
          canonical,
          def.displayName,
          def.category,
          def.source,
        );
        this.deps.sse.emit('tool_call', {
          callId: row.call_id,
          name: canonical,
          displayName: def.displayName,
          category: def.category,
          arguments: call.arguments,
          risk: def.risk,
          approvalMode: def.approvalMode,
          source: def.source,
          iteration,
          status: 'pending',
        });
        this.deps.sse.emit('tool_result', {
          callId: row.call_id,
          name: canonical,
          status: 'failed',
          summary: gate.message,
          data: null,
          truncated: false,
          durationMs: 0,
          resultId: '',
          error: {
            code: kind === 'security' ? 'TOOL_SECURITY_DENIED' : 'TOOL_INVALID_ARGS',
            kind,
            message: gate.message,
            retryable: false,
          },
        });
        feedback.push({
          callId: row.call_id,
          toolName: canonical,
          observation:
            kind === 'security'
              ? `工具 ${canonical} 被安全策略拒绝：${gate.message}。同一目标在本任务内不要重试。`
              : `工具 ${canonical} 参数不合法：${gate.message}。请修正参数后重试。`,
          errorKind: kind,
        });
        continue;
      }

      const digest = argsDigest(gate.args);

      // ── circuit breaker: 4th call returns without executing (AC-08) ─────────
      const circuit = this.deps.breaker.check(canonical);
      if (circuit.open) {
        circuitBlocked.push(canonical);
        const row = this.deps.toolCalls.insert({
          sessionId,
          messageId,
          callId: call.id,
          toolName: canonical,
          toolWireName: def.wireName,
          displayName: def.displayName,
          category: def.category,
          source: def.source,
          risk: gate.verdict.risk,
          approvalMode: gate.verdict.approvalMode,
          channel,
          iteration,
          argsJson: JSON.stringify(gate.args),
          argsDigest: digest,
        });
        this.deps.toolCalls.markFinished(row.id, {
          status: 'failed',
          errorKind: 'circuit_open',
          errorMsg: circuit.message,
        });
        this.deps.sse.emit('tool_call', {
          callId: row.call_id,
          name: canonical,
          displayName: def.displayName,
          category: def.category,
          arguments: gate.args,
          risk: gate.verdict.risk,
          approvalMode: gate.verdict.approvalMode,
          source: def.source,
          iteration,
          status: 'pending',
        });
        this.deps.sse.emit('tool_result', {
          callId: row.call_id,
          name: canonical,
          status: 'failed',
          summary: circuit.message,
          data: null,
          truncated: false,
          durationMs: 0,
          resultId: '',
          error: {
            code: 'TOOL_CIRCUIT_OPEN',
            kind: 'circuit_open',
            message: circuit.message,
            retryable: false,
          },
        });
        feedback.push({
          callId: row.call_id,
          toolName: canonical,
          observation: `工具 ${canonical} 已熔断：${circuit.message}请更换工具或调整参数。`,
          errorKind: 'circuit_open',
        });
        continue;
      }

      const row = this.deps.toolCalls.insert({
        sessionId,
        messageId,
        callId: call.id,
        toolName: canonical,
        toolWireName: def.wireName,
        displayName: def.displayName,
        category: def.category,
        source: def.source,
        risk: gate.verdict.risk,
        approvalMode: gate.verdict.approvalMode,
        channel,
        iteration,
        argsJson: JSON.stringify(gate.args),
        argsDigest: digest,
      });
      this.deps.sse.emit('tool_call', {
        callId: row.call_id,
        name: canonical,
        displayName: def.displayName,
        category: def.category,
        arguments: gate.args,
        risk: gate.verdict.risk,
        approvalMode: gate.verdict.approvalMode,
        source: def.source,
        iteration,
        status: 'pending',
      });
      items.push({
        toolCall: row,
        definition: def,
        args: gate.args,
        digest,
        verdict: gate.verdict,
        channel,
        iteration,
      });
    }
    return { items, feedback, circuitBlocked };
  }

  /**
   * 从调用参数里推出「工作区外的绝对目录」——只有它能成为授权对象。
   *
   * 返回 null 的情形（一律不弹授权）：
   * - 相对路径（可能只是沙箱内写错，也避免把相对路径当目录）；
   * - 含 `..` 段（穿越是攻击面）；
   * - 无路径参数（http / mcp 等）。
   */
  private grantTarget(def: ToolDefinition, args: Record<string, unknown>): string | null {
    const raw = def.name === 'sys.exec' ? args.cwd : args.path;
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const candidate = raw.trim();
    const segments = candidate.split(/[/\\]+/);
    if (segments.some((s) => s === '..')) return null;
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\') || candidate.startsWith('/');
    if (!isAbsolute) return null;
    if (def.name === 'sys.exec') return candidate;
    // purge 点名的是目录本身；其余文件操作授权其父目录。
    return String(args.operation ?? '') === 'purge' ? candidate : path.dirname(candidate);
  }

  private insertSynthetic(
    sessionId: string,
    messageId: string | null,
    call: ToolCallIR,
    iteration: number,
    channel: 'native' | 'react',
    errorKind: string,
    errorMsg: string,
    canonicalName?: string,
    displayName?: string,
    category?: 'http' | 'file' | 'compute' | 'mcp',
    source?: 'builtin' | 'mcp',
  ): ToolCallRow {
    const row = this.deps.toolCalls.insert({
      sessionId,
      messageId,
      callId: call.id,
      toolName: canonicalName ?? call.name,
      toolWireName: call.name,
      displayName: displayName ?? call.name,
      category: category ?? 'compute',
      source: source ?? 'builtin',
      risk: 'low',
      approvalMode: 'none',
      channel,
      iteration,
      argsJson: JSON.stringify(call.arguments),
      argsDigest: argsDigest(call.arguments),
    });
    this.deps.toolCalls.markFinished(row.id, { status: 'failed', errorKind, errorMsg });
    return row;
  }
}

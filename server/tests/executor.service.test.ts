/**
 * Tool executor — P2-3 result checksums + P2-6 consumed-successor guard.
 *
 *   P2-3 — `tool_results.sha256` shipped hardwired to null at both insert
 *          points, so the audit chain had no integrity check. Both the
 *          success and failure rows now carry sha256(serialized payload);
 *          payload-less results stay null.
 *   P2-6 — when the approved pending row vanished (consumed by a concurrent
 *          path), executeOne used to return null and the call's observation
 *          was dropped while its assistant message still carried the
 *          tool_calls entry — the next turn would go upstream with an
 *          orphaned call (HTTP 400). It now synthesizes a failure outcome.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolExecutor, type ExecuteItemInput, type ExecutionOutcome } from '../src/services/tools/executor.service.js';
import type { ToolCallRow } from '../src/services/memory/tool-call.repository.js';
import type { ToolResultRow } from '../src/services/memory/tool-result.repository.js';
import type { ApprovalService } from '../src/services/agent/approval.service.js';
import type { SseWriter } from '../src/services/agent/sse-writer.js';
import type { ToolDefinition, ToolOutcome, RiskVerdict } from '../src/types/tool.js';
import { argsDigest } from '../src/utils/digest.js';

interface FakeEvent {
  name: string;
  data: any;
}

interface InsertedResult {
  toolCallId: string;
  inlinePreview: string | null;
  artifactPath: string | null;
  bytes: number;
  truncated: boolean;
  sha256: string | null;
}

let sandboxRoot: string;

beforeEach(() => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), 'codelens-exec-'));
});

afterEach(() => {
  // 宿主环境的删除守卫（safe-delete shim）可能在并发下超时。
  // 清理是 best-effort：残留目录由环境侧回收，但不能让它把已通过的用例判红。
  try {
    rmSync(sandboxRoot, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
  }
});

function fakeSse(events: FakeEvent[]): SseWriter {
  return {
    emit: (name: string, data: unknown) => {
      events.push({ name, data });
    },
  } as unknown as SseWriter;
}

function toolDef(handler: (args: Record<string, unknown>) => Promise<ToolOutcome>): ToolDefinition {
  return {
    name: 'fs.write',
    wireName: 'fs_write',
    displayName: '写入文件',
    category: 'file',
    description: 'test tool',
    inputSchema: { type: 'object' },
    handler: (args) => handler(args),
    timeoutMs: 5000,
    risk: 'medium',
    approvalMode: 'soft',
    enabled: () => true,
    source: 'builtin',
    idempotent: true,
    maxResultChars: 100_000,
  };
}

function toolCallRow(callId: string, status: ToolCallRow['status'] = 'pending'): ToolCallRow {
  return {
    id: `tc_${callId}`,
    session_id: 'sess_1',
    message_id: 'msg_1',
    call_id: callId,
    tool_name: 'fs.write',
    tool_wire_name: 'fs_write',
    display_name: '写入文件',
    category: 'file',
    source: 'builtin',
    risk: 'medium',
    approval_mode: 'soft',
    channel: 'native',
    iteration: 1,
    args_json: '{"path":"a.txt"}',
    args_digest: argsDigest({ path: 'a.txt' }),
    status,
    error_kind: null,
    error_msg: null,
    result_ref: null,
    result_summary: null,
    truncated: 0,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    created_at: Date.now(),
  } as unknown as ToolCallRow;
}

interface Harness {
  executor: ToolExecutor;
  events: FakeEvent[];
  inserted: InsertedResult[];
  run: (item: Partial<ExecuteItemInput> & { toolCall: ToolCallRow; definition: ToolDefinition }) => Promise<ExecutionOutcome | null>;
}

function harness(opts: {
  approvalDecision?: 'allow_once' | 'reject';
  verdict?: RiskVerdict;
  canRetry?: boolean;
}): Harness {
  const events: FakeEvent[] = [];
  const inserted: InsertedResult[] = [];
  const rows: ToolCallRow[] = [];

  const toolCalls = {
    insert: (row: ToolCallRow) => {
      rows.push(row);
      return row;
    },
    listBySession: () => rows,
    markRunning: () => undefined,
    markFinished: (id: string, patch: Partial<ToolCallRow>) => {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
    },
  };
  const toolResults = {
    insert: (fields: InsertedResult): ToolResultRow => {
      inserted.push(fields);
      return { id: `tr_${inserted.length}`, created_at: Date.now(), ...fields } as ToolResultRow;
    },
  };
  const approvals = {
    hasSessionGrant: () => false,
    requestApproval: async () => opts.approvalDecision ?? 'allow_once',
  };

  const executor = new ToolExecutor({
    toolCalls: toolCalls as never,
    toolResults: toolResults as never,
    approvals: approvals as unknown as ApprovalService,
    sse: fakeSse(events),
    sandboxRoot,
    canRetry: () => opts.canRetry ?? false,
    onRetryConsumed: () => undefined,
  });

  return {
    executor,
    events,
    inserted,
    run: async (item) => {
      rows.push(item.toolCall);
      const outcomes = await executor.executeBatch([
        {
          args: {},
          digest: argsDigest({}),
          verdict: opts.verdict ?? { risk: 'low', approvalMode: 'none' },
          channel: 'native',
          iteration: 1,
          ...item,
        } as ExecuteItemInput,
      ]);
      return outcomes.get(item.toolCall.call_id) ?? null;
    },
  };
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('ToolExecutor: P2-3 result checksums', () => {
  it('success rows carry sha256(serialized payload) instead of null', async () => {
    const definition = toolDef(async () => ({ ok: true, summary: '写入成功', data: { hello: 'world' } }));
    const h = harness({});

    const outcome = await h.run({ toolCall: toolCallRow('call_ok'), definition });

    expect(outcome?.status).toBe('success');
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0].sha256).toBe(sha256Of(JSON.stringify({ hello: 'world' })));
    expect(h.inserted[0].bytes).toBe(Buffer.byteLength(JSON.stringify({ hello: 'world' })));
    expect(h.inserted[0].inlinePreview).toBe(JSON.stringify({ hello: 'world' }));
  });

  it('truncated results hash the FULL payload while the preview stays at 4000 chars', async () => {
    const big = { blob: 'x'.repeat(6000) };
    const serialized = JSON.stringify(big);
    expect(serialized.length).toBeGreaterThan(4000);
    const definition = toolDef(async () => ({ ok: true, summary: '大结果', data: big }));
    const h = harness({});
    const outcome = await h.run({ toolCall: toolCallRow('call_big'), definition });

    expect(outcome?.status).toBe('success');
    const row = h.inserted[0];
    expect(row.truncated).toBe(true);
    expect(row.inlinePreview).toHaveLength(4000);
    // The checksum covers everything, not just the inline slice — that is the
    // point of verifying the artifact against the row.
    expect(row.sha256).toBe(sha256Of(serialized));

    const artifact = path.join(sandboxRoot, '.artifacts', 'tc_call_big.json');
    expect(existsSync(artifact)).toBe(true);
    expect(readFileSync(artifact, 'utf8')).toBe(serialized);
    expect(row.sha256).toBe(sha256Of(readFileSync(artifact, 'utf8')));
  });

  it('failure rows with data carry the checksum; payload-less failures stay null', async () => {
    const withData = toolDef(async () => ({
      ok: false,
      summary: '执行失败',
      data: { partial: 1 },
      error: { code: 'TOOL_FAILED', kind: 'internal' as const, message: 'boom', retryable: false },
    }));
    const h1 = harness({});
    const outcome1 = await h1.run({ toolCall: toolCallRow('call_fail_data'), definition: withData });
    expect(outcome1?.status).toBe('failed');
    expect(h1.inserted[0].sha256).toBe(sha256Of(JSON.stringify({ partial: 1 })));

    const noData = toolDef(async () => ({
      ok: false,
      summary: '执行失败',
      error: { code: 'TOOL_FAILED', kind: 'internal' as const, message: 'boom', retryable: false },
    }));
    const h2 = harness({});
    const outcome2 = await h2.run({ toolCall: toolCallRow('call_fail_nodata'), definition: noData });
    expect(outcome2?.status).toBe('failed');
    expect(h2.inserted[0].sha256).toBeNull();
  });
});

describe('ToolExecutor: P2-6 consumed-successor guard', () => {
  it('a vanished successor row yields a synthetic failure outcome, not a dropped observation', async () => {
    const definition = toolDef(async () => ({ ok: true, summary: '不应该被执行', data: {} }));
    // approvalMode 'hard' forces the approval gate（R6 起 soft 不再前置审批）；
    // the decision allows, but no pending row for this callId survives
    // (it was consumed elsewhere) — the row we hand in is already 'revised'.
    const h = harness({
      approvalDecision: 'allow_once',
      verdict: { risk: 'medium', approvalMode: 'hard' },
    });

    const outcome = await h.run({ toolCall: toolCallRow('call_consumed', 'revised'), definition });

    expect(outcome).not.toBeNull();
    expect(outcome?.status).toBe('failed');
    expect(outcome?.errorKind).toBe('not_found');
    expect(String(outcome?.observation)).toContain('未执行');

    // The timeline stays complete: a tool_result event is emitted...
    const result = h.events.find((e) => e.name === 'tool_result');
    expect(result?.data.status).toBe('failed');
    expect(result?.data.error.code).toBe('TOOL_NOT_FOUND');
    // ...and the handler never ran.
    expect(h.inserted).toHaveLength(0);
  });
});

describe('ToolExecutor: P2-1 MCP retry gate', () => {
  function mcpDef(idempotent: boolean, failFirst: boolean): { definition: ToolDefinition; calls: () => number } {
    let calls = 0;
    const definition = toolDef(async () => {
      calls += 1;
      if (failFirst && calls === 1) {
        return {
          ok: false,
          summary: 'MCP 调用失败',
          error: { code: 'MCP_CALL_FAILED', kind: 'mcp' as const, message: 'upstream down', retryable: true },
        };
      }
      return { ok: true, summary: 'MCP 调用成功', data: { ok: true } };
    });
    definition.source = 'mcp';
    definition.idempotent = idempotent;
    return { definition, calls: () => calls };
  }

  it('a non-idempotent MCP write is NOT auto-retried (no duplicated side effect)', async () => {
    const { definition, calls } = mcpDef(false, true);
    const h = harness({ canRetry: true });

    const outcome = await h.run({ toolCall: toolCallRow('call_mcp_write'), definition });

    expect(calls()).toBe(1); // was retried once before the gate
    expect(outcome?.status).toBe('failed');
    expect(h.events.some((e) => e.name === 'tool_progress' && e.data.stage === 'retrying')).toBe(false);
  });

  it('a read-only/idempotent MCP tool still auto-retries once', async () => {
    const { definition, calls } = mcpDef(true, true);
    const h = harness({ canRetry: true });

    const outcome = await h.run({ toolCall: toolCallRow('call_mcp_read'), definition });

    expect(calls()).toBe(2);
    expect(outcome?.status).toBe('success');
    expect(h.events.some((e) => e.name === 'tool_progress' && e.data.stage === 'retrying')).toBe(true);
  });
});

describe('ToolExecutor: AUDIT-019 非幂等重试门', () => {
  function upstreamDef(idempotent: boolean): { definition: ToolDefinition; calls: () => number } {
    let calls = 0;
    const definition = toolDef(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          summary: '上游 500',
          error: { code: 'TOOL_UPSTREAM', kind: 'upstream' as const, message: 'HTTP 500', retryable: true },
        };
      }
      return { ok: true, summary: '重试成功', data: {} };
    });
    definition.idempotent = idempotent;
    return { definition, calls: () => calls };
  }

  it('非幂等写 + upstream(5xx) 不自动重试（避免重复副作用）', async () => {
    const { definition, calls } = upstreamDef(false);
    const h = harness({ canRetry: true });
    const outcome = await h.run({ toolCall: toolCallRow('call_upstream_write'), definition });

    expect(calls()).toBe(1);
    expect(outcome?.status).toBe('failed');
    expect(h.events.some((e) => e.name === 'tool_progress' && e.data.stage === 'retrying')).toBe(false);
  });

  it('非幂等 HTTP GET（天然只读）仍自动重试一次', async () => {
    const { definition, calls } = upstreamDef(false);
    const h = harness({ canRetry: true });
    const outcome = await h.run({
      toolCall: toolCallRow('call_upstream_get'),
      definition,
      args: { method: 'GET' },
    });

    expect(calls()).toBe(2);
    expect(outcome?.status).toBe('success');
  });

  it('幂等工具 + upstream(5xx) 仍自动重试一次', async () => {
    const { definition, calls } = upstreamDef(true);
    const h = harness({ canRetry: true });
    const outcome = await h.run({ toolCall: toolCallRow('call_upstream_idem'), definition });

    expect(calls()).toBe(2);
    expect(outcome?.status).toBe('success');
  });
});

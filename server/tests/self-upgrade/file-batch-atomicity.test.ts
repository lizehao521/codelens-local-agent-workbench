import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolExecutor, type ExecuteItemInput } from '../../src/services/tools/executor.service.js';
import { fsWriteTool } from '../../src/tools/builtin/fs-write.tool.js';
import type { ToolCallRow } from '../../src/services/memory/tool-call.repository.js';
import type { RiskVerdict, ToolDefinition } from '../../src/types/tool.js';
import type { ApprovalService } from '../../src/services/agent/approval.service.js';
import type { SseWriter } from '../../src/services/agent/sse-writer.js';
import { argsDigest } from '../../src/utils/digest.js';

let root = '';

function call(callId: string, file: string): ToolCallRow {
  return {
    id: `tc_${callId}`, session_id: 's', message_id: 'm', call_id: callId,
    tool_name: 'fs.write', tool_wire_name: 'fs_write', display_name: '写入文件',
    category: 'file', source: 'builtin', risk: 'medium', approval_mode: 'soft',
    channel: 'native', iteration: 1, args_json: '{}', args_digest: argsDigest({ path: file }),
    status: 'pending', error_kind: null, error_msg: null, result_ref: null,
    result_summary: null, truncated: 0, started_at: null, finished_at: null,
    duration_ms: null, created_at: Date.now(),
  } as ToolCallRow;
}

function item(callId: string, file: string, args: Record<string, unknown>, definition: ToolDefinition): ExecuteItemInput {
  const verdict: RiskVerdict = {
    risk: 'medium', approvalMode: 'soft',
    effect: {
      reversible: true, summary: `写入 ${file}`,
      items: [{ path: file, kind: 'file', exists: true, bytes: null }],
      itemCount: 1, recoverable: true, recoveryNote: null,
    },
  };
  return { toolCall: call(callId, file), definition, args, digest: argsDigest(args), verdict, channel: 'native', iteration: 1 };
}

function harness() {
  const rows: ToolCallRow[] = [];
  const executor = new ToolExecutor({
    toolCalls: {
      listBySession: () => rows,
      markRunning: () => undefined,
      markFinished: (id: string, patch: Partial<ToolCallRow>) => {
        const row = rows.find((r) => r.id === id);
        if (row) Object.assign(row, patch);
      },
    } as never,
    toolResults: { insert: (fields: unknown) => ({ id: 'tr', created_at: Date.now(), ...(fields as object) }) } as never,
    approvals: {
      hasSessionGrant: () => false,
      requestApproval: async () => 'allow_once',
    } as unknown as ApprovalService,
    sse: { emit: () => undefined } as unknown as SseWriter,
    sandboxRoot: root,
    allowedDirs: [],
    canRetry: () => false,
    onRetryConsumed: () => undefined,
  });
  return { executor, rows };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'batch-atomicity-'));
  await writeFile(path.join(root, 'a.txt'), 'A');
  await writeFile(path.join(root, 'b.txt'), 'B');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('batch-atomicity', () => {
  it('第二个写入失败时回滚第一个已写文件', async () => {
    const h = harness();
    const outcomes = await h.executor.executeBatch([
      item('c1', 'a.txt', { path: 'a.txt', operation: 'overwrite', content: 'A2' }, fsWriteTool),
      item('c2', 'b.txt', { path: 'b.txt', operation: 'replace', oldText: 'missing', newText: 'X' }, fsWriteTool),
    ]);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('A');
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('B');
    expect(outcomes.get('c2')?.status).toBe('failed');
    expect(outcomes.get('c2')?.summary).toContain('回滚');
  });

  it('新建文件在批次失败时被删除', async () => {
    const h = harness();
    const outcomes = await h.executor.executeBatch([
      item('c1', 'new.txt', { path: 'new.txt', operation: 'create', content: 'NEW' }, fsWriteTool),
      item('c2', 'b.txt', { path: 'b.txt', operation: 'replace', oldText: 'missing', newText: 'X' }, fsWriteTool),
    ]);
    await expect(stat(path.join(root, 'new.txt'))).rejects.toThrow();
    expect(outcomes.get('c2')?.summary).toContain('回滚');
  });
});

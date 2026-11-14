/**
 * CallResolver 端到端判据：运行中打开“免审批”必须影响后续高危调用。
 *
 * 只测 service.update 不够——它证明对象被更新，但证明不了 resolver 实际读到新值。
 * 这里用一个 resolver、同一个 autoApprove 引用，先解析一次未豁免的高危调用，
 * 再调用 service.update，然后解析第二次；第二次必须 approvalMode=none，
 * 且不能出现 tool_approval_required。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallResolver } from '../src/services/agent/call-resolver.js';
import { CircuitBreaker } from '../src/services/agent/circuit-breaker.js';
import { SandboxPermissionService } from '../src/services/tools/sandbox-permission.service.js';
import type { Db } from '../src/repositories/db.js';
import type { ToolDefinition } from '../src/types/tool.js';
import type { ToolCallIR } from '../src/services/agent/turn-ir.js';
import type { ToolCallRepository } from '../src/services/memory/tool-call.repository.js';
import type { ToolRegistry } from '../src/services/tools/registry.service.js';
import type { SseWriter } from '../src/services/agent/sse-writer.js';
import { buildReverseIndex } from '../src/utils/tool-name.js';

const base = mkdtempSync(join(tmpdir(), 'codelens-resolver-exempt-'));
const sandboxRoot = join(base, 'sandbox');

function fakeDb(): Db {
  let row: { config_json: string } | undefined;
  return {
    get: () => row,
    run: (_sql: string, params?: unknown[]) => {
      row = { config_json: String(params?.[0]) };
      return { changes: 1 };
    },
  } as unknown as Db;
}

function fsWriteDef(): ToolDefinition {
  return {
    name: 'fs.write',
    wireName: 'fs_write',
    displayName: '写文件',
    description: '',
    category: 'file',
    source: 'builtin',
    risk: 'medium',
    approvalMode: 'soft',
    idempotent: false,
    timeoutMs: 5000,
    enabled: () => true,
    maxResultChars: 3000,
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, operation: { type: 'string' } }, required: ['path', 'operation'] },
    handler: async () => ({ ok: true, summary: 'ok' }),
  };
}

const def = fsWriteDef();

const registry = {
  canonicalNames: () => ['fs.write'],
  get: (name: string) => (name === 'fs.write' ? def : undefined),
  isEnabled: () => true,
} as unknown as ToolRegistry;

let seq = 0;
const toolCalls = {
  insert: (input: Record<string, unknown>) => ({ id: `row-${++seq}`, call_id: input.callId }),
  markFinished: () => undefined,
} as unknown as ToolCallRepository;

const events: string[] = [];
const sse = { emit: (name: string) => events.push(name) } as unknown as SseWriter;

function call(id: string): ToolCallIR {
  return {
    id,
    name: 'fs.write',
    arguments: { path: 'a.txt', operation: 'delete' },
    rawArguments: '{"path":"a.txt","operation":"delete"}',
    channel: 'native',
  };
}

beforeAll(() => {
  mkdirSync(sandboxRoot, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('CallResolver：运行中打开免审批', () => {
  it('第一次高危调用仍 hard；update 后第二次为 none 且不再发审批事件', async () => {
    const svc = new SandboxPermissionService(fakeDb(), sandboxRoot);
    const resolver = new CallResolver({
      registry,
      toolCalls,
      sse,
      sandboxRoot,
      allowedDirs: [],
      exemptions: svc.autoApprove,
      reverseIndex: buildReverseIndex([def]),
      breaker: new CircuitBreaker(),
    });

    const first = await resolver.resolve([call('c1')], 's1', null, 1, 'native');
    expect(first.items[0]?.verdict.approvalMode).toBe('hard');

    const updated = svc.update({ autoApprove: { fsDestructive: true } });
    expect(updated.ok).toBe(true);

    const second = await resolver.resolve([call('c2')], 's1', null, 2, 'native');
    expect(second.items[0]?.verdict.approvalMode).toBe('none');
    expect(events).not.toContain('tool_approval_required');
    expect(events.filter((e) => e === 'tool_call')).toHaveLength(2);
  });
});

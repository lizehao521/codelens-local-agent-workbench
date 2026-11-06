/**
 * 账本完整性：谁在记账，记的是不是它该记的东西。
 *
 * 强化内核 C2「没有被消费的分数/指标/日志 = 开环」与 C4「不外推」在记账上的
 * 落点就是这两件事：
 *
 *   1. **usage_json 静默丢失**（P3）：只有「最终答案轮」写上游账单，「工具调用轮」
 *      整段不写。一次 agent 运行里绝大多数是工具调用轮 → 账单大面积丢失。
 *      `latestPromptUsage()` 读它给压缩判定托底，等于在残缺数据上做决策。
 *   2. **tokens 语义偏窄**（P3）：只算 `turn.text`，漏掉 reasoning_content 与
 *      tool_calls_json。实测工具调用轮正文为空（记 0–1 token），同一条 reasoning
 *      却有 2149 字符 —— `sessions.total_tokens` 长期虚低。
 *   3. **maxResultChars 死元数据**（P2）：12 处声明、0 处读取。
 *
 * 这组测试把三件事都钉死：字段必须被写、口径必须完整、预算必须真被消费。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { FakeLlm, type SseEvent } from './fixtures/fake-llm.js';
import { postJson, runAgentStream } from './fixtures/agent-http.js';
import { estimateAssistantTokens, estimateTextTokens } from '../src/services/agent/token-estimator.js';
import {
  ToolExecutor,
  clipToTokenBudget,
  type ExecuteItemInput,
} from '../src/services/tools/executor.service.js';
import type { ToolCallRow } from '../src/services/memory/tool-call.repository.js';
import type { ToolResultRow } from '../src/services/memory/tool-result.repository.js';
import type { ToolDefinition, ToolOutcome, RiskVerdict } from '../src/types/tool.js';
import { argsDigest } from '../src/utils/digest.js';

// ─────────────────────────────────────────────────────────────
// 1. 体积口径：正文 + 推理 + 工具调用，三者都占上下文
// ─────────────────────────────────────────────────────────────

describe('estimateAssistantTokens: 体积口径不漏项', () => {
  it('只算正文时返回值等于 estimateTextTokens（向后兼容）', () => {
    expect(estimateAssistantTokens('hello world', null, null)).toBe(estimateTextTokens('hello world'));
    expect(estimateAssistantTokens('', null, null)).toBe(0);
  });

  it('reasoning_content 必须计入（此前整段漏记）', () => {
    const text = '';
    const reasoning = '中'.repeat(2000); // 实测里出现过 2149 字符的 reasoning
    const total = estimateAssistantTokens(text, reasoning, null);
    expect(total).toBeGreaterThan(1500);
    expect(total).toBe(estimateTextTokens(reasoning));
  });

  it('tool_calls_json 必须计入（工具调用轮正文常为空）', () => {
    const toolCallsJson = JSON.stringify([
      { id: 'c1', type: 'function', function: { name: 'fs.read', arguments: '{"path":"server/package.json"}' } },
    ]);
    const total = estimateAssistantTokens('', null, toolCallsJson);
    expect(total).toBeGreaterThan(0);
    expect(total).toBe(estimateTextTokens(toolCallsJson));
  });

  it('三者同时存在时是三项之和', () => {
    const text = '结论：已修复';
    const reasoning = '先看根因，再改';
    const toolCallsJson = '[{"id":"c1","function":{"name":"fs.write"}}]';
    expect(estimateAssistantTokens(text, reasoning, toolCallsJson)).toBe(
      estimateTextTokens(text) + estimateTextTokens(reasoning) + estimateTextTokens(toolCallsJson),
    );
  });

  it('undefined / null 都当空处理，不抛错', () => {
    expect(estimateAssistantTokens('abc')).toBe(estimateTextTokens('abc'));
    expect(estimateAssistantTokens('abc', undefined, undefined)).toBe(estimateTextTokens('abc'));
  });
});

// ─────────────────────────────────────────────────────────────
// 2. maxResultChars 必须真被消费（P2，C2 开环回归）
// ─────────────────────────────────────────────────────────────

let sandboxRoot: string;

beforeEach(() => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), 'acct-'));
});

afterEach(() => {
  const dir = sandboxRoot;
  setImmediate(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 残留由环境侧回收 */
    }
  });
});

function toolDefWithBudget(
  maxResultChars: number,
  handler: (args: Record<string, unknown>) => Promise<ToolOutcome>,
): ToolDefinition {
  return {
    name: 'fs.read',
    wireName: 'fs_read',
    displayName: '读取文件',
    category: 'file',
    description: 'test tool',
    inputSchema: { type: 'object' },
    handler,
    timeoutMs: 5000,
    risk: 'low',
    approvalMode: 'none',
    enabled: () => true,
    source: 'builtin',
    idempotent: true,
    maxResultChars,
  };
}

function toolCallRow(callId: string): ToolCallRow {
  return {
    id: `tc_${callId}`,
    session_id: 'sess_1',
    message_id: 'msg_1',
    call_id: callId,
    tool_name: 'fs.read',
    tool_wire_name: 'fs_read',
    display_name: '读取文件',
    category: 'file',
    source: 'builtin',
    risk: 'low',
    approval_mode: 'none',
    channel: 'native',
    iteration: 1,
    args_json: '{}',
    args_digest: argsDigest({}),
    status: 'pending',
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

function execHarness(verdict?: RiskVerdict) {
  const inserted: Array<{ inlinePreview: string | null; artifactPath: string | null; truncated: boolean }> = [];
  const rows: ToolCallRow[] = [];
  const executor = new ToolExecutor({
    toolCalls: {
      insert: (r: ToolCallRow) => {
        rows.push(r);
        return r;
      },
      listBySession: () => rows,
      markRunning: () => undefined,
      markFinished: (id: string, patch: Partial<ToolCallRow>) => {
        const row = rows.find((r) => r.id === id);
        if (row) Object.assign(row, patch);
      },
    } as never,
    toolResults: {
      insert: (f: never) => {
        inserted.push(f as never);
        return { id: `tr_${inserted.length}`, created_at: Date.now(), ...(f as object) } as ToolResultRow;
      },
    } as never,
    approvals: { hasSessionGrant: () => false, requestApproval: async () => 'allow_once' } as never,
    sse: { emit: () => undefined } as never,
    sandboxRoot,
    canRetry: () => false,
    onRetryConsumed: () => undefined,
  });
  return {
    inserted,
    run: async (definition: ToolDefinition) => {
      const call = toolCallRow(`call_${inserted.length + 1}`);
      rows.push(call);
      const outcomes = await executor.executeBatch([
        {
          args: {},
          digest: argsDigest({}),
          verdict: verdict ?? { risk: 'low', approvalMode: 'none' },
          channel: 'native',
          iteration: 1,
          toolCall: call,
          definition,
        } as ExecuteItemInput,
      ]);
      return outcomes.get(call.call_id) ?? null;
    },
  };
}

describe('maxResultChars: 每工具预算必须真被消费', () => {
  it('小预算工具的结果被裁进自己的预算内（回归：此前 12 处声明 0 处读取）', async () => {
    const big = { content: 'x'.repeat(20000) };
    const def = toolDefWithBudget(500, async () => ({ ok: true, summary: 'ok', data: big }));
    const h = execHarness();
    const outcome = await h.run(def);

    expect(outcome?.status).toBe('success');
    // 预算 500 字符：observation 里的「结果数据」段不得超过它（再加提示语）
    const obs = outcome!.observation;
    const dataStart = obs.indexOf('结果数据：');
    const tail = obs.indexOf('\n（结果已截断');
    const dataLen = (tail > dataStart ? obs.slice(dataStart + 5, tail) : obs.slice(dataStart + 5)).length;
    expect(dataLen).toBeLessThanOrEqual(500);
  });

  it('大预算工具不被小预算误伤——预算只裁自己', async () => {
    const data = { answer: 'vitest run', version: '^5.0.5' };
    const def = toolDefWithBudget(100_000, async () => ({ ok: true, summary: 'ok', data }));
    const h = execHarness();
    const outcome = await h.run(def);
    expect(outcome!.observation).toContain('vitest run');
    expect(outcome!.observation).not.toContain('结果已截断');
  });

  it('预算为 0 或非有限值时不裁（视为未声明）', async () => {
    const data = { answer: 'x'.repeat(300) };
    for (const budget of [0, -1, Number.NaN]) {
      const def = toolDefWithBudget(budget, async () => ({ ok: true, summary: 'ok', data }));
      const h = execHarness();
      const outcome = await h.run(def);
      expect(outcome!.observation).toContain('x'.repeat(300));
    }
  });

  it('预算只裁 observation，artifact 仍存全量（审计链不缺损）', async () => {
    const big = { content: 'y'.repeat(20000) };
    const def = toolDefWithBudget(300, async () => ({ ok: true, summary: 'ok', data: big }));
    const h = execHarness();
    await h.run(def);
    expect(h.inserted[0].artifactPath).toBeTruthy();
    expect(h.inserted[0].truncated).toBe(true);
  });

  it('全局 token 硬顶仍然兜底（预算不能绕过它）', () => {
    // maxResultChars 再大，token 硬顶仍是最终闸——这是两道闸的分工
    const text = '中'.repeat(5000);
    expect(estimateTextTokens(clipToTokenBudget(text, 1000))).toBeLessThanOrEqual(1000);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. usage_json：工具调用轮也必须落上游账单（P3 静默丢失回归）
// ─────────────────────────────────────────────────────────────

let fake: FakeLlm;
let runtime: Runtime;
let server: http.Server;
let base: string;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'acct-e2e-'));
  runtime = createRuntime({ dbPath: path.join(tmpRoot, 'acct.db') });
  const app = createApp({ runtime, autoStartModelSync: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake = await FakeLlm.start();
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await fake.close();
  await runtime.close();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 残留由环境侧回收 */
  }
});

function agentBody(message: string): Record<string, unknown> {
  return {
    provider: 'custom',
    customBaseUrl: fake.baseUrl,
    model: 'fake-model-1',
    apiKey: 'test-key-acct',
    message,
    channelMode: 'auto',
    tools: ['fs.write'],
    maxIterations: 8,
    temperature: 0.2,
    maxTokens: 1024,
  };
}

describe('usage_json: 工具调用轮不得静默丢账', () => {
  it(
    '工具调用轮与最终答案轮都必须写入上游账单',
    { timeout: 60_000 },
    async () => {
      const relDir = path.relative(runtime.sandboxRoot, path.join(runtime.sandboxRoot, 'acct-data')).split(path.sep).join('/');
      fake.script([
        {
          toolCall: {
            id: 'call_1',
            name: 'fs_write',
            arguments: JSON.stringify({ path: `${relDir}/note.txt`, operation: 'create', content: 'acct' }),
          },
        },
        { text: '已写入。' },
      ]);

      const events: SseEvent[] = [];
      const { status } = await runAgentStream(base, agentBody('写个文件'), async (event) => {
        events.push(event);
        if (event.name === 'tool_approval_required') {
          await postJson(base, `/api/v1/approvals/${event.data.approvalId}`, {
            token: event.data.approvalToken,
            decision: 'allow_once',
          });
        }
      });
      expect(status).toBe(200);

      const msgRows = runtime.db.all<Record<string, any>>('SELECT * FROM messages ORDER BY seq');
      const assistantRows = msgRows.filter((m) => m.role === 'assistant');
      expect(assistantRows.length).toBeGreaterThanOrEqual(2); // 至少：工具调用轮 + 最终答案轮

      // 关键回归：**每一条** assistant 消息都必须带上游账单，不分轮次。
      const missing = assistantRows.filter((m) => !m.usage_json || m.usage_json === '' || m.usage_json === 'null');
      expect(missing, `以下 assistant 消息缺 usage_json：seq=${missing.map((m) => m.seq).join(',')}`).toHaveLength(0);

      // 工具调用轮的账单必须有具体数字（不是空对象）
      const toolTurn = assistantRows.find((m) => m.tool_calls_json);
      expect(toolTurn).toBeDefined();
      const usage = JSON.parse(String(toolTurn!.usage_json));
      expect(usage.promptTokens).toBeGreaterThan(0);

      // 体积口径：工具调用轮的 tokens 必须能覆盖 reasoning + tool_calls，不能只算正文
      // （FakeLlm 的工具轮正文为空，旧口径会记 0）
      const toolTurnTokens = Number(toolTurn!.tokens);
      expect(toolTurnTokens).toBeGreaterThan(0);
    },
  );
});

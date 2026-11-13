/**
 * T12 — normal-path end-to-end with a scriptable fake LLM server.
 *
 * The shipped agent-e2e.sh skips its only real-LLM closed loop when no API key
 * is present, so the happy path (question → tool call → human approval →
 * execution → observation feedback → final answer → done) was never covered by
 * automation. This suite closes that gap with a fake OpenAI-compatible server
 * whose tool_calls are scriptable turn by turn.
 *
 * Covered flows:
 *   1. happy path with an irreversible (hard) approval human loop (allow_once)
 *   2. approval rejection → synthetic observation → loop continues → done(stop)
 *   3. AC-10 revise → re-approval → execute — asserts the executor runs the
 *      REVISED arguments, not the stale ones (P0-3 approval-bypass regression)
 *   4. AbortRegistry serialization guard (P0-2): one task per session
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { AbortRegistry } from '../src/services/agent/abort-registry.js';
import { FakeLlm, type FakeStep, type SseEvent } from './fixtures/fake-llm.js';
import { postJson, runAgentStream } from './fixtures/agent-http.js';

// ── harness ──────────────────────────────────────────────────────────────────

let fake: FakeLlm;
let runtime: Runtime;
let server: http.Server;
let base: string;
let tmpRoot: string;
const sandboxCleanups: string[] = [];

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-e2e-'));
  runtime = createRuntime({ dbPath: path.join(tmpRoot, 'e2e.db') });
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
  // 宿主环境的删除守卫（safe-delete shim）可能在并发下超时。
  // 清理是 best-effort：残留目录由环境侧回收，但不能让它把已通过的用例判红。
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
    for (const dir of sandboxCleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
  }
});

function agentBody(message: string): Record<string, unknown> {
  return {
    provider: 'custom',
    customBaseUrl: fake.baseUrl,
    model: 'fake-model-1',
    apiKey: 'test-key-e2e',
    message,
    channelMode: 'auto',
    tools: ['fs.write'],
    maxIterations: 8,
    temperature: 0.2,
    maxTokens: 1024,
  };
}

function sandboxDir(tag: string): string {
  const dir = path.join(runtime.sandboxRoot, `e2e-${tag}-${Date.now().toString(36)}`);
  sandboxCleanups.push(dir);
  return path.relative(runtime.sandboxRoot, dir).split(path.sep).join('/');
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('T12 agent loop end-to-end (fake LLM)', () => {
  it(
    'happy path: question → tool call → hard approval（不可逆删除）→ execution → observation → final answer → done(stop)',
    // 这条要起真实 HTTP 上游 + 走完整审批往返，实测 5s 上下浮动；全量时 59 个
    // worker 并发会把它推到 15s+。断言本身很轻，慢的是调度与宿主删除守卫。
    { timeout: 60_000 },
    async () => {
      const relDir = sandboxDir('happy');
      // R6 起 create 属可逆（soft）→ 不再前置审批；用不可逆删除（hard）覆盖审批链。
      const hello = path.join(runtime.sandboxRoot, relDir, 'hello.txt');
      mkdirSync(path.dirname(hello), { recursive: true });
      writeFileSync(hello, 'hello from e2e', 'utf8');
      fake.script([
        {
          toolCall: {
            id: 'call_1',
            name: 'fs_write',
            arguments: JSON.stringify({ path: `${relDir}/hello.txt`, operation: 'delete' }),
          },
        },
        { text: '已按你的要求删除了文件。' },
      ]);

      let sessionId = '';
      const events: SseEvent[] = [];
      const { status } = await runAgentStream(base, agentBody('请创建一个文件'), async (event) => {
        events.push(event);
        if (event.name === 'meta') sessionId = String(event.data.sessionId);
        if (event.name === 'tool_approval_required') {
          const decision = await postJson(base, `/api/v1/approvals/${event.data.approvalId}`, {
            token: event.data.approvalToken,
            decision: 'allow_once',
          });
          expect(decision.status).toBe(200);
          expect(decision.body.decision).toBe('allow_once');
          expect(decision.body.status).toBe('executed');
        }
      });

      expect(status).toBe(200);
      const names = events.map((e) => e.name);
      expect(names).toContain('meta');
      expect(names.indexOf('meta')).toBeLessThan(names.indexOf('tool_call'));
      expect(names.indexOf('tool_call')).toBeLessThan(names.indexOf('tool_approval_required'));
      expect(names.indexOf('tool_approval_required')).toBeLessThan(names.indexOf('tool_result'));
      expect(names.indexOf('tool_result')).toBeLessThan(names.indexOf('done'));
      expect(names).not.toContain('error');

      const meta = events.find((e) => e.name === 'meta')!;
      expect(meta.data.channel).toBe('native'); // probe reported tool_calls → native
      expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const toolCall = events.find((e) => e.name === 'tool_call')!;
      expect(toolCall.data.callId).toBe('call_1');
      expect(toolCall.data.name).toBe('fs.write');
      expect(toolCall.data.approvalMode).toBe('hard');

      const toolResult = events.find((e) => e.name === 'tool_result')!;
      expect(toolResult.data.status).toBe('success');
      expect(toolResult.data.truncated).toBe(false);

      const done = events.find((e) => e.name === 'done')!;
      expect(done.data.finishReason).toBe('stop');
      expect(done.data.toolCallCount).toBe(1);
      expect((done.data.usage as { promptTokens: number }).promptTokens).toBeGreaterThanOrEqual(280); // 120 + 160

      // Observation feedback: some LLM turn must carry the paired role:tool message.
      const feedbackTurn = fake.requests.find((r) =>
        Array.isArray(r.messages) && r.messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call_1'),
      );
      expect(feedbackTurn).toBeDefined();
      const toolMessage = feedbackTurn!.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_1');
      expect(String(toolMessage.content)).toContain('执行成功');

      // Persistence: audit chain is complete and terminal.
      const callRows = runtime.db.all<Record<string, any>>('SELECT * FROM tool_calls');
      expect(callRows).toHaveLength(1);
      expect(callRows[0].call_id).toBe('call_1');
      expect(callRows[0].status).toBe('success');
      expect(callRows[0].approval_mode).toBe('hard');
      expect(callRows[0].risk).toBe('high');
      expect(String(callRows[0].args_digest)).toHaveLength(64);

      expect(runtime.db.all('SELECT * FROM tool_results')).toHaveLength(1);

      const approvalRows = runtime.db.all<Record<string, any>>('SELECT * FROM approvals');
      expect(approvalRows).toHaveLength(1);
      expect(approvalRows[0].status).toBe('decided');
      expect(approvalRows[0].decision).toBe('allow_once');

      const msgRows = runtime.db.all<Record<string, any>>('SELECT * FROM messages ORDER BY seq');
      expect(msgRows.find((m) => m.role === 'assistant' && m.tool_calls_json)).toBeDefined();
      expect(msgRows.find((m) => m.role === 'tool')?.tool_call_id).toBe('call_1');

      // The irreversible side effect really happened inside the sandbox.
      expect(existsSync(hello)).toBe(false);
    },
    20_000,
  );

  it('rejection: user rejects → synthetic observation → loop continues → done(stop)', async () => {
    const relDir = sandboxDir('reject');
    const nope = path.join(runtime.sandboxRoot, relDir, 'nope.txt');
    mkdirSync(path.dirname(nope), { recursive: true });
    writeFileSync(nope, 'keep', 'utf8');
    fake.script([
      {
        toolCall: {
          id: 'call_reject',
          name: 'fs_write',
          arguments: JSON.stringify({ path: `${relDir}/nope.txt`, operation: 'delete' }),
        },
      },
      { text: '好的，已取消该文件写入操作。' },
    ]);

    const events: SseEvent[] = [];
    const { status } = await runAgentStream(base, agentBody('请创建一个文件'), async (event) => {
      events.push(event);
      if (event.name === 'tool_approval_required') {
        const decision = await postJson(base, `/api/v1/approvals/${event.data.approvalId}`, {
          token: event.data.approvalToken,
          decision: 'reject',
        });
        expect(decision.status).toBe(200);
        expect(decision.body.decision).toBe('reject');
      }
    });

    expect(status).toBe(200);
    const names = events.map((e) => e.name);
    expect(names).not.toContain('error');

    const toolResult = events.find((e) => e.name === 'tool_result')!;
    expect(toolResult.data.status).toBe('rejected');
    expect(String(toolResult.data.error.code)).toBe('TOOL_REJECTED');

    const done = events.find((e) => e.name === 'done')!;
    expect(done.data.finishReason).toBe('stop');
    expect(done.data.toolCallCount).toBe(1);

    const callRows = runtime.db.all<Record<string, any>>('SELECT * FROM tool_calls');
    expect(callRows).toHaveLength(1);
    expect(callRows[0].status).toBe('rejected');

    const approvalRows = runtime.db.all<Record<string, any>>('SELECT * FROM approvals');
    expect(approvalRows[0].decision).toBe('reject');
    expect(approvalRows[0].status).toBe('decided');

    // Rejected call must not touch the filesystem.
    expect(existsSync(nope)).toBe(true);
    expect(readFileSync(nope, 'utf8')).toBe('keep');
  }, 20_000);

  it('P0-3 regression: revise → re-approval → the executor runs the REVISED arguments', async () => {
    const relDir = sandboxDir('revise');
    const note = path.join(runtime.sandboxRoot, relDir, 'note.txt');
    mkdirSync(path.dirname(note), { recursive: true });
    writeFileSync(note, 'ORIGINAL', 'utf8');
    // overwrite 已存在文件 = 不可逆（hard），才会进入前置审批；revise 改的是内容。
    const originalArgs = { path: `${relDir}/note.txt`, operation: 'overwrite', content: 'OLD-CONTENT' };
    const revisedArgs = { path: `${relDir}/note.txt`, operation: 'overwrite', content: 'NEW-CONTENT' };
    fake.script([
      { toolCall: { id: 'call_rev', name: 'fs_write', arguments: JSON.stringify(originalArgs) } },
      { text: '已按修改后的参数写入文件。' },
    ]);

    let approvalCount = 0;
    const events: SseEvent[] = [];
    const { status } = await runAgentStream(base, agentBody('请创建一个文件'), async (event) => {
      events.push(event);
      if (event.name === 'tool_approval_required') {
        approvalCount += 1;
        if (approvalCount === 1) {
          // First challenge: revise the arguments (risk stays soft → re-approval).
          const revised = await postJson(base, `/api/v1/approvals/${event.data.approvalId}/revise`, {
            token: event.data.approvalToken,
            arguments: revisedArgs,
          });
          expect(revised.status).toBe(200);
          expect(revised.body.status).toBe('reapproval_required');
          return;
        }
        // Second challenge: approve — the executor must use the NEW arguments.
        const decision = await postJson(base, `/api/v1/approvals/${event.data.approvalId}`, {
          token: event.data.approvalToken,
          decision: 'allow_once',
        });
        expect(decision.status).toBe(200);
        expect(decision.body.decision).toBe('allow_once');
      }
    });

    expect(status).toBe(200);
    expect(approvalCount).toBe(2);
    expect(events.map((e) => e.name)).not.toContain('error');

    const done = events.find((e) => e.name === 'done')!;
    expect(done.data.finishReason).toBe('stop');

    // Two audit rows share the callId: the superseded one is skipped/revised,
    // the executed one is success and carries the REVISED arguments.
    const callRows = runtime.db
      .all<Record<string, any>>("SELECT * FROM tool_calls WHERE call_id = 'call_rev' ORDER BY created_at ASC");
    expect(callRows).toHaveLength(2);
    expect(callRows[0].status).toBe('skipped');
    expect(callRows[0].error_kind).toBe('revised');
    expect(String(callRows[0].args_json)).toContain('OLD-CONTENT');
    expect(callRows[1].status).toBe('success');
    expect(String(callRows[1].args_json)).toContain('NEW-CONTENT');
    expect(callRows[1].id).not.toBe(callRows[0].id);

    // The approval chain: first challenge revised, second one decided/allow_once.
    const approvalRows = runtime.db.all<Record<string, any>>('SELECT * FROM approvals ORDER BY created_at ASC');
    expect(approvalRows).toHaveLength(2);
    expect(approvalRows[0].status).toBe('revised');
    expect(approvalRows[0].decision).toBe('revised');
    expect(approvalRows[1].status).toBe('decided');
    expect(approvalRows[1].decision).toBe('allow_once');
    expect(approvalRows[1].revise_depth).toBe(1);

    // The real side effect reflects the revised parameters, not the stale ones.
    const file = path.join(runtime.sandboxRoot, relDir, 'note.txt');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('NEW-CONTENT');
  }, 20_000);

  it('P0-1: aborting mid-stream recovers the already-billed usage into done.usage', async () => {
    fake.script([{ hang: true }]);

    let sessionId = '';
    let abortSent = false;
    const events: SseEvent[] = [];
    const { status } = await runAgentStream(base, agentBody('做一个耗时的任务'), async (event) => {
      events.push(event);
      if (event.name === 'meta') sessionId = String(event.data.sessionId);
      if (event.name === 'delta' && !abortSent) {
        // The stream is live and has delivered its usage chunk — abort now.
        abortSent = true;
        const aborted = await postJson(base, '/api/v1/agent/abort', { sessionId });
        expect(aborted.status).toBe(200);
        expect(aborted.body.aborted).toBe(true);
      }
    });

    expect(status).toBe(200);
    expect(abortSent).toBe(true);

    const done = events.find((e) => e.name === 'done')!;
    expect(done.data.finishReason).toBe('aborted');
    // Before the fix the aborted turn's usage was dropped and both were 0.
    expect((done.data.usage as { promptTokens: number }).promptTokens).toBe(555);
    expect((done.data.usage as { completionTokens: number }).completionTokens).toBe(7);
    expect(events.map((e) => e.name)).not.toContain('error');
  }, 20_000);

  it('P2-6: resume onto a deregistered tool still feeds back exactly one role:tool message', async () => {
    // Turn 1: the model calls a tool that does not exist — the resolver records
    // a synthetic failed row without executing anything. Turn 2: final answer.
    fake.script([
      { toolCall: { id: 'call_ghost', name: 'fs_nonexistent', arguments: '{"path":"x.txt"}' } },
      { text: '该工具不存在，已记录。' },
    ]);

    let sessionId = '';
    const events: SseEvent[] = [];
    await runAgentStream(base, agentBody('用一个不存在的工具'), (event) => {
      events.push(event);
      if (event.name === 'meta') sessionId = String(event.data.sessionId);
    });
    expect(events.find((e) => e.name === 'done')?.data.finishReason).toBe('stop');

    const ghostRow = runtime.db.get<Record<string, any>>('SELECT * FROM tool_calls WHERE call_id = ?', ['call_ghost']);
    expect(ghostRow).toBeDefined();
    expect(ghostRow!.status).toBe('failed');
    expect(ghostRow!.error_kind).toBe('not_found');

    // Resume from the ghost call: registry.get('fs_nonexistent') is undefined,
    // so reExecuteStep early-returns. Before P2-6 it returned silently while
    // deleteAfter had already removed the original role:tool message — the next
    // turn would go upstream with an orphaned tool_calls entry (HTTP 400).
    fake.script([{ text: '已从该步骤恢复。' }]);
    const resumed: SseEvent[] = [];
    const { status } = await runAgentStream(
      base,
      { ...agentBody('从该步骤重跑'), sessionId, resumeFromCallId: 'call_ghost' },
      (event) => {
        resumed.push(event);
      },
    );

    expect(status).toBe(200);
    expect(resumed.map((e) => e.name)).not.toContain('error');
    expect(resumed.find((e) => e.name === 'done')?.data.finishReason).toBe('stop');

    // Exactly one role:tool message for the call — inserted by the failure path.
    const toolMsgs = runtime.db.all<Record<string, any>>(
      "SELECT * FROM messages WHERE role = 'tool' AND tool_call_id = ? ORDER BY seq",
      ['call_ghost'],
    );
    expect(toolMsgs).toHaveLength(1);
    expect(String(toolMsgs[0].content)).toContain('已不在注册表中');

    // The pairing invariant holds: the assistant message carrying tool_calls is
    // immediately followed (by seq) by its tool result.
    const msgs = runtime.db.all<Record<string, any>>('SELECT * FROM messages ORDER BY seq');
    const assistantIdx = msgs.findIndex((m) => m.tool_calls_json && String(m.tool_calls_json).includes('call_ghost'));
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(msgs[assistantIdx + 1].role).toBe('tool');
    expect(msgs[assistantIdx + 1].tool_call_id).toBe('call_ghost');
  }, 25_000);

  it('taskKind wiring: the upstream system message carries base + task section (AUDIT-006 closure)', async () => {
    fake.script([{ text: '1. 结论：完成。2. 执行过程：无需工具。3. 遗留项：无。' }]);
    const { status, events } = await runAgentStream(
      base,
      { ...agentBody('这段代码为什么越界'), taskKind: 'debug' },
      () => undefined,
    );
    expect(status).toBe(200);
    expect(events.map((e) => e.name)).not.toContain('error');

    // 破坏夹具：schema→loop→buildSystemPrompt→native 通道任一环被删，
    // 上游 system 消息就不再含任务段/输出契约，此断言必红。
    const streams = fake.requests.filter((r) => r.stream === true && Array.isArray(r.messages));
    expect(streams.length).toBeGreaterThan(0);
    const system = streams[0].messages.find((m: Record<string, unknown>) => m.role === 'system') as
      | { content: string }
      | undefined;
    expect(system?.content).toContain('CodeLens Agent');
    expect(system?.content).toContain('【任务模式：调试】');
    expect(system?.content).toContain('根因分析');
    expect(system?.content).toContain('3. 遗留项');
  }, 25_000);
  it('推理吃满预算：只重试一次并抬到 2048', { timeout: 60_000 }, async () => {
    fake.script([
      { reasoning: '先推理很多步……', finishReason: 'length' },
      { text: '这是最终答案。' },
    ]);
    const stages: string[] = [];
    const { status } = await runAgentStream(
      base,
      { ...agentBody('请思考后回答'), channelMode: 'native', maxTokens: 512, maxIterations: 5 },
      (event) => {
        if (event.name === 'stage') stages.push(String(event.data.stage));
      },
    );
    expect(status).toBe(200);
    expect(stages).toContain('budget_adapted');
    const generation = fake.requests.filter((r) => !r.__probe__ && Array.isArray(r.messages));
    expect(generation.length).toBeGreaterThanOrEqual(2);
    expect(generation[0].max_tokens).toBe(512);
    expect(generation[1].max_tokens).toBe(2048);
  });
});

describe('AbortRegistry serialization guard (P0-2)', () => {
  it('register returns the live controller; isActive/abortAndWait/markDone/release behave', async () => {
    const registry = new AbortRegistry();
    expect(registry.isActive('s1')).toBe(false);

    const first = registry.register('s1');
    const second = registry.register('s1');
    expect(second).toBe(first); // same session → same controller (pre-existing contract)
    expect(registry.isActive('s1')).toBe(true);

    let unwound = false;
    const waiting = registry.abortAndWait('s1').then(() => {
      unwound = true;
    });
    expect(first.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(unwound).toBe(false); // still waiting for the old run's teardown

    registry.markDone('s1');
    await waiting;
    expect(unwound).toBe(true);

    registry.release('s1');
    expect(registry.isActive('s1')).toBe(false);
    expect(() => registry.release('unknown')).not.toThrow();
  });

  it('abortAndWait on an idle session resolves immediately with false', async () => {
    const registry = new AbortRegistry();
    await expect(registry.abortAndWait('idle')).resolves.toBe(false);
  });

  it('abortAndWait is bounded when the old run never marks itself done', async () => {
    const registry = new AbortRegistry();
    registry.register('stuck');
    const startedAt = Date.now();
    await expect(registry.abortAndWait('stuck', 60)).resolves.toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});

/**
 * 独立复核（R6）自证：
 *  - 只喂事实：发送给模型的 messages 里不含任何推理/计划字段，只有 ReviewFacts；
 *  - 无凭证 → unexec（不臆测结论）；
 *  - token/耗时真实落库，可按时延与 usage 核对；
 *  - 输出不是 JSON → unexec（不猜测）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { ReviewService, REVIEW_PROMPT_VERSION } from '../src/services/agent/review.service.js';
import type { OpenAICompatibleAdapter } from '../src/providers/openai-compatible.adapter.js';
import type { ReviewFacts } from '../src/types/tool.js';

let db: Db;

const FACTS: ReviewFacts = {
  toolName: 'fs.write',
  callId: 'call_1',
  iteration: 2,
  command: 'purge ./logs',
  cwd: 'C:/ws',
  affectedPaths: [
    { path: 'C:/ws/logs/a.log', operation: 'purge', beforeExists: true, beforeBytes: 1024, afterExists: false, afterBytes: null },
  ],
  itemCount: 12,
  sideEffects: ['删除 12 个日志文件'],
  diffSummary: '- a.log',
};

const CTX = {
  runId: 'run_1',
  sessionId: 'se_1',
  provider: 'nvidia',
  model: 'm',
  apiKey: 'k',
  baseUrl: 'https://x.test',
};

function fakeAdapter(content: string, usage = { promptTokens: 11, completionTokens: 7 }) {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; temperature: number }> = [];
  const adapter = {
    async chat(req: { messages: Array<{ role: string; content: string }>; temperature?: number }) {
      calls.push({ messages: req.messages, temperature: req.temperature ?? -1 });
      return { content, usage, finishReason: 'stop' };
    },
  } as unknown as OpenAICompatibleAdapter;
  return { adapter, calls };
}

beforeEach(() => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('ReviewService', () => {
  it('只喂事实：请求里只有 ReviewFacts，没有推理/计划/对话历史', async () => {
    const { adapter, calls } = fakeAdapter(JSON.stringify({ status: 'confirmed', findings: [] }));
    const svc = new ReviewService(db, { adapter });
    const result = await svc.review(FACTS, CTX, 'sync');

    expect(result.status).toBe('confirmed');
    expect(calls).toHaveLength(1);
    expect(calls[0].temperature).toBe(0);
    expect(calls[0].messages).toHaveLength(2);
    const user = calls[0].messages[1].content;
    // 事实在；推理/计划/历史不在。
    expect(user).toContain('C:/ws/logs/a.log');
    expect(user).toContain('"itemCount": 12');
    expect(user).not.toContain('reasoning');
    expect(user).not.toContain('plan');
    expect(user).not.toContain('assistant');
    expect(user).not.toContain('messages');
  });

  it('真实 token 与耗时落库，可按时延核对', async () => {
    const { adapter } = fakeAdapter(JSON.stringify({ status: 'confirmed', findings: [] }));
    const svc = new ReviewService(db, { adapter });
    const result = await svc.review(FACTS, CTX, 'async');
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const row = db.get<{ prompt_tokens: number; completion_tokens: number; latency_ms: number; status: string; mode: string }>(
      'SELECT prompt_tokens, completion_tokens, latency_ms, status, mode FROM agent_reviews WHERE call_id = ?',
      ['call_1'],
    );
    expect(row?.prompt_tokens).toBe(11);
    expect(row?.completion_tokens).toBe(7);
    expect(row?.latency_ms).toBe(result.latencyMs);
    expect(row?.status).toBe('confirmed');
    expect(row?.mode).toBe('async');
  });

  it('underestimated 会带具体指摘，并保留 severity', async () => {
    const { adapter } = fakeAdapter(
      JSON.stringify({
        status: 'underestimated',
        findings: [{ severity: 'high', claim: '删除影响 12 个文件而非 1 个', factRef: 'call_1' }],
      }),
    );
    const svc = new ReviewService(db, { adapter });
    const result = await svc.review(FACTS, CTX, 'sync');
    expect(result.status).toBe('underestimated');
    expect(result.findings[0]).toMatchObject({ severity: 'high', factRef: 'call_1' });
  });

  it('无凭证 → unexec，并给出原因（不臆测 confirmed）', async () => {
    const { adapter, calls } = fakeAdapter('{}');
    const svc = new ReviewService(db, { adapter });
    const result = await svc.review(FACTS, { ...CTX, apiKey: '' }, 'sync');
    expect(result.status).toBe('unexec');
    expect(result.reason).toContain('未配置');
    expect(calls).toHaveLength(0);
  });

  it('非 JSON 输出 → unexec，不猜测', async () => {
    const { adapter } = fakeAdapter('我觉得没问题');
    const svc = new ReviewService(db, { adapter });
    const result = await svc.review(FACTS, CTX, 'sync');
    expect(result.status).toBe('unexec');
    expect(result.reason).toContain('不是可解析的 JSON');
  });

  it('prompt 版本号稳定（判据可追溯）', () => {
    expect(REVIEW_PROMPT_VERSION).toBe('review-r6-v1');
  });
});

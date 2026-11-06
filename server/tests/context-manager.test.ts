/**
 * Context manager (AC-09) — window resolution, tool-schema accounting, and
 * the compaction failure/success contract (P1-3b / P1-3c / P1-3a regression).
 *
 * Covered here:
 *   P1-3(b) — the context window comes from the injected resolver (the same
 *             ChannelRouter source the meta event uses), not from a private
 *             32000 DB-only fallback. The test drives the seam with two
 *             resolvers to show the old split over/under-firing compaction.
 *   P1-3(c) — provider tool schemas count toward occupancy.
 *   P1-3(a) — a failed fidelity check surfaces `compactionFailed` (the loop
 *             turns that into the "context full" stop) instead of silently
 *             sending the over-window transcript upstream.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SessionRepository } from '../src/services/memory/session.repository.js';
import { MessageRepository } from '../src/services/memory/message.repository.js';
import { ContextManager, COMPACTION_THRESHOLD, TAIL_TURNS } from '../src/services/agent/context-manager.service.js';
import { SUMMARY_SECTIONS } from '../src/services/agent/fidelity-checker.js';
import { estimateTextTokens } from '../src/services/agent/token-estimator.js';
import type { SseWriter } from '../src/services/agent/sse-writer.js';

interface FakeEvent {
  name: string;
  data: any;
}

const SYSTEM_PROMPT = '你是助手';
const PROVIDER = 'openai';
const MODEL = 'gpt-4o-mini';

function fakeSse(events: FakeEvent[]): SseWriter {
  return {
    emit: (name: string, data: unknown) => {
      events.push({ name, data });
    },
  } as unknown as SseWriter;
}

function nineSectionSummary(): string {
  const body = SUMMARY_SECTIONS.map((section) => `【${section}】压缩后的内容`).join('\n');
  // The fidelity checker (P2-2) enforces an evidence floor: when the transcript
  // carries data-scale numbers (or paths), the summary must retain at least one
  // of each. The harness seeds rows whose index suffixes (e.g. "-105") are 3+
  // digit, so the transcript trips the number floor. A real summarizer would
  // keep a number and a path to stay traceable; the fake "passing" summary must
  // too — this represents the contract honestly instead of relaxing the guard.
  return `${body}\n【下一步计划】已处理 130 条消息，详见 src/agent/context.ts`;
}

interface Harness {
  sessionId: string;
  messages: MessageRepository;
  events: FakeEvent[];
  summarizeCalls: () => number;
  /** The transcript the summarizer last saw (P2-4 chaining assertions). */
  lastPrompt: () => string;
  build: (options: { window: number; summary?: string | (() => never) }) => ContextManager;
  close: () => void;
}

function setup(): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), 'codelens-ctx-'));
  const db: Db = createDb(path.join(dir, 'ctx.db'));
  db.exec(SCHEMA_SQL);
  const sessions = new SessionRepository(db);
  const messages = new MessageRepository(db);
  const session = sessions.create({ provider: PROVIDER, model: MODEL })!;
  const events: FakeEvent[] = [];
  let summarizeCalls = 0;
  let lastPrompt = '';
  return {
    sessionId: session.id,
    messages,
    events,
    summarizeCalls: () => summarizeCalls,
    lastPrompt: () => lastPrompt,
    build: ({ window, summary }) =>
      new ContextManager({
        messages,
        resolveContextWindow: () => window,
        sse: fakeSse(events),
        summarize: async (prompt) => {
          summarizeCalls += 1;
          lastPrompt = prompt;
          if (typeof summary === 'function') summary();
          return summary ?? nineSectionSummary();
        },
      }),
    close: () => {
      db.close();
      // 宿主环境的删除守卫（safe-delete shim）可能在并发下超时。
      // 清理是 best-effort：残留目录由环境侧回收，但不能让它把已通过的用例判红。
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
      }
    },
  };
}

function seed(harness: Harness, count: number, filler: string): void {
  for (let i = 0; i < count; i += 1) {
    harness.messages.insert({
      sessionId: harness.sessionId,
      role: 'user',
      content: `${filler}-${i}`,
      tokens: 1,
    });
  }
}

/** An assistant row carrying the provider's actual usage for that turn (P2-5). */
function seedWithUsage(harness: Harness, usage: { promptTokens: number; completionTokens: number }): void {
  harness.messages.insert({
    sessionId: harness.sessionId,
    role: 'assistant',
    content: '已完成的回合',
    usageJson: JSON.stringify(usage),
    tokens: 1,
  });
}

const openCleanups: Array<() => void> = [];
beforeEach(() => {
  openCleanups.length = 0;
});
afterEach(() => {
  for (const cleanup of openCleanups.splice(0)) cleanup();
});

function freshSetup(): Harness {
  const harness = setup();
  openCleanups.push(harness.close);
  return harness;
}

describe('ContextManager.buildView', () => {
  it('P1-3(b): uses the injected context-window resolver (shared with ChannelRouter), not a private fallback', async () => {
    // 30 rows ≈ 30k tokens of conversation: above 75% of the old 32000
    // fallback, below 75% of the router's 128000 for openai. The two windows
    // must disagree on whether compaction fires — proving the estimator
    // follows the resolver. (≥25 rows so the L3 tail leaves a non-empty head.)
    const smallWindow = await (() => {
      const harness = freshSetup();
      seed(harness, 30, '汉'.repeat(1_000));
      return harness.build({ window: 32_000 }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);
    })();
    expect(smallWindow.contextWindow).toBe(32_000);
    expect(smallWindow.occupancy).toBeGreaterThan(COMPACTION_THRESHOLD);
    expect(smallWindow.compacted).toBe(true);

    const largeWindow = await (() => {
      const harness = freshSetup();
      seed(harness, 30, '汉'.repeat(1_000));
      return harness.build({ window: 128_000 }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);
    })();
    expect(largeWindow.contextWindow).toBe(128_000);
    expect(largeWindow.occupancy).toBeLessThan(COMPACTION_THRESHOLD);
    expect(largeWindow.compacted).toBe(false);
  });

  it('P1-3(b): the compaction notice is emitted only when compaction actually fires', async () => {
    const harness = freshSetup();
    seed(harness, 30, '汉'.repeat(1_000));
    await harness.build({ window: 32_000 }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);
    expect(harness.events.some((e) => e.name === 'context_notice' && e.data.reason === 'compacted')).toBe(true);

    const harness2 = freshSetup();
    seed(harness2, 30, '汉'.repeat(1_000));
    await harness2.build({ window: 128_000 }).buildView(harness2.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);
    expect(harness2.events.some((e) => e.name === 'context_notice')).toBe(false);
    expect(harness2.summarizeCalls()).toBe(0);
  });

  it('P1-3(c): provider tool schemas count toward occupancy (accounting)', async () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'fs_read',
          description: '描'.repeat(3_000),
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    ];
    const toolsTokens = estimateTextTokens(JSON.stringify(tools));
    expect(toolsTokens).toBeGreaterThan(2_500);

    // A window large enough that nothing compacts: the delta must be exactly
    // the tool-schema estimate.
    const without = await (() => {
      const harness = freshSetup();
      seed(harness, 1, '汉'.repeat(1_000));
      return harness.build({ window: 100_000 }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT, undefined);
    })();
    const withTools = await (() => {
      const harness = freshSetup();
      seed(harness, 1, '汉'.repeat(1_000));
      return harness.build({ window: 100_000 }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT, tools);
    })();
    expect(withTools.estimatedTokens - without.estimatedTokens).toBe(toolsTokens);
  });

  it('P1-3(c): tool schemas can tip the 75% trigger (effect)', async () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'fs_read',
          description: '描'.repeat(3_500),
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    ];
    // 30 tiny rows (~190 tokens) against a 4000 window: 0.05 alone, but the
    // ~3.5k-token tool schemas push it past 0.75.
    const window = 4_000;

    const without = await (() => {
      const harness = freshSetup();
      seed(harness, 30, '短');
      return harness.build({ window }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT, undefined);
    })();
    expect(without.compacted).toBe(false);

    const withTools = await (() => {
      const harness = freshSetup();
      seed(harness, 30, '短');
      return harness.build({ window }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT, tools);
    })();
    expect(withTools.compacted).toBe(true);
  });

  it('P1-3(a): a summary missing sections surfaces compactionFailed (loop stops with "context full")', async () => {
    const harness = freshSetup();
    seed(harness, 30, '汉'.repeat(1_000));

    const view = await harness
      .build({ window: 32_000, summary: '这份摘要什么都没有落下' })
      .buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);

    expect(view.compacted).toBe(false);
    expect(view.compactionFailed).toEqual([...SUMMARY_SECTIONS]);
    // The over-window transcript is still returned as-is; the LOOP must refuse
    // to send it (agent-loop.service.ts checks compactionFailed and stops).
    expect(view.messages.length).toBeGreaterThan(1);
    const notice = harness.events.find((e) => e.name === 'context_notice');
    expect(notice?.data.reason).toBe('compaction_failed');
  });

  it('a throwing summarize also surfaces compactionFailed (no silent truncation)', async () => {
    const harness = freshSetup();
    seed(harness, 30, '汉'.repeat(1_000));

    const view = await harness
      .build({
        window: 32_000,
        summary: () => {
          throw new Error('upstream down');
        },
      })
      .buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);

    expect(view.compactionFailed).toEqual(['摘要生成失败']);
    expect(view.compacted).toBe(false);
  });

  it('a passing summary compacts, persists the is_summary anchor, and retains the tail', async () => {
    const harness = freshSetup();
    const rowCount = TAIL_TURNS * 4 + 6; // 30 rows > TAIL_TURNS*4
    seed(harness, rowCount, '汉'.repeat(1_000)); // >75% of 32000 → compaction fires

    const view = await harness.build({ window: 32_000 }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);

    expect(view.compacted).toBe(true);
    expect(view.compactionFailed).toBeUndefined();
    // system + summary + tail(TAIL_TURNS*4 rows)
    expect(view.messages).toHaveLength(2 + TAIL_TURNS * 4);
    expect(view.messages[1]!.content).toContain('【上下文压缩摘要】');
    expect(view.messages[view.messages.length - 1]!.content.endsWith(`-${rowCount - 1}`)).toBe(true);

    const summaryRows = harness.messages.listBySession(harness.sessionId).filter((row) => row.is_summary === 1);
    expect(summaryRows).toHaveLength(1);

    const notice = harness.events.find((e) => e.name === 'context_notice');
    expect(notice?.data.reason).toBe('compacted');
    expect(notice.data.removedMessages).toBe(rowCount - TAIL_TURNS * 4);
  });

  it('occupancy and estimatedTokens stay consistent on the fast path (no compaction)', async () => {
    const harness = freshSetup();
    seed(harness, 3, '短消息');

    const view = await harness.build({ window: 128_000 }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);

    expect(view.compacted).toBe(false);
    expect(view.occupancy).toBeCloseTo(view.estimatedTokens / 128_000, 10);
    expect(harness.events.some((e) => e.name === 'context_notice')).toBe(false);
  });
});

describe('P2-4 anchored compaction (no per-turn repeat)', () => {
  it('a later buildView reuses the anchor instead of summarizing the same prefix again', async () => {
    const harness = freshSetup();
    // Fixture scale matters: 200 chars/row keeps the retained L3 tail (24 rows)
    // well under the 32k window, so a second turn must NOT re-compact. Rows of
    // 1000 chars make the tail alone exceed 75% and force a cascade that says
    // nothing about anchor reuse.
    seed(harness, TAIL_TURNS * 4 + 106, '汉'.repeat(200));

    const first = await harness.build({ window: 32_000 }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);
    expect(first.compacted).toBe(true);
    expect(harness.summarizeCalls()).toBe(1);

    // Growth after the anchor must NOT re-compact while occupancy stays sane.
    // Before the fix this re-summarized (and re-inserted a summary row) every
    // single turn, on the main model.
    seed(harness, 2, '新消息');
    const second = await harness.build({ window: 32_000 }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);

    expect(harness.summarizeCalls()).toBe(1);
    expect(second.compacted).toBe(false);
    // The view replays the anchor as a USER message (no double system) and only
    // the live rows — the covered history is not duplicated into the prompt.
    expect(second.messages[0].role).toBe('system');
    expect(second.messages[1].role).toBe('user');
    expect(second.messages[1].content).toContain('【上下文压缩摘要】');
    // AUDIT-001 regression guard — this is the assertion that was locking the
    // bug in. The anchor used to be appended at the END of the log, so "the rows
    // after the anchor" was empty and the retained tail vanished from every
    // later turn, leaving just 2 + 2 messages. The L3 tail must still be here.
    const filler = '汉'.repeat(200);
    const firstTailIndex = 106;
    const lastTailIndex = TAIL_TURNS * 4 + 105;
    expect(second.messages.some((m) => m.content === `${filler}-${firstTailIndex}`)).toBe(true);
    expect(second.messages.some((m) => m.content === `${filler}-${lastTailIndex}`)).toBe(true);
    expect(second.messages).toHaveLength(2 + TAIL_TURNS * 4 + 2);
    const summaryRows = harness.messages.listBySession(harness.sessionId).filter((row) => row.is_summary === 1);
    expect(summaryRows).toHaveLength(1);
    expect(summaryRows[0].role).toBe('user'); // P2-4③: not 'system'
  });

  it('re-compaction chains the previous anchor into the transcript and keeps one system message', async () => {
    const harness = freshSetup();
    seed(harness, TAIL_TURNS * 4 + 6, '汉'.repeat(1_000));
    await harness.build({ window: 32_000 }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);

    // Push the live region past the threshold again.
    seed(harness, TAIL_TURNS * 4 + 6, '汉'.repeat(1_000));
    const second = await harness.build({ window: 32_000 }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);

    expect(second.compacted).toBe(true);
    expect(harness.summarizeCalls()).toBe(2);
    // The old anchor's content rides along, so dropping it from the view loses
    // nothing.
    expect(harness.lastPrompt()).toContain('【此前的压缩摘要】');
    // The view carries the NEWEST anchor only — exactly one system message.
    expect(second.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    const summaryRows = harness.messages.listBySession(harness.sessionId).filter((row) => row.is_summary === 1);
    expect(summaryRows).toHaveLength(2); // both persisted; the view keeps the newest
  });
});

describe('P2-5 usage calibration floor', () => {
  it('the estimate never drops below the newest actually-billed prompt', async () => {
    const harness = freshSetup();
    // 30 tiny rows (~a few hundred tokens of content) against an 8000 window:
    // content alone sits far below 75%, but the billed prompt says 7000.
    seed(harness, 30, '短');
    seedWithUsage(harness, { promptTokens: 7_000, completionTokens: 500 });

    const view = await harness.build({ window: 8_000 }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);

    // The floor is what crosses the threshold — content alone would not fire.
    expect(view.compacted).toBe(true);
    const notice = harness.events.find((e) => e.name === 'context_notice');
    expect(notice?.data.reason).toBe('compacted');
    expect(notice.data.estimatedTokensBefore).toBeGreaterThanOrEqual(7_000);
  });

  it('usage from before the anchor does not floor the post-anchor view (no re-compaction loop)', async () => {
    const harness = freshSetup();
    // P2-5: the 30k usage row must land BEFORE the compaction anchor (i.e. inside
    // the head that the anchor summarises) so that, once covered, it is excluded
    // from the post-anchor `live` region and cannot floor the next view. Seeding
    // it first puts it at position 0; the 130 user rows that follow push it well
    // inside the head, so the anchor (at live[keepFrom]) covers it.
    seedWithUsage(harness, { promptTokens: 30_000, completionTokens: 500 });
    seed(harness, TAIL_TURNS * 4 + 106, '汉'.repeat(200));
    const first = await harness.build({ window: 32_000 }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);
    expect(first.compacted).toBe(true);

    seed(harness, 2, '新消息');
    const second = await harness.build({ window: 32_000 }).buildView(harness.sessionId, PROVIDER, MODEL, SYSTEM_PROMPT);

    // The stale 30k usage describes a view that no longer exists; flooring on
    // it would re-trigger compaction and then fail with "no history to compress".
    expect(second.compacted).toBe(false);
    expect(harness.summarizeCalls()).toBe(1);
  });
});

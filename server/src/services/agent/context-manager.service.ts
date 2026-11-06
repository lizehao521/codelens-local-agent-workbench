/**
 * Context manager (AC-09): three-layer compression.
 *   L1 tool-result externalization — only the inline preview enters the context
 *      (executor already truncates; this layer keeps the mapping honest);
 *   L2 LLM nine-section summary — triggered when occupancy > 75%, validated by
 *      the fidelity checker; on failure the loop stops with "context full"
 *      instead of silently truncating;
 *   L3 tail retention — the most recent 6 turns always survive compression.
 *
 * P2-4: compaction is anchored, not repeated. The summary is persisted as an
 * `is_summary` message and every later buildView consumes it: the rows it covers
 * are dropped from the view and the anchor itself is replayed as a USER message
 * (a `role: 'system'` summary sat next to the system prompt — the double-system
 * hazard). A new compaction summarizes only what arrived since the last anchor,
 * chaining the previous anchor's text into the transcript, so one summarize call
 * happens per genuine threshold crossing instead of once per turn (and the DB no
 * longer grows a summary row every turn).
 */

import type { MessageRepository, MessageRow } from '../memory/message.repository.js';
import type { SseWriter } from './sse-writer.js';
import { estimateMessagesTokens, estimateTextTokens, latestPromptUsage, occupancyRatio } from './token-estimator.js';
import { buildCompactionPrompt, checkFidelity } from './fidelity-checker.js';
import type { UpstreamMessage } from '../../types/index.js';

export const COMPACTION_THRESHOLD = 0.75;
export const TAIL_TURNS = 6;

export interface ContextView {
  messages: UpstreamMessage[];
  estimatedTokens: number;
  contextWindow: number;
  occupancy: number;
  /** True when a compaction summary was applied to this view. */
  compacted: boolean;
  /**
   * Missing sections when compaction was attempted but failed its fidelity
   * check (AC-09). The loop must stop with "context full" instead of sending
   * the over-window transcript upstream.
   */
  compactionFailed?: string[];
}

export interface CompactionDeps {
  messages: MessageRepository;
  /**
   * P1-3(b): effective context window for (provider, model) — the SAME
   * resolution the ChannelRouter uses (static capability table merged with the
   * probed row). The old DB-only lookup fell back to 32000 while the router
   * fell back to 65536–128000, so occupancy was over-estimated on small-window
   * models (premature compaction) and under-estimated on large ones (missed
   * compaction → upstream 400). One shared source keeps the 75% trigger and
   * the meta event on the same window.
   */
  resolveContextWindow: (provider: string, model: string) => number;
  sse: SseWriter;
  /** Cheap-model completion for the summary; falls back to the main model. */
  summarize: (prompt: string, system: string) => Promise<string>;
}

/** Splits DB rows into LLM-bound messages, pairing tool calls with results. */
export function rowsToUpstreamMessages(rows: MessageRow[]): UpstreamMessage[] {
  const out: UpstreamMessage[] = [];
  for (const row of rows) {
    if (row.role === 'user' || row.role === 'system') {
      out.push({ role: row.role, content: row.content });
      continue;
    }
    if (row.role === 'assistant') {
      const toolCalls = row.tool_calls_json
        ? (JSON.parse(row.tool_calls_json) as UpstreamMessage['tool_calls'])
        : undefined;
      out.push({
        role: 'assistant',
        content: row.content,
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // role 'tool': must carry the tool_call_id or upstream 400s.
    out.push({
      role: 'tool',
      content: row.content,
      ...(row.tool_call_id ? { tool_call_id: row.tool_call_id } : {}),
    });
  }
  return out;
}

/** Index of the newest persisted compaction anchor, or -1. */
function lastAnchorIndex(rows: MessageRow[]): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]!.is_summary === 1) return i;
  }
  return -1;
}

export class ContextManager {
  constructor(private readonly deps: CompactionDeps) {}

  /**
   * Builds the message list for the next LLM call. When occupancy exceeds 75%,
   * attempts L2 compaction (summary replaces the middle, L3 tail is retained).
   *
   * `tools` are the provider tool schemas shipped with a native-function-calling
   * request; they count toward occupancy (P1-3c). Pass undefined for channels
   * whose catalogue already lives inside the system prompt (ReAct).
   */
  async buildView(
    sessionId: string,
    provider: string,
    model: string,
    systemPrompt: string,
    tools?: unknown,
  ): Promise<ContextView> {
    const rows = this.deps.messages.listBySession(sessionId);
    const contextWindow = this.deps.resolveContextWindow(provider, model);

    // P2-4: an existing anchor covers every row up to it — those rows are not
    // replayed (that duplication is what made the old code re-compact, and
    // re-insert a summary row, on every single turn).
    const anchorIdx = lastAnchorIndex(rows);
    const anchorMessage: UpstreamMessage | null =
      anchorIdx >= 0 ? { role: 'user', content: rows[anchorIdx]!.content } : null;
    const live = anchorIdx >= 0 ? rows.slice(anchorIdx + 1) : rows;

    const systemMessage: UpstreamMessage = { role: 'system', content: systemPrompt };
    const base = anchorMessage ? [systemMessage, anchorMessage] : [systemMessage];
    let messages = [...base, ...rowsToUpstreamMessages(live)];
    let estimated = estimateMessagesTokens(messages, tools);
    // P2-5: never estimate below the last actually-billed prompt (ground truth
    // beats the char heuristic; errs high, the safe direction). Only the LIVE
    // region counts: a usage row from before the anchor describes a view that
    // no longer exists, and flooring on it would re-trigger compaction (and
    // then fail with "no history to compress") on the very next turn.
    estimated = Math.max(estimated, latestPromptUsage(live));
    let compacted = false;
    let compactionFailed: string[] | undefined;

    if (occupancyRatio(estimated, contextWindow) > COMPACTION_THRESHOLD) {
      const compaction = await this.compact(sessionId, rows, contextWindow, tools, estimated);
      if (compaction.ok) {
        messages = [systemMessage, compaction.summaryMessage, ...compaction.tail];
        estimated = estimateMessagesTokens(messages, tools);
        compacted = true;
        this.deps.sse.emit('context_notice', {
          reason: 'compacted',
          removedMessages: compaction.removedCount,
          estimatedTokensBefore: compaction.before,
          estimatedTokensAfter: estimated,
          summaryPreview: compaction.summaryMessage.content.slice(0, 120),
        });
      } else {
        this.deps.sse.emit('context_notice', {
          reason: 'compaction_failed',
          removedMessages: 0,
          estimatedTokensBefore: estimated,
          estimatedTokensAfter: estimated,
          summaryPreview: `压缩自检未通过（缺：${compaction.missing.join('、')}）`,
        });
        compactionFailed = compaction.missing;
      }
    }

    return {
      messages,
      estimatedTokens: estimated,
      contextWindow,
      occupancy: occupancyRatio(estimated, contextWindow),
      compacted,
      compactionFailed,
    };
  }

  private async compact(
    sessionId: string,
    rows: MessageRow[],
    contextWindow: number,
    tools: unknown,
    before: number,
  ): Promise<
    | { ok: true; summaryMessage: UpstreamMessage; tail: UpstreamMessage[]; removedCount: number; before: number }
    | { ok: false; missing: string[] }
  > {
    const anchorIdx = lastAnchorIndex(rows);
    const live = anchorIdx >= 0 ? rows.slice(anchorIdx + 1) : rows;
    // L3: keep the last TAIL_TURNS *user-initiated* turns. Approximated by message
    // count: a turn ≈ one user message + its assistant/tool fallout.
    const keepFrom = Math.max(0, live.length - TAIL_TURNS * 4);
    const head = live.slice(0, keepFrom);
    const tail = rowsToUpstreamMessages(live.slice(keepFrom));
    if (head.length === 0) {
      return { ok: false, missing: ['无历史可压缩'] };
    }

    // Chain the previous anchor into the transcript so the new summary subsumes
    // it — otherwise dropping the old anchor from the view would lose its content.
    const previousAnchor = anchorIdx >= 0 ? rows[anchorIdx]!.content : null;
    const transcript =
      (previousAnchor ? `【此前的压缩摘要】\n${previousAnchor}\n\n` : '') +
      head.map((row) => `[${row.role}] ${row.content.slice(0, 600)}`).join('\n');
    let summary: string;
    try {
      summary = await this.deps.summarize(transcript, buildCompactionPrompt());
    } catch {
      return { ok: false, missing: ['摘要生成失败'] };
    }
    const fidelity = checkFidelity(summary, transcript);
    if (!fidelity.ok) {
      return { ok: false, missing: [...fidelity.missing, ...fidelity.missingEvidence] };
    }
    // P2-4③: the summary line is a USER message — a system-role summary sat
    // beside the system prompt (double system), which some upstreams reject.
    const summaryMessage: UpstreamMessage = {
      role: 'user',
      content: `【上下文压缩摘要】\n${summary}`,
    };
    // Persist as an is_summary message so later turns (and a page reload) reuse
    // it instead of re-summarizing the same prefix (P2-4①).
    //
    // The anchor goes AT the boundary it summarises, not at the end of the log.
    // Appending it made it the newest row, so every later turn resolved the live
    // region to the rows AFTER it — empty — and silently dropped the L3 tail that
    // AC-09 promises to retain. Seating it at `boundarySeq` keeps history order
    // truthful: below it everything is covered by the summary, above it still live.
    const boundarySeq = live[keepFrom]!.seq;
    this.deps.messages.insertAt(
      {
        sessionId,
        role: 'user',
        content: summaryMessage.content,
        isSummary: true,
        tokens: estimateTextTokens(summary),
      },
      boundarySeq,
    );
    return { ok: true, summaryMessage, tail, removedCount: head.length, before };
  }
}

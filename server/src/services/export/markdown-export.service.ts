/**
 * Session Markdown export service (P1-2): renders a session's message timeline
 * plus its tool-call audit rows into a single structured Markdown document.
 *
 * Pure functions only — no I/O, no DB. The controller owns HTTP concerns
 * (auth, headers, Content-Disposition); this module owns rendering safety:
 *  - fence injection: content is fenced with a backtick run longer than any
 *    backtick run inside the content, so ``` in user/model output cannot
 *    close the fence early;
 *  - truncation caps: per-block and whole-document limits keep a huge session
 *    from producing an unbounded response body;
 *  - filename sanitization: the download filename is derived from the session
 *    title, so path separators / control chars / reserved chars are stripped;
 *  - corrupt-JSON tolerance: segments / tool_calls / args JSON that fails to
 *    parse degrades to a visible placeholder instead of throwing (AUDIT-017
 *    philosophy: one bad field must not 500 the whole export).
 */

import type { MessageRow } from '../memory/message.repository.js';
import type { SessionRow } from '../memory/session.repository.js';
import type { ToolCallRow } from '../memory/tool-call.repository.js';

/** Per-block (message content / tool args / tool result) character cap. */
export const MAX_BLOCK_CHARS = 8_000;
/** Whole-document character cap — the hard ceiling on the response body. */
export const MAX_DOC_CHARS = 200_000;
/** Filename (title-derived part) character cap. */
export const MAX_FILENAME_TITLE_CHARS = 60;

const TRUNCATION_NOTE = '…[已截断]';

/** Damaged JSON degrades to null instead of throwing (AUDIT-017). */
export function safeParseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Truncates `text` to at most MAX_BLOCK_CHARS, appending a visible marker. */
export function truncateBlock(text: string, maxChars: number = MAX_BLOCK_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRUNCATION_NOTE;
}

/**
 * Returns a backtick fence at least one longer than the longest backtick run
 * in `content`, so embedded ``` (or ````) can never terminate the fence.
 */
export function fenceFor(content: string): string {
  const longest = content.match(/`+/g)?.reduce((m, run) => Math.max(m, run.length), 0) ?? 0;
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Renders `content` as a fenced code block that is injection-safe. */
export function fencedBlock(content: string, lang = ''): string {
  const fence = fenceFor(content);
  // A line inside content that equals the fence would still close it — pad the
  // fence with a trailing space variant is not portable, so instead ensure no
  // line of content is exactly the fence by construction: fence length exceeds
  // every backtick run, and a closing fence must be a line of ONLY backticks,
  // which cannot occur inside content because any such line is a backtick run
  // shorter than the fence.
  return `${fence}${lang}\n${content}\n${fence}`;
}

/**
 * Sanitizes a session title into a filename-safe slug. Strips path separators,
 * Windows-reserved chars, control chars; collapses whitespace; falls back to
 * 'session' when nothing survives. This is the filename-injection guard: the
 * title is user-controlled and must never reach Content-Disposition raw.
 */
export function sanitizeFilenamePart(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, MAX_FILENAME_TITLE_CHARS)
    .trim();
  return cleaned || 'session';
}

/** Builds the Content-Disposition filename for a session export. */
export function exportFilename(session: SessionRow, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:T]/g, '-').slice(0, 19); // YYYY-MM-DD-HH-mm-ss
  const title = sanitizeFilenamePart(session.title || '');
  return `codelens-${title}-${stamp}.md`;
}

function iso(ts: number | null): string {
  if (!ts) return '-';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '-' : d.toISOString();
}

const ROLE_HEADING: Record<MessageRow['role'], string> = {
  user: '用户',
  assistant: '助手',
  system: '系统',
  tool: '工具结果',
};

interface ToolCallBrief {
  id: string;
  name: string;
  argsRaw: string | null;
  /** Structured arguments when the provider sent an object instead of a JSON string. */
  args: unknown;
}

function parseToolCallsJson(raw: string | null): ToolCallBrief[] {
  const parsed = safeParseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => {
      const fn = typeof entry.function === 'object' && entry.function !== null
        ? (entry.function as Record<string, unknown>)
        : {};
      const name = typeof fn.name === 'string' && fn.name ? fn.name : String(entry.name ?? 'unknown');
      const argsRaw = typeof fn.arguments === 'string' ? fn.arguments : null;
      const args = argsRaw === null && fn.arguments !== undefined ? fn.arguments : null;
      const id = typeof entry.id === 'string' ? entry.id : '';
      return { id, name, argsRaw, args };
    });
}

function renderToolCallRow(row: ToolCallRow): string[] {
  const lines: string[] = [];
  const statusLine = `状态: ${row.status}${row.duration_ms ? ` · 耗时 ${row.duration_ms}ms` : ''}`;
  lines.push(`- \`${row.tool_name}\`（${row.display_name || row.tool_name}，风险 ${row.risk}，第 ${row.iteration} 轮）— ${statusLine}`);
  if (row.args_json) {
    lines.push(`  - 参数:`);
    lines.push('  ' + fencedBlock(truncateBlock(row.args_json), 'json').replace(/\n/g, '\n  '));
  }
  if (row.result_summary) {
    lines.push(`  - 结果摘要: ${truncateBlock(row.result_summary, 2_000)}`);
  }
  if (row.error_msg) {
    lines.push(`  - 错误: ${truncateBlock(row.error_msg, 2_000)}`);
  }
  return lines;
}

function renderMessage(msg: MessageRow, toolCallsByCallId: Map<string, ToolCallRow>): string[] {
  const lines: string[] = [];
  const heading = ROLE_HEADING[msg.role] ?? msg.role;
  lines.push(`### ${heading} · #${msg.seq} · ${iso(msg.created_at)}`);
  lines.push('');
  if (msg.role === 'assistant' && msg.reasoning_content) {
    lines.push('**推理:**');
    lines.push('');
    lines.push(fencedBlock(truncateBlock(msg.reasoning_content)));
    lines.push('');
  }
  if (msg.content) {
    lines.push(fencedBlock(truncateBlock(msg.content)));
    lines.push('');
  }
  const calls = parseToolCallsJson(msg.tool_calls_json);
  if (calls.length > 0) {
    lines.push('**工具调用:**');
    lines.push('');
    for (const call of calls) {
      const audit = msg.tool_call_id ? toolCallsByCallId.get(msg.tool_call_id) : undefined;
      const callId = typeof (safeParseJson(msg.tool_calls_json) as unknown[] | null)?.[calls.indexOf(call)] === 'object'
        ? String(((safeParseJson(msg.tool_calls_json) as Record<string, unknown>[])[calls.indexOf(call)] as Record<string, unknown>).id ?? '')
        : '';
      void audit;
      lines.push(`- \`${call.name}\`${callId ? ` (call_id: \`${callId}\`)` : ''}`);
      if (call.argsRaw) {
        lines.push('  ' + fencedBlock(truncateBlock(call.argsRaw), 'json').replace(/\n/g, '\n  '));
      } else if (call.args !== null) {
        lines.push('  ' + fencedBlock(truncateBlock(JSON.stringify(call.args, null, 2) ?? ''), 'json').replace(/\n/g, '\n  '));
      }
    }
    lines.push('');
  }
  if (msg.role === 'tool' && msg.tool_call_id) {
    const audit = toolCallsByCallId.get(msg.tool_call_id);
    if (audit) {
      lines.push('**工具审计:**');
      lines.push('');
      lines.push(...renderToolCallRow(audit).map((l) => '  ' + l));
      lines.push('');
    }
  }
  if (msg.is_summary === 1) {
    lines.push('> 本段为上下文压缩摘要。');
    lines.push('');
  }
  return lines;
}

export interface ExportInput {
  session: SessionRow;
  messages: MessageRow[];
  toolCalls: ToolCallRow[];
}

/** Renders the full Markdown document, capped at MAX_DOC_CHARS. */
export function renderSessionMarkdown(input: ExportInput): string {
  const { session, messages, toolCalls } = input;
  const toolCallsByCallId = new Map(toolCalls.map((row) => [row.call_id, row]));

  const out: string[] = [];
  out.push(`# 会话导出: ${session.title || '新会话'}`);
  out.push('');
  out.push(`- 会话 ID: \`${session.id}\``);
  out.push(`- Provider / Model: ${session.provider} / ${session.model}`);
  out.push(`- 创建时间: ${iso(session.created_at)}`);
  out.push(`- 更新时间: ${iso(session.updated_at)}`);
  out.push(`- 消息数: ${messages.length} · 工具调用数: ${toolCalls.length} · 累计 tokens: ${session.total_tokens}`);
  out.push('');
  out.push('---');
  out.push('');

  // Merge messages and tool-call audit rows into one timeline ordered by time.
  interface TimelineItem {
    kind: 'message' | 'toolCall';
    at: number;
    seq: number;
    row: MessageRow | ToolCallRow;
  }
  const timeline: TimelineItem[] = [
    ...messages.map((row) => ({ kind: 'message' as const, at: row.created_at, seq: row.seq, row })),
    ...toolCalls
      .filter((row) => !row.message_id) // message-bound calls are rendered under their message
      .map((row) => ({ kind: 'toolCall' as const, at: row.created_at, seq: Number.MAX_SAFE_INTEGER, row })),
  ];
  timeline.sort((a, b) => a.at - b.at || a.seq - b.seq);

  for (const item of timeline) {
    if (item.kind === 'message') {
      out.push(...renderMessage(item.row as MessageRow, toolCallsByCallId));
    } else {
      out.push('### 工具调用（独立记录）');
      out.push('');
      out.push(...renderToolCallRow(item.row as ToolCallRow));
      out.push('');
    }
  }

  let doc = out.join('\n');
  if (doc.length > MAX_DOC_CHARS) {
    doc = doc.slice(0, MAX_DOC_CHARS) + `\n\n${TRUNCATION_NOTE}（文档超过 ${MAX_DOC_CHARS} 字符上限）`;
  }
  return doc;
}

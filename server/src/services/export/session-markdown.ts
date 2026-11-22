/**
 * P1-2 · 会话执行记录导出（Markdown 渲染，纯函数，不碰 DB）。
 *
 * 分工：本模块只负责「把 sessions/messages/tool_calls 三张表的行渲染成
 * 结构化 Markdown 字符串」；取数在 SessionsController（复用 listBySession），
 * 权限复用既有 assertOwned。渲染侧不做任何业务判断。
 *
 * 安全/边界刻意点：
 *  - 用户内容（消息正文 / 工具参数 / 结果摘要）一律进围栏代码块，且围栏长度
 *    取「内容中最长反引号串 + 1」，保证内容里的 ``` 不会提前闭合代码块；
 *  - 损坏的 JSON 字段由调用方 safeParse 后传入，本模块只认已经解析好的值；
 *  - 结果摘要/参数有硬截断上限，避免一条超长结果把导出文件撑爆；
 *  - 文件名完全由 session id + 时间戳拼出，不用 title，杜绝 Content-Disposition 注入。
 */

import type { MessageRow } from '../memory/message.repository.js';
import type { SessionRow } from '../memory/session.repository.js';
import type { ToolCallRow } from '../memory/tool-call.repository.js';

export interface SessionExportData {
  session: SessionRow;
  messages: MessageRow[];
  toolCalls: ToolCallRow[];
}

/** 单条工具调用的结果摘要最多导出多少字符（超出追加截断标记）。 */
export const EXPORT_RESULT_SUMMARY_MAX = 2000;
/** 工具参数 JSON 最多导出多少字符。 */
export const EXPORT_ARGS_MAX = 4000;

const STATUS_LABEL: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  success: '成功',
  failed: '失败',
  timeout: '超时',
  rejected: '已拒绝',
  skipped: '已跳过',
};

const ROLE_LABEL: Record<string, string> = {
  user: '用户',
  assistant: '助手',
  system: '系统',
  tool: '工具',
};

/** 内容里最长的连续反引号串长度 + 1，至少 3 —— 保证围栏不会被内容提前闭合。 */
function fenceFor(text: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === '`') {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** 把任意文本包进自适应围栏代码块；空文本返回空串占位。 */
function codeBlock(text: string, lang = ''): string {
  const body = text.length > 0 ? text : '(空)';
  const fence = fenceFor(body);
  return `${fence}${lang}\n${body}\n${fence}`;
}

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

/** 损坏/缺失的 JSON 安全解析：坏串返回 null 而不是抛出（与 detail 接口的 safeParseJson 同口径）。 */
function safeJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[已截断，共 ${text.length} 字符]`;
}

function prettyArgs(argsJson: string): string {
  const parsed = safeJson(argsJson);
  const text = parsed === null ? argsJson : JSON.stringify(parsed, null, 2);
  return truncate(text, EXPORT_ARGS_MAX);
}

function renderToolCall(call: ToolCallRow): string[] {
  const lines: string[] = [];
  const status = STATUS_LABEL[call.status] ?? call.status;
  lines.push(`#### 工具调用 \`${call.tool_name}\` — ${status}（${call.duration_ms} ms）`);
  lines.push('');
  lines.push(`- 分类：${call.category} · 来源：${call.source} · 风险：${call.risk} · 审批：${call.approval_mode}`);
  lines.push(`- 通道：${call.channel} · 第 ${call.iteration} 轮 · call_id：\`${call.call_id}\``);
  if (call.started_at) lines.push(`- 开始：${iso(call.started_at)}${call.ended_at ? ` · 结束：${iso(call.ended_at)}` : ''}`);
  lines.push('');
  lines.push('参数：');
  lines.push('');
  lines.push(codeBlock(prettyArgs(call.args_json), 'json'));
  lines.push('');
  if (call.status === 'success' || call.result_summary) {
    const summary = truncate(call.result_summary ?? '', EXPORT_RESULT_SUMMARY_MAX);
    lines.push(`结果摘要${call.truncated === 1 ? '（已截断）' : ''}：`);
    lines.push('');
    lines.push(codeBlock(summary));
    lines.push('');
  }
  if (call.error_kind || call.error_msg) {
    lines.push(`错误：${call.error_kind ?? ''} ${call.error_msg ?? ''}`.trim());
    lines.push('');
  }
  return lines;
}

/**
 * 渲染整份导出文档。
 *
 * 结构：头部元信息 → 消息时间线（每条消息后紧跟归属它的工具调用）→ 未归属工具调用 → 统计。
 * 消息按 seq 升序（时间线），工具调用按 created_at 归属到 message_id。
 */
export function renderSessionMarkdown(data: SessionExportData): string {
  const { session, messages, toolCalls } = data;
  const out: string[] = [];

  out.push(`# ${session.title || '新会话'}`);
  out.push('');
  out.push('## 会话信息');
  out.push('');
  out.push(`- 会话 ID：\`${session.id}\``);
  out.push(`- Provider / Model：${session.provider} / ${session.model}`);
  out.push(`- 通道模式：${session.channel_mode}${session.degraded === 1 ? '（已降级）' : ''}`);
  out.push(`- 创建时间：${iso(session.created_at)}`);
  out.push(`- 消息数：${session.message_count} · 累计 tokens：${session.total_tokens}`);
  out.push('');

  const callsByMessage = new Map<string, ToolCallRow[]>();
  const orphanCalls: ToolCallRow[] = [];
  for (const call of toolCalls) {
    if (call.message_id) {
      const list = callsByMessage.get(call.message_id) ?? [];
      list.push(call);
      callsByMessage.set(call.message_id, list);
    } else {
      orphanCalls.push(call);
    }
  }

  out.push('## 消息时间线');
  out.push('');
  if (messages.length === 0) {
    out.push('（本会话暂无消息）');
    out.push('');
  }
  for (const msg of messages) {
    const role = ROLE_LABEL[msg.role] ?? msg.role;
    out.push(`### ${msg.seq}. ${role} · ${iso(msg.created_at)}${msg.is_summary === 1 ? ' · [摘要]' : ''}`);
    out.push('');
    if (msg.reasoning_content) {
      out.push('推理：');
      out.push('');
      out.push(codeBlock(msg.reasoning_content));
      out.push('');
    }
    out.push(codeBlock(msg.content ?? ''));
    out.push('');
    if (msg.tokens > 0) out.push(`tokens：${msg.tokens}`);
    if (msg.finish_reason) out.push(` · 结束原因：${msg.finish_reason}`);
    if (msg.tokens > 0 || msg.finish_reason) out.push('');
    const calls = callsByMessage.get(msg.id);
    if (calls && calls.length > 0) {
      out.push(`**工具调用（${calls.length} 次）**`);
      out.push('');
      for (const call of calls) {
        out.push(...renderToolCall(call));
      }
    }
  }

  if (orphanCalls.length > 0) {
    out.push('## 未归属消息的工具调用');
    out.push('');
    for (const call of orphanCalls) {
      out.push(...renderToolCall(call));
    }
  }

  const byStatus = new Map<string, number>();
  for (const call of toolCalls) {
    byStatus.set(call.status, (byStatus.get(call.status) ?? 0) + 1);
  }
  out.push('## 统计');
  out.push('');
  out.push(`- 消息：${messages.length} 条`);
  out.push(`- 工具调用：${toolCalls.length} 次（${[...byStatus.entries()].map(([s, n]) => `${STATUS_LABEL[s] ?? s} ${n}`).join('、') || '无'}）`);
  out.push(`- 工具总耗时：${toolCalls.reduce((sum, c) => sum + c.duration_ms, 0)} ms`);
  out.push('');
  out.push(`---\n导出时间：${iso(Date.now())}`);
  out.push('');

  return out.join('\n');
}

/** 附件文件名：只含 session id 前 8 位 + UTC 时间戳，不用 title，杜绝 header 注入。 */
export function exportFilename(session: SessionRow, now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `codelens-session-${session.id.slice(0, 8)}-${stamp}.md`;
}

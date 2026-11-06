// SSE 流解析 —— fetch + ReadableStream 手读事件流（spec §11：EventSource 不支持 POST）
// v2.0：十事件统一下划线（meta / delta / reasoning / tool_call / tool_progress /
// tool_result / tool_approval_required / context_notice / done / error）

import type {
  AgentApprovalDedupPayload,
  AgentApprovalPayload,
  AgentContextNoticePayload,
  AgentDeltaPayload,
  AgentDonePayload,
  AgentErrorPayload,
  AgentMetaPayload,
  AgentReasoningPayload,
  AgentSSEEventType,
  AgentStagePayload,
  AgentStreamRequest,
  AgentToolCallPayload,
  AgentToolProgressPayload,
  AgentToolResultPayload,
  ReviewResult,
  RunReport,
  SandboxGrantRequest,
} from '../types';

/**
 * 建立 Agent SSE 连接：POST /api/v1/agent/stream。
 * 注意：HTTP 层可能返回 4xx/5xx（预检失败），此时 body 不是 SSE 而是 JSON 错误。
 */
export async function openAgentStream(request: AgentStreamRequest, signal: AbortSignal): Promise<Response> {
  return fetch('/api/v1/agent/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
}

export interface AgentStreamHandlers {
  /** R3：运行阶段（connecting / upstream_first_byte / reasoning / content / 终局）。 */
  onStage?: (data: AgentStagePayload) => void;
  onMeta?: (data: AgentMetaPayload) => void;
  onDelta?: (data: AgentDeltaPayload) => void;
  onReasoning?: (data: AgentReasoningPayload) => void;
  onToolCall?: (data: AgentToolCallPayload) => void;
  onToolProgress?: (data: AgentToolProgressPayload) => void;
  onToolResult?: (data: AgentToolResultPayload) => void;
  onApproval?: (data: AgentApprovalPayload) => void;
  /** E：可逆写入第二次起沿用上次授权（不弹卡，仅一行提示）。 */
  onApprovalDedup?: (data: AgentApprovalDedupPayload) => void;
  /** R6：可逆调用已执行，等待复核（reviewPending）。 */
  onResultReview?: (data: { callId: string; reviewPending: boolean }) => void;
  /** R6：独立复核结论（可逆为并行回填，不可逆为执行前同步）。 */
  onReviewResult?: (data: { callId: string; result: ReviewResult }) => void;
  /** 工作区外首次访问，需要用户按目录授权。 */
  onSandboxGrant?: (data: SandboxGrantRequest) => void;
  /** RunState 汇报卡（仅「有实质变化」或 everyRun 时下发）。 */
  onRunReport?: (data: RunReport) => void;
  onContextNotice?: (data: AgentContextNoticePayload) => void;
  onDone?: (data: AgentDonePayload) => void;
  onError?: (data: AgentErrorPayload) => void;
}

/** 事件名 → 载荷类型映射（未知事件名走不到这里，直接忽略） */
type PayloadOf<T extends AgentSSEEventType> = T extends 'stage'
  ? AgentStagePayload
  : T extends 'meta'
  ? AgentMetaPayload
  : T extends 'delta'
    ? AgentDeltaPayload
    : T extends 'reasoning'
      ? AgentReasoningPayload
      : T extends 'tool_call'
        ? AgentToolCallPayload
        : T extends 'tool_progress'
          ? AgentToolProgressPayload
          : T extends 'tool_result'
            ? AgentToolResultPayload
            : T extends 'tool_approval_required'
              ? AgentApprovalPayload
              : T extends 'approval_dedup'
                ? AgentApprovalDedupPayload
                : T extends 'result_review'
                ? { callId: string; reviewPending: boolean }
                : T extends 'review_result'
                  ? { callId: string; result: ReviewResult }
                  : T extends 'sandbox_grant_required'
                    ? SandboxGrantRequest
                    : T extends 'run_report'
                      ? RunReport
                      : T extends 'context_notice'
                        ? AgentContextNoticePayload
                        : T extends 'done'
                          ? AgentDonePayload
                          : AgentErrorPayload;

function parseEventData(raw: string): unknown | null {
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // 注释/心跳行
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join('\n'));
  } catch {
    return null;
  }
}

const EVENT_NAMES: AgentSSEEventType[] = [
  'stage',
  'meta',
  'delta',
  'reasoning',
  'tool_call',
  'tool_progress',
  'tool_result',
  'tool_approval_required',
  'approval_dedup',
  'result_review',
  'review_result',
  'sandbox_grant_required',
  'run_report',
  'context_notice',
  'done',
  'error',
];

/**
 * 解析 SSE 响应体：按 \n\n 分帧，逐帧按 event 名分发到对应 handler。
 * 容错：单帧 JSON 损坏时跳过；未知事件名忽略；流尾残留帧尽力解析。
 */
export async function parseAgentSSE(response: Response, handlers: AgentStreamHandlers): Promise<void> {
  const body = response.body;
  if (!body) throw new Error('SSE 响应缺少 body');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (rawFrame: string): void => {
    const normalized = rawFrame.replace(/\r\n/g, '\n');
    let eventName = 'message';
    for (const line of normalized.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
        break;
      }
    }
    if (!EVENT_NAMES.includes(eventName as AgentSSEEventType)) return;
    const data = parseEventData(normalized);
    if (data === null) return;
    const key = eventName as AgentSSEEventType;
    switch (key) {
      case 'stage':
        handlers.onStage?.(data as PayloadOf<'stage'>);
        break;
      case 'meta':
        handlers.onMeta?.(data as PayloadOf<'meta'>);
        break;
      case 'delta':
        handlers.onDelta?.(data as PayloadOf<'delta'>);
        break;
      case 'reasoning':
        handlers.onReasoning?.(data as PayloadOf<'reasoning'>);
        break;
      case 'tool_call':
        handlers.onToolCall?.(data as PayloadOf<'tool_call'>);
        break;
      case 'tool_progress':
        handlers.onToolProgress?.(data as PayloadOf<'tool_progress'>);
        break;
      case 'tool_result':
        handlers.onToolResult?.(data as PayloadOf<'tool_result'>);
        break;
      case 'tool_approval_required':
        handlers.onApproval?.(data as PayloadOf<'tool_approval_required'>);
        break;
      case 'approval_dedup':
        handlers.onApprovalDedup?.(data as PayloadOf<'approval_dedup'>);
        break;
      case 'result_review':
        handlers.onResultReview?.(data as PayloadOf<'result_review'>);
        break;
      case 'review_result':
        handlers.onReviewResult?.(data as PayloadOf<'review_result'>);
        break;
      case 'sandbox_grant_required':
        handlers.onSandboxGrant?.(data as PayloadOf<'sandbox_grant_required'>);
        break;
      case 'run_report':
        handlers.onRunReport?.(data as PayloadOf<'run_report'>);
        break;
      case 'context_notice':
        handlers.onContextNotice?.(data as PayloadOf<'context_notice'>);
        break;
      case 'done':
        handlers.onDone?.(data as PayloadOf<'done'>);
        break;
      case 'error':
        handlers.onError?.(data as PayloadOf<'error'>);
        break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // 先归一化 CRLF 再分帧：若上游/反代用 \r\n\r\n 分帧，按 '\n\n' 切会一直切不出来，
    // 表现为「流式不吐字、结束时一次性出现」。在追加时整段归并可兼顾跨 chunk 的 \r|\n 边界。
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      dispatch(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf('\n\n');
    }
  }
  const tail = buffer.trim();
  if (tail) dispatch(tail);
}

/** 主动中止：POST /api/v1/agent/abort（浏览器 abort 为主，此为备选通道） */
export async function abortAgentRun(sessionId: string): Promise<void> {
  await fetch('/api/v1/agent/abort', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  }).catch(() => undefined);
}

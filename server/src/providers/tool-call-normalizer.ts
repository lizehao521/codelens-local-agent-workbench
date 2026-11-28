/**
 * Streaming tool-call accumulator: reconstructs complete tool calls from upstream
 * delta fragments (architecture 7.2.2). Pure functions, no IO — unit-testable.
 *
 * The old adapter concatenated argument fragments into delta text and dropped
 * id/name/index, which is fatal for agent flows (upstream 400 on tool results,
 * TOOL_NOT_FOUND, misaligned parallel results). This module is the single place
 * where fragments are merged.
 */

export interface RawToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface NormalizedToolCall {
  index: number;
  id: string;
  /** Wire name as returned by the provider (resolve via the registry reverse index). */
  name: string;
  rawArguments: string;
  arguments: Record<string, unknown>;
  parseError?: 'EMPTY_ARGS' | 'INVALID_JSON' | 'MISSING_ID' | 'MISSING_NAME';
}

interface Accumulator {
  index: number;
  id: string;
  name: string;
  argFragments: string[];
  objectArgs?: Record<string, unknown>;
  seen: boolean;
}

export interface ToolCallAccumulator {
  readonly calls: Map<number, Accumulator>;
  /** 无 index 的提供商：当前分槽游标 + 按 id 反查，避免多个调用折叠串台（A22-N-1）。 */
  fallbackIndex: number;
  readonly idToIndex: Map<string, number>;
}

/** Factory: isolates mutable state so tests can drive one accumulator per case. */
export function createToolCallAccumulator(): ToolCallAccumulator {
  return { calls: new Map(), fallbackIndex: 0, idToIndex: new Map() };
}

/**
 * 解析本帧应落入的槽：
 * - 带合法 index：原样使用（并行调用的标准路径）。
 * - 无 index 且带非空 id：单调用提供商的常见形态。首次出现的 id 分配一个新槽，
 *   已出现的 id 复用其槽——这样两个不同的无-index 调用不会折叠串台。
 * - 无 index 且无 id：片段续帧，落到 fallbackIndex 游标指向的槽（兼容单调用多帧）。
 */
function resolveIndex(acc: ToolCallAccumulator, delta: RawToolCallDelta): number {
  if (typeof delta.index === 'number' && Number.isFinite(delta.index) && delta.index >= 0) {
    return Math.trunc(delta.index);
  }
  if (typeof delta.id === 'string' && delta.id.length > 0) {
    const known = acc.idToIndex.get(delta.id);
    if (known !== undefined) return known;
    const next = Math.max(-1, ...acc.calls.keys()) + 1;
    acc.idToIndex.set(delta.id, next);
    acc.fallbackIndex = next;
    return next;
  }
  // 无 index 也无 id：续帧，落到当前游标。
  return acc.fallbackIndex;
}

/** Feeds one delta array (typically one SSE frame's delta.tool_calls). */
export function accumulate(acc: ToolCallAccumulator, deltas: readonly RawToolCallDelta[]): void {
  for (const delta of deltas) {
    const index = resolveIndex(acc, delta);
    let call = acc.calls.get(index);
    if (!call) {
      call = { index, id: '', name: '', argFragments: [], seen: true };
      acc.calls.set(index, call);
    }
    // id / name lock to the first non-empty value (later fragments send "" / null).
    if (call.id === '' && typeof delta.id === 'string' && delta.id.length > 0) {
      call.id = delta.id;
      acc.idToIndex.set(delta.id, index); // 带 index 的调用也登记，供后续无-index 续帧复用。
    }
    if (call.name === '' && typeof delta.function?.name === 'string' && delta.function.name.length > 0) {
      call.name = delta.function.name;
    }
    const args = delta.function?.arguments;
    if (typeof args === 'string' && args.length > 0) {
      call.argFragments.push(args);
    } else if (args && typeof args === 'object' && !Array.isArray(args)) {
      // Non-standard providers may send the object directly. 与字符串分片合并而非丢弃（A22-N-3）。
      call.objectArgs = { ...(call.objectArgs ?? {}), ...(args as Record<string, unknown>) };
    }
  }
}

function parseArguments(raw: string): { arguments: Record<string, unknown>; parseError?: NormalizedToolCall['parseError'] } {
  if (raw.trim() === '') return { arguments: {} }; // no-arg tool: legal, not an error
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { arguments: parsed as Record<string, unknown> };
    }
    return { arguments: {}, parseError: 'INVALID_JSON' };
  } catch {
    return { arguments: {}, parseError: 'INVALID_JSON' };
  }
}

/** Finalizes the stream: complete calls sorted by index, with parse-error markers. */
export function finalize(acc: ToolCallAccumulator): NormalizedToolCall[] {
  const out: NormalizedToolCall[] = [];
  for (const call of [...acc.calls.values()].sort((a, b) => a.index - b.index)) {
    const parseErrors: NormalizedToolCall['parseError'][] = [];
    if (call.id === '') parseErrors.push('MISSING_ID');
    if (call.name === '') parseErrors.push('MISSING_NAME');

    let args: Record<string, unknown> = {};
    let rawArguments = call.argFragments.join('');
    let parseError = parseErrors[0];
    const parsed = parseArguments(rawArguments);
    if (call.objectArgs !== undefined) {
      // A22-N-3：对象帧与字符串分片并存时合并两者，对象键优先；不再静默丢弃分片。
      args = { ...parsed.arguments, ...call.objectArgs };
      rawArguments = JSON.stringify(args);
      // 字符串分片非法 JSON 但对象帧已给出完整参数时，不再误报 INVALID_JSON。
    } else {
      args = parsed.arguments;
      if (parsed.parseError) {
        // A22-N-4：结构性错误（缺 id/name）优先于 JSON 解析错误，不被覆盖。
        if (!parseError) parseError = parsed.parseError;
      }
    }
    out.push({
      index: call.index,
      id: call.id,
      name: call.name,
      rawArguments,
      arguments: args,
      parseError,
    });
  }
  return out;
}

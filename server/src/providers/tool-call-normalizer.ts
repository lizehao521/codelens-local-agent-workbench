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
}

/** Factory: isolates mutable state so tests can drive one accumulator per case. */
export function createToolCallAccumulator(): ToolCallAccumulator {
  return { calls: new Map() };
}

/** Feeds one delta array (typically one SSE frame's delta.tool_calls). */
export function accumulate(acc: ToolCallAccumulator, deltas: readonly RawToolCallDelta[]): void {
  for (const delta of deltas) {
    // Missing index means single-call providers: fold everything into slot 0.
    const index = typeof delta.index === 'number' && delta.index >= 0 ? delta.index : 0;
    let call = acc.calls.get(index);
    if (!call) {
      call = { index, id: '', name: '', argFragments: [], seen: true };
      acc.calls.set(index, call);
    }
    // id / name lock to the first non-empty value (later fragments send "" / null).
    if (call.id === '' && typeof delta.id === 'string' && delta.id.length > 0) call.id = delta.id;
    if (call.name === '' && typeof delta.function?.name === 'string' && delta.function.name.length > 0) {
      call.name = delta.function.name;
    }
    const args = delta.function?.arguments;
    if (typeof args === 'string' && args.length > 0) {
      call.argFragments.push(args);
    } else if (args && typeof args === 'object' && !Array.isArray(args)) {
      // Non-standard providers may send the object directly.
      call.objectArgs = args as Record<string, unknown>;
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
    let rawArguments = '';
    let parseError = parseErrors[0];
    if (call.objectArgs !== undefined) {
      args = call.objectArgs;
      rawArguments = JSON.stringify(call.objectArgs);
    } else {
      rawArguments = call.argFragments.join('');
      const parsed = parseArguments(rawArguments);
      args = parsed.arguments;
      if (parsed.parseError) parseError = parsed.parseError;
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

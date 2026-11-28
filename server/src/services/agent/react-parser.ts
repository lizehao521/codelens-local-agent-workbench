/**
 * Channel B parser (architecture 7.3): three-level degradation for ReAct output.
 *
 *   L1  tool_call tags wrapping a JSON object (the canonical format)
 *   L2  first balanced {...} in the whole text, must contain a "tool" field
 *   L3  regex "tool"\s*:\s*"NAME" plus the adjacent balanced "arguments" object
 *
 * All levels fail and no tool intent at all  -> kind 'none' (T-1 stop, plain text).
 * Tool name present but arguments unparseable -> kind 'invalid' (TOOL_ARGS_INVALID,
 * fed back to the model without consuming the retry budget).
 *
 * Pure functions only: no I/O; ids come from a module counter + timestamp.
 */

export interface ReactToolCall {
  id: string;
  /** Name as written by the model (wire or canonical - the resolver normalizes). */
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
}

export type ReactParseResult =
  | { kind: 'none' }
  | { kind: 'calls'; text: string; toolCalls: ReactToolCall[]; warnings: string[] }
  | { kind: 'invalid'; text: string; error: { message: string } };

const OPEN_TAG = String.fromCharCode(60) + 'tool_call' + String.fromCharCode(62);
const CLOSE_TAG = String.fromCharCode(60) + '/tool_call' + String.fromCharCode(62);

let reactCallSeq = 0;

function nextCallId(): string {
  reactCallSeq += 1;
  return `call_react_${reactCallSeq.toString(36)}_${Date.now().toString(36)}`;
}

/**
 * Scans for the first balanced {...} starting at or after `from`, respecting
 * string literals and escapes. Returns the slice bounds, or null.
 */
function scanBalancedObject(text: string, from: number): { start: number; end: number } | null {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

interface ParsedCall {
  name: string;
  args: Record<string, unknown>;
  rawArguments: string;
}

/** Validates one decoded tool-call object. */
function decodeCallObject(value: unknown): { ok: true; call: ParsedCall } | { ok: false; message: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: '工具调用必须是 JSON 对象' };
  }
  const record = value as Record<string, unknown>;
  const name = record.tool ?? record.name;
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, message: '工具调用缺少 "tool" 字段（工具名）' };
  }
  const rawArgs = record.arguments;
  if (rawArgs === undefined || rawArgs === null) {
    return { ok: true, call: { name, args: {}, rawArguments: '{}' } };
  }
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return { ok: false, message: `工具 ${name} 的 arguments 必须是 JSON 对象` };
  }
  return {
    ok: true,
    call: { name, args: rawArgs as Record<string, unknown>, rawArguments: JSON.stringify(rawArgs) },
  };
}

/** L1: every tool_call block must decode; one bad block invalidates the turn. */
function parseTagged(text: string): ReactParseResult | null {
  if (!text.includes(OPEN_TAG)) return null;
  const calls: ReactToolCall[] = [];
  let cursor = 0;
  let residual = '';
  for (;;) {
    const open = text.indexOf(OPEN_TAG, cursor);
    if (open < 0) {
      residual += text.slice(cursor);
      break;
    }
    residual += text.slice(cursor, open);
    const close = text.indexOf(CLOSE_TAG, open + OPEN_TAG.length);
    const body = close < 0 ? text.slice(open + OPEN_TAG.length) : text.slice(open + OPEN_TAG.length, close);
    let decoded: unknown;
    try {
      decoded = JSON.parse(body.trim());
    } catch {
      return { kind: 'invalid', text, error: { message: '工具调用块不是合法 JSON（TOOL_ARGS_INVALID）' } };
    }
    const result = decodeCallObject(decoded);
    if (!result.ok) {
      // TypeScript narrowing issue - use explicit type assertion
      const errorMsg = (result as { ok: false; message: string }).message;
      return { kind: 'invalid', text, error: { message: `${errorMsg}（TOOL_ARGS_INVALID）` } };
    }
    const call = result.call;
    calls.push({
      id: nextCallId(),
      name: call.name,
      arguments: call.args,
      rawArguments: call.rawArguments,
    });
    cursor = close < 0 ? text.length : close + CLOSE_TAG.length;
  }
  if (calls.length === 0) return { kind: 'none' };
  return { kind: 'calls', text: residual.trim(), toolCalls: calls, warnings: [] };
}

/** L2: the first balanced object anywhere in the text, when it carries a "tool" field. */
function parseBalancedFallback(text: string): ReactParseResult | null {
  const bounds = scanBalancedObject(text, 0);
  if (!bounds) return null;
  const slice = text.slice(bounds.start, bounds.end);
  let decoded: unknown;
  try {
    decoded = JSON.parse(slice);
  } catch {
    return null;
  }
  const result = decodeCallObject(decoded);
  if (!result.ok) return null;
  const residual = (text.slice(0, bounds.start) + text.slice(bounds.end)).trim();
  return {
    kind: 'calls',
    text: residual,
    toolCalls: [
      { id: nextCallId(), name: result.call.name, arguments: result.call.args, rawArguments: result.call.rawArguments },
    ],
    warnings: ['模型输出缺少工具调用标签，已按降级策略（平衡对象）解析'],
  };
}

/** L3: regex tool name + the adjacent balanced "arguments" object. */
function parseRegexFallback(text: string): ReactParseResult | null {
  const nameMatch = /"tool"\s*:\s*"([^"]+)"/.exec(text);
  if (!nameMatch) return null;
  const name = nameMatch[1]!;

  // 从 tool 名之后向后扫，维护相对深度；只在 depth===0 处接受 "arguments" 键，
  // 跳过嵌套对象（如 "data":{"arguments":...}）内的同名键。
  let argsKey = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = nameMatch.index + nameMatch[0].length; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth === 0 && text.startsWith('arguments"', i + 1)) { argsKey = i; break; }
      inString = true;
    } else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }

  if (argsKey < 0) {
    return {
      kind: 'calls',
      text: text.replace(nameMatch[0]!, '').trim(),
      toolCalls: [{ id: nextCallId(), name, arguments: {}, rawArguments: '{}' }],
      warnings: ['模型输出被截断或混入散文，已按降级策略（正则）解析，arguments 缺失按空对象处理'],
    };
  }
  const colon = text.indexOf(':', argsKey + '"arguments"'.length);
  if (colon < 0) return null;
  const bounds = scanBalancedObject(text, colon + 1);
  if (!bounds) {
    return {
      kind: 'invalid',
      text,
      error: { message: `工具 ${name} 的 arguments 不是完整 JSON 对象（TOOL_ARGS_INVALID）` },
    };
  }
  const rawArguments = text.slice(bounds.start, bounds.end);
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawArguments);
  } catch {
    return {
      kind: 'invalid',
      text,
      error: { message: `工具 ${name} 的 arguments 不是合法 JSON（TOOL_ARGS_INVALID）` },
    };
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return { kind: 'invalid', text, error: { message: `工具 ${name} 的 arguments 必须是 JSON 对象（TOOL_ARGS_INVALID）` } };
  }
  const residual = (text.slice(0, nameMatch.index) + text.slice(bounds.end)).trim();
  return {
    kind: 'calls',
    text: residual,
    toolCalls: [{ id: nextCallId(), name, arguments: decoded as Record<string, unknown>, rawArguments }],
    warnings: ['模型输出被截断或混入散文，已按降级策略（正则）解析'],
  };
}

/** Removes consumed tool-call markup from text (used when echoing the residual answer). */
export function stripConsumed(text: string): string {
  const pattern = new RegExp(OPEN_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?(?:' + CLOSE_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|$)', 'g');
  return text.replace(pattern, '').trim();
}

/**
 * L0: Try to parse as JSON protocol format {"tool": "name", "arguments": {...}}
 * This supports models that output JSON protocol instead of XML-style tags.
 */
function parseJsonProtocol(text: string): ReactParseResult | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
  const record = decoded as Record<string, unknown>;
  // Support both "tool" and "name" field for tool name
  const name = record.tool ?? record.name;
  if (typeof name !== 'string' || name.length === 0) return null;
  const rawArgs = record.arguments;
  let args: Record<string, unknown> = {};
  if (rawArgs !== undefined && rawArgs !== null) {
    if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return null;
    args = rawArgs as Record<string, unknown>;
  }
  const rawArguments = JSON.stringify(args);
  return {
    kind: 'calls',
    text: '',
    toolCalls: [{
      id: nextCallId(),
      name,
      arguments: args,
      rawArguments,
    }],
    warnings: ['JSON 协议格式解析成功'],
  };
}

export function parseReactOutput(text: string): ReactParseResult {
  // L0: JSON protocol format (e.g., {"tool": "name", "arguments": {...}})
  const jsonProtocol = parseJsonProtocol(text);
  if (jsonProtocol) return jsonProtocol;
  // L1: XML-style tool_call tags
  const tagged = parseTagged(text);
  if (tagged) return tagged;
  // L2: Balanced object with "tool" field
  const balanced = parseBalancedFallback(text);
  if (balanced) return balanced;
  // L3: Regex fallback
  const regex = parseRegexFallback(text);
  if (regex) return regex;
  return { kind: 'none' };
}

/**
 * JSON 自动修复工具：针对常见的、无歧义的 JSON 格式错误做保守修复。
 * 只处理确定性、无歧义的损坏；无法安全恢复时返回失败，保留原有回灌语义。
 * 每个 bad call 最多尝试一次自动修复（由调用方控制）。
 */

export interface RepairResult {
  ok: boolean;
  value?: Record<string, unknown> | unknown[];
  repaired: boolean;
  error?: string;
}

/**
 * 尝试修复常见的 JSON 格式错误
 * @param raw 原始 JSON 字符串
 * @returns 修复结果，包含是否成功、修复后的值、是否进行了修复
 */
export function repairJson(raw: string): RepairResult {
  const trimmed = raw.trim();
  
  if (trimmed === '') {
    return { ok: false, repaired: false, error: 'Empty input' };
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown>, repaired: false };
    }
    if (Array.isArray(parsed)) {
      return { ok: true, value: parsed, repaired: false };
    }
    return { ok: false, repaired: false, error: 'Top-level must be object or array' };
  } catch {
  }

  let repaired = trimmed;
  let didRepair = false;

  const singleQuoteFixed = fixSingleQuotes(repaired);
  if (singleQuoteFixed !== repaired) {
    repaired = singleQuoteFixed;
    didRepair = true;
  }

  const trailingCommaFixed = fixTrailingCommas(repaired);
  if (trailingCommaFixed !== repaired) {
    repaired = trailingCommaFixed;
    didRepair = true;
  }

  const braceFixed = fixMissingBraces(repaired);
  if (braceFixed !== repaired) {
    repaired = braceFixed;
    didRepair = true;
  }

  const escapeFixed = fixUnescapedChars(repaired);
  if (escapeFixed !== repaired) {
    repaired = escapeFixed;
    didRepair = true;
  }

  try {
    const parsed = JSON.parse(repaired);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown>, repaired: didRepair };
    }
    if (Array.isArray(parsed)) {
      return { ok: true, value: parsed, repaired: didRepair };
    }
    return { ok: false, repaired: false, error: 'Top-level must be object or array after repair' };
  } catch (e) {
    return { ok: false, repaired: false, error: `Repair failed: ${e instanceof Error ? e.message : 'Unknown error'}` };
  }
}

function fixSingleQuotes(input: string): string {
  let result = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let escapeNext = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escapeNext) {
      result += ch;
      escapeNext = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      escapeNext = true;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      result += ch;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      if (!inSingleQuote) {
        inSingleQuote = true;
        result += '"';
      } else {
        inSingleQuote = false;
        result += '"';
      }
      continue;
    }

    result += ch;
  }

  return result;
}

function fixTrailingCommas(input: string): string {
  let result = '';
  let inString = false;
  let stringChar = '';
  let escapeNext = false;
  const chars = input.split('');

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];

    if (escapeNext) {
      result += ch;
      escapeNext = false;
      continue;
    }

    if (ch === '\\' && inString) {
      result += ch;
      escapeNext = true;
      continue;
    }

    if ((ch === '"' || ch === "'") && !escapeNext) {
      if (!inString) {
        inString = true;
        stringChar = ch;
      } else if (ch === stringChar) {
        inString = false;
        stringChar = '';
      }
      result += ch;
      continue;
    }

    if (ch === ',' && !inString) {
      let j = i + 1;
      while (j < chars.length && /\s/.test(chars[j]!)) {
        j++;
      }
      if (j < chars.length && (chars[j]! === '}' || chars[j]! === ']')) {
        continue;
      }
    }

    result += ch;
  }

  return result;
}

function fixMissingBraces(input: string): string {
  let result = input;
  let braceStack: string[] = [];
  let inString = false;
  let stringChar = '';
  let escapeNext = false;

  for (const ch of input) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if ((ch === '"' || ch === "'") && !escapeNext) {
      if (!inString) {
        inString = true;
        stringChar = ch;
      } else if (ch === stringChar) {
        inString = false;
        stringChar = '';
      }
      continue;
    }

    if (!inString) {
      if (ch === '{' || ch === '[') {
        braceStack.push(ch === '{' ? '}' : ']');
      } else if (ch === '}' || ch === ']') {
        if (braceStack.length > 0 && braceStack[braceStack.length - 1] === ch) {
          braceStack.pop();
        }
      }
    }
  }

  while (braceStack.length > 0) {
    result += braceStack.pop();
  }

  return result;
}

function fixUnescapedChars(input: string): string {
  let result = '';
  let inString = false;
  let stringChar = '';
  let escapeNext = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escapeNext) {
      result += ch;
      escapeNext = false;
      continue;
    }

    if (ch === '\\' && inString) {
      result += ch;
      escapeNext = true;
      continue;
    }

    if ((ch === '"' || ch === "'") && !escapeNext) {
      if (!inString) {
        inString = true;
        stringChar = ch;
      } else if (ch === stringChar) {
        inString = false;
        stringChar = '';
      }
      result += ch;
      continue;
    }

    if (inString && stringChar === '"') {
      switch (ch) {
        case '\n':
          result += '\\n';
          continue;
        case '\r':
          result += '\\r';
          continue;
        case '\t':
          result += '\\t';
          continue;
        case '\b':
          result += '\\b';
          continue;
        case '\f':
          result += '\\f';
          continue;
        case '"':
          result += '\\"';
          continue;
        case '\\':
          result += '\\\\';
          continue;
      }
    }

    result += ch;
  }

  return result;
}
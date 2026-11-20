/**
 * P2′ 零进展停止：失败签名规范化（密钥脱敏、路径去前缀、行号/版本归一）。
 * 从 cross-generation-stall.ts 拆出（结构棘轮 ≤300 行）。
 */

import type { FailureInput } from './cross-generation-stall.types.js';

// ---------------------------------------------------------------------------
// 内部工具：密钥脱敏
// ---------------------------------------------------------------------------

/**
 * 对文本中的密钥模式进行脱敏替换。
 * 覆盖：Bearer token、sk-xxx、api_key=、password=、token=、Authorization header。
 */
function redactSecrets(text: string): string {
  return text
    // Authorization: Bearer <token>
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;"']+/gi, '$1[REDACTED]')
    // sk-<key>
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED_SK]')
    // api_key=<value> 或 api_key: <value>
    .replace(/(api_key\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    // password=<value> 或 password: <value>
    .replace(/(password\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    // token=<value> 或 token: <value>（不含 Bearer 已处理的情况）
    .replace(/(\btoken\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    // secret=<value>
    .replace(/(\bsecret\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
}

// ---------------------------------------------------------------------------
// 内部工具：路径规范化
// ---------------------------------------------------------------------------

/**
 * 将绝对路径规范化为相对路径主干。
 * 策略：去掉已知前缀（/workspace/...、/tmp/...、/home/... 等），
 * 保留从 src/ 或最后一个有意义目录开始的部分。
 * 若无法识别前缀，则保留路径最后两段。
 */
function normalizePath(rawPath: string): string {
  // 统一分隔符
  const p = rawPath.replace(/\\/g, '/');
  // 尝试截取 src/ 之后的部分
  const srcMatch = p.match(/(?:^|\/)(src\/.+)$/);
  if (srcMatch !== null && srcMatch[1] !== undefined) {
    return srcMatch[1];
  }
  // 去掉常见绝对前缀
  const stripped = p.replace(/^(?:\/(?:workspace|tmp|home|var|opt|usr|root|build|dist|out)\/[^\s]*?\/)+/, '');
  if (stripped !== p && stripped.length > 0) {
    return stripped;
  }
  // 兜底：取最后两段
  const parts = p.split('/').filter((s) => s.length > 0);
  if (parts.length >= 2) {
    return parts.slice(-2).join('/');
  }
  return parts.join('/');
}

// ---------------------------------------------------------------------------
// 内部工具：行号/列号归一
// ---------------------------------------------------------------------------

/** 将 file.ts:42:10 或 file.ts:42 中的行号列号替换为占位符 */
function normalizeLineCol(text: string): string {
  // 匹配 path:line:col 或 path:line（在路径上下文中）
  return text.replace(/(\.[a-zA-Z]+):(\d+)(?::(\d+))?/g, (_m, ext: string) => `${ext}:LINE`);
}

// ---------------------------------------------------------------------------
// 内部工具：版本号归一
// ---------------------------------------------------------------------------

/** 将 v1.2.3 / 1.2.3 等语义版本号替换为占位符 */
function normalizeVersions(text: string): string {
  return text.replace(/\bv?\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?\b/g, 'VERSION');
}

// ---------------------------------------------------------------------------
// 轮1：失败签名规范化
// ---------------------------------------------------------------------------

/**
 * 对失败输入进行规范化，生成可比较的签名字符串。
 *
 * 处理步骤（顺序固定）：
 *   1. 密钥脱敏
 *   2. 路径去前缀
 *   3. 行号/列号归一
 *   4. 版本号归一
 *   5. 空白折叠
 *   6. 拼接 errorType + 规范化消息主干
 */
export function normalizeFailureSignature(failure: FailureInput): string {
  const rawMessage = failure.message ?? failure.rawText;

  // 1. 密钥脱敏
  let text = redactSecrets(rawMessage);

  // 2. 路径去前缀：匹配类 Unix 绝对路径
  text = text.replace(/(?:\/[^\s/]+)+\/[^\s:,]+/g, (match) => normalizePath(match));

  // 3. 行号/列号归一
  text = normalizeLineCol(text);

  // 4. 版本号归一
  text = normalizeVersions(text);

  // 5. 空白折叠
  text = text.replace(/\s+/g, ' ').trim();

  // 6. 拼接 errorType 前缀
  const prefix = failure.errorType !== undefined && failure.errorType.length > 0
    ? `${failure.errorType}::`
    : '';

  return `${prefix}${text}`;
}

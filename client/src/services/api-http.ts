// API HTTP 核心：BASE / 查询串 / 错误体解析 / 脱敏 / get / send。
// 从 api.ts 抽出（api.ts 只保留业务端点），公开导出面不变。

export const BASE = '/api/v1';

/**
 * 拼查询串：跳过 undefined 与空串，返回带 `?` 的后缀（无参数时原样返回 path）。
 *
 * 此前每个带参数的端点都手写一遍「建 qs → set → toString → 判断有无 ?」，
 * 四份几乎一模一样；而漏掉空值判断就会发出 `?limit=undefined` 这类请求 ——
 * 服务端要额外做一次解析容错才能不报错。空串同样跳过：`?q=` 与不带 q 语义不同。
 */
export function withQuery(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const text = String(value);
    if (text.length === 0) continue;
    qs.set(key, text);
  }
  const suffix = qs.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export class ApiError extends Error {
  code: string;
  status: number;
  /** 422 时携带被拒目录及原因（沙箱权限），便于前端高亮。 */
  rejected?: Array<{ dir: string; error: string }>;
  constructor(code: string, message: string, status: number, rejected?: Array<{ dir: string; error: string }>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.rejected = rejected;
  }
}

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|authorization)/i;

/**
 * 递归打码疑似密钥字段：字段名匹配 apiKey/token/secret/password/authorization 时值置为脱敏占位。
 * 用于任何可能进入日志 / UI 的接口载荷，避免 API Key 经错误响应泄露（F-02）。
 */
export function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(
      /(api[_-]?key|secret|token|password|authorization)\s*[:=]\s*\S+/gi,
      '$1: ***REDACTED***',
    ) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = Array.isArray(value)
      ? ([] as unknown as Record<string, unknown>)
      : {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k) && typeof v === 'string') out[k] = '***REDACTED***';
      else out[k] = redactSecrets(v);
    }
    return out as T;
  }
  return value;
}

export async function parseErrorResponse(res: Response): Promise<ApiError> {
  try {
    const raw = (await res.json()) as {
      error?: { code?: string; message?: string } | string;
      message?: string;
      rejected?: Array<{ dir: string; error: string }>;
    };
    // 服务端错误体可能回显含密钥的上下文，先整体脱敏再取值。
    const data = redactSecrets(raw);
    if (data && typeof data.error === 'object' && data.error !== null) {
      const code = data.error.code ?? `HTTP_${res.status}`;
      const message = data.error.message ?? `请求失败（HTTP ${res.status}）`;
      return new ApiError(code, message, res.status, data.rejected);
    }
    const code = typeof data.error === 'string' ? data.error : `HTTP_${res.status}`;
    const message = data.message ?? `请求失败（HTTP ${res.status}）`;
    return new ApiError(code, message, res.status, data.rejected);
  } catch {
    return new ApiError(`HTTP_${res.status}`, `请求失败（HTTP ${res.status}）`, res.status);
  }
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw await parseErrorResponse(res);
  return (await res.json()) as T;
}

export async function send<T>(path: string, body?: unknown, method = 'POST', deviceToken?: string | null): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (deviceToken) headers['X-Device-Token'] = deviceToken;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return (await res.json()) as T;
}

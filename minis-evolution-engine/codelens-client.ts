/**
 * CodeLens API 客户端 - 推送提案、轮询审批、触发验收
 * 支持重试、指数退避、超时处理
 * 
 * 端点映射（与 CodeLens 侧 rsi-apply.routes.ts 严格对齐）：
 * - POST /api/v1/rsi/apply-patch     -> 应用 Patch
 * - POST /api/v1/rsi/verify          -> 运行验收
 * - GET  /api/v1/rsi/proposals/:id   -> 查看提案详情
 * - POST /api/v1/rsi/verification    -> CodeLens 侧回传验收结果（Minis 不调用，只接收）
 */

import type {
  CandidateProposal,
  UnifiedError,
  EvolutionEngineConfig,
} from './types.js';

// ========== 与 CodeLens 侧严格对齐的契约 ==========

export interface ApplyPatchRequest {
  proposalId: string;
  patch: string;
  targetPath: string;
  kind: 'patch' | 'skill' | 'eval';
}

export interface ApplyPatchResponse {
  applied: boolean;
  filesChanged: string[];
}

export interface VerifyRequest {
  proposalId: string;
  suite: 'acceptance' | 'unit' | 'e2e';
}

export interface VerifyResponse {
  proposalId: string;
  suite: string;
  passed: number;
  total: number;
  score: number;
  regression: boolean;
  durationMs: number;
  logs: string[];
}

export interface ProposalDetailResponse {
  id: string;
  kind: 'patch' | 'skill' | 'eval';
  targetPath: string;
  patch?: string;
  code?: string;
  meta: {
    score: number;
    evidence: Array<{ type: string; description: string; data?: Record<string, unknown> }>;
    mutationKillRate: number;
    generatedAt: string;
    strategy: string;
  };
}

export interface HealthResponse {
  status: string;
  uptime: number;
  version: string;
  db: { ok: boolean; sizeBytes: number; degraded: boolean; tables: number; expectedTables: number };
  mcp: { servers: number; healthy: number };
  sandbox: { rootConfigured: boolean; writable: boolean };
}

// ========== 内部类型 ==========

interface HttpResponse<T> {
  ok: boolean;
  status: number;
  data: T | UnifiedError;
}

interface RetryConfig {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

// ========== HTTP 封装 ==========

async function httpRequest<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number },
  retry: RetryConfig
): Promise<HttpResponse<T>> {
  const { timeoutMs = 30_000, ...fetchOptions } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retry.attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...fetchOptions.headers,
        },
      });

      clearTimeout(timeout);

      const text = await response.text();
      let data: T | UnifiedError;
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = { error: { code: 'PARSE_ERROR', message: '响应非 JSON', details: { raw: text.slice(0, 500) } } };
      }

      if (!response.ok) {
        return { ok: false, status: response.status, data };
      }

      return { ok: true, status: response.status, data };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));

      if (attempt === retry.attempts) break;

      const delay = Math.min(
        retry.baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000,
        retry.maxDelayMs
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }

  return {
    ok: false,
    status: 0,
    data: { error: { code: 'NETWORK_ERROR', message: lastError?.message ?? '未知网络错误' } },
  };
}

// ========== CodeLens 客户端类 ==========

export interface CodeLensClientOptions {
  baseUrl: string;
  apiKey?: string;
  retry?: Partial<RetryConfig>;
  defaultTimeoutMs?: number;
}

export class CodeLensClient {
  private baseUrl: string;
  private apiKey?: string;
  private retry: RetryConfig;
  private defaultTimeoutMs: number;

  constructor(options: CodeLensClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.retry = {
      attempts: options.retry?.attempts ?? 3,
      baseDelayMs: options.retry?.baseDelayMs ?? 1000,
      maxDelayMs: options.retry?.maxDelayMs ?? 10_000,
    };
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private getApiBase(): string {
    return `${this.baseUrl}/api/v1/rsi`;
  }

  // 1. 推送 Patch（对齐 POST /api/v1/rsi/apply-patch）
  async applyPatch(
    proposalId: string,
    patch: string,
    targetPath: string,
    kind: 'patch' | 'skill' | 'eval'
  ): Promise<HttpResponse<ApplyPatchResponse>> {
    return httpRequest<ApplyPatchResponse>(
      `${this.getApiBase()}/apply-patch`,
      {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({ proposalId, patch, targetPath, kind }),
      },
      this.retry
    );
  }

  // 2. 触发验收（对齐 POST /api/v1/rsi/verify）
  async verify(
    proposalId: string,
    suite: 'acceptance' | 'unit' | 'e2e'
  ): Promise<HttpResponse<VerifyResponse>> {
    return httpRequest<VerifyResponse>(
      `${this.getApiBase()}/verify`,
      {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({ proposalId, suite }),
      },
      this.retry
    );
  }

  // 3. 获取提案详情（对齐 GET /api/v1/rsi/proposals/:id）
  async getProposal(proposalId: string): Promise<HttpResponse<ProposalDetailResponse>> {
    return httpRequest<ProposalDetailResponse>(
      `${this.getApiBase()}/proposals/${proposalId}`,
      {
        method: 'GET',
        headers: this.getAuthHeaders(),
      },
      this.retry
    );
  }

  // 4. 获取反思报告（对齐 GET /api/v1/rsi/reflection）
  async getReflection(limit: number = 10): Promise<HttpResponse<{ reflections: Array<{ at: string; gaps?: unknown[]; evidence?: unknown[] }>; total: number }>> {
    return httpRequest<{ reflections: Array<{ at: string; gaps?: unknown[]; evidence?: unknown[] }>; total: number }>(
      `${this.getApiBase()}/reflection?limit=${limit}`,
      {
        method: 'GET',
        headers: this.getAuthHeaders(),
      },
      this.retry
    );
  }

  // 5. 获取失败 Run 摘要（对齐 GET /api/v1/rsi/failed-runs）
  async getFailedRuns(limit: number = 20): Promise<HttpResponse<{ failedRuns: Array<{ runId: string; verdicts: Array<{ reason: string }>; createdAt: number }>; total: number }>> {
    return httpRequest<{ failedRuns: Array<{ runId: string; verdicts: Array<{ reason: string }>; createdAt: number }>; total: number }>(
      `${this.getApiBase()}/failed-runs?limit=${limit}`,
      {
        method: 'GET',
        headers: this.getAuthHeaders(),
      },
      this.retry
    );
  }

  // 6. 健康检查
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ========== 从配置创建客户端 ==========

export function createClientFromConfig(config: EvolutionEngineConfig): CodeLensClient {
  return new CodeLensClient({
    baseUrl: config.codeLensUrl,
    apiKey: config.apiKey || process.env.CODELENS_API_KEY,
    retry: {
      attempts: config.retryAttempts,
      baseDelayMs: config.retryBaseDelayMs,
      maxDelayMs: 30_000,
    },
    defaultTimeoutMs: config.timeoutMs,
  });
}

// ========== 批量推送并轮询编排（简化版：仅 applyPatch + verify） ==========

export interface PushAndPollResult {
  proposalId: string;
  verdict: 'accepted' | 'rejected' | 'pending' | 'timeout';
  reason?: string;
  applied?: boolean;
  verifyScore?: number;
}

export async function pushAndPollAll(
  client: CodeLensClient,
  proposals: Array<{
    proposalId: string;
    patch: string;
    targetPath: string;
    kind: 'patch' | 'skill' | 'eval';
  }>,
  options?: {
    verifySuite?: 'acceptance' | 'unit' | 'e2e';
    onProgress?: (completed: number, total: number) => void;
  }
): Promise<PushAndPollResult[]> {
  const { verifySuite = 'unit', onProgress } = options ?? {};
  const results: PushAndPollResult[] = [];

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];

    // 1. 应用 Patch
    const applyResponse = await client.applyPatch(p.proposalId, p.patch, p.targetPath, p.kind);
    if (!applyResponse.ok) {
      results.push({
        proposalId: p.proposalId,
        verdict: 'rejected',
        reason: `应用失败: ${(applyResponse.data as UnifiedError).error?.message}`,
      });
      if (onProgress) onProgress(i + 1, proposals.length);
      continue;
    }

    const applyData = applyResponse.data as ApplyPatchResponse;
    if (!applyData.applied) {
      results.push({
        proposalId: p.proposalId,
        verdict: 'rejected',
        reason: 'Patch 未应用',
      });
      if (onProgress) onProgress(i + 1, proposals.length);
      continue;
    }

    // 2. 触发验收
    const verifyResponse = await client.verify(p.proposalId, verifySuite);
    let verifyScore = 0;
    let regressed = false;
    if (verifyResponse.ok) {
      const verifyData = verifyResponse.data as VerifyResponse;
      verifyScore = verifyData.score;
      regressed = verifyData.regression;
    }

    results.push({
      proposalId: p.proposalId,
      verdict: regressed ? 'rejected' : 'accepted',
      reason: regressed ? `验收失败 (score: ${verifyScore}, regression: true)` : undefined,
      applied: true,
      verifyScore,
    });

    if (onProgress) onProgress(i + 1, proposals.length);
  }

  return results;
}

// ========== 导出便捷函数 ==========

export async function createClientAndVerify(config: EvolutionEngineConfig): Promise<CodeLensClient> {
  const client = createClientFromConfig(config);
  const healthy = await client.healthCheck();
  if (!healthy) {
    throw new Error(`CodeLens 健康检查失败: ${config.codeLensUrl}`);
  }
  return client;
}
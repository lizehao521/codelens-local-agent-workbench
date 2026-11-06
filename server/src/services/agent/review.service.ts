/**
 * 独立复核（R6）：只喂事实，不喂主脑推理/计划。
 *
 * 唯一问法：
 *   「下面这些事实里，哪一条不可逆、或影响面（数量/范围）被低估？
 *    没有就回答 confirmed。」
 *
 * 关键约束：
 * - 输入类型是 `ReviewFacts`，只含工具名、路径、存在性/字节数、命令、副作用、diff；
 *   任何 messages / 计划 / 推理都不在类型里，调用方无法顺手塞进去。
 * - temperature 0、maxTokens 400，输出 JSON；解析失败按 unexec，不猜测。
 * - 每次调用都记录真实 prompt/completion token 与 latency，落 `agent_reviews`。
 */

import type { Db } from '../../repositories/db.js';
import type { ReviewFacts, ReviewFinding, ReviewResult, ReviewStatus } from '../../types/tool.js';
import { OpenAICompatibleAdapter } from '../../providers/openai-compatible.adapter.js';
import type { ProviderCapabilities } from '../../types/index.js';

export interface ReviewContext {
  runId: string | null;
  sessionId: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export type ReviewMode = 'sync' | 'async';

export const REVIEW_PROMPT_VERSION = 'review-r6-v1';

const SYSTEM_PROMPT = [
  '你是独立复核者。你只看到一次工具调用的客观事实，不允许推测执行者的意图或计划。',
  '只回答一个问题：这些事实里，哪一条不可逆、或影响面（文件/条目数量、范围、外部副作用）被低估？',
  '如果没有任何一条被低估，status 必须是 confirmed。',
  '严格输出 JSON，不要输出多余文字：',
  '{"status":"confirmed|underestimated","findings":[{"severity":"high|medium|low","claim":"具体指摘","factRef":"对应路径/调用/步骤"}]}',
].join('\n');

function unsafeJson(content: string): unknown {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseResult(content: string): { status: ReviewStatus; findings: ReviewFinding[] } | null {
  const raw = unsafeJson(content) as
    | { status?: unknown; findings?: unknown }
    | null;
  if (!raw) return null;
  const status = raw.status === 'underestimated' ? 'underestimated' : raw.status === 'confirmed' ? 'confirmed' : null;
  if (!status) return null;
  const findings: ReviewFinding[] = [];
  if (Array.isArray(raw.findings)) {
    for (const item of raw.findings) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const claim = typeof row.claim === 'string' ? row.claim.trim() : '';
      if (!claim) continue;
      const severity = row.severity === 'high' || row.severity === 'medium' ? row.severity : 'low';
      const factRef = typeof row.factRef === 'string' ? row.factRef.trim() : '';
      findings.push({ severity, claim, factRef });
    }
  }
  if (status === 'underestimated' && findings.length === 0) {
    findings.push({ severity: 'medium', claim: '复核认为影响面可能被低估，但未给出具体条目', factRef: 'n/a' });
  }
  return { status, findings };
}

export class ReviewService {
  private readonly adapter: OpenAICompatibleAdapter;

  constructor(
    private readonly db: Db,
    opts: { timeoutMs?: number; adapter?: OpenAICompatibleAdapter } = {},
  ) {
    this.adapter =
      opts.adapter ??
      new OpenAICompatibleAdapter({
        timeoutMs: opts.timeoutMs ?? 15_000,
        retries: 0,
      });
  }

  /** 只接受事实输入；调用方拿不到把 messages 塞进来的入口。 */
  async review(
    facts: ReviewFacts,
    ctx: ReviewContext,
    mode: ReviewMode,
    signal?: AbortSignal,
  ): Promise<ReviewResult> {
    const startedAt = Date.now();
    if (!ctx.apiKey || !ctx.baseUrl || !ctx.model) {
      const unexec: ReviewResult = {
        status: 'unexec',
        findings: [],
        usage: { promptTokens: 0, completionTokens: 0 },
        latencyMs: 0,
        provider: ctx.provider,
        model: ctx.model,
        reason: '未配置模型凭证或 baseUrl，复核未执行',
      };
      this.persist(facts, ctx, mode, unexec);
      return unexec;
    }

    let content = '';
    let usage = { promptTokens: 0, completionTokens: 0 };
    try {
      const caps: ProviderCapabilities = {
        nativeTools: false,
        toolChoiceValues: [],
        contextWindow: 4096,
        retainReasoningContent: false,
        requireToolStreamFlag: false,
        explicitParallelToolCalls: false,
        supportsSystemRole: true,
      };
      const result = await this.adapter.chat(
        {
          baseUrl: ctx.baseUrl,
          apiKey: ctx.apiKey,
          model: ctx.model,
          temperature: 0,
          maxTokens: 400,
          stream: false,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `事实（仅此一份，不含任何推理或计划）：\n${JSON.stringify(facts, null, 2)}`,
            },
          ],
        },
        caps,
        signal,
      );
      content = result.content ?? '';
      usage = {
        promptTokens: result.usage?.promptTokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? 0,
      };
    } catch (err) {
      const reason = signal?.aborted
        ? '复核被取消'
        : err instanceof Error
          ? `复核调用失败：${err.message.slice(0, 200)}`
          : '复核调用失败';
      const failed: ReviewResult = {
        status: 'unexec',
        findings: [],
        usage,
        latencyMs: Date.now() - startedAt,
        provider: ctx.provider,
        model: ctx.model,
        reason,
      };
      this.persist(facts, ctx, mode, failed);
      return failed;
    }

    const parsed = parseResult(content);
    const result: ReviewResult = {
      status: parsed?.status ?? 'unexec',
      findings: parsed?.findings ?? [],
      usage,
      latencyMs: Date.now() - startedAt,
      provider: ctx.provider,
      model: ctx.model,
      reason: parsed ? undefined : '复核输出不是可解析的 JSON，按未执行处理',
    };
    this.persist(facts, ctx, mode, result);
    return result;
  }

  private persist(facts: ReviewFacts, ctx: ReviewContext, mode: ReviewMode, result: ReviewResult): void {
    this.db.run(
      `INSERT INTO agent_reviews
        (run_id, session_id, call_id, mode, status, findings_json,
         prompt_tokens, completion_tokens, latency_ms, provider, model, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ctx.runId,
        ctx.sessionId,
        facts.callId,
        mode,
        result.status,
        JSON.stringify(result.findings),
        result.usage.promptTokens,
        result.usage.completionTokens,
        result.latencyMs,
        result.provider,
        result.model,
        result.reason ?? null,
        Date.now(),
      ],
    );
  }

  /** 供测试/报告查询：按 run 查复核开销。 */
  listByRun(runId: string): Array<{
    callId: string;
    mode: string;
    status: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  }> {
    return this.db
      .all<{
        call_id: string;
        mode: string;
        status: string;
        prompt_tokens: number;
        completion_tokens: number;
        latency_ms: number;
      }>(
        'SELECT call_id, mode, status, prompt_tokens, completion_tokens, latency_ms FROM agent_reviews WHERE run_id = ? ORDER BY created_at ASC',
        [runId],
      )
      .map((r) => ({
        callId: r.call_id,
        mode: r.mode,
        status: r.status,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        latencyMs: r.latency_ms,
      }));
  }
}

/**
 * run() 的 per-request 服务工厂。
 *
 * 这些服务持有本次请求的 SSE / 预算 / 取消信号，必须在 run 内创建；
 * 但「怎么装配」与「主循环怎么走」是两件事。抽出来后 run() 只保留
 * 生命周期与控制流，装配细节（审批去重、复核回写、上下文窗口来源）
 * 在这里集中，改装配不会再把 run() 顶过行数闸。
 */
import type { MessageRepository } from '../memory/message.repository.js';
import type { OpenAICompatibleAdapter } from '../../providers/openai-compatible.adapter.js';
import { ToolExecutor, type ExecutorDeps } from '../tools/executor.service.js';
import { ApprovalDedupService } from './approval-dedup.service.js';
import { ContextManager } from './context-manager.service.js';
import { canRetry, consumeRetry, type BudgetState } from './loop-budget.js';
import type { ChannelRouter } from './channel-router.service.js';
import type { SseWriter } from './sse-writer.js';
import type { ReviewService } from './review.service.js';
import type { ReviewContext } from './review.service.js';
import type { RunStateService } from './run-state.service.js';

type ExecutorBase = Pick<
  ExecutorDeps,
  'toolCalls' | 'toolResults' | 'approvals' | 'sse' | 'sandboxRoot' | 'allowedDirs'
>;

export function buildToolExecutor(
  base: ExecutorBase,
  opts: {
    budget: BudgetState;
    runId: string;
    turnSignal: AbortSignal;
    review?: ReviewService;
    reviewCtx: ReviewContext;
    runState?: RunStateService;
  },
): ToolExecutor {
  const { budget, runId, turnSignal, review, reviewCtx, runState } = opts;
  return new ToolExecutor({
    ...base,
    canRetry: () => canRetry(budget),
    onRetryConsumed: () => consumeRetry(budget),
    runId,
    dedup: new ApprovalDedupService(),
    onApprovalDedup: ({ toolCall, reusedGrantId, reusedStep }) => {
      runState?.approval(runId, {
        callId: toolCall.call_id,
        name: toolCall.tool_name,
        approvalMode: toolCall.approval_mode as 'soft' | 'hard' | 'two_step',
        decision: 'deduped',
        at: Date.now(),
        reusedGrantId,
        reusedStep,
      });
    },
    reviewIrreversible: review
      ? async (facts) => {
          const result = await review.review(facts, reviewCtx, 'sync', turnSignal);
          runState?.addReviewCost(runId, result.usage.promptTokens, result.usage.completionTokens);
          if (result.status === 'underestimated') {
            runState?.error(runId, {
              code: 'REVIEW_UNDERESTIMATED',
              kind: 'error',
              message: `复核认为影响面被低估：${result.findings.map((f) => f.claim).join('；').slice(0, 200)}`,
              at: Date.now(),
            });
          }
          return result;
        }
      : undefined,
    onApprovalDecision: ({ toolCall, approvalMode, decision }) => {
      runState?.approval(runId, {
        callId: toolCall.call_id,
        name: toolCall.tool_name,
        approvalMode,
        decision: decision === 'revised_direct' ? 'revised' : decision,
        at: Date.now(),
      });
    },
  });
}

export function buildContextManager(input: {
  messages: MessageRepository;
  channelRouter: ChannelRouter;
  adapter: OpenAICompatibleAdapter;
  baseUrl: string;
  apiKey: string;
  model: string;
  sse: SseWriter;
  turnSignal: AbortSignal;
}): ContextManager {
  const { messages, channelRouter, adapter, baseUrl, apiKey, model, sse, turnSignal } = input;
  return new ContextManager({
    messages,
    resolveContextWindow: (provider, modelId) =>
      channelRouter.resolveCapabilities(provider, modelId).contextWindow,
    sse,
    summarize: (prompt, system) =>
      adapter
        .chat(
          {
            baseUrl,
            apiKey,
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: prompt },
            ],
            temperature: 0.1,
            maxTokens: 800,
            stream: false,
          },
          undefined,
          turnSignal,
        )
        .then((result) => result.content),
  });
}

/**
 * run() 的前置装配：把 per-request 服务集合一次性搭好。
 *
 * 这些对象都绑定本次请求的 SSE / 预算 / 取消信号，不能跨 run 复用；
 * 但「怎么装配」与「主循环怎么走」是两件事。抽到独立模块后，
 * run() 只保留生命周期与控制流，装配细节不再把它顶过行数闸。
 */
import type { AgentLoopDeps, AgentRunRequest } from './agent-loop.service.js';
import type { ApprovalService } from './approval.service.js';
import type { ChannelRouter } from './channel-router.service.js';
import type { ReviewContext } from './review.service.js';
import type { BudgetState } from './loop-budget.js';
import type { SseWriter } from './sse-writer.js';
import { CallResolver } from './call-resolver.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { ConvergenceDetector } from './convergence-detector.js';
import { LoopDetector } from './loop-detector.js';
import { buildContextManager, buildToolExecutor } from './run-services.js';
import { buildReverseIndex } from '../../utils/tool-name.js';
import { config } from '../../config/env.js';

type AssembleDeps = Pick<
  AgentLoopDeps,
  | 'toolCalls'
  | 'toolResults'
  | 'registry'
  | 'messages'
  | 'adapter'
  | 'sandboxRoot'
  | 'sandboxPermissions'
  | 'checkpoint'
  | 'grants'
  | 'runState'
  | 'review'
>;

export interface PreparedRun {
  executor: ReturnType<typeof buildToolExecutor>;
  contextManager: ReturnType<typeof buildContextManager>;
  breaker: CircuitBreaker;
  detector: LoopDetector;
  convergence: ConvergenceDetector;
  reportedCircuit: Set<string>;
  resolver: CallResolver;
}

export function prepareRun(
  deps: AssembleDeps,
  p: {
    approvals: ApprovalService;
    channelRouter: ChannelRouter;
    sse: SseWriter;
    req: AgentRunRequest;
    budget: BudgetState;
    runId: string;
    turnSignal: AbortSignal;
    reviewCtx: ReviewContext;
    baseUrl: string;
    apiKey: string;
    allowedDirs: string[];
    sessionId: string;
  },
): PreparedRun {
  const allowedDirs = p.allowedDirs;
  const executor = buildToolExecutor(
    {
      toolCalls: deps.toolCalls,
      toolResults: deps.toolResults,
      approvals: p.approvals,
      sse: p.sse,
      sandboxRoot: deps.sandboxRoot,
      allowedDirs,
    },
    {
      budget: p.budget,
      runId: p.runId,
      turnSignal: p.turnSignal,
      review: deps.review,
      reviewCtx: p.reviewCtx,
      runState: deps.runState,
    },
  );
  const contextManager = buildContextManager({
    messages: deps.messages,
    channelRouter: p.channelRouter,
    adapter: deps.adapter,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.req.model,
    sse: p.sse,
    turnSignal: p.turnSignal,
  });
  const breaker = new CircuitBreaker();
  const detector = new LoopDetector();
  const convergence = new ConvergenceDetector(config.agentConvergenceRounds);
  const reportedCircuit = new Set<string>();
  const resolver = new CallResolver({
    registry: deps.registry,
    toolCalls: deps.toolCalls,
    sse: p.sse,
    sandboxRoot: deps.sandboxRoot,
    allowedDirs,
    exemptions: deps.sandboxPermissions?.autoApprove,
    checkpointEnabled: deps.checkpoint?.enabled,
    grants: deps.grants,
    reverseIndex: buildReverseIndex(deps.registry.list()),
    breaker,
  });
  return { executor, contextManager, breaker, detector, convergence, reportedCircuit, resolver };
}

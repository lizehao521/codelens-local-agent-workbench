/**
 * run() 拆分第一步：把「可逆结果审」的事实投影抽成纯函数。
 *
 * 为什么先抽这一段：它只读 effect/args/outcome，不写库、不发 SSE，
 * 却是 run() 里最长的一段纯数据拼装。抽出来后 run() 只保留
 * 「什么时候发复核」的控制流，事实形状由本函数单测钉住。
 * 这样后续再拆执行循环时，不必连事实投影一起搬。
 */
import type { EffectPreview, ReviewFacts } from '../../types/tool.js';

export interface ReviewSubject {
  toolCall: { call_id: string; tool_name: string };
  args: Record<string, unknown>;
}

export interface ReviewDiffItem {
  path: string;
  added: number;
  removed: number;
  preview: string;
}

/** 把一次工具执行投影成复核模型可消费的事实（不含模型自述/推理）。 */
export function buildReviewFacts(
  subject: ReviewSubject,
  effect: EffectPreview,
  summary: string | null | undefined,
  iteration: number,
  itemDiffs: ReviewDiffItem[],
): ReviewFacts {
  return {
    toolName: subject.toolCall.tool_name,
    callId: subject.toolCall.call_id,
    iteration,
    command: typeof subject.args.command === 'string' ? subject.args.command : undefined,
    cwd: typeof subject.args.cwd === 'string' ? subject.args.cwd : undefined,
    affectedPaths: effect.items
      .filter((it) => it.kind === 'file' || it.kind === 'dir')
      .map((it) => ({
        path: it.path,
        operation: String(subject.args.operation ?? subject.toolCall.tool_name),
        beforeExists: it.exists,
        beforeBytes: it.bytes,
        afterExists: true,
        afterBytes: null,
      })),
    itemCount: effect.itemCount,
    sideEffects: [summary ?? ''].filter(Boolean),
    diffSummary: itemDiffs
      .map((f) => `${f.path}: +${f.added}/-${f.removed}\n${f.preview}`)
      .join('\n')
      .slice(0, 4000),
  };
}

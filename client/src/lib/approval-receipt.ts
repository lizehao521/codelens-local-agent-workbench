// 审批回执错误映射 —— 404/409/410/400 各有不同用户动作，绝不统一弹 Toast

import type { ApprovalReceipt, ApprovalSubmitRequest } from '../types';

/** 熔断阈值：mismatch_count 达 3 次 → 挑战置 aborted */
export const MISMATCH_ABORT_THRESHOLD = 3;

/**
 * 把 HTTP 失败映射为确认条内的呈现档位。
 * 200 返回 null —— 什么都不做，卡片终态由服务端在原 SSE 流推 tool_result 驱动。
 */
export function mapApprovalFailure(
  status: number,
  code: string | undefined,
  mismatchCount: number,
): ApprovalReceipt {
  if (status === 404 || code === 'APPROVAL_NOT_FOUND') {
    return { level: 'inline', message: '此审批已失效', disabled: true };
  }
  if (code === 'APPROVAL_ALREADY_DECIDED') {
    return { level: 'inline', message: '该操作已处理过', disabled: true };
  }
  if (status === 410 || code === 'APPROVAL_EXPIRED') {
    return { level: 'inline', message: '确认已过期，此调用已取消', disabled: true };
  }
  if (code === 'APPROVAL_ARGS_MISMATCH') {
    return {
      level: 'danger',
      message: '参数已变更，请重新确认后再执行',
      disabled: false,
      action: 'reload-args',
    };
  }
  if (code === 'APPROVAL_TOKEN_MISMATCH' || code === 'APPROVAL_MISMATCH') {
    return buildMismatchReceipt(mismatchCount + 1);
  }
  if (status === 400 || code === 'VALIDATION_ERROR') {
    return { level: 'danger', message: '请求被拒绝：提交内容非法', disabled: true };
  }
  return { level: 'danger', message: `提交失败（${code ?? status}），请重试`, disabled: false };
}

/** 熔断提示：1、2 次显示「已连续异常 N 次（3 次后将锁定）」，第 3 次锁定 */
export function buildMismatchReceipt(count: number): ApprovalReceipt {
  if (count >= MISMATCH_ABORT_THRESHOLD) {
    return { level: 'aborted', message: '该操作已锁定，未执行', disabled: true };
  }
  return {
    level: 'danger',
    message: `校验未通过，本次操作已取消。已连续异常 ${count} 次（${MISMATCH_ABORT_THRESHOLD} 次后将锁定）`,
    disabled: false,
  };
}

/**
 * 组装审批请求 body —— 只允许 { token, decision, reason? } / revise 档的 arguments。
 * 纪律：reason 为空字符串时整个键省略（zod .strict() 会拒收多余/空值键）。
 */
export function buildApprovalBody(
  token: string,
  decision: 'allow_once' | 'allow_session' | 'reject' | 'revise',
  reason?: string,
  args?: Record<string, unknown>,
): ApprovalSubmitRequest {
  const body: ApprovalSubmitRequest = { token, decision };
  if (decision === 'reject' && reason && reason.trim()) body.reason = reason.trim();
  if (decision === 'revise' && args) body.arguments = args;
  return body;
}

/** 令牌剩余时间的语义档位（>60s 常规 / ≤60s warning / ≤10s danger） */
export function countdownTone(remainMs: number): 'normal' | 'warning' | 'danger' {
  if (remainMs <= 10_000) return 'danger';
  if (remainMs <= 60_000) return 'warning';
  return 'normal';
}

export function countdownClass(remainMs: number): string {
  const tone = countdownTone(remainMs);
  if (tone === 'danger') return 'text-danger';
  if (tone === 'warning') return 'text-warning';
  return 'text-text-secondary';
}

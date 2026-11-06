// ToolApprovalBar —— inline 审批确认条（AC-04/AC-06）：不弹窗，挂在工具卡内部
// 服务端持有参数与 5 分钟令牌；前端只回传 { token, decision } / revise 档 { token, arguments }。
// 回执纪律：404/409/410 → inline 置灰；mismatch → danger 累加，3 次锁定（lib/approval-receipt）。

import { useEffect, useRef, useState } from 'react';
import { Loader, Pencil, ShieldCheck, ShieldX, Timer, TriangleAlert } from 'lucide-react';
import type { ApprovalDecision, ApprovalVM } from '../../types';
import { useApprovalStore } from '../../stores/approvalStore';
import {
  MISMATCH_ABORT_THRESHOLD,
  buildApprovalBody,
  countdownClass,
  mapApprovalFailure,
} from '../../lib/approval-receipt';
import { formatCountdown as fmtCd } from '../../lib/tool-format';
import { submitApproval, reviseApproval, reissueApproval } from '../../services/api';
import { cn } from '../../lib/cn';

/** AUDIT-009：剩余时间低于此阈值时自动续期，避免在场但慢速的用户被 5 分钟硬超时打败。 */
const REISSUE_THRESHOLD_MS = 30_000;

const RISK_LABEL: Record<ApprovalVM['risk'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

const MODE_LABEL: Record<ApprovalVM['approvalMode'], string> = {
  soft: '建议确认',
  hard: '必须确认',
  two_step: '两步确认',
};

export interface ToolApprovalBarProps {
  approval: ApprovalVM;
  /** 决定被服务端接受后的回调（终态仍由原 SSE 流的 tool_result 驱动） */
  onSettled?: (decision: ApprovalDecision) => void;
}

export function ToolApprovalBar({ approval, onSettled }: ToolApprovalBarProps) {
  const setReceipt = useApprovalStore((s) => s.setReceipt);
  const bumpMismatch = useApprovalStore((s) => s.bumpMismatch);
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftArgs, setDraftArgs] = useState(() => JSON.stringify(approval.arguments, null, 2));
  const [draftError, setDraftError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // 倒计时（1s 粒度；过期只影响按钮禁用，服务端权威）
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const remainMs = approval.expiresAt - now;
  const expired = remainMs <= 0;
  const locked = approval.receipt?.disabled === true;
  const mismatchCount = approval.mismatchCount;

  // AUDIT-005 客户端：两步确认进度与瞬时锁定
  const isTwoStep = approval.approvalMode === 'two_step';
  const pass = approval.pass ?? 1;
  const totalPasses = approval.totalPasses ?? 1;
  const awaitingNextStep = approval.awaitingNextStep === true;

  // AUDIT-009：临过期前自动续期，让在场但慢速的用户不会被 5 分钟硬超时自动驳回。
  // 必须置于 expired/locked/awaitingNextStep 声明之后（这些派生量供本 effect 依赖与判断）。
  const reissuedFor = useRef<string | null>(null);
  useEffect(() => {
    const remaining = approval.expiresAt - now;
    if (
      remaining > 0 &&
      remaining <= REISSUE_THRESHOLD_MS &&
      !expired &&
      !locked &&
      !awaitingNextStep &&
      !busy &&
      reissuedFor.current !== approval.token
    ) {
      reissuedFor.current = approval.token;
      void reissueApproval(approval.approvalId, approval.token)
        .then((r) => {
          useApprovalStore.getState().refresh(approval.callId, r.approvalToken, r.expiresAt);
        })
        .catch(() => {
          /* 续期失败（如服务端已过期）则交给定时器自然过期，不重复重试 */
        });
    }
  }, [now, approval.expiresAt, approval.token, expired, locked, awaitingNextStep, busy]);

  const handleFailure = (status: number, code: string | undefined): void => {
    if (code === 'APPROVAL_TOKEN_MISMATCH' || code === 'APPROVAL_MISMATCH') {
      const next = bumpMismatch(approval.callId);
      setReceipt(approval.callId, mapApprovalFailure(status, code, next));
    } else {
      setReceipt(approval.callId, mapApprovalFailure(status, code, mismatchCount));
    }
  };

  const submit = async (decision: ApprovalDecision, args?: Record<string, unknown>): Promise<void> => {
    setBusy(decision);
    try {
      if (decision === 'revise' && args) {
        await reviseApproval(approval.approvalId, approval.token, args);
        onSettled?.('revise');
      } else {
        await submitApproval(approval.approvalId, buildApprovalBody(approval.token, decision));
        // AUDIT-005 客户端：两步确认的非终步，确认后锁定按钮，直到下一步挑战到达，
        // 防止用户对同一已决令牌重复提交（否则服务端返回 APPROVAL_ALREADY_DECIDED）。
        if (isTwoStep && pass < totalPasses) {
          useApprovalStore.getState().ackPass(approval.callId);
        }
        onSettled?.(decision);
      }
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      const code = (err as { code?: string }).code;
      handleFailure(status, code);
    } finally {
      setBusy(null);
    }
  };

  const handleReviseSubmit = (): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draftArgs);
    } catch {
      setDraftError('不是合法 JSON');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setDraftError('参数必须是 JSON 对象');
      return;
    }
    setDraftError(null);
    setEditing(false);
    void submit('revise', parsed as Record<string, unknown>);
  };

  return (
    <div className="rounded-md border border-warning/40 bg-warning-subtle p-2.5">
      {/* 头部：模式 + 风险 + 倒计时 */}
      <div className="flex items-center gap-2">
        <ShieldCheck size={14} className="shrink-0 text-warning" />
        <span className="text-xs font-medium text-text-primary">{MODE_LABEL[approval.approvalMode]}</span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-xs',
            approval.risk === 'high' ? 'bg-danger-subtle text-danger' : 'bg-bg-inset text-text-secondary',
          )}
        >
          {RISK_LABEL[approval.risk]}
        </span>
        <span className={cn('ml-auto flex items-center gap-1 font-mono text-xs', countdownClass(remainMs))}>
          <Timer size={11} />
          {expired ? '已过期' : fmtCd(remainMs)}
        </span>
      </div>

      {/* 两步确认进度（AUDIT-005）：明确「第几步 / 共几步」，避免被误读成重复弹窗 */}
      {isTwoStep && (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex items-center gap-1">
            {Array.from({ length: totalPasses }, (_, i) => {
              const stepNo = i + 1;
              const done = stepNo < pass || (awaitingNextStep && stepNo === pass);
              const current = !awaitingNextStep && stepNo === pass;
              return (
                <span
                  key={stepNo}
                  className={cn(
                    'flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-medium',
                    done
                      ? 'bg-success text-text-on-accent'
                      : current
                        ? 'bg-accent text-text-on-accent'
                        : 'bg-bg-inset text-text-tertiary',
                  )}
                >
                  {done ? '✓' : stepNo}
                </span>
              );
            })}
          </div>
          <span className="text-xs text-text-secondary">
            {awaitingNextStep ? `已确认第 ${pass} 步，等待最终确认…` : `两步确认 · 第 ${pass}/${totalPasses} 步`}
          </span>
        </div>
      )}

      {/* R6：不可逆操作审「后果预览」——只列可核实事实，不做推断 */}
      {approval.effect && !approval.effect.reversible && (
        <div className="mt-1.5 rounded border border-danger/30 bg-danger-subtle p-2">
          <div className="text-xs font-medium text-danger">
            不可撤销 · {approval.effect.summary}
          </div>
          <ul className="mt-1 space-y-0.5 text-[11px] text-text-secondary">
            {approval.effect.items.slice(0, 6).map((item) => (
              <li key={`${item.kind}:${item.path}`} className="break-all font-mono">
                {item.kind === 'command' ? '命令' : item.kind === 'url' ? '请求' : '路径'} {item.path}
                {item.exists ? (
                  <span className="text-text-tertiary">
                    （已存在{item.bytes !== null ? ` · ${item.bytes} 字节` : ''}
                    {typeof item.itemCount === 'number' ? ` · ${item.itemCount} 项` : ''}）
                  </span>
                ) : (
                  <span className="text-text-tertiary">（尚不存在）</span>
                )}
              </li>
            ))}
            {approval.effect.items.length > 6 && (
              <li className="text-text-tertiary">…共 {approval.effect.itemCount} 项</li>
            )}
          </ul>
          <div className="mt-1 text-[11px] text-text-tertiary">
            {approval.effect.recoverable
              ? approval.effect.recoveryNote ?? '可用写前快照恢复'
              : approval.effect.recoveryNote ?? '不可恢复'}
          </div>
        </div>
      )}

      {/* 拦截原因 + 参数预览 */}
      <p className="mt-1.5 text-xs text-text-secondary">{approval.reason}</p>
      {!editing && (
        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-primary p-1.5 font-mono text-xs text-text-tertiary">
          {JSON.stringify(approval.arguments, null, 2)}
        </pre>
      )}

      {/* 回执（失败映射） */}
      {approval.receipt && (
        <div
          className={cn(
            'mt-1.5 flex items-start gap-1.5 rounded p-1.5 text-xs',
            approval.receipt.level === 'danger' ? 'bg-danger-subtle text-danger' : 'bg-bg-inset text-text-secondary',
          )}
        >
          <TriangleAlert size={11} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{approval.receipt.message}</span>
          {approval.receipt.action === 'reload-args' && (
            <button
              type="button"
              onClick={() => {
                setDraftArgs(JSON.stringify(approval.arguments, null, 2));
                setEditing(true);
              }}
              className="shrink-0 text-accent hover:underline"
            >
              重新确认
            </button>
          )}
        </div>
      )}

      {/* 改参数编辑区 */}
      {editing && (
        <div className="mt-1.5">
          <textarea
            value={draftArgs}
            onChange={(e) => setDraftArgs(e.target.value)}
            rows={5}
            className="w-full rounded border border-border bg-bg-primary p-1.5 font-mono text-xs text-text-primary focus:border-accent"
            aria-label="修改后的工具参数（JSON）"
          />
          {draftError && <p className="mt-0.5 text-xs text-danger">{draftError}</p>}
          <div className="mt-1 flex gap-1.5">
            <button
              type="button"
              onClick={handleReviseSubmit}
              className="rounded bg-accent px-2 py-1 text-xs font-medium text-text-on-accent transition-colors duration-150 hover:bg-accent-hover"
            >
              提交新参数（将重新校验并再次确认）
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraftError(null);
              }}
              className="rounded border border-border px-2 py-1 text-xs text-text-secondary transition-colors duration-150 hover:border-accent"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 操作按钮 */}
      {!editing && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <DecisionButton
            icon={ShieldCheck}
            label="允许一次"
            disabled={locked || expired || awaitingNextStep || busy !== null}
            loading={busy === 'allow_once'}
            onClick={() => void submit('allow_once')}
          />
          <DecisionButton
            icon={ShieldCheck}
            label="本会话允许"
            disabled={locked || expired || awaitingNextStep || busy !== null}
            loading={busy === 'allow_session'}
            onClick={() => void submit('allow_session')}
          />
          <DecisionButton
            icon={ShieldX}
            label="拒绝"
            tone="danger"
            disabled={locked || expired || awaitingNextStep || busy !== null}
            loading={busy === 'reject'}
            onClick={() => void submit('reject')}
          />
          {approval.approvalMode !== 'two_step' && (
            <DecisionButton
              icon={Pencil}
              label="改参数"
              disabled={locked || expired || awaitingNextStep || busy !== null}
              loading={busy === 'revise'}
              onClick={() => {
                setDraftArgs(JSON.stringify(approval.arguments, null, 2));
                setEditing(true);
              }}
            />
          )}
          {mismatchCount > 0 && !locked && (
            <span className="ml-auto text-xs text-text-tertiary">
              异常 {mismatchCount}/{MISMATCH_ABORT_THRESHOLD}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function DecisionButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  loading,
  tone,
}: {
  icon: typeof ShieldCheck;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'danger'
          ? 'border border-border text-text-secondary hover:border-danger hover:text-danger'
          : 'bg-accent text-text-on-accent hover:bg-accent-hover',
      )}
    >
      {loading ? <Loader size={11} className="animate-spin" /> : <Icon size={11} />}
      {label}
    </button>
  );
}

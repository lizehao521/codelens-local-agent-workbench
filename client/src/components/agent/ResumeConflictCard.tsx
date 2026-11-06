// ResumeConflictCard —— F：续跑冲突态（C 强校验失败时的明确视觉与文案）。
// 只展示冲突清单与下一步动作；不在前端做任何自动覆盖。

import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useRunStore } from '../../stores/runStore';
import { resumeRun } from '../../services/api';
import { useState } from 'react';

export function ResumeConflictCard() {
  const conflict = useRunStore((s) => s.resumeConflict);
  const setConflict = useRunStore((s) => s.setResumeConflict);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!conflict) return null;

  const recheck = async () => {
    setChecking(true);
    setMessage(null);
    const result = await resumeRun(conflict.runId);
    setChecking(false);
    if (result.status === 'conflict') {
      setConflict({ runId: conflict.runId, conflicts: result.conflicts });
      setMessage(`仍有 ${result.conflicts.length} 个文件冲突，续跑已阻止（未写盘）`);
    } else if (result.status === 'ok') {
      setConflict(null);
    } else {
      setMessage(result.status === 'not_resumable' ? result.reason : 'run 不存在');
    }
  };

  return (
    <div
      className="mx-3 mt-2 shrink-0 rounded-lg border border-warning bg-warning-subtle px-3 py-2"
      role="alert"
      aria-live="assertive"
      data-state="resume-conflict"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-warning">
        <AlertTriangle size={13} />
        续跑已阻止：文件与你上次授权后不一致
        <button
          type="button"
          onClick={() => setConflict(null)}
          aria-label="关闭冲突提示"
          className="ml-auto rounded p-0.5 text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X size={12} />
        </button>
      </div>
      <p className="mt-1 text-[11px] text-text-secondary">
        Agent 没有自动续跑，也没有覆盖你的改动。请先把下列文件改回期望状态，或撤销本次 run 的改动后再续跑。
      </p>
      <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-text-secondary">
        {conflict.conflicts.map((item) => (
          <li key={`${item.path}-${item.step}`} className="truncate">
            {item.path} · 期望 {item.expectedSha256.slice(0, 8)} · 实际 {(item.actualSha256 ?? '缺失').slice(0, 8)} · 第 {item.step ?? '—'} 步
          </li>
        ))}
      </ul>
      {message && <p className="mt-1 text-[11px] text-warning">{message}</p>}
      <button
        type="button"
        onClick={() => void recheck()}
        disabled={checking}
        className="mt-1 inline-flex items-center gap-1 rounded border border-warning px-2 py-0.5 text-[11px] text-warning hover:bg-warning hover:text-bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
      >
        <RefreshCw size={11} /> 重新检查
      </button>
    </div>
  );
}

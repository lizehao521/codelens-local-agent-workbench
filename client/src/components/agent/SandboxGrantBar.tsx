/**
 * 工作区外「按目录授权」弹条（R6）。
 *
 * 服务端在 gateway 判定越界后挂起该调用，并推 sandbox_grant_required；
 * 用户在这里允许/拒绝，决定通过 HTTP 端点结算，原调用随即恢复。
 * 拒绝或超时 = fail-closed（不执行、不落授权）。
 */

import { FolderLock, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useRunStore } from '../../stores/runStore';
import { cn } from '../../lib/cn';

export function SandboxGrantBar() {
  const pending = useRunStore((s) => s.pendingGrant);
  const clear = useRunStore((s) => s.setPendingGrant);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!pending) return null;

  const decide = async (allow: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/sandbox-grants/${encodeURIComponent(pending.requestId)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `请求失败（HTTP ${res.status}）`);
        return;
      }
      clear(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '网络请求失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-3 mt-2 shrink-0 rounded-lg border border-warning/40 bg-warning-subtle px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
        <FolderLock size={12} className="text-warning" />
        请求访问工作区外目录
      </div>
      <p className="mt-1 break-all font-mono text-xs text-text-secondary">{pending.dir}</p>
      <p className="mt-0.5 text-[11px] text-text-tertiary">
        授权后本次及后续同目录访问不再打断；敏感目录与 `..` 穿越不会走到这里。
      </p>
      {pending.sensitive && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-danger">
          <TriangleAlert size={10} />
          该目录被识别为敏感路径，建议拒绝。
        </p>
      )}
      {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}
      <div className="mt-1.5 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide(true)}
          className={cn(
            'rounded bg-accent px-2.5 py-1 text-xs text-text-on-accent',
            busy && 'cursor-not-allowed opacity-60',
          )}
        >
          允许该目录
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide(false)}
          className={cn('rounded border border-border px-2.5 py-1 text-xs text-text-secondary', busy && 'opacity-60')}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

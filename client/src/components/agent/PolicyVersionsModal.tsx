/**
 * PolicyVersionsModal —— π（策略）版本历史 + 回滚（唯一写操作）。
 *
 * 三条设计约束：
 *  1. 回滚必须二次确认：历史只读、回滚可逆，但「改的是下一代的行为」，
 *     单击即生效会让人来不及看清目标版本；
 *  2. 每版都要能回答「这版改了什么」—— diff 是事实（加了/删了/阈值变了），
 *     不展示模型意见；空 diff 也如实写「内容无变化（可能为幂等回滚）」；
 *  3. 只有非当前版才显示回滚按钮：回滚到当前版没有语义，藏掉比禁用更干净。
 */

import { useState } from 'react';
import { RotateCcw, GitBranch } from 'lucide-react';
import { Modal } from '../common/Modal';
import { cn } from '../../lib/cn';
import { useAsyncData } from '../../hooks/useAsyncData';
import { getPolicyVersions, rollbackPolicy, type PolicyVersionView } from '../../services/api';
import { useUiStore } from '../../stores/uiStore';

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function PolicyVersionsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pushToast = useUiStore((s) => s.pushToast);
  const [reloadKey, setReloadKey] = useState(0);
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, loading, error } = useAsyncData(() => getPolicyVersions(20), [reloadKey], {
    errorMessage: '加载 π 版本历史失败',
  });

  const confirmRollback = async (version: number) => {
    setBusy(true);
    try {
      const result = await rollbackPolicy(version);
      pushToast({
        message:
          result.currentVersion === result.rolledBackTo
            ? `已回滚到 v${version}`
            : `已回滚到 v${version}（内容与当前版一致，未产生新版本）`,
        variant: 'success',
      });
      setPending(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : '回滚失败', variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="π 版本历史" maxWidth={760}>
      <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto pr-1">
        <p className="text-[11px] text-text-tertiary">
          历史 append-only：回滚 = 追加一个内容等于目标版的新版本，可再回滚回来。经验的产生只能由 Judge 判决驱动，不提供手工写入。
        </p>
        {loading && <p className="py-6 text-center text-xs text-text-tertiary">加载中…</p>}
        {error && <p className="py-6 text-center text-xs text-danger">{error}</p>}
        {data && (data.versions ?? []).length === 0 && (
          <p className="rounded border border-border bg-bg-inset px-3 py-6 text-center text-xs text-text-tertiary">
            还没有任何 π 版本。第一次判决产生经验后，这里会出现版本链。
          </p>
        )}
        {(data?.versions ?? []).map((v) => (
          <VersionRow
            key={v.version}
            item={v}
            pending={pending === v.version}
            busy={busy}
            onAsk={() => setPending(v.version)}
            onCancel={() => setPending(null)}
            onConfirm={() => void confirmRollback(v.version)}
          />
        ))}
      </div>
    </Modal>
  );
}

function VersionRow({
  item,
  pending,
  busy,
  onAsk,
  onCancel,
  onConfirm,
}: {
  item: PolicyVersionView;
  pending: boolean;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const hasDiff =
    item.diff.added.length > 0 || item.diff.removed.length > 0 || item.diff.thresholdChanges.length > 0;

  return (
    <div
      className={cn(
        'rounded border px-3 py-2',
        item.current ? 'border-accent/50 bg-accent-subtle/40' : 'border-border bg-bg-inset',
      )}
    >
      <div className="flex items-center gap-2">
        <GitBranch size={13} className="shrink-0 text-text-tertiary" />
        <span className="text-xs font-medium text-text-primary">v{item.version}</span>
        {item.current && (
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">当前生效</span>
        )}
        <span className="text-[10px] text-text-tertiary">
          {item.lessonCount} 条经验 · {fmtTime(item.createdAt)}
          {item.parentVersion !== null ? ` · 承接 v${item.parentVersion}` : ' · 首版'}
        </span>
        <div className="ml-auto">
          {!item.current && !pending && (
            <button
              type="button"
              onClick={onAsk}
              className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-text-secondary hover:border-accent hover:text-accent"
            >
              <RotateCcw size={10} />
              回滚到此版
            </button>
          )}
          {pending && (
            <span className="flex items-center gap-1">
              <span className="text-[10px] text-warning">确认回到 v{item.version}？</span>
              <button
                type="button"
                disabled={busy}
                onClick={onConfirm}
                className="rounded bg-accent px-2 py-0.5 text-[10px] text-text-on-accent disabled:opacity-50"
              >
                {busy ? '回滚中…' : '确认'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onCancel}
                className="rounded border border-border px-2 py-0.5 text-[10px] text-text-secondary"
              >
                取消
              </button>
            </span>
          )}
        </div>
      </div>

      {item.sourceJudgment && (
        <p className="mt-1 truncate text-[10px] text-text-tertiary" title={item.sourceJudgment}>
          来源：{item.sourceJudgment}
        </p>
      )}

      <div className="mt-1 flex flex-col gap-0.5 text-[10px]">
        {!hasDiff && <span className="text-text-tertiary">内容无变化（同内容重写 / 幂等回滚）</span>}
        {item.diff.added.map((lesson, i) => (
          <span key={`add-${i}`} className="truncate text-success" title={lesson}>
            + {lesson}
          </span>
        ))}
        {item.diff.removed.map((lesson, i) => (
          <span key={`del-${i}`} className="truncate text-danger" title={lesson}>
            − {lesson}
          </span>
        ))}
        {item.diff.thresholdChanges.map((t) => (
          <span key={`th-${t.key}`} className="text-warning">
            阈值 {t.key}: {t.from ?? '—'} → {t.to ?? '—'}
          </span>
        ))}
      </div>
    </div>
  );
}
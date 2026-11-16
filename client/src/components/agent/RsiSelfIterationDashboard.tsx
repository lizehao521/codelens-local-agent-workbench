/** 自迭代雷达：实时轮询 RSI 迭代，展示每轮决策/判据/参数信号变化与检索证据。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { getRsiIterations, type RsiIterationList, type RsiIterationRecord } from '../../services/api';
import { Modal } from '../common/Modal';
import { useComposerStore } from '../../stores/composerStore';
import { useUiStore } from '../../stores/uiStore';
import { cn } from '../../lib/cn';
import {
  criteriaCounts,
  decisionLabel,
  decisionTone,
  extractSearchEvidence,
  rawChanges,
  rawHighlights,
  verdictTone,
} from '../../lib/rsi-live';

const DECISIONS = ['continue', 'retry', 'rollback', 'escalate', 'halt'] as const;
const TONE: Record<string, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  muted: 'text-text-secondary',
};

function fmtTime(at: string | number | undefined): string {
  if (!at) return '—';
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(t)) return String(at);
  return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function useLiveIterations(enabled: boolean): {
  data: RsiIterationList | null;
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
  reload: () => void;
} {
  const [data, setData] = useState<RsiIterationList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    getRsiIterations(60)
      .then((next) => {
        setData(next);
        setError(null);
        setUpdatedAt(Date.now());
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!enabled) return;
    load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [enabled, load]);
  return { data, error, loading, updatedAt, reload: load };
}

export function RsiSelfIterationDashboard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, error, loading, updatedAt, reload } = useLiveIterations(open);
  const pushToast = useUiStore((s) => s.pushToast);
  const setDraft = useComposerStore((s) => s.setDraft);
  const items = data?.items ?? [];
  const latest = items[items.length - 1];
  const counts = data?.summary.byDecision ?? {};
  const max = Math.max(1, ...DECISIONS.map((d) => counts[d] ?? 0));

  const rounds = useMemo(
    () => items.map((item, index) => ({ item, prev: items[index - 1] })).reverse(),
    [items],
  );

  const startSearch = (): void => {
    setDraft(
      '请联网搜索同类产品（Agent/Runtime/RSI 自迭代方向），对比它们如何衡量工具成功率、审批拒绝率、预算效率与迭代收益；把检索来源、结论、可借鉴参数或信号逻辑写入本轮迭代证据。',
    );
    pushToast({ message: '检索任务已填入输入框，确认后发送', variant: 'success' });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="自迭代雷达" maxWidth={1000}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg-secondary px-3 py-2 text-xs">
          <span className={cn('inline-flex items-center gap-1.5 font-medium', error ? 'text-danger' : 'text-success')}>
            <span className={cn('h-1.5 w-1.5 rounded-full', error ? 'bg-danger' : 'bg-success')} />
            {error ? '连接中断' : '实时监控中'}
          </span>
          <span className="text-text-tertiary">每 8s 刷新</span>
          {data?.model && <span className="text-text-tertiary">模型 {data.model}</span>}
          {updatedAt && <span className="text-text-tertiary">更新 {new Date(updatedAt).toLocaleTimeString('zh-CN')}</span>}
          <button type="button" onClick={reload} className="ml-auto inline-flex items-center gap-1 text-text-secondary hover:text-accent">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
          </button>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded border border-danger/30 bg-danger-subtle p-2 text-xs text-danger">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="迭代记录" value={data?.summary.total ?? 0} />
          <Stat label="需关注" value={data?.summary.attention ?? 0} tone={(data?.summary.attention ?? 0) > 0 ? 'danger' : 'muted'} />
          <Stat label="最近判决" value={latest?.verdict ?? '—'} tone={latest ? verdictTone(latest.verdict) : 'muted'} />
          <Stat label="最近决策" value={latest ? decisionLabel(latest.result.decision) : '—'} tone={latest ? decisionTone(latest.result.decision) : 'muted'} />
        </div>

        <section>
          <h3 className="mb-2 text-xs font-medium text-text-secondary">决策分布</h3>
          <div className="space-y-1.5">
            {DECISIONS.map((d) => {
              const n = counts[d] ?? 0;
              return (
                <div key={d} className="flex items-center gap-2 text-[11px]">
                  <span className="w-16 shrink-0 text-text-tertiary">{decisionLabel(d)}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded bg-bg-tertiary">
                    <div className={cn('h-full rounded', n > 0 ? 'bg-accent' : 'bg-transparent')} style={{ width: `${(n / max) * 100}%` }} />
                  </div>
                  <span className="w-5 text-right font-mono text-text-secondary">{n}</span>
                </div>
              );
            })}
          </div>
        </section>

        <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-border px-3 py-2">
          <div>
            <p className="text-xs font-medium text-text-primary">同类产品联网检索</p>
            <p className="text-[11px] text-text-tertiary">把检索任务填入输入框，由 Agent 执行并记录证据；面板只展示账本里已有的检索字段。</p>
          </div>
          <button type="button" onClick={startSearch} className="inline-flex shrink-0 items-center gap-1 rounded border border-accent px-2 py-1 text-xs text-accent hover:bg-accent-subtle">
            <Search size={12} /> 发起检索
          </button>
        </div>

        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <Activity size={12} /> 逐轮计算与调整
          </h3>
          {rounds.length === 0 ? (
            <p className="py-8 text-center text-xs text-text-tertiary">{loading ? '正在读取迭代账本…' : '还没有 RSI 迭代记录。'}</p>
          ) : (
            <div className="space-y-2">
              {rounds.map(({ item, prev }) => (
                <RoundCard key={item.id} item={item} prev={prev} />
              ))}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

function Stat({ label, value, tone = 'muted' }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded border border-border bg-bg-primary p-2">
      <div className="text-[11px] text-text-tertiary">{label}</div>
      <div className={cn('mt-0.5 truncate text-sm font-medium', TONE[tone] ?? TONE.muted)}>{value}</div>
    </div>
  );
}

function RoundCard({ item, prev }: { item: RsiIterationRecord; prev?: RsiIterationRecord }) {
  const counts = criteriaCounts(item);
  const changes = rawChanges(prev, item);
  const highlights = rawHighlights(item.raw);
  const evidence = extractSearchEvidence(item.raw);
  return (
    <details className="rounded-md border border-border bg-bg-primary">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-xs">
        <span className="font-mono text-text-tertiary">#{item.attempt}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{item.task}</span>
        <span className={cn('rounded px-1.5 py-0.5 text-[10px]', TONE[verdictTone(item.verdict)])}>{item.verdict}</span>
        <span className={cn('rounded px-1.5 py-0.5 text-[10px]', TONE[decisionTone(item.result.decision)])}>{decisionLabel(item.result.decision)}</span>
        <span className="text-text-tertiary">{item.domain} · {item.trigger}</span>
        <span className="text-text-tertiary">{fmtTime(item.at)}</span>
      </summary>
      <div className="space-y-2 border-t border-border-subtle px-3 py-2 text-xs">
        <div className="flex flex-wrap gap-2 text-[11px] text-text-tertiary">
          <span>判据 {counts.pass} 通过 / {counts.fail} 失败 / {counts.unexec} 未执行</span>
          {item.version && <span>版本 {item.version}</span>}
        </div>
        {item.result.criteria.length > 0 && (
          <table className="w-full text-left text-[11px]">
            <thead className="text-text-tertiary"><tr><th className="py-0.5">判据</th><th>阈值</th><th>实际</th><th>状态</th></tr></thead>
            <tbody>
              {item.result.criteria.map((c) => (
                <tr key={c.id} className="border-t border-border-subtle">
                  <td className="py-0.5 text-text-secondary">{c.name}</td>
                  <td className="font-mono text-text-tertiary">{c.threshold}</td>
                  <td className="font-mono text-text-secondary">{c.actual}</td>
                  <td className={c.status === 'pass' ? 'text-success' : c.status === 'fail' ? 'text-danger' : 'text-warning'}>{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {item.result.rollbackReasons.length > 0 && (
          <p className="text-[11px] text-danger">回滚原因：{item.result.rollbackReasons.join('；')}</p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <Block title="参数 / 信号记录" rows={highlights} empty="本轮没有记录参数或信号字段。" />
          <Block title="较上一轮变化" rows={changes.map((c) => ({ key: c.key, text: `${c.from} → ${c.to}` }))} empty="没有可比较的字段变化。" />
        </div>
        <Block title="联网检索证据" rows={evidence} empty="本轮未记录联网检索证据。" />
      </div>
    </details>
  );
}

function Block({ title, rows, empty }: { title: string; rows: Array<{ key: string; text: string }>; empty: string }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-text-secondary">{title}</p>
      {rows.length === 0 ? (
        <p className="text-[11px] text-text-tertiary">{empty}</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <li key={r.key} className="break-all font-mono text-[10px] text-text-tertiary">
              <span className="text-text-secondary">{r.key}: </span>{r.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

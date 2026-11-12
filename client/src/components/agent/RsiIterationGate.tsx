/**
 * RsiIterationGate — 自我迭代闸门面板。
 *
 * ── 它在整个链路里的位置 ──────────────────────────────────
 * 后端已经能逐轮算出「这一轮达标没有、不达标该重试还是回滚」（iteration-gate），
 * 但那些结论此前只出现在脚本的 stdout 里——人能看见，却**无法在界面上做决定**。
 * 这个面板补的就是这一步：把决策摊开，把人能做的三个动作（批准 / 回滚 / 停机）放到结论旁边。
 *
 * ── 三条显示纪律（与后端契约对齐）────────────────────────
 * 1. **三态而不是两态**：判据的 pass / fail / unexec 分开渲染。把「没执行」画成红色，
 *    会让人误以为跑挂了；画成绿色更糟——那是把没跑说成通过（宣言 C4）。
 * 2. **决策徽标从契约取色**：tone 映射到语义类，不在前端新增颜色值。
 * 3. **动作只是「记录」**：面板上的回滚按钮不会真的改代码（后端只追加一行决策日志）。
 *    所以按钮文案写「记录回滚决定」，不写「回滚」——文案撒谎比功能缺失更坏。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  decideRsiIteration,
  getRsiIterations,
  type RsiIterationList,
  type RsiIterationRecord,
  type RsiTone,
} from '../../services/api';
import {
  filterIterations,
  decisionTone,
  statusLabel,
  statusClass,
  type FilterMode,
} from '../../lib/iteration-gate-view';

// tone → 带边框的语义类只是展示细节；判定逻辑一律走上面的纯函数模块。
const TONE_CLASS: Record<RsiTone, string> = {
  success: 'text-success border-success',
  danger: 'text-danger border-danger',
  warning: 'text-warning border-warning',
  muted: 'text-text-tertiary border-border',
};

const DECISION_LABEL: Record<string, string> = {
  continue: '达标继续',
  retry: '重试',
  rollback: '回滚',
  escalate: '待人审',
  halt: '停机',
};

type Filter = FilterMode;

export function RsiIterationGate(): React.ReactElement {
  const [data, setData] = useState<RsiIterationList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // silent=true 用于轮询：只换数据，不闪「读取中」，也不清掉用户刚看到的提示。
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setData(await getRsiIterations(80));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // 5 秒轮询：CodeLens v9 那种「循环还在后台自己跑」的状态，面板必须自己跟得上，
    // 否则人看到的是几分钟前的快照，会误以为系统停了。
    const timer = window.setInterval(() => void load(true), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (rec: RsiIterationRecord, action: 'approve' | 'rollback' | 'halt') => {
    // 破坏性动作在面板上再确认一次：后端也校验 confirm，这里是第二道。
    if (action !== 'approve') {
      const word = action === 'rollback' ? '回滚' : '停机';
      if (!window.confirm(`确认记录「${word}」决定？\n\n迭代：${rec.id}\n题目：${rec.task}\n\n注意：本操作只记录决定，不会立即改动任何代码。`)) {
        return;
      }
    }
    setBusy(rec.id);
    try {
      const r = await decideRsiIteration(rec.id, action, `由迭代闸门面板发起（${rec.result.decision}）`);
      setFlash(r.note);
      await load();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // 筛选逻辑走纯函数模块（判据可测），组件只负责渲染。
  const items: RsiIterationRecord[] = filterIterations(
    (data?.items ?? []).map((r) => ({ id: r.id, task: r.task, decision: r.result.decision, record: r })),
    filter,
  ).map((x) => x.record);

  const s = data?.summary;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-text-secondary">逐轮判定与去留</span>
          <button
            type="button"
            onClick={() => void load()}
            className="text-xs text-text-tertiary hover:text-text-primary"
            disabled={loading}
          >
            {loading ? '读取中…' : '刷新'}
          </button>
        </div>
        {s && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
            <span>
              共 <span className="text-text-primary">{s.total}</span> 轮
            </span>
            {Object.entries(s.byDecision).map(([k, n]) => (
              <span key={k} className={TONE_CLASS[decisionTone(k)]?.split(' ')[0]}>
                {DECISION_LABEL[k] ?? k} {n}
              </span>
            ))}
            {s.attention > 0 && <span className="text-warning">需关注 {s.attention}</span>}
          </div>
        )}
        {s && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border bg-bg-secondary px-2 py-1.5 text-[11px] text-text-secondary">
            <span>
              轮次 <span className="text-text-primary">{s.total}</span>
            </span>
            <span>
              最新 <span className="text-text-primary">{data?.items?.[0] ? (DECISION_LABEL[data.items[0].result.decision] ?? data.items[0].result.decision) : '—'}</span>
            </span>
            <span>
              模型 <span className="text-text-primary">{data?.model ?? '—'}</span>
            </span>
            <span className="text-text-tertiary">
              5 秒自动刷新{data?.serverTime ? ` · ${data.serverTime.slice(11, 19)}` : ''}
            </span>
          </div>
        )}
        <div className="mt-2 flex gap-3 text-xs">
          {(['all', 'attention', 'ok'] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={filter === f ? 'text-text-primary underline' : 'text-text-tertiary hover:text-text-secondary'}
            >
              {f === 'all' ? '全部' : f === 'attention' ? '需关注' : '达标'}
            </button>
          ))}
        </div>
      </div>

      {flash && (
        <div className="border-b border-border bg-bg-secondary px-4 py-2 text-xs text-text-secondary">
          {flash}
          <button type="button" onClick={() => setFlash(null)} className="ml-2 text-text-tertiary hover:text-text-primary">
            关闭
          </button>
        </div>
      )}

      {error && <div className="px-4 py-3 text-xs text-danger">{error}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 && !loading && (
          <div className="px-4 py-6 text-xs text-text-tertiary">
            没有符合条件的迭代记录。跑一轮自我升级后，这里会出现逐轮判定。
          </div>
        )}
        {items.map((rec) => {
          const tone = decisionTone(rec.result.decision);
          const open = expanded === rec.id;
          return (
            <div key={rec.id} className="border-b border-border px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${TONE_CLASS[tone]}`}>
                      {DECISION_LABEL[rec.result.decision] ?? rec.result.decision}
                    </span>
                    <span className="truncate text-xs text-text-primary">{rec.task}</span>
                    <span className="shrink-0 text-[11px] text-text-tertiary">
                      {rec.domain}｜{rec.verdict}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-text-secondary">{rec.result.headline}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : rec.id)}
                  className="shrink-0 text-[11px] text-text-tertiary hover:text-text-primary"
                >
                  {open ? '收起' : '判据'}
                </button>
              </div>

              {rec.result.rollbackReasons.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {rec.result.rollbackReasons.map((r) => (
                    <li key={r} className="text-[11px] text-danger">
                      {r}
                    </li>
                  ))}
                </ul>
              )}

              {open && (
                <div className="mt-2">
                  <table className="w-full text-left text-[11px]">
                    <thead className="text-text-tertiary">
                      <tr>
                        <th className="py-1 font-normal">判据</th>
                        <th className="py-1 font-normal">阈值</th>
                        <th className="py-1 font-normal">实际</th>
                        <th className="py-1 font-normal">结论</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rec.result.criteria.map((c) => (
                        <tr key={c.id} className="border-t border-border">
                          <td className="py-1 text-text-secondary">
                            {c.id} {c.name}
                          </td>
                          <td className="py-1 text-text-tertiary">{c.threshold}</td>
                          <td className="py-1 text-text-secondary">{c.actual}</td>
                          <td className={`py-1 ${statusClass(c.status)}`}>{statusLabel(c.status)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="mt-1 text-[11px] text-text-tertiary">
                    置信度 {rec.result.confidence.toFixed(2)}
                    {rec.at ? `｜${rec.at.slice(0, 19).replace('T', ' ')}` : ''}
                    {rec.version ? `｜版本 ${rec.version}` : ''}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy === rec.id}
                      onClick={() => void act(rec, 'approve')}
                      className="rounded border border-border px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-50"
                    >
                      记录批准
                    </button>
                    <button
                      type="button"
                      disabled={busy === rec.id}
                      onClick={() => void act(rec, 'rollback')}
                      className="rounded border border-danger px-2 py-1 text-[11px] text-danger disabled:opacity-50"
                    >
                      记录回滚决定
                    </button>
                    <button
                      type="button"
                      disabled={busy === rec.id}
                      onClick={() => void act(rec, 'halt')}
                      className="rounded border border-border px-2 py-1 text-[11px] text-text-tertiary hover:text-danger disabled:opacity-50"
                    >
                      记录停机
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-border px-4 py-2 text-[11px] text-text-tertiary">
        判据三态：通过 / 未通过 / 未执行。「未执行」不算通过，也不算失败。
      </div>
    </div>
  );
}

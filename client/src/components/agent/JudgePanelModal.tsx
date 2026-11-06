// 判据塔面板（运行时「判据塔」按钮打开，只读）。
//
// 三块内容对应强化内核的三件事：
//   1. 判决历史 —— 每次任务被怎么判、覆盖率多少（r 是否可信）；
//   2. 自证状态 —— 金丝雀现在能不能分开好坏样本（判据还有没有资格判决）；
//   3. 经验有效性 —— 注入过的 π 经验，事后任务表现如何（C2 闭环是否真的成立）。
//
// 这里刻意不做任何「手动改判决」的入口：r 只能来自运行期 Judge。

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Gauge, HelpCircle, XCircle } from 'lucide-react';
import { Modal } from '../common/Modal';
import { cn } from '../../lib/cn';
import { useAsyncData } from '../../hooks/useAsyncData';
import {
  deepJudgeRun,
  getJudgeEffectiveness,
  getJudgeRun,
  getJudgeRuns,
  getJudgeSelfCheck,
  getKernelInsight,
  replayJudgeRun,
  type JudgeCriterionVerdict,
  type JudgeDeepResult,
  type JudgeReplayResult,
  type JudgeRunSummary,
  type JudgeRunVerdict,
  type JudgeSelfCheck,
  type JudgeVerdictStatus,
  type LessonEffectivenessRow,
} from '../../services/api';

type Tab = 'runs' | 'self' | 'policy' | 'insight';

/** 空列表用模块级常量：每次渲染新建数组会让下游 memo 与引用比较全部失效。 */
const EMPTY_RUNS: JudgeRunSummary[] = [];
const EMPTY_LESSONS: LessonEffectivenessRow[] = [];

const TABS: { key: Tab; label: string }[] = [
  { key: 'runs', label: '判决历史' },
  { key: 'self', label: '判据塔自证' },
  { key: 'policy', label: '经验有效性' },
  { key: 'insight', label: '内核洞察' },
];

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function runTone(verdict: JudgeRunVerdict): string {
  if (verdict === 'pass') return 'text-success';
  if (verdict === 'fail') return 'text-danger';
  return 'text-warning';
}

function runLabel(verdict: JudgeRunVerdict): string {
  if (verdict === 'pass') return '通过';
  if (verdict === 'fail') return '失败';
  return '未定论';
}

function VerdictIcon({ status }: { status: JudgeVerdictStatus }) {
  if (status === 'pass') return <CheckCircle2 size={12} className="shrink-0 text-success" />;
  if (status === 'fail') return <XCircle size={12} className="shrink-0 text-danger" />;
  return <HelpCircle size={12} className="shrink-0 text-text-tertiary" />;
}

const STATUS_LABEL: Record<JudgeVerdictStatus, string> = {
  pass: '通过',
  fail: '失败',
  unexec: '未执行',
};

export function JudgePanelModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('runs');

  // 三个数据源并发拉取；任一失败则整体降级为错误态
  // （面板语义：要么三块都有，要么明确说明为什么没有）。
  const { data, error, loading } = useAsyncData(
    async () => ({
      runs: await getJudgeRuns({ limit: 50 }),
      selfCheck: await getJudgeSelfCheck(),
      lessons: await getJudgeEffectiveness(),
    }),
    [open],
    { enabled: open, errorMessage: '加载判据塔数据失败' },
  );
  // 空值用模块级常量兜底：每次渲染新建空数组会让下游 memo 失效。
  const runs = data?.runs ?? EMPTY_RUNS;
  const selfCheck = data?.selfCheck ?? null;
  const lessons = data?.lessons ?? EMPTY_LESSONS;

  return (
    <Modal open={open} onClose={onClose} title="判据塔" maxWidth={680}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-text-secondary leading-relaxed">
          判决由运行期判据塔产出，此处只读。「未执行」不等于通过：覆盖率不足时只会给出
          <span className="text-warning"> 未定论 </span>，不会冒充全绿。
        </p>

        <div className="flex gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'px-2.5 py-1.5 text-xs transition-colors',
                tab === t.key
                  ? 'border-b-2 border-accent text-text-primary'
                  : 'border-b-2 border-transparent text-text-tertiary hover:text-text-secondary',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading && <p className="py-6 text-center text-xs text-text-tertiary">加载中…</p>}

        {!loading && error && (
          <p className="flex items-start gap-1.5 rounded bg-bg-inset p-2.5 text-xs text-danger">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}

        {!loading && !error && tab === 'runs' && (
          <RunsView runs={runs} coverageThreshold={selfCheck?.coverageThreshold ?? 0.6} />
        )}
        {!loading && !error && tab === 'self' && <SelfCheckView selfCheck={selfCheck} />}
        {!loading && !error && tab === 'policy' && <PolicyView lessons={lessons} />}
        {/* 条件渲染即懒加载：只在切到该 tab 时挂载并发请求，
            不并进上面的 Promise.all（那会让每次开面板都解压 200 条深判快照）。 */}
        {!loading && !error && tab === 'insight' && <InsightView />}
      </div>
    </Modal>
  );
}

function RunsView({ runs, coverageThreshold }: { runs: JudgeRunSummary[]; coverageThreshold: number }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, JudgeCriterionVerdict[]>>({});
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [replays, setReplays] = useState<Record<number, JudgeReplayResult>>({});
  const [replayLoading, setReplayLoading] = useState<number | null>(null);
  const [replayError, setReplayError] = useState<Record<number, string>>({});
  const [deeps, setDeeps] = useState<Record<number, JudgeDeepResult>>({});
  const [deepLoading, setDeepLoading] = useState<number | null>(null);
  const [deepError, setDeepError] = useState<Record<number, string>>({});

  // 深判会真的调用模型、真的花钱，所以只在用户明确点击时发生，不做自动触发。
  const deep = (id: number): void => {
    setDeepLoading(id);
    setDeepError((prev) => ({ ...prev, [id]: '' }));
    deepJudgeRun(id, {})
      .then((r) => setDeeps((prev) => ({ ...prev, [id]: r })))
      .catch((err) => setDeepError((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : '深判失败' })))
      .finally(() => setDeepLoading(null));
  };

  const toggle = (id: number): void => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (details[id]) return;
    setLoadingId(id);
    setLoadError(null);
    getJudgeRun(id)
      .then((d) => setDetails((prev) => ({ ...prev, [id]: d.verdicts })))
      .catch((err) => setLoadError(err instanceof Error ? err.message : '加载判据明细失败'))
      .finally(() => setLoadingId(null));
  };

  // 复算只是「重放一次判决」，不改任何数据；因此可以随便点。
  const replay = (id: number): void => {
    setReplayLoading(id);
    setReplayError((prev) => ({ ...prev, [id]: '' }));
    replayJudgeRun(id, 'snapshot')
      .then((r) => setReplays((prev) => ({ ...prev, [id]: r })))
      .catch((err) => setReplayError((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : '复算失败' })))
      .finally(() => setReplayLoading(null));
  };

  if (runs.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-text-tertiary">
        还没有判决记录。完成一次任务后，判据塔会在收尾时自动作出判决。
      </p>
    );
  }
  return (
    <div className="flex max-h-[52vh] flex-col gap-1.5 overflow-y-auto pr-1">
      {loadError && <p className="text-[11px] text-danger">{loadError}</p>}
      <ul className="flex flex-col gap-1.5">
        {runs.map((r) => {
          const lowCoverage = r.coverage < coverageThreshold;
          const isOpen = expanded === r.id;
          return (
            <li key={r.id} className="rounded border border-border bg-bg-inset px-2.5 py-2">
              <button
                type="button"
                onClick={() => toggle(r.id)}
                className="flex w-full items-center gap-2 text-left"
              >
                <span className={cn('text-xs font-medium', runTone(r.verdict))}>{runLabel(r.verdict)}</span>
                {r.tier === 'deep' ? (
                  <span
                    className="rounded border border-accent/40 px-1 text-[10px] text-accent"
                    title="LLM 深判：只追加一条独立判决，不改写原判决"
                  >
                    深判·LLM{r.parentRun ? ` ← #${r.parentRun}` : ''}
                  </span>
                ) : (
                  <span className="rounded border border-border px-1 text-[10px] text-text-tertiary">规则判</span>
                )}
                <span className="text-[11px] text-text-tertiary">
                  得分 {(r.score * 100).toFixed(0)} · 覆盖率 {pct(r.coverage)}（{r.executed}/{r.total}）
                  <span className="ml-1">全塔 {pct(r.towerCoverage)}</span>
                </span>
                {r.degraded && (
                  <span
                    className="rounded border border-warning/40 px-1 text-[10px] text-warning"
                    title="本次有判据本可执行却未执行，结论只覆盖已执行的部分"
                  >
                    降级
                  </span>
                )}
                <span className="ml-auto text-[11px] text-text-tertiary">
                  {new Date(r.createdAt).toLocaleString()}
                </span>
              </button>
              {lowCoverage && (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-warning">
                  <AlertTriangle size={11} className="shrink-0" />
                  可用判据覆盖率不足 60%，本次结论不作为「通过」采信
                </p>
              )}
              {isOpen && (
                <div className="mt-1.5 border-t border-border pt-1.5">
                  {(r.reasons ?? []).length > 0 && (
                    <p className="mb-1 text-[11px] text-warning">定档理由：{(r.reasons ?? []).join('、')}</p>
                  )}
                  {(r.unavailableLayers ?? []).length > 0 && (
                    <p className="mb-1 text-[11px] text-text-tertiary">
                      不可用层：
                      {(r.unavailableLayers ?? [])
                        .map((p) => `${p.layer}（${p.detail ?? p.reason ?? '未说明'}）`)
                        .join('、')}
                    </p>
                  )}
                  {loadingId === r.id && <p className="text-[11px] text-text-tertiary">加载判据明细…</p>}
                  {details[r.id] && (
                    <ul className="flex flex-col gap-1">
                      {details[r.id].map((v) => (
                        <li key={v.id} className="flex items-start gap-1.5">
                          <VerdictIcon status={v.status} />
                          <span className="text-[11px] text-text-tertiary">{v.layer}</span>
                          <span className="min-w-0 flex-1">
                            <span className="text-[11px] text-text-secondary">{v.criterion}</span>
                            <span className="ml-1 text-[11px] text-text-tertiary">
                              {STATUS_LABEL[v.status]}
                            </span>
                            {v.detail && (
                              <span className="block text-[11px] text-text-tertiary">{v.detail}</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => replay(r.id)}
                      disabled={replayLoading === r.id}
                      className="rounded border border-border px-1.5 py-0.5 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-50"
                    >
                      {replayLoading === r.id ? '复算中…' : '复算'}
                    </button>
                    {/* 只有 v2 快照的规则判决才可深判：v1 没留语义证据，深判无从下手。 */}
                    {r.tier !== 'deep' && r.coverageVersion === 2 && (
                      <button
                        type="button"
                        onClick={() => deep(r.id)}
                        disabled={deepLoading === r.id}
                        title="让模型重判这一条的语义层；会真实调用模型并可能产生费用，结果作为新判决追加，原判决不变"
                        className="rounded border border-accent/40 px-1.5 py-0.5 text-[11px] text-accent hover:text-text-primary disabled:opacity-50"
                      >
                        {deepLoading === r.id ? '深判中…' : '深判（调用模型）'}
                      </button>
                    )}
                    {deeps[r.id] && <DeepBadge result={deeps[r.id]} />}
                    {deepError[r.id] && <span className="text-[11px] text-danger">{deepError[r.id]}</span>}
                    {replays[r.id] && <ReplayBadge result={replays[r.id]} />}
                    {replays[r.id]?.evidence.drifted && (
                      <span className="text-[11px] text-warning" title="判决后证据被改动过；复算仍按快照进行">
                        证据已漂移
                      </span>
                    )}
                    {replayError[r.id] && <span className="text-[11px] text-danger">{replayError[r.id]}</span>}
                  </div>
                  {replays[r.id]?.diffs.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {replays[r.id].diffs.map((d) => (
                        <li key={`${d.layer}:${d.criterion}:${d.kind}`} className="text-[11px] text-danger">
                          {d.layer} · {d.criterion}：记录 {String(d.recorded)} → 重算 {String(d.recomputed)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {replays[r.id]?.reasons.length > 0 && (
                    <p className="mt-1 text-[11px] text-text-tertiary">
                      复算说明：{replays[r.id].reasons.join('、')}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 深判失败原因的中文映射。
 * 这些文案刻意都用**中性**描述：深判没跑成是「没测到」，不是任务失败，
 * 所以一律不套用红色（红=失败）。
 */
const DEEP_FAILURE_LABEL: Record<string, string> = {
  timeout: '模型超时',
  invalid_json: '输出不是合法 JSON',
  schema_violation: '输出结构不合法',
  out_of_range: '分数越界',
  inconsistent_output: '输出自相矛盾',
  empty_output: '模型返回空内容',
  not_configured: '未配置深判凭证',
  injection_suspected: '回答含可疑指令，已拒绝判绿',
  original_not_eligible: '该判决不可深判',
  provider_error: '上游错误',
  network: '网络错误',
  rate_limited: '被上游限流',
  aborted: '调用被中止',
};

function DeepBadge({ result }: { result: JudgeDeepResult }) {
  if (result.status === 'unexec') {
    const label = result.failure ? (DEEP_FAILURE_LABEL[result.failure] ?? result.failure) : '证据不足';
    return (
      <span className="text-[11px] text-text-tertiary" title={`failure=${result.failure ?? 'unknown'}`}>
        深判未判定（{label}）
      </span>
    );
  }
  if (result.status === 'reused') {
    return <span className="text-[11px] text-text-tertiary">深判已复用 #{result.runId}</span>;
  }
  const verdictText = result.verdict === 'pass' ? '通过' : result.verdict === 'fail' ? '失败' : '未定论';
  return (
    <span className="text-[11px] text-accent">
      深判 #{result.runId}：{verdictText}
      {result.deep ? ` · ${result.deep.provider.model}` : ''}
    </span>
  );
}

/**
 * 内核洞察：把四个机制的运行状况放在一屏里。
 *
 * 懒加载由条件渲染天然给出（切到该 tab 才挂载），所以这里不需要额外的
 * 「是否已加载过」状态 —— 也不会拖慢打开面板的主路径。
 *
 * 每个数字旁边的口径小字不是装饰：这一屏最容易误读的三处是
 * 「深判行数 ≠ 被深判的原判决数」「深判花费不计入会话预算」「— 不是 0%」。
 */
function InsightView() {
  const { data, loading, error } = useAsyncData(() => getKernelInsight(), [], {
    errorMessage: '加载内核洞察失败',
  });

  if (loading) return <p className="py-6 text-center text-xs text-text-tertiary">加载中…</p>;
  if (error) return <p className="py-6 text-center text-xs text-danger">{error}</p>;
  if (!data) return null;

  const { layers, distribution, deepUsage, injection, window: win } = data;
  const canaryBad = layers.canary.status !== 'pass';

  return (
    <div className="flex max-h-[52vh] flex-col gap-3 overflow-y-auto pr-1">
      {canaryBad && (
        <p className="rounded border border-danger/40 bg-danger/5 px-2 py-1 text-[11px] text-danger">
          判据塔自证未通过（{layers.canary.detail || '金丝雀判别力不足'}），本轮 L0 绿一律作废。
        </p>
      )}
      {data.errors.length > 0 && (
        <p className="text-[11px] text-warning">部分数据降级：{data.errors.join('、')}</p>
      )}

      <section>
        <h4 className="mb-1 text-[11px] font-medium text-text-secondary">四层判据</h4>
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-text-tertiary">
              <th className="text-left font-normal">层</th>
              <th className="text-left font-normal">可用 / 必需</th>
              <th className="text-left font-normal">最近判决覆盖率</th>
            </tr>
          </thead>
          <tbody>
            {layers.items.map((item) => (
              <tr key={item.layer} title={item.detail ?? item.reason ?? ''}>
                <td className="text-text-secondary">{item.layer}</td>
                <td className={cn(item.available ? 'text-success' : 'text-text-tertiary')}>
                  {item.available ? '可用' : '不可用'}
                  <span className="text-text-tertiary">{item.required ? ' · 必需' : ''}</span>
                </td>
                <td className="text-text-secondary">
                  {item.lastRunCoverage === null ? '—' : pct(item.lastRunCoverage)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-[10px] text-text-tertiary">
          「—」表示最近一次规则判决没有留下快照，不是 0%。覆盖率门槛 {pct(layers.coverageThreshold)}。
        </p>
      </section>

      <section>
        <h4 className="mb-1 text-[11px] font-medium text-text-secondary">
          判决分布（最近 {win.runsScanned} 次，全库 {distribution.totalRuns} 次）
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border border-border bg-bg-inset px-2 py-1.5">
            <div className="text-[11px] text-text-secondary">规则判 {distribution.rules.runs} 次</div>
            <div className="text-[10px] text-text-tertiary">
              通过 {distribution.rules.pass} · 失败 {distribution.rules.fail} · 未定论{' '}
              {distribution.rules.inconclusive}
            </div>
          </div>
          <div className="rounded border border-accent/30 bg-bg-inset px-2 py-1.5">
            <div className="text-[11px] text-text-secondary">深判·LLM {distribution.deep.runs} 次</div>
            <div className="text-[10px] text-text-tertiary">
              通过 {distribution.deep.pass} · 失败 {distribution.deep.fail} · 未定论{' '}
              {distribution.deep.inconclusive}
            </div>
            <div className="text-[10px] text-text-tertiary">
              覆盖原判决 {distribution.deep.coveredOriginals} · 重复深判 {distribution.deep.repeatParents}
            </div>
          </div>
        </div>
        <p className="mt-1 text-[10px] text-text-tertiary">
          一次深判 = 一行 = 一个样本，不等于被深判的原判决数。
        </p>
      </section>

      <section>
        <h4 className="mb-1 text-[11px] font-medium text-text-secondary">深判花费</h4>
        {distribution.deep.runs === 0 ? (
          <p className="text-[11px] text-text-tertiary">
            还没有深判记录（深判需在「判决历史」里手动触发）。
          </p>
        ) : (
          <>
            <div className="text-[11px] text-text-secondary">
              合计 {deepUsage.totalTokens} tokens
              <span className="text-text-tertiary">
                （prompt {deepUsage.promptTokens} / completion {deepUsage.completionTokens}）
              </span>
            </div>
            <div className="text-[10px] text-text-tertiary">
              有记录 {deepUsage.rowsWithUsage} 条 · 扫描 {win.deepScanned} 条
              {win.deepTruncated ? `（仅最近 ${win.deepScanLimit} 条）` : ''}
              {deepUsage.avgLatencyMs !== null ? ` · 平均延迟 ${deepUsage.avgLatencyMs}ms` : ''}
            </div>
            {deepUsage.byModel.length > 0 && (
              <ul className="mt-1 flex flex-col gap-0.5">
                {deepUsage.byModel.slice(0, 3).map((m) => (
                  <li key={m.model} className="text-[10px] text-text-tertiary">
                    {m.model}：{m.runs} 次 · {m.promptTokens + m.completionTokens} tokens
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-[10px] text-text-tertiary">
              仅统计已落库的深判行；复用（reused）不写行不计费。深判花费不计入会话 token 预算。
            </p>
          </>
        )}
      </section>

      <section>
        <h4 className="mb-1 text-[11px] font-medium text-text-secondary">本轮经验注入</h4>
        {injection === null ? (
          <p className="text-[11px] text-text-tertiary">注入视图未接线。</p>
        ) : injection.lessons.length === 0 ? (
          <p className="text-[11px] text-text-tertiary">π 还没有经验。</p>
        ) : (
          <>
            <ol className="flex flex-col gap-0.5">
              {injection.lessons.map((lesson, i) => (
                <li key={lesson} className="text-[11px] text-text-secondary">
                  {i + 1}. {lesson}
                </li>
              ))}
            </ol>
            <div className="mt-1 text-[10px] text-text-tertiary">
              注入 {injection.chars} 字符
              {injection.budget ? ` / 预算 ${injection.budget.maxChars}` : ''}
              {' · '}π 共 {injection.policyLessons} 条
              {injection.evicted.length === 0
                ? ' · 预算内全部注入'
                : ` · 本轮裁掉 ${injection.evicted.length} 条`}
            </div>
            {injection.evicted.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[10px] text-text-tertiary">
                  查看被裁掉的 {injection.evicted.length} 条
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {injection.evicted.map((lesson) => (
                    <li key={lesson} className="text-[10px] text-text-tertiary">
                      · {lesson}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>
    </div>
  );
}

const REPLAY_LABEL: Record<JudgeReplayResult['outcome'], { text: string; tone: string }> = {
  reproduced: { text: '复算一致', tone: 'text-success' },
  mismatch: { text: '复算不符', tone: 'text-danger' },
  unreproducible: { text: '无法复算', tone: 'text-text-tertiary' },
};

function ReplayBadge({ result }: { result: JudgeReplayResult }) {
  const meta = REPLAY_LABEL[result.outcome];
  return <span className={cn('text-[11px]', meta.tone)}>{meta.text}</span>;
}

function SelfCheckView({ selfCheck }: { selfCheck: JudgeSelfCheck | null }) {
  if (!selfCheck) return null;
  const canaryOk = selfCheck.canary.status === 'pass';
  return (
    <div className="flex max-h-[52vh] flex-col gap-2.5 overflow-y-auto pr-1">
      <div
        className={cn(
          'rounded border px-2.5 py-2',
          canaryOk ? 'border-border bg-bg-inset' : 'border-danger/40 bg-bg-inset',
        )}
      >
        <div className="flex items-center gap-1.5">
          <Gauge size={13} className={canaryOk ? 'text-success' : 'text-danger'} />
          <span className="text-xs font-medium text-text-primary">金丝雀判别力</span>
          <span className={cn('ml-auto text-[11px]', canaryOk ? 'text-success' : 'text-danger')}>
            {canaryOk ? '成立' : STATUS_LABEL[selfCheck.canary.status]}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-text-secondary leading-relaxed">{selfCheck.canary.detail}</p>
        <p className="mt-1 text-[11px] text-text-tertiary">
          已知好样本得分 {selfCheck.canary.goodScore} · 已知坏样本得分 {selfCheck.canary.badScore}
        </p>
      </div>

      <div className="rounded border border-border bg-bg-inset px-2.5 py-2">
        <p className="text-xs font-medium text-text-primary">判据阈值（可被自我修改收紧，不可放宽越界）</p>
        <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-text-secondary">
          <li>工具成功率下限：{pct(selfCheck.thresholds.minToolSuccessRate)}</li>
          <li>审批拒绝率上限：{pct(selfCheck.thresholds.maxApprovalRejectionRate)}</li>
          <li>预算使用率上限：{pct(selfCheck.thresholds.maxBudgetUsageRate)}</li>
        </ul>
      </div>

      {selfCheck.unimplementedLayers.length > 0 && (
        <div className="rounded border border-border bg-bg-inset px-2.5 py-2">
          <p className="text-xs font-medium text-text-primary">尚未实现的层（如实标注为未执行）</p>
          <ul className="mt-1 flex flex-col gap-1 text-[11px] text-text-secondary">
            {selfCheck.unimplementedLayers.map((l) => (
              <li key={l.layer}>
                <span className="text-warning">{l.layer}</span> · {l.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded border border-border bg-bg-inset px-2.5 py-2">
        <p className="text-xs font-medium text-text-primary">
          判据历史分布 <span className="ml-1 text-[11px] text-text-tertiary">共 {selfCheck.totalRuns} 次判决</span>
        </p>
        {selfCheck.criteria.length === 0 ? (
          <p className="mt-1 text-[11px] text-text-tertiary">尚无历史数据</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1 text-[11px]">
            {selfCheck.criteria.map((c) => (
              <li key={c.criterion} className="flex items-center gap-1.5">
                <span className="text-text-tertiary">{c.layer}</span>
                <span className="min-w-0 flex-1 truncate text-text-secondary">{c.criterion}</span>
                <span className="text-success">{c.pass}</span>
                <span className="text-danger">{c.fail}</span>
                <span className="text-text-tertiary">{c.unexec}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PolicyView({ lessons }: { lessons: LessonEffectivenessRow[] }) {
  if (lessons.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-text-tertiary">
        还没有经验被注入过。当任务以失败判决收尾时，判据塔会沉淀经验并在下次任务中注入。
      </p>
    );
  }
  return (
    <ul className="flex max-h-[52vh] flex-col gap-1.5 overflow-y-auto pr-1">
      {lessons.map((l) => (
        <li key={l.lesson} className="rounded border border-border bg-bg-inset px-2.5 py-2">
          <p className="text-[11px] text-text-secondary leading-relaxed">{l.lesson}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-tertiary">
            <span>注入 {l.injected} 次</span>
            <span className="text-success">通过 {l.passes}</span>
            <span className="text-danger">失败 {l.fails}</span>
            {l.inconclusive > 0 && <span className="text-warning">未定论 {l.inconclusive}</span>}
            {l.pending > 0 && <span>待验证 {l.pending}</span>}
            <span className="ml-auto text-text-secondary">
              {l.passRate === null ? '有效性未知' : `通过率 ${pct(l.passRate)}`}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

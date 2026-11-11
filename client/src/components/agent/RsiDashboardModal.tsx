// RSI 判据读数面板 —— 只读展示 /api/rsi/overview 的判据塔判决与 RSI 代际。
// 关键口径：task.test_pass_rate 的分母是固定评测套件的用例数，分母变化即基线断裂，
// 因此曲线按分母分段绘制、断点单独标注，不能跨段连线比较。

import {
  AlertTriangle, CheckCircle2, FlaskConical, GitCompare, Info, ListChecks,
  RefreshCw, ServerOff, ShieldCheck,
} from 'lucide-react';
import type { RsiEval, RsiOverview, RsiRulesContract } from '../../services/api';
import { getRsiOverview } from '../../services/api';
import { useAsyncData } from '../../hooks/useAsyncData';
import {
  buildPassSeries,
  latestPoint,
  type RsiPassPoint,
  type RsiPassSeries,
  type RsiSuiteResult,
} from '../../lib/rsi-series';
import {
  criterionStatusPresentation,
  judgeRunPresentation,
  resolveContract,
  rsiStateAction,
  rsiStatePresentation,
  ruleIdFromReason,
} from '../../lib/rsi-rules';
import { Modal } from '../common/Modal';
import { cn } from '../../lib/cn';

interface RsiDashboardModalProps {
  open: boolean;
  onClose: () => void;
  /** 当前活动会话；为空时面板提示先选择会话 */
  sessionId: string | null;
}

export function RsiDashboardModal({ open, onClose, sessionId }: RsiDashboardModalProps) {
  const { data, error, loading, reload } = useAsyncData(
    () => (sessionId ? getRsiOverview(sessionId) : Promise.reject(new Error('未选择会话'))),
    [sessionId],
    { enabled: open && !!sessionId, errorMessage: '加载 RSI 读数失败' },
  );

  const series = data ? buildPassSeries(data.judgeRuns, data.verdictsByRun) : null;
  // 旧后端不下发 rules 时用逐值相同的兜底契约；整个面板共用同一份契约（AC-08）。
  const contract = resolveContract(data?.rules);

  return (
    <Modal open={open} onClose={onClose} title="RSI 判据读数" maxWidth={880}>
      <div className="flex flex-col gap-4">
        <p className="text-xs leading-relaxed text-text-secondary">
          只读视图：数据来自当前会话的判据塔判决与 RSI 代际。通过率的分母是「固定评测套件用例数」；
          分母扩大时曲线会断开，扩题前后的点不能直接跨基线比较。
        </p>

        {!sessionId ? (
          <EmptyBlock
            title="还没有选中的会话"
            detail="先在左侧选择或新建一个会话，RSI 读数按会话归集。"
          />
        ) : loading ? (
          <p className="py-10 text-center text-sm text-text-secondary">正在读取 RSI 读数…</p>
        ) : error ? (
          <ErrorBlock error={error} onRetry={reload} />
        ) : !data ? (
          <EmptyBlock title="没有可展示的数据" detail="接口返回为空，请稍后重试。" />
        ) : data.judgeRuns.length === 0 && data.rsiRuns.length === 0 ? (
          <EmptyBlock
            title="这个会话还没有判据读数"
            detail="判据塔在该会话跑过判决后，这里会出现套件通过率、分母基线与代际曲线。"
          />
        ) : (
          <>
            <DataVersionNotice evalData={data.eval} />
            <SummaryTiles
              data={data}
              evalData={data.eval}
              series={series ?? buildPassSeries([], {})}
              contract={contract}
            />
            <PassRateSection series={series ?? buildPassSeries([], {})} />
            <SuiteSection
              evalData={data.eval}
              series={series ?? buildPassSeries([], {})}
              contract={contract}
            />
            <GenerationSection data={data} contract={contract} />
            <RulesSection contract={contract} />
          </>
        )}
      </div>
    </Modal>
  );
}

function pct(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const percent = value * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

function formatDateTime(timestamp: number): string {
  if (!timestamp) return '时间未知';
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// 三套枚举域（判据塔 run / RSI 代际 / 单条判据 status）不再共用一个映射函数：
// 旧函数既判断了后端从不产生的幽灵值，又漏掉 inconclusive 与 6 态 RSI 判决。
// 现在按调用点分别走 lib/rsi-rules.ts 的三套分派，互不串用。

function EmptyBlock({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-bg-tertiary">
        <FlaskConical size={18} className="text-text-tertiary" />
      </div>
      <p className="text-sm font-medium text-text-primary">{title}</p>
      <p className="max-w-md text-xs leading-relaxed text-text-tertiary">{detail}</p>
    </div>
  );
}

function ErrorBlock({ error, onRetry }: { error: string; onRetry: () => void }) {
  const offline = error.includes('无法连接后端服务');
  return (
    <div role="alert" className="rounded-md border border-danger bg-danger-subtle px-3 py-3">
      <div className="flex items-start gap-2">
        {offline ? (
          <ServerOff size={15} className="mt-0.5 shrink-0 text-danger" />
        ) : (
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-danger">
            {offline ? '后端未启动或不可达' : 'RSI 接口请求失败'}
          </p>
          <p className="mt-1 break-words text-xs leading-relaxed text-text-secondary">{error}</p>
          {offline && (
            <p className="mt-1 text-xs leading-relaxed text-text-tertiary">
              在 server/ 下启动后端（默认 127.0.0.1:8080）后点「重试」。
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="flex shrink-0 items-center gap-1 rounded border border-danger px-2 py-1 text-xs text-danger transition-colors duration-150 hover:bg-danger hover:text-bg-primary"
        >
          <RefreshCw size={11} /> 重试
        </button>
      </div>
    </div>
  );
}

function isStructuredEval(evalData: RsiEval | null): boolean {
  if (!evalData) return false;
  if (evalData.source === 'structured') return true;
  if (evalData.source === 'detail_only') return false;
  // 兼容没有 source 的早期响应：有套件或分母/通过数即视为结构化
  return (
    evalData.suites.length > 0 ||
    evalData.denominator !== null ||
    evalData.total !== null ||
    evalData.passed !== null
  );
}

/** 顶部的数据版本提示：结构化 / 旧格式 / 完全没有 eval 三种口径。 */
function DataVersionNotice({ evalData }: { evalData: RsiEval | null }) {
  if (!evalData) {
    return (
      <div className="flex items-start gap-1.5 rounded border border-border bg-bg-primary px-3 py-2">
        <Info size={13} className="mt-0.5 shrink-0 text-text-tertiary" />
        <p className="text-[11px] leading-relaxed text-text-tertiary">
          接口没有返回 eval 字段，套件与分母按 task.test_pass_rate 的 detail 文本解析。
        </p>
      </div>
    );
  }

  if (isStructuredEval(evalData)) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-success bg-success-subtle px-3 py-2">
        <CheckCircle2 size={13} className="shrink-0 text-success" />
        <span className="text-xs font-medium text-success">
          结构化数据（source={evalData.source || 'structured'}）
        </span>
        <span className="text-[11px] text-text-secondary">
          第 {evalData.runId} 次判决 · 分母 {evalData.denominator ?? evalData.total ?? '未知'} ·{' '}
          {evalData.suites.length} 个套件
        </span>
        <span className="text-[11px] text-text-tertiary">
          套件清单与分母直接来自接口字段，不依赖文本解析。
        </span>
        <span className="text-[11px] text-text-tertiary">
          评测集指纹 {evalData.evalSetFingerprint ?? '未标注（旧会话）'} · 失败分类{' '}
          {Object.entries(evalData.failureKinds ?? {})
            .filter(([kind]) => kind !== 'passed')
            .map(([kind, count]) => `${kind}:${count}`)
            .join(' / ') || '无'}{' '}
          · 采样 {evalData.samples ?? 1} 次，可靠性{' '}
          {evalData.reliability === 'measured' ? '已测' : '未测（pass^k 不可计算）'}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded border border-warning bg-warning-subtle px-3 py-2">
      <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
        <AlertTriangle size={13} className="shrink-0" />
        旧格式（source={evalData.source || 'detail_only'}）· 结论不完整
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
        这批读数没有结构化套件与分母（passed / total / denominator 为 null，suites 为空），
        下方按 detail 文本回退解析。null 表示未知，不按 0 处理；无法还原完整套件清单。
      </p>
    </div>
  );
}

function SummaryTiles({
  data,
  evalData,
  series,
  contract,
}: {
  data: RsiOverview;
  evalData: RsiEval | null;
  series: RsiPassSeries;
  contract: RsiRulesContract;
}) {
  const latest = latestPoint(series.points);
  const latestRun = data.judgeRuns[data.judgeRuns.length - 1];
  const latestRsi = data.rsiRuns[data.rsiRuns.length - 1];
  const lastChange = series.changes[series.changes.length - 1];
  const judgePres = latestRun ? judgeRunPresentation(latestRun.verdict, contract) : null;
  const rsiPres = latestRsi ? rsiStatePresentation(latestRsi.verdict, contract) : null;
  // 优先用顶层 eval 的数值（同一次判决），没有时退回序列末点。
  const structured = isStructuredEval(evalData);
  const score = evalData?.score ?? latest?.score ?? null;
  const passed = structured ? (evalData?.passed ?? null) : (latest?.passed ?? null);
  const total = structured
    ? (evalData?.denominator ?? evalData?.total ?? null)
    : (latest?.total ?? null);

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Tile
        label="最新通过率"
        value={score !== null ? pct(score) : '—'}
        detail={
          score !== null
            ? passed !== null && total !== null
              ? `${passed}/${total} 通过${structured ? '' : '（文本解析）'}`
              : structured
                ? '结构化读数缺少通过数'
                : '读数缺少通过数分母'
            : '尚无 test_pass_rate 读数'
        }
      />
      <Tile
        label="判据塔判决"
        value={judgePres ? judgePres.label : '—'}
        detail={
          latestRun
            ? `得分 ${pct(latestRun.score)} · 覆盖率 ${pct(latestRun.coverage)} · 共 ${data.judgeRuns.length} 次`
            : '还没有判决记录'
        }
        tone={judgePres ? judgePres.toneClass : undefined}
      />
      <Tile
        label="分母基线"
        value={
          lastChange
            ? `${lastChange.from}→${lastChange.to}`
            : series.points.length > 0
              ? series.points.some((p) => p.total === null)
                ? '部分未知'
                : '未变化'
              : '—'
        }
        detail={
          lastChange
            ? `共 ${series.changes.length} 次基线切换${
                lastChange.ratio !== null ? `，最近一次 ${lastChange.ratio > 0 ? '+' : ''}${(lastChange.ratio * 100).toFixed(0)}%` : ''
              }`
            : '同一分母内比较才有效'
        }
      />
      <Tile
        label="RSI 代际"
        value={`${data.rsiRuns.length} 代`}
        detail={
          latestRsi
            ? `最新 g${latestRsi.generation} · ${rsiPres?.label ?? latestRsi.verdict}${
                data.attributions.length > 0 ? ` · ${data.attributions.length} 条归因` : ''
              }`
            : '还没有代际对比记录'
        }
        tone={rsiPres ? rsiPres.toneClass : undefined}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-bg-primary px-2.5 py-2">
      <p className="text-[11px] text-text-tertiary">{label}</p>
      <p className={cn('mt-0.5 truncate text-base font-semibold text-text-primary', tone)}>{value}</p>
      <p className="mt-0.5 break-words text-[11px] leading-relaxed text-text-tertiary">{detail}</p>
    </div>
  );
}

function PassRateSection({ series }: { series: RsiPassSeries }) {
  const unknownCount = series.points.filter((p) => p.total === null).length;
  return (
    <section className="rounded-md border border-border bg-bg-primary p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-text-primary">task.test_pass_rate 走势</h3>
        <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-text-tertiary">
          按分母分段
        </span>
        {series.changes.length > 0 && (
          <span className="rounded border border-warning px-1.5 py-0.5 text-[11px] text-warning">
            {series.changes.length} 次基线断点
          </span>
        )}
      </div>

      {series.points.length === 0 ? (
        <p className="mt-3 rounded border border-border bg-bg-secondary px-3 py-6 text-center text-xs leading-relaxed text-text-tertiary">
          判决记录里没有 task.test_pass_rate 读数。该判据只在判据塔跑过代码修复评测时产出；
          仅有普通对话的会话不会有这一项。
        </p>
      ) : (
        <>
          <PassRateChart series={series} />
          {series.points.length === 1 && (
            <p className="mt-1 rounded border border-warning bg-warning-subtle px-2.5 py-1.5 text-[11px] leading-relaxed text-warning">
              只有 1 条 test_pass_rate 读数：能显示当前点，但不足以判断趋势，也看不出分母是否变化。
              不另造数据，等后续判决累积后会按分母分段绘制。
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-tertiary">
            <span className="flex items-center gap-1">
              <span className="inline-block h-0.5 w-4 bg-accent" /> 实线：同分母区间
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-0.5 w-4 border-t border-dashed border-accent" /> 虚线：区间均值
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-3 w-0 border-l border-dashed border-warning" /> 竖线：分母断点
            </span>
          </div>
          {unknownCount > 0 && (
            <p className="mt-1 text-[11px] leading-relaxed text-warning">
              有 {unknownCount} 条读数缺少分母（结构化字段为空且 detail 里没有「X/Y 通过」），
              分母未知，无法判断基线是否一致。
            </p>
          )}
          <BaselineTable changes={series.changes} points={series.points} />
        </>
      )}
    </section>
  );
}

function PassRateChart({ series }: { series: RsiPassSeries }) {
  const W = 660;
  const H = 236;
  const PAD_L = 44;
  const PAD_R = 16;
  const PAD_T = 22;
  const PAD_B = 30;
  const points = series.points;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const xAt = (index: number): number =>
    points.length === 1 ? PAD_L + innerW / 2 : PAD_L + (index * innerW) / (points.length - 1);
  const yAt = (score: number): number => PAD_T + (1 - Math.max(0, Math.min(1, score))) * innerH;
  const grid = [0, 0.25, 0.5, 0.75, 1];

  const describe = points
    .map((p) => `第${p.index}次 ${pct(p.score)}${p.passed !== null ? `（${p.passed}/${p.total}）` : ''}`)
    .join('；');

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mt-3 h-auto w-full"
      role="img"
      aria-label={`通过率走势：${describe}`}
    >
      {grid.map((value) => (
        <g key={value}>
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={yAt(value)}
            y2={yAt(value)}
            stroke="var(--color-border)"
            strokeWidth={1}
            strokeDasharray={value === 0 ? undefined : '3 4'}
            opacity={0.8}
          />
          <text x={PAD_L - 8} y={yAt(value) + 3} textAnchor="end" fontSize="9" fill="var(--color-text-tertiary)">
            {Math.round(value * 100)}%
          </text>
        </g>
      ))}

      {series.segments.slice(1).map((segment, segIndex) => {
        const point = segment[0];
        if (!point) return null;
        const index = points.indexOf(point);
        const x = index > 0 ? (xAt(index - 1) + xAt(index)) / 2 : xAt(index);
        // 只在前一段与当前段的末尾分母都已知时标注数值
        const prevSegment = series.segments[segIndex];
        const from = prevSegment[prevSegment.length - 1]?.total ?? null;
        const to = point.total;
        return (
          <g key={`boundary-${point.runId}`}>
            <line
              x1={x}
              x2={x}
              y1={PAD_T - 6}
              y2={H - PAD_B}
              stroke="var(--color-warning)"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
            {from !== null && to !== null && (
              <text
                x={x}
                y={PAD_T - 9}
                textAnchor="middle"
                fontSize="8.5"
                fill="var(--color-warning)"
              >
                分母 {from}→{to}
              </text>
            )}
          </g>
        );
      })}

      {series.segments.map((segment, segIndex) => {
        const coords = segment
          .map((p) => `${xAt(points.indexOf(p))},${yAt(p.score)}`)
          .join(' ');
        const average =
          segment.reduce((sum, p) => sum + p.score, 0) / Math.max(1, segment.length);
        const firstIndex = points.indexOf(segment[0]);
        const lastIndex = points.indexOf(segment[segment.length - 1]);
        return (
          <g key={`segment-${segIndex}`}>
            <line
              x1={xAt(firstIndex)}
              x2={xAt(lastIndex)}
              y1={yAt(average)}
              y2={yAt(average)}
              stroke="var(--color-accent)"
              strokeWidth={1}
              strokeDasharray="5 5"
              opacity={0.35}
            />
            {segment.length > 1 && (
              <polyline
                points={coords}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {segment.map((p) => (
              <g key={p.runId}>
                <circle
                  cx={xAt(points.indexOf(p))}
                  cy={yAt(p.score)}
                  r={4}
                  fill={p.status === 'fail' ? 'var(--color-danger)' : 'var(--color-accent)'}
                  stroke="var(--color-bg-primary)"
                  strokeWidth={1.2}
                >
                  <title>{pointTooltip(p)}</title>
                </circle>
              </g>
            ))}
          </g>
        );
      })}

      <text x={PAD_L} y={H - 8} fontSize="9" fill="var(--color-text-tertiary)">
        第 1 次判决
      </text>
      <text x={W - PAD_R} y={H - 8} textAnchor="end" fontSize="9" fill="var(--color-text-tertiary)">
        第 {points.length} 次 · {formatDateTime(points[points.length - 1].createdAt)}
      </text>
    </svg>
  );
}

function pointTooltip(point: RsiPassPoint): string {
  const battery =
    point.passed !== null && point.total !== null ? ` · ${point.passed}/${point.total} 通过` : ' · 分母未知';
  return `第${point.index}次判决 · ${formatDateTime(point.createdAt)}\n得分 ${pct(point.score)}${battery}`;
}

function BaselineTable({ changes, points }: { changes: RsiPassSeries['changes']; points: RsiPassPoint[] }) {
  if (changes.length === 0) {
    const knownTotals = Array.from(
      new Set(points.map((p) => p.total).filter((total): total is number => total !== null)),
    );
    const unknownCount = points.filter((p) => p.total === null).length;
    return (
      <p className="mt-2 text-[11px] leading-relaxed text-text-tertiary">
        {knownTotals.length > 0
          ? `${points.length} 条读数的分母均为 ${knownTotals.join(' / ')}，未观察到分母变化，因此没有基线断点。`
          : '未观察到分母变化'}
        {unknownCount > 0 ? `（其中 ${unknownCount} 条读数缺少分母，结论不完整）` : ''}
        。
      </p>
    );
  }
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[420px] text-left text-xs">
        <thead className="text-text-tertiary">
          <tr className="border-b border-border">
            <th className="py-1 font-normal">断点</th>
            <th className="py-1 font-normal">时间</th>
            <th className="py-1 font-normal">分母变化</th>
            <th className="py-1 font-normal">幅度</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => {
            const point = points[change.atIndex];
            return (
              <tr key={`${change.atIndex}-${change.from}-${change.to}`} className="border-b border-border/60">
                <td className="py-1 text-text-secondary">第 {point?.index ?? '?'} 次判决</td>
                <td className="py-1 text-text-tertiary">{point ? formatDateTime(point.createdAt) : '—'}</td>
                <td className="py-1 text-text-primary">
                  {change.from} → {change.to}
                </td>
                <td className={cn('py-1', change.ratio !== null && change.ratio > 0 ? 'text-warning' : 'text-text-secondary')}>
                  {change.ratio === null
                    ? '—'
                    : `${change.ratio > 0 ? '+' : ''}${(change.ratio * 100).toFixed(0)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SuiteSection({
  evalData,
  series,
  contract,
}: {
  evalData: RsiEval | null;
  series: RsiPassSeries;
  contract: RsiRulesContract;
}) {
  const latest = latestPoint(series.points);
  const structured = isStructuredEval(evalData);
  const suites = structured && evalData ? evalData.suites : [];

  // detail 回退：接口只在「未满分」时回传套件明细，这里汇总历史上出现过的未满分套件。
  const observed = new Map<string, { suite: RsiSuiteResult; index: number }>();
  if (!structured) {
    for (const point of series.points) {
      for (const suite of point.failing) observed.set(suite.id, { suite, index: point.index });
    }
  }

  const passed = structured && evalData ? evalData.passed : (latest?.passed ?? null);
  const total = structured && evalData
    ? (evalData.denominator ?? evalData.total)
    : (latest?.total ?? null);
  const score = structured && evalData ? evalData.score : (latest?.score ?? null);
  const status = structured && evalData ? evalData.status : (latest?.status ?? null);
  // 单条判据 status 的 3 态域，与判据塔 run 级 / RSI 代际 6 态分开分派。
  const statusPres = criterionStatusPresentation(status ?? '', contract);
  const latestStatusPres = criterionStatusPresentation(latest?.status ?? '', contract);

  return (
    <section className="rounded-md border border-border bg-bg-primary p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-text-primary">评测套件通过情况</h3>
        {structured ? (
          <span className="rounded border border-success px-1.5 py-0.5 text-[11px] text-success">
            结构化 · {suites.length} 个套件
          </span>
        ) : (
          <span className="rounded border border-warning px-1.5 py-0.5 text-[11px] text-warning">
            旧格式 · 仅未满分文本
          </span>
        )}
        <span className="text-[11px] text-text-tertiary">
          {latest ? `最近判决：第 ${latest.index} 次 · ${formatDateTime(latest.createdAt)}` : '暂无判决'}
        </span>
      </div>

      {!latest && !evalData ? (
        <p className="mt-2 text-xs text-text-tertiary">还没有可用的 task.test_pass_rate 读数。</p>
      ) : null}
      {!latest && evalData && !structured ? (
        <p className="mt-2 text-xs text-text-tertiary">
          这批旧格式读数没有可解析的 task.test_pass_rate 序列；detail 里也没有通过数，无法还原套件明细。
        </p>
      ) : null}

      {structured && evalData ? (
        <>
          <p className="mt-2 text-xs leading-relaxed text-text-secondary">
            聚合结果：
            <span className="ml-1 font-medium text-text-primary">
              {passed !== null && total !== null ? `${passed}/${total} 通过` : '结构化读数缺少通过数'}
            </span>
            <span className="mx-2 text-text-tertiary">·</span>
            得分 <span className="font-medium text-text-primary">{pct(score)}</span>
            <span className="mx-2 text-text-tertiary">·</span>
            判决 <span className={cn('font-medium', statusPres.toneClass)}>{statusPres.label}</span>
            <span className="mx-2 text-text-tertiary">·</span>
            分母 <span className="font-medium text-text-primary">{evalData.denominator ?? '—'}</span>
          </p>

          {suites.length > 0 ? (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-xs">
                <thead className="text-text-tertiary">
                  <tr className="border-b border-border">
                    <th className="py-1 font-normal">套件</th>
                    <th className="py-1 font-normal">全部用例</th>
                    <th className="py-1 font-normal">公开用例</th>
                    <th className="py-1 font-normal">状态</th>
                    <th className="py-1 font-normal">错误</th>
                  </tr>
                </thead>
                <tbody>
                  {suites.map((suite) => (
                    <tr key={suite.id} className="border-b border-border/60">
                      <td className="py-1 text-text-primary">
                        <span className="font-medium">{suite.title || suite.id}</span>
                        <span className="ml-1 text-[11px] text-text-tertiary">{suite.id}</span>
                      </td>
                      <td className="py-1 text-text-secondary">
                        {suite.passed}/{suite.total}
                      </td>
                      <td className="py-1 text-text-tertiary">
                        {suite.publicPassed}/{suite.publicTotal}
                      </td>
                      <td className={cn('py-1 font-medium', suite.ok ? 'text-success' : 'text-warning')}>
                        {suite.ok ? '通过' : '未满分'}
                      </td>
                      <td className="max-w-[220px] py-1 break-words text-text-tertiary">
                        {suite.error ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-2 text-xs text-text-tertiary">
              本次结构化读数没有回传 suites[]，无法列出逐套件明细；不据此推断全部通过。
            </p>
          )}
        </>
      ) : latest ? (
        <>
          <p className="mt-2 text-xs leading-relaxed text-text-secondary">
            聚合结果（文本解析）：
            <span className="ml-1 font-medium text-text-primary">
              {latest.passed !== null && latest.total !== null
                ? `${latest.passed}/${latest.total} 通过`
                : 'detail 里没有「X/Y 通过」'}
            </span>
            <span className="mx-2 text-text-tertiary">·</span>
            得分 <span className="font-medium text-text-primary">{pct(latest.score)}</span>
            <span className="mx-2 text-text-tertiary">·</span>
            判决 <span className={cn('font-medium', latestStatusPres.toneClass)}>{latestStatusPres.label}</span>
          </p>

          {latest.failing.length > 0 ? (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[360px] text-left text-xs">
                <thead className="text-text-tertiary">
                  <tr className="border-b border-border">
                    <th className="py-1 font-normal">未满分套件（文本解析）</th>
                    <th className="py-1 font-normal">通过</th>
                    <th className="py-1 font-normal">错误</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.failing.map((suite) => (
                    <tr key={suite.id} className="border-b border-border/60">
                      <td className="py-1 font-medium text-text-primary">{suite.id}</td>
                      <td className="py-1 text-text-secondary">
                        {suite.passed}/{suite.total}
                      </td>
                      <td className="py-1 break-words text-text-tertiary">{suite.error ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-2 text-xs text-text-tertiary">
              detail 里没有「未满分：」明细，无法判断是全部通过还是信息缺失。
            </p>
          )}

          {observed.size > 0 && (
            <div className="mt-3">
              <p className="text-[11px] text-text-tertiary">历史出现过的未满分套件（最近一次出现）</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {Array.from(observed.entries()).map(([id, item]) => (
                  <span
                    key={id}
                    className="rounded border border-border bg-bg-secondary px-1.5 py-0.5 text-[11px] text-text-secondary"
                    title={`最近出现在第 ${item.index} 次判决`}
                  >
                    {id} · {item.suite.passed}/{item.suite.total}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      ) : null}

      <div className="mt-3 flex items-start gap-1.5 rounded border border-border bg-bg-secondary px-2 py-1.5">
        <Info size={12} className="mt-0.5 shrink-0 text-text-tertiary" />
        <p className="text-[11px] leading-relaxed text-text-tertiary">
          {structured
            ? '套件清单、通过数与分母来自 eval.suites[] 与 eval.passed/total/denominator。'
            : '旧格式（detail_only）没有结构化套件与分母：以下数值由 task.test_pass_rate 的 detail 文本解析，'
              + '完整套件清单无法还原；null/解析失败一律显示为未知，不按 0 处理。'}
        </p>
      </div>
    </section>
  );
}

function GenerationSection({ data, contract }: { data: RsiOverview; contract: RsiRulesContract }) {
  const runs = [...data.rsiRuns].sort((a, b) => a.generation - b.generation);
  return (
    <section className="rounded-md border border-border bg-bg-primary p-3">
      <h3 className="text-sm font-semibold text-text-primary">RSI 代际对比</h3>
      {runs.length === 0 ? (
        <p className="mt-2 text-xs text-text-tertiary">
          还没有 RSI 代际记录（policy_rsi_runs 为空）；跑够判决样本后才会生成代际对比。
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-xs">
            <thead className="text-text-tertiary">
              <tr className="border-b border-border">
                <th className="py-1 font-normal">代际</th>
                <th className="py-1 font-normal">对比</th>
                <th className="py-1 font-normal">判决</th>
                <th className="py-1 font-normal">退出码</th>
                <th className="py-1 font-normal">原因 · 触发规则 / 处置要求</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const pres = rsiStatePresentation(run.verdict, contract);
                const action = rsiStateAction(run.verdict, contract);
                return (
                  <tr key={run.generation} className="border-b border-border/60">
                    <td className="py-1 text-text-primary">g{run.generation}</td>
                    <td className="py-1 text-text-secondary">
                      {run.prevGeneration === null ? '—' : `g${run.prevGeneration} → g${run.generation}`}
                    </td>
                    <td className={cn('py-1 font-medium', pres.toneClass)}>{pres.label}</td>
                    <td className="py-1 text-text-secondary">{run.exitCode ?? '—'}</td>
                    <td className="max-w-[300px] py-1 break-words">
                      {run.reasons.length > 0 ? (
                        <ul className="flex flex-col gap-1">
                          {run.reasons.map((reason, index) => {
                            const ruleId = ruleIdFromReason(reason, contract);
                            const ruleName = ruleId
                              ? contract.rules.find((rule) => rule.id === ruleId)?.name
                              : null;
                            return (
                              <li key={`${run.generation}-${index}`} className="text-text-tertiary">
                                {ruleId && (
                                  <span
                                    className="mr-1 inline-block rounded border border-border bg-bg-secondary px-1 py-0.5 text-[10px] font-medium text-text-secondary"
                                    title={ruleName ?? ruleId}
                                  >
                                    {ruleId}
                                  </span>
                                )}
                                <span>{reason}</span>
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <span className="text-text-tertiary">—</span>
                      )}
                      {action && (
                        <p className="mt-1 text-[11px] leading-relaxed text-text-tertiary">
                          处置：{action}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * 规则清单：直接消费契约里的 6 条规则，执行顺序按 rules[].order 派生，
 * 不再按编号顺序叙述（R6 实际在 R5 之前执行）。旧后端无 rules 时这里
 * 展示的是逐值相同的兜底契约，不会白屏。
 */
function RulesSection({ contract }: { contract: RsiRulesContract }) {
  const ordered = [...contract.rules].sort((a, b) => a.order - b.order);
  const orderText = ordered.map((rule) => rule.id).join('→');
  return (
    <section className="rounded-md border border-border bg-bg-primary p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ListChecks size={20} className="shrink-0 text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary">规则契约 · {contract.rules.length} 条判据</h3>
        <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-text-tertiary">
          {contract.version} · {contract.authority}
        </span>
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-1.5 rounded border border-border bg-bg-secondary px-2 py-1.5 text-[11px] leading-relaxed text-text-secondary">
        <Info size={16} className="shrink-0 text-text-tertiary" />
        执行顺序 <span className="font-medium text-text-primary">{orderText}</span>，编号顺序不等于执行顺序
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {ordered.map((rule) => (
          <div key={rule.id} className="rounded border border-border bg-bg-secondary px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-2">
              {rule.kind === 'rejection' ? (
                <ShieldCheck size={16} className="shrink-0 text-text-secondary" />
              ) : (
                <GitCompare size={16} className="shrink-0 text-text-secondary" />
              )}
              <span className="text-xs font-semibold text-text-primary">{rule.id}</span>
              <span className="text-xs text-text-primary">{rule.name}</span>
              <span className="rounded border border-border px-1 py-0.5 text-[10px] text-text-tertiary">
                第 {rule.order} 步
              </span>
              <span className="rounded border border-border px-1 py-0.5 text-[10px] text-text-tertiary">
                {rule.kind === 'rejection' ? '前置拒收' : '严格比较'}
              </span>
            </div>
            <dl className="mt-1.5 grid grid-cols-1 gap-x-3 gap-y-0.5 text-[11px] leading-relaxed sm:grid-cols-2">
              <div className="flex gap-1">
                <dt className="shrink-0 text-text-tertiary">适用条件</dt>
                <dd className="text-text-secondary">{rule.appliesWhen}</dd>
              </div>
              <div className="flex gap-1">
                <dt className="shrink-0 text-text-tertiary">判断标准</dt>
                <dd className="text-text-secondary">{rule.criterion}</dd>
              </div>
              <div className="flex gap-1 sm:col-span-2">
                <dt className="shrink-0 text-text-tertiary">响应要求</dt>
                <dd className="text-text-secondary">{rule.onHit}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}

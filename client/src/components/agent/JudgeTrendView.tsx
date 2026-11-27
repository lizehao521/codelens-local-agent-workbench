/**
 * JudgeTrendView —— 判据塔趋势（只读）。
 *
 * 回答 insight 回答不了的问题：这一周判决在变好还是变差？
 * 三条读数叠一张图，各有各的「假信号」边界：
 *   · pass 率（线）：null 断线 —— 没有判决的那天不是「0% 通过」；
 *   · 平均分（线）：只对有 score 的行取均值，空桶为 null；
 *   · 判决量（柱）：用柱高暴露「样本量」—— 只有一两次判决的 100% 通过
 *     和一百次判决的 95% 通过不是同一件事，读图的人必须一眼能看出来。
 *
 * 不引图表库：viewBox 固定 + 纯几何在 lib/judge-trend.ts（已单测）。
 */

import { useState } from 'react';
import { useAsyncData } from '../../hooks/useAsyncData';
import { cn } from '../../lib/cn';
import {
  getJudgeStats,
  type JudgeStats,
} from '../../services/api';
import {
  TREND_BOX,
  bars,
  compactNumber,
  formatBucketLabel,
  lineSegments,
  toTrendPoints,
  xAt,
  yAt,
  type TrendPoint,
} from '../../lib/judge-trend';

const WINDOWS = [7, 14, 30] as const;

function pct(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 100)}%`;
}

function rate(part: number, total: number): number | null {
  return total > 0 ? part / total : null;
}

export function JudgeTrendView() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(7);
  const { data, loading, error } = useAsyncData(() => getJudgeStats(days), [days], {
    errorMessage: '加载判决趋势失败',
  });

  return (
    <div className="flex max-h-[52vh] flex-col gap-3 overflow-y-auto pr-1">
      <div className="flex items-center gap-1">
        {WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setDays(w)}
            className={cn(
              'rounded px-2 py-0.5 text-[11px]',
              days === w
                ? 'bg-accent-subtle text-accent'
                : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary',
            )}
          >
            {w} 天
          </button>
        ))}
        <span className="ml-auto text-[10px] text-text-tertiary">
          只读 · 数据来自 judge_runs 快照
        </span>
      </div>

      {loading && <p className="py-6 text-center text-xs text-text-tertiary">加载中…</p>}
      {error && <p className="py-6 text-center text-xs text-danger">{error}</p>}
      {data && <TrendBody stats={data} />}
    </div>
  );
}

function TrendBody({ stats }: { stats: JudgeStats }) {
  const points = toTrendPoints(stats.buckets);
  const totals = stats.totals;
  const passRate = rate(totals.pass, totals.runs);

  if (totals.runs === 0) {
    return (
      <p className="rounded border border-border bg-bg-inset px-3 py-6 text-center text-xs text-text-tertiary">
        窗口内没有判决记录。跑一次任务后，这里会出现通过率 / 均分 / 判决量三条趋势。
      </p>
    );
  }

  return (
    <>
      <div className="grid grid-cols-4 gap-2">
        <Stat label="判决总数" value={String(totals.runs)} hint={`窗口 ${stats.window.days} 天`} />
        <Stat
          label="通过率"
          value={pct(passRate)}
          tone={passRate !== null && passRate >= 0.8 ? 'success' : passRate !== null && passRate < 0.5 ? 'danger' : undefined}
          hint={`pass ${totals.pass} / fail ${totals.fail} / 不确定 ${totals.inconclusive}`}
        />
        <Stat label="平均分" value={totals.avgScore === null ? '—' : totals.avgScore.toFixed(2)} hint="仅规则与深判的有效 score" />
        <Stat
          label="Token 消耗"
          value={compactNumber(totals.promptTokens + totals.completionTokens)}
          hint={`输入 ${compactNumber(totals.promptTokens)} · 输出 ${compactNumber(totals.completionTokens)}`}
        />
      </div>

      {stats.rowsWithoutSnapshot > 0 && (
        <p className="text-[10px] text-warning">
          有 {stats.rowsWithoutSnapshot} 条判决缺少用量快照（旧版本写入或快照损坏），token 合计只覆盖其余行。
        </p>
      )}

      <TrendChart points={points} bucketMs={stats.window.bucketMs} />
      <Legend />
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'success' | 'danger';
}) {
  return (
    <div className="rounded border border-border bg-bg-inset px-2 py-1.5" title={hint}>
      <div className="text-[10px] text-text-tertiary">{label}</div>
      <div
        className={cn(
          'text-sm font-semibold',
          tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-text-primary',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function TrendChart({ points, bucketMs }: { points: TrendPoint[]; bucketMs: number }) {
  const box = TREND_BOX;
  const maxRuns = Math.max(1, ...points.map((p) => p.runs));
  const runBars = bars(points.map((p) => p.runs), maxRuns, box);
  const passSegs = lineSegments(points.map((p) => p.passRate), 1, box);
  const scoreSegs = lineSegments(points.map((p) => p.avgScore), 1, box);
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const tickValues = [0, 0.5, 1];

  return (
    <svg viewBox={`0 0 ${box.width} ${box.height}`} className="h-auto w-full" role="img" aria-label="判决趋势：通过率与平均分折线 + 判决量柱">
      {tickValues.map((v) => (
        <g key={v}>
          <line
            x1={box.padLeft}
            x2={box.width - box.padRight}
            y1={yAt(v, 1, box)}
            y2={yAt(v, 1, box)}
            stroke="var(--color-border)"
            strokeWidth={1}
            strokeDasharray={v === 0 ? undefined : '3 4'}
            opacity={0.7}
          />
          <text x={box.padLeft - 6} y={yAt(v, 1, box) + 3} textAnchor="end" fontSize="9" fill="var(--color-text-tertiary)">
            {Math.round(v * 100)}%
          </text>
        </g>
      ))}

      {runBars.map((b, i) => (
        <rect
          key={`bar-${i}`}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          fill="var(--color-border)"
          opacity={0.45}
        >
          <title>{`${formatBucketLabel(points[i]!.t, bucketMs)} · ${points[i]!.runs} 次判决`}</title>
        </rect>
      ))}

      {pointerLine(points, 'passRate', 'var(--color-success)', passSegs)}
      {pointerLine(points, 'avgScore', 'var(--color-warning)', scoreSegs)}

      {points.map((p, i) =>
        i % labelEvery === 0 ? (
          <text
            key={`tick-${p.t}`}
            x={xAt(i, points.length, box)}
            y={box.height - box.padBottom + 12}
            textAnchor="middle"
            fontSize="9"
            fill="var(--color-text-tertiary)"
          >
            {formatBucketLabel(p.t, bucketMs)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function pointerLine(
  points: TrendPoint[],
  field: 'passRate' | 'avgScore',
  color: string,
  segments: string[],
) {
  const labelFor = (p: TrendPoint, i: number): string => {
    const v = p[field];
    const shown = v === null ? '—' : `${Math.round(v * 100)}%`;
    return `${formatBucketLabel(p.t, 0)} #${i} · ${shown} · ${p.runs} 次`;
  };
  return (
    <g>
      {segments.map((seg, i) => (
        <polyline key={`${field}-${i}`} points={seg} fill="none" stroke={color} strokeWidth={1.6} />
      ))}
      {points.map((p, i) => {
        const v = p[field];
        if (v === null || !Number.isFinite(v)) return null;
        return (
          <circle
            key={`${field}-dot-${i}`}
            cx={xAt(i, points.length)}
            cy={yAt(v, 1)}
            r={2}
            fill={color}
          >
            <title>{labelFor(p, i)}</title>
          </circle>
        );
      })}
    </g>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-4 text-[10px] text-text-tertiary">
      <span className="flex items-center gap-1">
        <span className="inline-block h-1.5 w-4 rounded-sm bg-border opacity-60" />
        判决量（柱高按窗口内最大量归一）
      </span>
      <span className="flex items-center gap-1">
        <span className="h-0.5 w-4 bg-success" />
        通过率
      </span>
      <span className="flex items-center gap-1">
        <span className="h-0.5 w-4 bg-warning" />
        平均分
      </span>
      <span>断线 = 该桶无判决（不是 0%）</span>
    </div>
  );
}
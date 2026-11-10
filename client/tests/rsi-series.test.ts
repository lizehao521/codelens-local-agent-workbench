import { describe, it, expect } from 'vitest';
import { buildPassSeries, parseBatteryDetail, TEST_PASS_RATE } from '../src/lib/rsi-series';
import type { RsiJudgeRun, RsiVerdictRow } from '../src/services/api';

function run(id: number, createdAt: number): RsiJudgeRun {
  return {
    id,
    verdict: 'pass',
    score: 1,
    coverage: 1,
    executed: 1,
    total: 1,
    createdAt,
  };
}

function verdict(
  runId: number,
  score: number | null,
  detail: string | null,
  data: RsiVerdictRow['data'] = null,
): RsiVerdictRow {
  return { runId, layer: 'task', criterion: TEST_PASS_RATE, status: 'pass', score, detail, data };
}

describe('parseBatteryDetail', () => {
  it('正常例：解析聚合通过数与未满分套件', () => {
    const parsed = parseBatteryDetail(
      '固定评测套件 21/23 通过（含隐藏用例）；未满分：slugify 4/5（err）、json 0/1',
    );
    expect(parsed.passed).toBe(21);
    expect(parsed.total).toBe(23);
    expect(parsed.failing).toEqual([
      { id: 'slugify', passed: 4, total: 5, error: 'err' },
      { id: 'json', passed: 0, total: 1, error: null },
    ]);
  });

  it('边界：detail 为空或格式不符时不猜分母', () => {
    expect(parseBatteryDetail(null)).toEqual({ passed: null, total: null, failing: [] });
    expect(parseBatteryDetail('模型自评通过')).toEqual({ passed: null, total: null, failing: [] });
  });
});

describe('buildPassSeries', () => {
  const judgeRuns = [
    run(1, 1000),
    run(2, 2000),
    run(3, 3000),
    run(4, 4000),
  ];
  const verdictsByRun: Record<number, RsiVerdictRow[]> = {
    1: [verdict(1, 0.9, '固定评测套件 18/20 通过（含隐藏用例）')],
    2: [verdict(2, 0.92, '固定评测套件 20/20 通过（含隐藏用例）')],
    3: [
      // 缺 score 的判决应被跳过
      { runId: 3, layer: 'task', criterion: TEST_PASS_RATE, status: 'unexec', score: null, detail: null, data: null },
    ],
    4: [verdict(4, 0.8, '固定评测套件 40/50 通过（含隐藏用例）；未满分：json 0/1')],
  };

  it('只收录含 task.test_pass_rate 且 score 为数字的判决', () => {
    const series = buildPassSeries(judgeRuns, verdictsByRun);
    expect(series.points.map((p) => p.runId)).toEqual([1, 2, 4]);
    expect(series.points.map((p) => p.index)).toEqual([1, 2, 3]);
  });

  it('按分母切段，并记录分母扩大断点', () => {
    const series = buildPassSeries(judgeRuns, verdictsByRun);
    expect(series.segments.map((s) => s.map((p) => p.total))).toEqual([
      [20, 20],
      [50],
    ]);
    expect(series.changes).toEqual([{ atIndex: 2, from: 20, to: 50, ratio: 1.5 }]);
  });

  it('分母未知的相邻读数归为同一段且不产生断点', () => {
    const series = buildPassSeries(
      [run(1, 1), run(2, 2)],
      {
        1: [verdict(1, 0.5, '无聚合信息')],
        2: [verdict(2, 0.6, '仍然无聚合信息')],
      },
    );
    expect(series.segments).toHaveLength(1);
    expect(series.changes).toEqual([]);
    expect(series.points[0].total).toBeNull();
  });

  it('结构化 data 优先于 detail 文本，并使用 denominator 作分母', () => {
    const series = buildPassSeries(
      [run(1, 1)],
      {
        1: [
          verdict(1, 0.345, '固定评测套件 18/20 通过（含隐藏用例）；未满分：old 1/2', {
            passed: 38,
            total: 110,
            denominator: 110,
            score: 0.345,
            suites: [
              { id: 'slugify', title: '标题转 slug', ok: false, passed: 0, total: 7, publicPassed: 0, publicTotal: 2, error: null },
              { id: 'chunk', title: '数组切块', ok: true, passed: 6, total: 6, publicPassed: 2, publicTotal: 2, error: null },
            ],
          }),
        ],
      },
    );
    const point = series.points[0];
    expect(point.source).toBe('structured');
    expect(point.passed).toBe(38);
    expect(point.total).toBe(110);
    // 只把 ok=false 的套件记为未满分
    expect(point.failing).toEqual([{ id: 'slugify', passed: 0, total: 7, error: null }]);
  });

  it('结构化 data 全空时回退 detail 解析（旧格式不把 null 当 0）', () => {
    const series = buildPassSeries(
      [run(1, 1)],
      {
        1: [
          verdict(1, 0.345, '固定评测套件 38/110 通过（含隐藏用例）；未满分：json 0/1', {
            passed: null,
            total: null,
            denominator: null,
            score: null,
            suites: [],
          }),
        ],
      },
    );
    const point = series.points[0];
    expect(point.source).toBe('detail');
    expect(point.passed).toBe(38);
    expect(point.total).toBe(110);
    expect(point.failing).toEqual([{ id: 'json', passed: 0, total: 1, error: null }]);
  });
});

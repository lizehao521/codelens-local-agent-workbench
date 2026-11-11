/**
 * 判据 · task.suite_floor 的判别力自证。
 *
 * 这条判据存在的理由（M4 · 口径窄于风险）：
 *   task.test_pass_rate 是整机聚合率 Σpassed/Σtotal，13 个套件的涨跌会互相抵消。
 *   实测注入 parse_query 2/8→8/8（+6）同时 csv_import 7/17→2/17（-5），
 *   整机率 0.691→0.699，krsi 判 improved 并写「全部指标严格变好」。
 *   套件地板按套件逐个比较，任何套件通过率下降即判 fail。
 *
 * 每个用例都是「注入坏值 → 必红 → 还原 → 必绿」的一半：
 * 不注入就断言绿，等于没测判别力（M6 永真断言）。
 */
import { describe, expect, it } from 'vitest';
import {
  readSuiteScores,
  suiteFloor,
  suiteFloorVerdict,
  SUITE_FLOOR_CRITERION,
  TEST_PASS_RATE_CRITERION,
  type SuiteScore,
} from '../src/services/judge/eval-rate.js';
import type { CriterionVerdict } from '../src/services/judge/types.js';
import { KNOWN_CRITERIA, verdictsToReadings } from '../src/services/rsi/manifest-builder.js';

const S = (id: string, passed: number, total: number): SuiteScore => ({ id, passed, total });

/** 13 套件基线（与 gen4 实测读数一致，合计 88/136）。 */
const BASE: SuiteScore[] = [
  S('slugify', 7, 7),
  S('chunk', 2, 6),
  S('parse_kv', 3, 8),
  S('interval_merge', 5, 7),
  S('parse_query', 2, 8),
  S('to_roman', 9, 9),
  S('inventory_rollup', 13, 13),
  S('job_queue', 12, 12),
  S('csv_import', 1, 17),
  S('json_patch', 5, 16),
  S('bank_ledger', 15, 16),
  S('rsi_report_parse', 10, 10),
  S('slugify_edge_cases', 4, 7),
];

/** 把某套件的通过数改掉，其余不动。 */
function withSuite(id: string, passed: number): SuiteScore[] {
  return BASE.map((s) => (s.id === id ? { ...s, passed } : s));
}

describe('suiteFloor：逐套件比较', () => {
  it('完全一致 → 1.0，判 pass（可绿）', () => {
    const r = suiteFloor(BASE, BASE)!;
    expect(r.score).toBe(1);
    expect(r.kept).toBe(r.comparable);
    expect(r.regressions).toEqual([]);
  });

  it('任何套件通过率下降 → 必红，并点名是哪一个', () => {
    const r = suiteFloor(BASE, withSuite('csv_import', 0))!;
    expect(r.score).toBeLessThan(1);
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0]).toContain('csv_import');
    expect(r.regressions[0]).toContain('1/17 → 0/17');
  });

  it('套件通过率上升不算回退（只要求不倒退，不要求变好）', () => {
    const r = suiteFloor(BASE, withSuite('parse_query', 8))!;
    expect(r.score).toBe(1);
    expect(r.regressions).toEqual([]);
  });

  it('抵消场景：一涨一跌仍是回退，尽管整机通过数上涨', () => {
    // 这是核心用例：parse_query +6、csv_import -1 时，Σpassed 反而涨 5 例
    // —— 正是能骗过 test_pass_rate、让内核判 improved 的那种形态。
    const cur = withSuite('csv_import', 0).map((s) =>
      s.id === 'parse_query' ? { ...s, passed: 8 } : s,
    );
    const before = BASE.reduce((a, s) => a + s.passed, 0);
    const after = cur.reduce((a, s) => a + s.passed, 0);
    expect(after).toBeGreaterThan(before); // 整机确实涨了
    const r = suiteFloor(BASE, cur)!;
    expect(r.score).toBeLessThan(1); // 地板判红
    expect(r.regressions.join()).toContain('csv_import');
  });

  it('题数变化的套件排除出分母，不当回退（题面变了就不可比）', () => {
    const cur = BASE.map((s) => (s.id === 'chunk' ? S('chunk', 8, 8) : s));
    const r = suiteFloor(BASE, cur)!;
    expect(r.comparable).toBe(BASE.length - 1);
    expect(r.regressions).toEqual([]);
    expect(r.incomparable.join()).toContain('chunk');
  });

  it('上一代有、这一代整条消失 → 算回退（删题比做错更严重）', () => {
    const cur = BASE.filter((s) => s.id !== 'bank_ledger');
    const r = suiteFloor(BASE, cur)!;
    expect(r.regressions.join()).toContain('bank_ledger');
    expect(r.score).toBeLessThan(1);
  });

  it('这一代新增套件不进分母（没有基线，谈不上退步）', () => {
    const cur = [...BASE, S('brand_new', 0, 9)];
    const r = suiteFloor(BASE, cur)!;
    expect(r.comparable).toBe(BASE.length);
    expect(r.score).toBe(1);
    expect(r.incomparable.join()).toContain('brand_new');
  });

  it('上一代的套件这一代全没了 → 0 分，而不是「无可比」（灾难不能退化成空结论）', () => {
    const r = suiteFloor(BASE, [S('other', 0, 5)])!;
    expect(r.score).toBe(0);
    expect(r.regressions).toHaveLength(BASE.length);
  });

  it('上一代本身没有套件读数 → null，绝不编造读数', () => {
    expect(suiteFloor([], BASE)).toBeNull();
  });
});

describe('suiteFloorVerdict：判决形状', () => {
  it('无基线 / 本代无量 → 不产出判决（不冒充读数）', () => {
    expect(suiteFloorVerdict(null, BASE)).toBeNull();
    expect(suiteFloorVerdict(BASE, null)).toBeNull();
    expect(suiteFloorVerdict([], BASE)).toBeNull();
  });

  it('回退时 status=fail 且 detail 点名套件与前后读数', () => {
    const v = suiteFloorVerdict(BASE, withSuite('json_patch', 3))!;
    expect(v.criterion).toBe(SUITE_FLOOR_CRITERION);
    expect(v.status).toBe('fail');
    expect(v.score).toBeLessThan(1);
    expect(String(v.detail)).toContain('json_patch 5/16 → 3/16');
  });

  it('无回退时 status=pass', () => {
    const v = suiteFloorVerdict(BASE, BASE)!;
    expect(v.status).toBe('pass');
    expect(v.score).toBe(1);
  });
});

describe('写进 manifest 的形状（role/direction 决定内核怎么判）', () => {
  it('必须是 guard：写成 objective 会让「持平」也算没变好，真改进被误杀', () => {
    const readings = verdictsToReadings([suiteFloorVerdict(BASE, BASE)!]);
    const r = readings.find((x) => x.metric === 'suite_floor_ratio');
    expect(r).toBeDefined();
    expect(r!.role).toBe('guard'); // 实测：guard 才有「不得变差」语义
    expect(r!.direction).toBe('up');
    expect(r!.basis).toBe(1); // Measured，不是 Relay/Absent
    expect(KNOWN_CRITERIA).toContain(SUITE_FLOOR_CRITERION);
  });

  it('回退时读数 < 1，内核据此判 guard 变差', () => {
    const readings = verdictsToReadings([suiteFloorVerdict(BASE, withSuite('csv_import', 0))!]);
    const r = readings.find((x) => x.metric === 'suite_floor_ratio')!;
    expect(r.n).toBeLessThan(1);
    expect(r.role).toBe('guard');
  });
});

describe('readSuiteScores：从 test_pass_rate 的 data 里取套件明细', () => {
  const mk = (data: unknown): CriterionVerdict[] => [
    {
      layer: 'L1',
      criterion: TEST_PASS_RATE_CRITERION,
      status: 'fail',
      score: 0.647,
      detail: '固定评测套件 88/136 通过',
      data,
    },
  ];

  it('正常明细可读出', () => {
    const got = readSuiteScores(mk({ suites: [{ id: 'a', passed: 1, total: 2 }] }));
    expect(got).toEqual([{ id: 'a', passed: 1, total: 2 }]);
  });

  it('字段缺失/类型不对时跳过该行，而不是当成 0 分', () => {
    const got = readSuiteScores(
      mk({ suites: [{ id: 'a', passed: '1', total: 2 }, { id: 'b', passed: 3, total: 4 }] }),
    );
    expect(got).toEqual([{ id: 'b', passed: 3, total: 4 }]);
  });

  it('没有 data / 空数组 → null（不可得不等于不合格）', () => {
    expect(readSuiteScores(mk(undefined))).toBeNull();
    expect(readSuiteScores(mk({ suites: [] }))).toBeNull();
    expect(readSuiteScores([])).toBeNull();
  });
});

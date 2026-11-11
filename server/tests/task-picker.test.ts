/**
 * 任务选择 · 按分数挑下一道题。
 *
 * 这些用例钉的是「不会浪费一代」的两个具体行为：
 *   - 不撞满分套件（Agent 没活干，那一代白跑）
 *   - 不重复撞同一道修不动的题（换一道才有新信息）
 */
import { describe, expect, it } from 'vitest';
import { pickTaskByScore, suiteIdOfTask, type SuiteScoreLike } from '../src/services/eval/task-picker.js';

const T = (id: string) => `修复 eval/${id}/impl.cjs 的缺陷，让它满足规范。`;

const TASKS = [
  T('bank_ledger'),
  T('chunk'),
  T('csv_import'),
  T('interval_merge'),
  T('inventory_rollup'),
  T('job_queue'),
  T('json_patch'),
  T('parse_kv'),
  T('parse_query'),
  T('slugify'),
  T('slugify_edge_cases'),
  T('to_roman'),
];

/** gen4 实测读数（88/136）。 */
const SUITES: SuiteScoreLike[] = [
  { id: 'slugify', passed: 7, total: 7 },
  { id: 'chunk', passed: 2, total: 6 },
  { id: 'parse_kv', passed: 3, total: 8 },
  { id: 'interval_merge', passed: 5, total: 7 },
  { id: 'parse_query', passed: 2, total: 8 },
  { id: 'to_roman', passed: 9, total: 9 },
  { id: 'inventory_rollup', passed: 13, total: 13 },
  { id: 'job_queue', passed: 12, total: 12 },
  { id: 'csv_import', passed: 1, total: 17 },
  { id: 'json_patch', passed: 5, total: 16 },
  { id: 'bank_ledger', passed: 15, total: 16 },
  { id: 'slugify_edge_cases', passed: 4, total: 7 },
];

describe('suiteIdOfTask', () => {
  it('从任务文本里取出套件 id（含下划线）', () => {
    expect(suiteIdOfTask(T('slugify_edge_cases'))).toBe('slugify_edge_cases');
    expect(suiteIdOfTask(T('bank_ledger'))).toBe('bank_ledger');
    expect(suiteIdOfTask('本轮让通过率提高，不点名任何文件')).toBeNull();
  });
});

describe('pickTaskByScore', () => {
  it('选当前最差的未满分套件（csv_import 1/17）', () => {
    const p = pickTaskByScore(TASKS, SUITES)!;
    expect(p.id).toBe('csv_import');
    expect(p.task).toContain('eval/csv_import/');
  });

  it('绝不选满分套件（inventory_rollup / job_queue / slugify 都没活可干）', () => {
    const p = pickTaskByScore(TASKS, SUITES)!;
    expect(['inventory_rollup', 'job_queue', 'slugify', 'to_roman']).not.toContain(p.id);
  });

  it('上次点过的套件降权：第二次选另一道题', () => {
    const first = pickTaskByScore(TASKS, SUITES, new Set())!;
    const second = pickTaskByScore(TASKS, SUITES, new Set([first.id]))!;
    expect(second.id).not.toBe(first.id);
    // 第一次的 csv_import 降权后，第二次应轮到次差的 parse_query(2/8) 或 chunk(2/6)
    expect(['parse_query', 'chunk']).toContain(second.id);
  });

  it('连续 4 轮覆盖 4 个不同套件（不在同一堵墙上连撞）', () => {
    const attempted = new Set<string>();
    const picked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = pickTaskByScore(TASKS, SUITES, attempted)!;
      picked.push(p.id);
      attempted.add(p.id);
    }
    expect(new Set(picked).size).toBe(4);
    // 且都在未满分集合里
    const full = new Set(['slugify', 'to_roman', 'inventory_rollup', 'job_queue']);
    for (const id of picked) expect(full.has(id)).toBe(false);
  });

  it('全部满分时不崩：选一道并说明这是回归确认', () => {
    const allFull = SUITES.map((s) => ({ ...s, passed: s.total }));
    const p = pickTaskByScore(TASKS, allFull)!;
    expect(p).not.toBeNull();
    expect(p.why).toContain('满分');
    expect(p.why).toContain('回归');
  });

  it('任务文本与套件对不上 → null（不猜）', () => {
    const orphans = [T('no_such_suite'), '一段没有点名套件的任务'];
    expect(pickTaskByScore(orphans, SUITES)).toBeNull();
    expect(pickTaskByScore([], SUITES)).toBeNull();
  });

  it('通过率相同、题数不同时，修用例多的那道', () => {
    const suites = [
      { id: 'small', passed: 1, total: 4 },
      { id: 'big', passed: 4, total: 16 },
    ];
    const p = pickTaskByScore([T('small'), T('big')], suites)!;
    expect(p.id).toBe('big'); // 都是 0.25，16 例收益更大
  });

  it('确定性：同一输入的两次选择一致', () => {
    const a = pickTaskByScore(TASKS, SUITES, new Set())!;
    const b = pickTaskByScore(TASKS, SUITES, new Set())!;
    expect(a.id).toBe(b.id);
  });

  it('能选到只有热加载定义、过去没有任务文本的套件', () => {
    // slugify_edge_cases 4/7。把更差的都排除，确认它确实在候选池里。
    const onlyIt = SUITES.filter((s) => s.id === 'slugify_edge_cases' || s.passed >= s.total);
    const p = pickTaskByScore(TASKS, onlyIt)!;
    expect(p.id).toBe('slugify_edge_cases');
  });
});

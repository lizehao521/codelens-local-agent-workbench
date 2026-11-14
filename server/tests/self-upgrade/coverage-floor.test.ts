/**
 * 判据 · 覆盖率地板闸（S4 / Judge / C3 自证 + C4 不外推）
 *
 * 缺陷背景：本轮之前仓库没有任何覆盖率读数——「代码质量是重点」这句话没有可核实的
 * 衡量面。补上 v8 插桩后立刻出现第二个风险：闸本身可能是装饰。三种典型假绿：
 *   1. 报告没跑起来时报 0% 或直接放行（C4 违规：未执行不得算通过）；
 *   2. 按前缀聚合时对百分比求平均——10 行全覆盖的小文件 + 990 行零覆盖的大文件
 *      读作 50%，真实行覆盖 1%，地板闸于是形同虚设；
 *   3. 分母为 0 的指标当成 100%（凭空发明覆盖率）。
 *
 * 本判据用受跟踪夹具钉死这三条，并额外钉住「地板必须来自实测、不得定成 0」——
 * 把 min 改成 0 是让闸变绿最省事的手段，必须红。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aggregate, checkRule, evaluate } from '../../../scripts/lib/coverage-floor.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const FIXTURE = readJson('scripts/fixtures/coverage-floor/summary.json');
const FLOORS = readJson('scripts/coverage-floors.json');

/** 造一份最小报告：一个文件 + total。 */
const report = (file: string, covered: number, total: number) => ({
  total: { lines: { total, covered, skipped: 0, pct: 0 } },
  [file]: { lines: { total, covered, skipped: 0, pct: 0 } },
});
const rule = (prefix: string, min: number, metric = 'lines') => ({
  package: 'server',
  prefix,
  metric,
  min,
});

describe('聚合必须累加 covered/total，不得平均百分比（核心反向断言）', () => {
  it('10 行全覆盖 + 990 行零覆盖 → 1%，不是 50%', () => {
    const mixed = aggregate(FIXTURE.belowFloor, 'src/mixed');
    expect(mixed.lines.total).toBe(1000);
    expect(mixed.lines.covered).toBe(10);
    expect(mixed.lines.pct).toBe(1);
    expect(mixed.lines.pct >= 40).toBe(false);
  });

  it('平均口径会让这条陷阱规则假绿，累加口径必须判红', () => {
    const r = checkRule(FIXTURE.belowFloor, rule('src/mixed', 40));
    expect(r.status).toBe('fail');
    expect(r.status === 'pass').toBe(false);
  });

  it('小文件不得把大文件的零覆盖稀释掉', () => {
    const s = {
      total: { lines: { total: 1000, covered: 10, skipped: 0, pct: 1 } },
      '/r/src/tools/tiny.ts': { lines: { total: 10, covered: 10, skipped: 0, pct: 100 } },
      '/r/src/tools/huge.ts': { lines: { total: 990, covered: 0, skipped: 0, pct: 0 } },
    };
    expect(aggregate(s, 'src/tools').lines.pct).toBe(1);
    expect(aggregate(s, 'src/tools').lines.pct > 50).toBe(false);
  });

  it('skipped 也要累加，不能只加 total/covered', () => {
    const s = {
      total: { lines: { total: 10, covered: 5, skipped: 0, pct: 50 } },
      '/r/src/a.ts': { lines: { total: 6, covered: 3, skipped: 2, pct: 50 } },
      '/r/src/b.ts': { lines: { total: 4, covered: 2, skipped: 1, pct: 50 } },
    };
    expect(aggregate(s, 'src').lines.skipped).toBe(3);
  });
});

describe('前缀匹配与边界', () => {
  it('Windows 反斜杠路径必须能匹配（否则本机聚合恒为空）', () => {
    const s = {
      total: { lines: { total: 10, covered: 8, skipped: 0, pct: 80 } },
      'C:\\repo\\server\\src\\utils\\hash.ts': { lines: { total: 10, covered: 8, skipped: 0, pct: 80 } },
    };
    expect(aggregate(s, 'src/utils')).not.toBe(null);
    expect(aggregate(s, 'src/utils').lines.pct).toBe(80);
  });

  it('前缀无匹配 → null，不是 0% 也不是满分', () => {
    expect(aggregate(FIXTURE.aboveFloor, 'src/does-not-exist')).toBe(null);
  });

  it('空前缀取 total（整体兜底闸靠它）', () => {
    expect(aggregate(FIXTURE.aboveFloor, '').lines.pct).toBe(90);
  });

  it('summary 不可得 → null', () => {
    expect(aggregate(null, 'src')).toBe(null);
    expect(aggregate(undefined, '')).toBe(null);
  });

  it('total 键不得被当成文件重复计入', () => {
    const a = aggregate(FIXTURE.aboveFloor, 'src/tools');
    expect(a.lines.total).toBe(800);
    expect(a.lines.total === 1800).toBe(false);
  });
});

describe('单条规则：达标 / 低于地板 / 不可判', () => {
  it('恰好等于地板算达标（≥ 而不是 >）', () => {
    const r = checkRule(report('/r/src/utils/a.ts', 95, 100), rule('src/utils', 95));
    expect(r.status).toBe('pass');
    expect(r.pct).toBe(95);
  });

  it('低于地板 0.01 个点也要红', () => {
    const r = checkRule(report('/r/src/utils/a.ts', 9499, 10000), rule('src/utils', 95));
    expect(r.status).toBe('fail');
    expect(r.pct).toBe(94.99);
  });

  it('分母为 0 → unexec，绝不当成 100%', () => {
    const r = checkRule(FIXTURE.zeroDenominator, rule('src/tools', 80));
    expect(r.status).toBe('unexec');
    expect(r.pct).toBe(null);
    expect(r.status === 'pass').toBe(false);
  });

  it('报告里没有这个指标 → unexec', () => {
    const r = checkRule(report('/r/src/a.ts', 5, 10), rule('src', 1, 'branches'));
    expect(r.status).toBe('unexec');
    expect(r.reason).toBeTruthy();
  });

  it('范围不存在 → unexec，不是 fail（区分「没测」与「测得差」）', () => {
    const r = checkRule(FIXTURE.aboveFloor, rule('src/nope', 50));
    expect(r.status).toBe('unexec');
    expect(r.status === 'fail').toBe(false);
  });
});

describe('整组判定：缺报告一律 UNEXEC（C4）', () => {
  it('summary=null 时全部 unexec、passed 必须为 0', () => {
    const r = evaluate(null, FLOORS.rules);
    expect(r.passed).toBe(0);
    expect(r.unexec).toBe(FLOORS.rules.length);
    expect(r.failures).toEqual([]);
    expect(r.results.every((x: { status: string }) => x.status === 'unexec')).toBe(true);
    expect(r.results.some((x: { status: string }) => x.status === 'pass')).toBe(false);
  });

  it('夹具三态：belowFloor 全红 / aboveFloor 全绿 / zeroDenominator 零达标', () => {
    const low = evaluate(FIXTURE.belowFloor, FIXTURE.rules);
    expect(low.failures.length).toBe(FIXTURE.rules.length);
    expect(low.passed).toBe(0);

    const good = evaluate(FIXTURE.aboveFloor, FIXTURE.rules);
    expect(good.failures).toEqual([]);
    expect(good.unexec).toBe(0);
    expect(good.passed).toBe(FIXTURE.rules.length);

    const zero = evaluate(FIXTURE.zeroDenominator, FIXTURE.rules);
    expect(zero.passed).toBe(0);
    expect(zero.unexec).toBe(FIXTURE.rules.length);
  });

  it('混合态：达标数 + 失败数 + 不可判数 = 规则总数', () => {
    const rules = [rule('src/tools', 80), rule('src/mixed', 40), rule('src/absent', 10)];
    const r = evaluate(FIXTURE.belowFloor, rules);
    expect(r.passed + r.failures.length + r.unexec).toBe(rules.length);
    expect(r.unexec).toBe(1);
  });
});

describe('地板定义必须来自实测，不得是装饰', () => {
  it('每条规则字段齐全且 min > 0（定成 0 等于没有闸）', () => {
    expect(FLOORS.rules.length > 0).toBe(true);
    for (const r of FLOORS.rules) {
      expect(['server', 'client']).toContain(r.package);
      expect(['lines', 'statements', 'functions', 'branches']).toContain(r.metric);
      expect(typeof r.prefix).toBe('string');
      expect(r.min > 0).toBe(true);
      expect(r.min <= 100).toBe(true);
    }
  });

  it('地板不得高于实测值（凭空定高 = 永远红 = 闸会被关掉）', () => {
    for (const r of FLOORS.rules) {
      expect(typeof r.measured).toBe('number');
      expect(r.min <= r.measured).toBe(true);
    }
  });

  it('两个包都要有规则，且各有一条整体兜底（防「把代码挪出被测前缀」绕过）', () => {
    for (const pkg of ['server', 'client']) {
      const rs = FLOORS.rules.filter((r: { package: string }) => r.package === pkg);
      expect(rs.length > 0).toBe(true);
      expect(rs.some((r: { prefix: string }) => r.prefix === '')).toBe(true);
    }
  });

  it('夹具里的陷阱规则必须存在，否则平均口径无人守', () => {
    expect(FIXTURE.rules.some((r: { prefix: string }) => r.prefix === 'src/mixed')).toBe(true);
    expect(FIXTURE.belowFloor['/repo/src/mixed/large.ts'].lines.covered).toBe(0);
    expect(FIXTURE.belowFloor['/repo/src/mixed/small.ts'].lines.pct).toBe(100);
  });
});

describe('插桩口径：分母不得被缩小', () => {
  it('server 覆盖率配置继承基础配置（执行语义必须与普通轮一致）', () => {
    const text = readFileSync(join(ROOT, 'server/vitest.coverage.config.ts'), 'utf8');
    expect(text).toContain('mergeConfig');
    expect(text).toContain('./vitest.config');
    expect(text.includes("include: ['src/**']")).toBe(true);
  });

  it('client 覆盖率同样按 src/** 全量计入', () => {
    const text = readFileSync(join(ROOT, 'client/vite.config.ts'), 'utf8');
    expect(text).toContain("provider: 'v8'");
    expect(text.includes("include: ['src/**']")).toBe(true);
  });

  it('两个包都提供 test:coverage 与 check:coverage-floor 入口', () => {
    for (const pkg of ['server', 'client']) {
      const p = readJson(`${pkg}/package.json`);
      expect(p.scripts['test:coverage']).toBeTruthy();
      expect(p.scripts['check:coverage-floor']).toContain(`--package=${pkg}`);
    }
  });

  it('测量与判闸必须串成一条命令（只测不判 = 有读数没有闸）', () => {
    for (const pkg of ['server', 'client']) {
      const cmd = readJson(`${pkg}/package.json`).scripts['check:coverage'];
      expect(cmd).toContain('npm run test:coverage');
      expect(cmd).toContain('&&');
      expect(cmd).toContain('npm run check:coverage-floor');
      expect(cmd.includes('||')).toBe(false);
    }
  });

  it('地板闸不得被塞进 test:acceptance（验收不产报告，塞进去只会恒 UNEXEC）', () => {
    for (const pkg of ['server', 'client']) {
      const acc = readJson(`${pkg}/package.json`).scripts['test:acceptance'];
      expect(acc.includes('coverage')).toBe(false);
    }
  });
});
// 独立看板（server/public/rsi-dashboard.html）的源码级回归：
// 它是单文件静态页、无法 import TS 模块，因此这里直接核对它「按契约派生、
// 不硬编码排除列表」的关键形态，防止 C8 的 R2 漏判、两态 CSS 缺失、
// 侧栏只统计 4 态等问题回归。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FALLBACK_RULES_CONTRACT,
  isRuleViolation,
  resolveContract,
  ruleIdFromReason,
} from '../src/lib/rsi-rules';

// vmThreads 池下 import.meta.url 不是 file: scheme，不能用 fileURLToPath。
// 按 cwd 兼容「cd client」与「仓库根目录」两种运行方式。
const htmlPath = [
  resolve(process.cwd(), '../server/public/rsi-dashboard.html'),
  resolve(process.cwd(), 'server/public/rsi-dashboard.html'),
].find((candidate) => existsSync(candidate));
if (!htmlPath) throw new Error(`找不到 server/public/rsi-dashboard.html（cwd=${process.cwd()}）`);
const html = readFileSync(htmlPath, 'utf8');

describe('独立看板 HTML（C8 / AC-06 / AC-08）', () => {
  it('阻断项 A：契约加载与 overview 解耦，overview 失败仍渲染规则清单', () => {
    // 两个请求并行发起，独立端点不再排在 overview 成功之后
    expect(html).toContain('Promise.all([');
    expect(html).toContain('fetchStandaloneContract(),');
    expect(html).toContain('overviewResult');
    expect(html).toContain('overviewError');
    // 不再整页替换 DOM / early return
    expect(html).not.toContain('document.body.innerHTML');
    expect(html).not.toContain('if (!res.ok) {');
    // 失败时用空数据骨架，既有渲染循环按空集合跑（含指标条与 CDN 等待的空态保护）
    expect(html).toContain('judgeRuns: [], verdictsByRun: {}, rsiRuns: [], attributions: []');
    expect(html).toContain('(last2V[1] || [])');
    expect(html).toContain('&& !overviewError');
  });

  it('advisory 1：overview fetch 带 cache no-store，不产生 HTTP 缓存层分叉', () => {
    expect(html).toContain("fetch(`/api/rsi/overview?session=${sessionId}`, { cache: 'no-store' })");
  });

  it('advisory 2：内置切片执行顺序与契约一致（R6.order=5、R5.order=6）', () => {
    expect(html).toContain('MIN_CONTRACT_SLICE');
    const start = html.indexOf('function deriveRuleIds(pattern)');
    const end = html.indexOf('const MIN_CONTRACT_SLICE');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const derive = new Function(`${html.slice(start, end)}; return deriveRuleIds;`)() as (p: string) => string[];
    const ids = derive('^(R[1-6]):');
    expect(ids).toEqual(['R1', 'R2', 'R3', 'R4', 'R6', 'R5']);
    // 6 条 id 集合完整，R2 染色不漏
    expect([...ids].sort()).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
    const order = Object.fromEntries(ids.map((id, i) => [id, i + 1]));
    expect(order.R6).toBe(5);
    expect(order.R5).toBe(6);
  });

  it('内嵌脚本语法可解析（解耦改动后防回归）', () => {
    const block = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(block.length).toBeGreaterThan(1000);
    expect(() => new Function(block)).not.toThrow();
  });

  it('不再硬编码「排除 R1/R3/R4/R5/R6」列表', () => {
    expect(html).not.toContain("!reason.includes('R5')");
    expect(html).not.toMatch(/!reason\.includes\('R[1-6]'\)/);
  });

  it('违规染色按契约派生：rules[].id 集合 + reasonRuleIdPattern', () => {
    expect(html).toContain('contract.reasonRuleIdPattern');
    expect(html).toContain('ruleIds.includes(id)');
    expect(html).toContain('isViolation(reason)');
    expect(html).toContain('new RegExp(');
    expect(html).toContain('data.rules');
  });

  it('R2 属于契约规则集合（染色覆盖 R2）', () => {
    const contract = resolveContract(null);
    expect(contract.rules.some((r) => r.id === 'R2')).toBe(true);
    expect(isRuleViolation('R2: 静默改判据', contract)).toBe(true);
  });

  it('CSS 补齐 skipped / error 两态，且新增规则未引入 hex 颜色', () => {
    expect(html).toContain('.verdict-tag.skipped');
    expect(html).toContain('.rsi-item .v-tag.skipped');
    expect(html).toContain('.verdict-tag.error');
    expect(html).toContain('.rsi-item .v-tag.error');
    const addedCss = html.slice(
      html.indexOf('.verdict-tag.skipped'),
      html.indexOf('/* ── Footer ── */'),
    );
    expect(addedCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('侧栏统计覆盖 6 态（不只 4 态）', () => {
    for (const state of ['improved', 'not_improved', 'refused', 'undecidable', 'skipped', 'error']) {
      expect(html).toContain(`data-state="${state}"`);
    }
    expect(html).toContain('for (const st of (contract.states || []))');
  });

  it('规则清单消费 data.rules / 独立端点，缺失时给中性提示', () => {
    expect(html).toContain('/api/rsi/rules');
    expect(html).toContain('规则详情未随接口下发');
    expect(html).toContain('编号顺序不等于执行顺序');
    expect(html).toContain('id="rules-list"');
    expect(html).toContain('id="rules-note"');
  });

  it('中文标签与 tone 按契约 states 派生', () => {
    expect(html).toContain('stateLabel(latest.verdict)');
    expect(html).toContain("' tone-' + stateTone");
    expect(html).toContain('states: [');
  });

  it('判据塔 run 级 3 态也按契约显示中文标签（AC-04，含 inconclusive → 未定论）', () => {
    expect(html).toContain('runStateLabel(run.verdict)');
    expect(html).toContain('contract.judgeRunStates');
    expect(html).toContain('未定论');
  });
});

describe('兜底契约与 Spec §2 锁定值', () => {
  it('6 态 state / exitCode / label / tone 逐项一致', () => {
    expect(FALLBACK_RULES_CONTRACT.states.map((s) => [s.state, s.exitCode, s.label, s.tone])).toEqual([
      ['improved', 0, '已改进', 'success'],
      ['not_improved', 1, '未改进', 'warning'],
      ['refused', 2, '拒收', 'danger'],
      ['undecidable', 3, '无法判定', 'warning'],
      ['skipped', null, '跳过', 'muted'],
      ['error', null, '桥接故障', 'danger'],
    ]);
  });

  it('judgeRunStates / criterionStatuses 三态标签与 tone', () => {
    expect(FALLBACK_RULES_CONTRACT.judgeRunStates).toEqual([
      { state: 'pass', label: '通过', tone: 'success' },
      { state: 'fail', label: '未通过', tone: 'danger' },
      { state: 'inconclusive', label: '未定论', tone: 'warning' },
    ]);
    expect(FALLBACK_RULES_CONTRACT.criterionStatuses).toEqual([
      { state: 'pass', label: '通过', tone: 'success' },
      { state: 'fail', label: '未通过', tone: 'danger' },
      { state: 'unexec', label: '未执行', tone: 'muted' },
    ]);
  });

  it('basis 5 项 value/name/label/requiredField 锁定（第 5 项 label = 量不到）', () => {
    expect(FALLBACK_RULES_CONTRACT.basis.map((x) => [x.value, x.name, x.label, x.requiredField])).toEqual([
      [1, 'measured', '实测', null],
      [2, 'relayed', '转述', null],
      [3, 'estimated', '估算', null],
      [4, 'model_says', '模型自述', 'source'],
      [5, 'absent', '量不到', 'why_absent'],
    ]);
  });

  it('6 条规则长名与 order 锁定（R6.order=5、R5.order=6）', () => {
    const ordered = [...FALLBACK_RULES_CONTRACT.rules].sort((a, b) => a.order - b.order);
    expect(ordered.map((r) => [r.id, r.order, r.name])).toEqual([
      ['R1', 1, '结构与 schema 合法'],
      ['R2', 2, '判据集显式锚定'],
      ['R3', 3, '防删指标（防放水）'],
      ['R4', 4, '产物内容哈希可复核'],
      ['R6', 5, '同一代账本唯一'],
      ['R5', 6, '两代读数严格比较'],
    ]);
  });

  it('执行顺序 R1→R2→R3→R4→R6→R5，编号顺序 ≠ 执行顺序', () => {
    const ids = [...FALLBACK_RULES_CONTRACT.rules]
      .sort((a, b) => a.order - b.order)
      .map((r) => r.id);
    expect(ids).toEqual(['R1', 'R2', 'R3', 'R4', 'R6', 'R5']);
  });

  it('reasonRuleIdPattern 对 "R5: ..." 与 "R2: ..." 都能提取 id', () => {
    expect(ruleIdFromReason('R5: 目标指标已达上限', FALLBACK_RULES_CONTRACT)).toBe('R5');
    expect(ruleIdFromReason('R2: 静默改判据', FALLBACK_RULES_CONTRACT)).toBe('R2');
    expect(ruleIdFromReason('R7: 契约外', FALLBACK_RULES_CONTRACT)).toBeNull();
  });
});

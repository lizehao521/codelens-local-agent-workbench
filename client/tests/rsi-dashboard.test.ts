// RSI 面板三态与分母断点的渲染验证：直接挂载面板，打桩 fetch。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { RsiDashboardModal } from '../src/components/agent/RsiDashboardModal';
import { getRsiOverview, getRsiRules } from '../src/services/api';
import {
  criterionStatusPresentation,
  isRuleViolation,
  judgeRunPresentation,
  resolveContract,
  rsiStatePresentation,
  ruleIdFromReason,
} from '../src/lib/rsi-rules';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const EMPTY_OVERVIEW = {
  session: { id: 's1', title: '测试会话', provider: 'custom', model: '平衡', created_at: 1 },
  judgeRuns: [],
  verdictsByRun: {},
  eval: null,
  rsiRuns: [],
  attributions: [],
};

const STRUCTURED_EVAL = {
  runId: 3,
  status: 'fail',
  score: 0.345,
  detail: '固定评测套件 38/110 通过（含隐藏用例）；未满分：slugify 0/7、chunk 2/6',
  measuredAt: 3000,
  passed: 38,
  total: 110,
  denominator: 110,
  suites: [
    { id: 'slugify', title: '标题转 slug', ok: false, passed: 0, total: 7, publicPassed: 0, publicTotal: 2 },
    { id: 'chunk', title: '数组切块', ok: true, passed: 6, total: 6, publicPassed: 2, publicTotal: 2 },
  ],
  source: 'structured',
};

const DETAIL_ONLY_EVAL = {
  runId: 3,
  status: 'fail',
  score: 0.345,
  detail: '固定评测套件 38/110 通过（含隐藏用例）；未满分：json 0/1',
  measuredAt: 3000,
  passed: null,
  total: null,
  denominator: null,
  suites: [],
  source: 'detail_only',
};

async function render(sessionId = 's1'): Promise<void> {
  await act(async () => {
    root.render(createElement(RsiDashboardModal, { open: true, onClose: () => undefined, sessionId }));
  });
  // 等 useAsyncData 的 then 链跑完
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('RsiDashboardModal 状态提示', () => {
  it('后端未启动：区分「服务不可达」并给出启动指引与重试', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    await render();
    expect(container.textContent).toContain('后端未启动或不可达');
    expect(container.textContent).toContain('127.0.0.1:8080');
    expect(container.textContent).toContain('重试');
  });

  it('接口失败：展示接口报错，不静默空白', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'INTERNAL', message: '内部错误' } }, 500),
      ),
    );
    await render();
    expect(container.textContent).toContain('RSI 接口请求失败');
    expect(container.textContent).toContain('内部错误');
  });

  it('无数据：明确说明该会话还没有判据读数', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(EMPTY_OVERVIEW)));
    await render();
    expect(container.textContent).toContain('这个会话还没有判据读数');
  });

  it('有读数：按分母分段并标注 20→50 的基线断点', async () => {
    const overview = {
      ...EMPTY_OVERVIEW,
      judgeRuns: [
        { id: 1, verdict: 'pass', score: 0.9, coverage: 1, executed: 20, total: 20, created_at: 1000 },
        { id: 2, verdict: 'pass', score: 0.92, coverage: 1, executed: 20, total: 20, created_at: 2000 },
        { id: 3, verdict: 'fail', score: 0.8, coverage: 1, executed: 50, total: 50, created_at: 3000 },
      ],
      verdictsByRun: {
        1: [
          {
            run_id: 1,
            layer: 'task',
            criterion: 'task.test_pass_rate',
            status: 'pass',
            score: 0.9,
            detail: '固定评测套件 18/20 通过（含隐藏用例）；未满分：slugify 4/5（err）',
            data: null,
          },
        ],
        2: [
          {
            run_id: 2,
            layer: 'task',
            criterion: 'task.test_pass_rate',
            status: 'pass',
            score: 0.92,
            detail: '固定评测套件 19/20 通过（含隐藏用例）',
            data: null,
          },
        ],
        3: [
          {
            run_id: 3,
            layer: 'task',
            criterion: 'task.test_pass_rate',
            status: 'fail',
            score: 0.8,
            detail: '固定评测套件 40/50 通过（含隐藏用例）；未满分：json 0/1',
            data: null,
          },
        ],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(overview)));
    await render();
    expect(container.textContent).toContain('分母 20→50');
    expect(container.textContent).toContain('1 次基线断点');
    expect(container.textContent).toContain('18/20 通过');
    expect(container.textContent).toContain('40/50 通过');
    // 未满分套件在聚合区出现
    expect(container.textContent).toContain('json');
  });

  it('结构化 eval：展示全套件清单、公开用例与 38/110 分母', async () => {
    const overview = {
      ...EMPTY_OVERVIEW,
      eval: STRUCTURED_EVAL,
      judgeRuns: [
        { id: 3, verdict: 'fail', score: 0.345, coverage: 0.692, executed: 9, total: 13, created_at: 3000 },
      ],
      verdictsByRun: {
        3: [
          {
            run_id: 3,
            layer: 'task',
            criterion: 'task.test_pass_rate',
            status: 'fail',
            score: 0.345,
            detail: STRUCTURED_EVAL.detail,
            data: {
              passed: 38,
              total: 110,
              denominator: 110,
              score: 0.345,
              suites: STRUCTURED_EVAL.suites,
            },
          },
        ],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(overview)));
    await render();
    expect(container.textContent).toContain('结构化数据（source=structured）');
    expect(container.textContent).toContain('结构化 · 2 个套件');
    expect(container.textContent).toContain('38/110 通过');
    expect(container.textContent).toContain('标题转 slug');
    expect(container.textContent).toContain('数组切块');
    // 全部用例 / 公开用例两列都在
    expect(container.textContent).toContain('0/7');
    expect(container.textContent).toContain('2/2');
    expect(container.textContent).toContain('只有 1 条 test_pass_rate 读数');
  });

  it('detail_only：回退文本解析并明确标注旧格式、结论不完整', async () => {
    const overview = {
      ...EMPTY_OVERVIEW,
      eval: DETAIL_ONLY_EVAL,
      judgeRuns: [
        { id: 3, verdict: 'fail', score: 0.345, coverage: 0.692, executed: 9, total: 13, created_at: 3000 },
      ],
      verdictsByRun: {
        3: [
          {
            run_id: 3,
            layer: 'task',
            criterion: 'task.test_pass_rate',
            status: 'fail',
            score: 0.345,
            detail: DETAIL_ONLY_EVAL.detail,
            data: null,
          },
        ],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(overview)));
    await render();
    expect(container.textContent).toContain('旧格式（source=detail_only）· 结论不完整');
    expect(container.textContent).toContain('旧格式 · 仅未满分文本');
    expect(container.textContent).toContain('38/110 通过');
    expect(container.textContent).toContain('文本解析');
    // 结构化套件表不应出现
    expect(container.textContent).not.toContain('结构化 · 2 个套件');
  });
});

// ── 规则契约对齐回归（C6 / C7 / C8 / AC-04..AC-08）────────────────────────
// 以下全部是新增断言，上面既有断言的语义一个未改。

describe('RSI 契约分派（C6 / AC-04 / AC-05）', () => {
  const contract = resolveContract(null);

  it('inconclusive → 未定论（不再显示英文原串）', () => {
    const p = judgeRunPresentation('inconclusive', contract);
    expect(p.label).toBe('未定论');
    expect(p.toneClass).toBe('text-warning');
  });

  it('判据塔 run 三态互不串用', () => {
    expect(judgeRunPresentation('pass', contract).label).toBe('通过');
    expect(judgeRunPresentation('fail', contract).label).toBe('未通过');
    expect(judgeRunPresentation('fail', contract).toneClass).toBe('text-danger');
  });

  it('单条判据 status 三态使用自己的分派表', () => {
    expect(criterionStatusPresentation('pass', contract).label).toBe('通过');
    expect(criterionStatusPresentation('fail', contract).label).toBe('未通过');
    const unexec = criterionStatusPresentation('unexec', contract);
    expect(unexec.label).toBe('未执行');
    expect(unexec.toneClass).toBe('text-text-tertiary');
  });

  it('RSI 代际 6 态中文标签 + tone 锁定值', () => {
    const expected = [
      ['improved', '已改进', 'text-success'],
      ['not_improved', '未改进', 'text-warning'],
      ['refused', '拒收', 'text-danger'],
      ['undecidable', '无法判定', 'text-warning'],
      ['skipped', '跳过', 'text-text-tertiary'],
      ['error', '桥接故障', 'text-danger'],
    ] as const;
    for (const [state, label, tone] of expected) {
      const p = rsiStatePresentation(state, contract);
      expect(p.label).toBe(label);
      expect(p.toneClass).toBe(tone);
    }
  });

  it('三套枚举域不互串：代际不吃判据塔标签，反之亦然', () => {
    expect(rsiStatePresentation('inconclusive', contract).label).not.toBe('未定论');
    expect(judgeRunPresentation('improved', contract).label).not.toBe('已改进');
    expect(criterionStatusPresentation('refused', contract).label).not.toBe('拒收');
  });

  it('三套枚举域取值完备：判据塔含 inconclusive、RSI 含 undecidable，互不混用', () => {
    expect(contract.judgeRunStates.map((s) => s.state)).toEqual(['pass', 'fail', 'inconclusive']);
    expect(contract.criterionStatuses.map((s) => s.state)).toEqual(['pass', 'fail', 'unexec']);
    expect(contract.states.map((s) => s.state)).toEqual([
      'improved', 'not_improved', 'refused', 'undecidable', 'skipped', 'error',
    ]);
  });

  it('契约外状态保留原串、不伪装成已测结论（后端从不产生幽灵值）', () => {
    const p = judgeRunPresentation('ghost_state', contract);
    expect(p.label).toBe('ghost_state');
    expect(p.toneClass).toBe('text-text-tertiary');
  });
});

describe('规则 id 按契约派生（C8 / AC-06）', () => {
  const contract = resolveContract(null);

  it('R2 原因命中契约规则，不被判为通过', () => {
    const reason = 'R2: 判据指纹变了（criteria_sha256 不一致）却没有 criteria_diff 声明：拒绝静默改判据';
    expect(ruleIdFromReason(reason, contract)).toBe('R2');
    expect(isRuleViolation(reason, contract)).toBe(true);
  });

  it('R1..R6 六条规则的原因全部命中，不再漏 R2', () => {
    for (const id of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
      expect(ruleIdFromReason(`${id}: 触发`, contract)).toBe(id);
      expect(isRuleViolation(`${id}: 触发`, contract)).toBe(true);
    }
  });

  it('契约外噪声不算规则命中', () => {
    expect(isRuleViolation('R9: 噪声', contract)).toBe(false);
    expect(isRuleViolation('全部指标严格变好', contract)).toBe(false);
    expect(ruleIdFromReason('判据指纹变了', contract)).toBeNull();
  });
});

describe('兜底契约（AC-08）', () => {
  it('无 rules 时返回 6 条规则 / 6 态 / 3+3 分派表，顺序按 order', () => {
    const c = resolveContract(null);
    expect(c.rules.map((r) => r.id).sort()).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
    expect(c.rules.map((r) => r.order)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(c.states).toHaveLength(6);
    expect(c.judgeRunStates).toHaveLength(3);
    expect(c.criterionStatuses).toHaveLength(3);
    expect(c.reasonRuleIdPattern).toBe('^(R[1-6]):');
  });

  it('半截契约按字段回退到兜底，不产生 undefined 分派', () => {
    const broken = { ...resolveContract(null), judgeRunStates: [] };
    const c = resolveContract(broken);
    expect(judgeRunPresentation('inconclusive', c).label).toBe('未定论');
  });
});

describe('api.ts 映射层（C7 / AC-07）', () => {
  it('eval 4 个元数据字段原样透传', async () => {
    const fingerprint = 'a1b2c3d4e5f60718';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ...EMPTY_OVERVIEW,
          eval: {
            ...STRUCTURED_EVAL,
            evalSetFingerprint: fingerprint,
            failureKinds: { public_fail: 3, hidden_only: 2 },
            samples: 7,
            reliability: 'measured',
          },
        }),
      ),
    );
    const overview = await getRsiOverview('s1');
    expect(overview.eval?.evalSetFingerprint).toBe(fingerprint);
    expect(overview.eval?.failureKinds).toEqual({ public_fail: 3, hidden_only: 2 });
    expect(overview.eval?.samples).toBe(7);
    expect(overview.eval?.reliability).toBe('measured');
  });

  it('旧行缺 4 字段时用中性缺省，绝不把缺失伪装成已测', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ...EMPTY_OVERVIEW, eval: STRUCTURED_EVAL })),
    );
    const overview = await getRsiOverview('s1');
    expect(overview.eval?.evalSetFingerprint).toBeNull();
    expect(overview.eval?.failureKinds).toEqual({});
    expect(overview.eval?.samples).toBe(1);
    expect(overview.eval?.reliability).toBe('unmeasured');
  });

  it('响应无 rules 时 RsiOverview.rules 为 null（组件走兜底）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(EMPTY_OVERVIEW)));
    const overview = await getRsiOverview('s1');
    expect(overview.rules).toBeNull();
  });

  it('响应含 rules 时原样透传同源契约，不做字段加工', async () => {
    const rules = resolveContract(null);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...EMPTY_OVERVIEW, rules })));
    const overview = await getRsiOverview('s1');
    expect(overview.rules).toEqual(rules);
    expect(overview.rules?.rules).toHaveLength(6);
    expect(overview.rules?.states).toHaveLength(6);
  });

  it('getRsiRules 读取独立契约端点 GET /api/rsi/rules', async () => {
    const rules = resolveContract(null);
    const fetchSpy = vi.fn(async () => jsonResponse(rules));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await getRsiRules();
    expect(result).toEqual(rules);
    expect(fetchSpy).toHaveBeenCalledWith('/api/rsi/rules', { cache: 'no-store' });
  });

  it('契约 version 升版时仍透传，不静默退回旧兜底（形状校验不锁版本串）', async () => {
    const future = { ...resolveContract(null), version: 'rsi-rules-contract-v2' };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...EMPTY_OVERVIEW, rules: future })));
    const overview = await getRsiOverview('s1');
    expect(overview.rules).not.toBeNull();
    expect(JSON.stringify(overview.rules)).toBe(JSON.stringify(future));
  });
});

describe('面板渲染对齐（AC-04 / AC-05 / AC-07 / AC-08）', () => {
  it('判据塔 inconclusive：显示「未定论」，不显示英文原串', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ...EMPTY_OVERVIEW,
          judgeRuns: [
            { id: 1, verdict: 'inconclusive', score: 0.7, coverage: 0.5, executed: 3, total: 6, created_at: 1000 },
          ],
        }),
      ),
    );
    await render();
    expect(container.textContent).toContain('未定论');
    expect(container.textContent).not.toContain('inconclusive');
  });

  it('RSI 6 态：代际表判决列显示对应中文标签', async () => {
    const states = ['improved', 'not_improved', 'refused', 'undecidable', 'skipped', 'error'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ...EMPTY_OVERVIEW,
          rsiRuns: states.map((verdict, i) => ({
            generation: i + 1,
            prev_generation: i === 0 ? null : i,
            verdict,
            exit_code: null,
            reasons_json: '[]',
          })),
        }),
      ),
    );
    await render();
    const cells = Array.from(container.querySelectorAll('table tbody tr')).map(
      (tr) => tr.children[2]?.textContent ?? '',
    );
    expect(cells).toEqual(['已改进', '未改进', '拒收', '无法判定', '跳过', '桥接故障']);
  });

  it('eval 4 字段透传后组件显示真实指纹 / 失败分类 / 采样 / 可靠性', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ...EMPTY_OVERVIEW,
          eval: {
            ...STRUCTURED_EVAL,
            evalSetFingerprint: 'a1b2c3d4e5f60718',
            failureKinds: { suite_error: 2, hidden_only: 1, passed: 8 },
            samples: 5,
            reliability: 'measured',
          },
          judgeRuns: [
            { id: 3, verdict: 'fail', score: 0.345, coverage: 0.692, executed: 9, total: 13, created_at: 3000 },
          ],
        }),
      ),
    );
    await render();
    const text = container.textContent ?? '';
    expect(text).toContain('a1b2c3d4e5f60718');
    expect(text).toContain('suite_error:2');
    expect(text).toContain('hidden_only:1');
    expect(text).toContain('采样 5 次');
    expect(text).toContain('已测');
    expect(text).not.toContain('未标注（旧会话）');
    expect(text).not.toContain('未测（pass^k 不可计算）');
  });

  it('无 rules（旧后端）：面板走兜底契约正常渲染，规则清单与执行顺序齐全', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ...EMPTY_OVERVIEW,
          judgeRuns: [
            { id: 1, verdict: 'pass', score: 0.9, coverage: 1, executed: 20, total: 20, created_at: 1000 },
          ],
          rsiRuns: [
            { generation: 1, prev_generation: null, verdict: 'skipped', exit_code: null, reasons_json: '[]' },
          ],
        }),
      ),
    );
    await render();
    const text = container.textContent ?? '';
    expect(text).toContain('规则契约 · 6 条判据');
    expect(text).toContain('R1→R2→R3→R4→R6→R5');
    expect(text).toContain('编号顺序不等于执行顺序');
    expect(text).toContain('判据集显式锚定');
    expect(text).toContain('跳过');
  });

  it('R2 原因：代际表标注命中的规则 id，并显示该状态处置要求', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ...EMPTY_OVERVIEW,
          rsiRuns: [
            {
              generation: 1,
              prev_generation: null,
              verdict: 'refused',
              exit_code: 2,
              reasons_json: JSON.stringify([
                'R2: 判据指纹变了（criteria_sha256 不一致）却没有 criteria_diff 声明：拒绝静默改判据',
              ]),
            },
          ],
        }),
      ),
    );
    await render();
    const badge = container.querySelector('span[title="判据集显式锚定"]');
    expect(badge?.textContent).toBe('R2');
    expect(container.textContent).toContain('拒收');
    expect(container.textContent).toContain('处置：');
  });
});

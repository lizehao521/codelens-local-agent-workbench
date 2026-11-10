// RSI 面板三态与分母断点的渲染验证：直接挂载面板，打桩 fetch。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { RsiDashboardModal } from '../src/components/agent/RsiDashboardModal';

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

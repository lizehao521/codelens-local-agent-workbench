/**
 * 判据 · 资源天花板要归到「调预算」，不是「拆题」（Judge / 尺子侧）
 *
 * 缺口现场（2026-11-14 机械取证，夹具逐字取自 .self-upgrade/loop 的真实 SSE 尾部）：
 * checkTermination 对 tool_calls / tokens / wall_clock 三道顶都返回同一个
 * finishReason=budget_exhausted，归因于是只看 finishReason 就一律喊 split_task。
 * 但 iteration 14/25、7/25 都远没到迭代上限 —— 拆完题每题仍撞同一道顶。
 * 实证：原合并题 code-search-glob 六靶子拆成 fs-glob-shared 五靶子后，
 * 第 1 轮仍在 iteration 14 处 token 耗尽（267198/256000），
 * 第 2 轮在 iteration 7 处墙钟耗尽（400784/180000 ms）。拆题没解决任何问题。
 *
 * 三道顶各自对应一个 env 旋钮，只有人拧得动。所以正确动作是 raise_budget +
 * 停机点名旋钮，而不是继续换模型把模型轮转烧在假因上（实测第 3 轮因此连换两个
 * 不存在的模型名，各拿一次 HTTP 404）。
 *
 * C3：把 CEILINGS 的识别串改错、或去掉 iteration < maxIterations 的守卫，
 * 本判据必须转红（下面每条金丝雀各钉一种误判）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attributeFailure, type AttributionInput } from '../../scripts/failure-attribution.js';
import { buildDispatchTail } from '../../scripts/lib/sse-tail.mjs';

/**
 * 真实 run_state 事件（sse-fs-glob-shared-2.txt 逐字裁剪）。
 * maxIterations 只在这里出现，run_report 里没有 —— 少了他就判不了「迭代还没用满」。
 */
const runState = (maxIterations: number | null): string =>
  maxIterations === null
    ? ''
    : `data: {"stage":"run_state","model":"deepseek-ai/deepseek-v4.1-flash","iteration":1,` +
      `"maxIterations":${maxIterations},"contextWindow":128000,"tokenBudget":256000,"toolCount":17}\n\n`;

/** 真实 run_report（sse-fs-glob-shared-1.txt 尾部，逐字）。 */
const TOKEN_REPORT =
  'data: {"finishReason":"budget_exhausted","iteration":14,"toolCallCount":18,' +
  '"usage":{"promptTokens":267198,"completionTokens":6344},"tokenBudget":256000,' +
  '"messageId":"","firstTokenMs":2568}\n\n';
const TOKEN_DETAIL = 'data: {"stage":"budget","detail":"任务 token 预算已用尽（256000）"}\n\n';

/** 真实 run_report（sse-fs-glob-shared-2.txt 尾部，逐字）。 */
const WALL_REPORT =
  'data: {"finishReason":"budget_exhausted","iteration":7,"toolCallCount":15,' +
  '"usage":{"promptTokens":95691,"completionTokens":2040},"tokenBudget":256000,' +
  '"messageId":"","firstTokenMs":4115}\n\n';
const WALL_DETAIL =
  'data: {"stage":"budget","detail":"墙钟预算（180000ms）已用尽"}\n\n' +
  'data: {"stage":"summary","detail":"墙钟预算在第 7 步触发（400784/180000 ms）；' +
  '已做：已完成 15 次工具调用；未做：后续轮次因墙钟上限未执行"}\n\n';

const TOOL_DETAIL = 'data: {"stage":"budget","detail":"工具调用预算已用尽（40/40），基于已完成的结果输出总结"}\n\n';
const TOOL_REPORT =
  'data: {"finishReason":"budget_exhausted","iteration":9,"toolCallCount":40,' +
  '"usage":{"promptTokens":120000,"completionTokens":3000},"tokenBudget":256000}\n\n';

/** 围栏形状照抄真实那几轮：判据绿、全量红、受保护路径完好。 */
const base: AttributionInput = {
  taskId: 'ceiling-probe',
  attempt: 1,
  maxAttempts: 3,
  dispatch: { exitOk: true, output: '' },
  diagnosis: '',
  fence: {
    reached: true,
    targetChanged: true,
    typeOk: true,
    judgeOk: true,
    fullOk: false,
    fullRan: true,
    protectedIntact: true,
    judgeTampered: false,
  },
  serviceHealthy: true,
};

const withOutput = (output: string): AttributionInput => ({ ...base, dispatch: { exitOk: true, output } });

describe('三道天花板各自点名自己的旋钮', () => {
  it('token 硬顶：14/25 轮就撞顶 ⇒ raise_budget + AGENT_TOKEN_BUDGET_FACTOR', () => {
    const a = attributeFailure(withOutput(runState(25) + TOKEN_DETAIL + TOKEN_REPORT));
    expect(a.layer).toBe('budget');
    expect(a.code).toBe('TOKEN_CEILING_BELOW_ITERATIONS');
    expect(a.nextAction).toBe('raise_budget');
    expect(a.countsAgainstAgent).toBe(false);
    expect(a.note).toContain('AGENT_TOKEN_BUDGET_FACTOR');
    expect(a.note).toContain('14');
    expect(a.note).toContain('25');
    expect(a.evidence.join(' ')).toContain('267198/256000');
  });

  it('墙钟：7/25 轮就撞顶 ⇒ raise_budget + AGENT_TASK_BUDGET_MS，并带上真实用量', () => {
    const a = attributeFailure(withOutput(runState(25) + WALL_DETAIL + WALL_REPORT));
    expect(a.code).toBe('WALL_CLOCK_CEILING');
    expect(a.nextAction).toBe('raise_budget');
    expect(a.countsAgainstAgent).toBe(false);
    expect(a.note).toContain('AGENT_TASK_BUDGET_MS');
    expect(a.evidence.join(' ')).toContain('400784/180000 ms');
  });

  it('墙钟那一轮 token 才用了 95691/256000，不许顺手归成 token 顶', () => {
    const a = attributeFailure(withOutput(runState(25) + WALL_DETAIL + WALL_REPORT));
    expect(a.code).not.toBe('TOKEN_CEILING_BELOW_ITERATIONS');
    expect(a.note).not.toContain('AGENT_TOKEN_BUDGET_FACTOR');
  });

  it('工具调用总次数：9/25 轮撞 40 次上限 ⇒ raise_budget + AGENT_MAX_TOOL_CALLS', () => {
    const a = attributeFailure(withOutput(runState(25) + TOOL_DETAIL + TOOL_REPORT));
    expect(a.code).toBe('TOOL_CALL_CEILING');
    expect(a.nextAction).toBe('raise_budget');
    expect(a.note).toContain('AGENT_MAX_TOOL_CALLS');
  });
});

describe('金丝雀：这些都不该喊「调预算」', () => {
  it('真的用满迭代上限（25/25）⇒ 仍是 MAX_ITERATIONS / split_task', () => {
    const out =
      runState(25) +
      'data: {"finishReason":"max_iterations","iteration":25,"toolCallCount":30,' +
      '"usage":{"promptTokens":200000,"completionTokens":5000},"tokenBudget":256000}\n\n';
    const a = attributeFailure(withOutput(out));
    expect(a.code).toBe('MAX_ITERATIONS');
    expect(a.nextAction).toBe('split_task');
  });

  it('token 顶但迭代上限也只有 14（14/14）⇒ 拆题才是对的', () => {
    const a = attributeFailure(withOutput(runState(14) + TOKEN_DETAIL + TOKEN_REPORT));
    expect(a.nextAction).not.toBe('raise_budget');
  });

  it('缺 iteration ⇒ 不许猜（缺证据 ≠ 反证），退回 BUDGET_EXHAUSTED', () => {
    // run_state 里也有 iteration，必须两处都去掉才是真的「取证缺失」
    const out = (runState(25) + TOKEN_DETAIL + TOKEN_REPORT).replace(/"iteration":\d+,?/g, '');
    const a = attributeFailure(withOutput(out));
    expect(a.nextAction).not.toBe('raise_budget');
    expect(a.code).toBe('BUDGET_EXHAUSTED');
  });

  it('缺 maxIterations（没有 run_state 事件）⇒ 同样不许猜', () => {
    const a = attributeFailure(withOutput(TOKEN_DETAIL + TOKEN_REPORT));
    expect(a.nextAction).not.toBe('raise_budget');
    expect(a.code).toBe('BUDGET_EXHAUSTED');
  });

  it('单轮输出被 max_tokens 截断 ⇒ OUTPUT_TRUNCATED，即使文中也出现 token 顶字样', () => {
    const a = attributeFailure(withOutput(runState(25) + TOKEN_DETAIL + TOKEN_REPORT + 'max_tokens 上限被截断\n'));
    expect(a.code).toBe('OUTPUT_TRUNCATED');
    expect(a.nextAction).not.toBe('raise_budget');
  });

  it('budget_exhausted 但三道顶的 detail 都不在 ⇒ 保守退回 BUDGET_EXHAUSTED', () => {
    const a = attributeFailure(withOutput(runState(25) + TOKEN_REPORT));
    expect(a.code).toBe('BUDGET_EXHAUSTED');
    expect(a.nextAction).toBe('split_task');
  });
});

describe('识别串必须与生产者同源，且循环真的消费 raise_budget', () => {
  it('三道顶的识别串逐字出自 loop-budget.ts（生产者改文案，这里必须跟着红）', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/services/agent/loop-budget.ts', import.meta.url)),
      'utf8',
    );
    expect(src.includes('任务 token 预算已用尽')).toBe(true);
    expect(src.includes('墙钟预算')).toBe(true);
    expect(src.includes('工具调用预算')).toBe(true);
  });

  it('三个旋钮名真的是 env 配置项，不是编出来的', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/config/env.ts', import.meta.url)), 'utf8');
    for (const knob of ['AGENT_TOKEN_BUDGET_FACTOR', 'AGENT_TASK_BUDGET_MS', 'AGENT_MAX_TOOL_CALLS']) {
      expect(src.includes(knob), `${knob} 不在 env.ts 里`).toBe(true);
    }
  });

  it('循环遇到 raise_budget 停机点名旋钮，不再换模型烧轮转', async () => {
    const src = await import('node:fs/promises').then((m) =>
      m.readFile(new URL('../../scripts/self-upgrade-loop.ts', import.meta.url), 'utf8'),
    );
    const at = src.indexOf("if (attr.nextAction === 'raise_budget')");
    expect(at).toBeGreaterThan(-1);
    const branch = src.slice(at, src.indexOf('if (attr.layer ===', at));
    expect(branch.includes('return;')).toBe(true);
    expect(branch.includes('MODEL_ROTATION')).toBe(false);
    expect(branch.includes('countsAgainstAgent: false')).toBe(true);
  });
});

/**
 * 上面所有夹具都是**手工拼的 data: 行**，直接喂给归因，绕过了 buildDispatchTail。
 * 于是它们全绿、生产却静默失效：真实 SSE 里 maxIterations 只出现在流头的 meta 事件，
 * 而取证尾部原先只保留 run_report / done —— 右操作数永远是 null，
 * `iteration < maxIterations` 守卫恒假，三道顶一律退回笼统的 BUDGET_EXHAUSTED + split_task。
 * 实测 2026-11-14 code-search 第 1 次派单：iteration=20 送达、maxIterations=25 没送达。
 * 这一组走**真实链路**：真实事件形状 → 真实尾部生产者 → 真实归因。
 */
describe('真实链路：取证尾部必须把 maxIterations 送到归因手里', () => {
  /**
   * 逐字取自 .self-upgrade/loop/sse-code-search-1.txt（第 5 行 meta + 尾部三事件）。
   * 中间必须垫足够多的 delta：真实流 112KB，原始尾部窗口只有 1200 字符。
   * 夹具短于窗口时 meta 会被原始尾部整条兜住，于是「丢了 meta」也测不出来 ——
   * 第一版就这样被变异体 sse-tail-meta-dropped 骗过（SURVIVED）。
   */
  const REAL_SSE =
    'event: meta\n' +
    'data: {"sessionId":"149e4926","messageId":"45d5facb","provider":"custom","model":"nvidia/nemotron-3-ultra-550b-a55b",' +
    '"channel":"native","degraded":false,"degradedReason":null,"iteration":1,"maxIterations":25,"contextWindow":128000,' +
    '"tokenBudget":512000,"estimatedPromptTokens":0,"toolCount":18,"switchedFrom":null,"switchReason":null}\n\n' +
    'event: delta\ndata: {"text":"开工"}\n\n'.repeat(400) +
    'event: run_report\n' +
    'data: {"runId":"7b3f20d6","outcome":"budget_exhausted","statusCode":"RUN_BUDGET_WALL_CLOCK",' +
    '"reason":"墙钟预算在第 20 步触发（701723/660000 ms）；已做：已完成 24 次工具调用、改动 2 个文件",' +
    '"finishReason":"budget_exhausted","fileChangeCount":2,"errorCount":0,"toolCallCount":24,' +
    '"promptTokens":374820,"completionTokens":4016,"durationMs":701725}\n\n' +
    'event: delta\ndata: {"text":"\\n\\n【任务墙钟预算（660000ms）已用尽】"}\n\n' +
    'event: stage\ndata: {"runId":"7b3f20d6","stage":"done","elapsedMs":701777,"detail":"任务墙钟预算（660000ms）已用尽"}\n\n' +
    'event: done\n' +
    'data: {"finishReason":"budget_exhausted","iteration":20,"toolCallCount":25,' +
    '"usage":{"promptTokens":374820,"completionTokens":4016},"tokenBudget":512000,"messageId":"","firstTokenMs":1490}\n\n';

  it('maxIterations 在真实流里只出现一次，且在 meta 里（钉住生产者形状）', () => {
    expect((REAL_SSE.match(/maxIterations/g) ?? []).length).toBe(1);
    expect(REAL_SSE.indexOf('maxIterations')).toBeLessThan(REAL_SSE.indexOf('event: run_report'));
    const types = readFileSync(fileURLToPath(new URL('../../src/types/agent-events.ts', import.meta.url)), 'utf8');
    const meta = types.slice(types.indexOf('interface SseMetaPayload'), types.indexOf('interface SseDeltaPayload'));
    expect(meta.includes('maxIterations: number;')).toBe(true);
  });

  it('尾部必须留住 meta，否则守卫的右操作数丢失', () => {
    const tail = buildDispatchTail(REAL_SSE);
    expect(/event: meta/.test(tail)).toBe(true);
    expect(tail.includes('"maxIterations":25')).toBe(true);
  });

  it('端到端：真实尾部 ⇒ WALL_CLOCK_CEILING / raise_budget，不是笼统的 split_task', () => {
    const a = attributeFailure(withOutput(buildDispatchTail(REAL_SSE)));
    expect(a.code).toBe('WALL_CLOCK_CEILING');
    expect(a.nextAction).toBe('raise_budget');
    expect(a.countsAgainstAgent).toBe(false);
    expect(a.note).toContain('AGENT_TASK_BUDGET_MS');
    expect(a.evidence.join(' ')).toContain('701723/660000 ms');
  });

  it('iteration 取 done 的 20，不是 meta 的 1（meta 排最前才不会污染「取最后一次」）', () => {
    const a = attributeFailure(withOutput(buildDispatchTail(REAL_SSE)));
    expect(a.evidence.join(' ')).toContain('iteration=20/25');
    expect(a.evidence.join(' ')).not.toContain('iteration=1/25');
  });

  it('加了 meta 之后尾部仍然有界（反向：不许为了取证把整条流灌进控制台）', () => {
    const huge = 'event: delta\ndata: {"text":"x"}\n\n'.repeat(5000) + REAL_SSE;
    const tail = buildDispatchTail(huge);
    expect(tail.length).toBeLessThanOrEqual(4000);
    expect(tail.includes('"maxIterations":25')).toBe(true);
    expect(/event: run_report/.test(tail)).toBe(true);
  });

  it('meta 缺席时不许猜上限（缺证据 ≠ 反证）：退回 BUDGET_EXHAUSTED', () => {
    const noMeta = REAL_SSE.slice(REAL_SSE.indexOf('event: run_report'));
    const a = attributeFailure(withOutput(buildDispatchTail(noMeta)));
    expect(a.code).toBe('BUDGET_EXHAUSTED');
    expect(a.nextAction).not.toBe('raise_budget');
  });
});
/**
 * 判据 · 预算耗尽必须归资源层，不许记成 Agent 的能力失败（G2 前置 / Judge / D4）
 *
 * 现场（2026-11-14，code-search-glob 第 1 次真实派单）：三次尝试全部死于
 * `RUN_BUDGET_TOKENS`（~265k/256k token），run_report 明写 outcome=budget_exhausted，
 * 但账本三行全记成 implementation / BEHAVIOR_WRONG / countsAgainstAgent=true。
 * 尺子替被衡量者说了谎 —— 与 S3 的覆盖率口径缺陷同一类。
 *
 * 两处独立缺陷合成这次漏判，缺一不可复现：
 *   1. **生产者**：task-self-upgrade.ts 只把 `sse.slice(-900)` 打进 stdout。
 *      run_report 整行 576 字节，但它后面还跟着 delta / stage / done 三个事件，
 *      900 字节刚好把 run_report 整条切掉。归因的主证据源根本没送到。
 *   2. **消费者**：failure-attribution.ts 的资源层分支只认
 *      `outcome === 'budget_exhausted'` 或 `finishReason === 'max_iterations'`。
 *      幸存下来的 done 事件写的是 `finishReason: "budget_exhausted"` —— 不在名单里。
 *      于是唯一送达的那个字段也不被识别。
 *
 * 为什么 toolCallCount 却抠到了（循环没报「0 次工具调用」）：它在 done 事件里，
 * 而 done 在最后 900 字节内。**同一份 stdout，一半字段到得了、一半到不了**，
 * 这正是「截断式取证」最难发现的地方：它不是全盲，是选择性失明。
 *
 * 本判据同时钉住两侧，并留两条金丝雀防止「把真正的能力失败也一并洗白」。
 */
import { describe, expect, it } from 'vitest';
import { attributeFailure, type AttributionInput } from '../../scripts/failure-attribution.js';
import { buildDispatchTail } from '../../scripts/lib/sse-tail.mjs';

const base: AttributionInput = {
  taskId: 'budget-probe',
  attempt: 1,
  maxAttempts: 3,
  dispatch: { exitOk: true, output: '' },
  diagnosis: '',
  fence: {
    reached: true,
    targetChanged: true,
    typeOk: true,
    judgeOk: false,
    fullOk: false,
    protectedIntact: true,
    judgeTampered: false,
  },
  serviceHealthy: true,
};

const RUN_REPORT =
  'event: run_report\n' +
  'data: {"runId":"af984b6f","sessionId":"f8bc9690","outcome":"budget_exhausted","statusCode":"RUN_BUDGET_TOKENS",' +
  '"reason":"token 预算在第 14 步触发（267980/256000 token）","hasMaterialChange":true,"fileChangeCount":0,' +
  '"irreversibleCount":0,"approvalCount":0,"errorCount":0,"toolCallCount":20,"promptTokens":266827,' +
  '"completionTokens":1153,"durationMs":40761,"finishReason":"budget_exhausted"}\n\n';

/** run_report 之后的三个事件：正是它们把 run_report 挤出 900 字节窗口。 */
const AFTER_REPORT =
  'event: delta\ndata: {"text":"\\n\\n【任务 token 预算已用尽（256000）】"}\n\n' +
  'event: stage\ndata: {"runId":"af984b6f","stage":"done","at":1794593908910,"elapsedMs":40793,' +
  '"detail":"任务 token 预算已用尽（256000）"}\n\n' +
  'event: done\ndata: {"finishReason":"budget_exhausted","iteration":14,"toolCallCount":20,' +
  '"usage":{"promptTokens":266827,"completionTokens":1153},"tokenBudget":256000,"messageId":"","firstTokenMs":1306}\n\n';

const SSE = `${RUN_REPORT}${AFTER_REPORT}`;
/** 旧实现真正送进归因的东西（现场实测 416 字符，run_report 整条丢失）。 */
const OLD_TAIL = SSE.slice(-900).replace(/\\n/g, '\n').split('\n').slice(-10).join('\n');

describe('缺陷复现：旧取证链路把预算耗尽漏成实现层', () => {
  it('旧 900 字节尾部里根本没有 run_report（生产者缺陷）', () => {
    expect(OLD_TAIL.includes('run_report')).toBe(false);
    expect(OLD_TAIL.includes('"outcome"')).toBe(false);
    expect(OLD_TAIL.includes('"toolCallCount":20')).toBe(true);
  });

  it('done 事件里的 finishReason=budget_exhausted 旧归因不认（消费者缺陷）', () => {
    expect(OLD_TAIL.includes('"finishReason":"budget_exhausted"')).toBe(true);
    expect(OLD_TAIL.includes('"finishReason":"max_iterations"')).toBe(false);
  });
});

describe('消费者：finishReason 单独送达也必须归资源层', () => {
  it('只有 done 事件（run_report 被切掉）→ budget / BUDGET_EXHAUSTED / 不计入 Agent', () => {
    const a = attributeFailure({ ...base, dispatch: { exitOk: true, output: OLD_TAIL } });
    expect(a.layer).toBe('budget');
    expect(a.code).toBe('BUDGET_EXHAUSTED');
    expect(a.countsAgainstAgent).toBe(false);
    expect(a.owner).toBe('author');
  });

  it('run_report 完整送达时结论不变（两条路径必须同归一处）', () => {
    const a = attributeFailure({ ...base, dispatch: { exitOk: true, output: SSE } });
    expect(a.layer).toBe('budget');
    expect(a.countsAgainstAgent).toBe(false);
  });

  it('finishReason=max_iterations 仍归 MAX_ITERATIONS（回归）', () => {
    const out = 'event: done\ndata: {"finishReason":"max_iterations","toolCallCount":25}\n\n';
    const a = attributeFailure({ ...base, dispatch: { exitOk: true, output: out } });
    expect(a.layer).toBe('budget');
    expect(a.code).toBe('MAX_ITERATIONS');
    expect(a.countsAgainstAgent).toBe(false);
  });

  it('outcome=budget_exhausted 单独出现也归资源层（回归）', () => {
    const a = attributeFailure({
      ...base,
      dispatch: { exitOk: true, output: '{"outcome":"budget_exhausted","toolCallCount":3}' },
    });
    expect(a.layer).toBe('budget');
    expect(a.countsAgainstAgent).toBe(false);
  });

  it('资源层的下一步是拆题或放预算，不是换模型', () => {
    const a = attributeFailure({ ...base, dispatch: { exitOk: true, output: OLD_TAIL } });
    expect(a.nextAction).toBe('split_task');
    expect(a.note.includes('不要记成模型失败')).toBe(true);
  });
});

describe('金丝雀：不许把真正的能力失败一并洗白（反向）', () => {
  it('正常收工 + 靶子已改 + 判据没过 → 仍是 implementation 且计入 Agent', () => {
    const a = attributeFailure({
      ...base,
      dispatch: {
        exitOk: true,
        output: 'event: done\ndata: {"finishReason":"stop","outcome":"completed","toolCallCount":9,"fileChangeCount":2}\n\n',
      },
      diagnosis: 'FAIL  判据未通过：tests/self-upgrade/x.test.ts',
    });
    expect(a.layer).toBe('implementation');
    expect(a.countsAgainstAgent).toBe(true);
    expect(a.layer === 'budget').toBe(false);
  });

  it('有预算却一次工具都不调 → 仍是 behavior / NO_TOOL_CALL', () => {
    const a = attributeFailure({
      ...base,
      dispatch: { exitOk: true, output: '{"outcome":"completed","finishReason":"stop","toolCallCount":0}' },
      fence: { ...base.fence, targetChanged: false },
    });
    expect(a.layer).toBe('behavior');
    expect(a.code).toBe('NO_TOOL_CALL');
    expect(a.layer === 'budget').toBe(false);
  });

  it('上游额度耗尽仍归 infra，不被资源层抢走', () => {
    const a = attributeFailure({
      ...base,
      dispatch: { exitOk: true, output: 'Daily usage limit exceeded, resets at 2026-11-15' },
    });
    expect(a.layer).toBe('infra');
    expect(a.code).toBe('UPSTREAM_QUOTA_EXCEEDED');
    expect(a.layer === 'budget').toBe(false);
  });
});

describe('生产者：取证尾部必须完整携带归因所需的机械信号', () => {
  it('run_report 整条可解析，outcome 字段在', () => {
    const tail = buildDispatchTail(SSE);
    const m = /event: run_report\ndata: (.+)/.exec(tail);
    expect(m).toBeTruthy();
    const report = JSON.parse((m as RegExpExecArray)[1]);
    expect(report.outcome).toBe('budget_exhausted');
    expect(report.statusCode).toBe('RUN_BUDGET_TOKENS');
    expect(report.toolCallCount).toBe(20);
  });

  it('done 事件也整条可解析', () => {
    const tail = buildDispatchTail(SSE);
    const m = /event: done\ndata: (.+)/.exec(tail);
    expect(m).toBeTruthy();
    expect(JSON.parse((m as RegExpExecArray)[1]).finishReason).toBe('budget_exhausted');
  });

  it('新尾部喂进归因必须得到 budget（端到端串起来，不是各修各的）', () => {
    const a = attributeFailure({ ...base, dispatch: { exitOk: true, output: buildDispatchTail(SSE) } });
    expect(a.layer).toBe('budget');
    expect(a.countsAgainstAgent).toBe(false);
  });

  it('尾部必须有界，不能把整条 SSE 灌进循环控制台', () => {
    const huge = `${'event: delta\ndata: {"text":"x"}\n\n'.repeat(5000)}${SSE}`;
    const tail = buildDispatchTail(huge);
    expect(tail.length <= 4000).toBe(true);
    expect(/event: run_report/.test(tail)).toBe(true);
  });

  it('没有 run_report 时不得凭空造一个（反向）', () => {
    const tail = buildDispatchTail('event: delta\ndata: {"text":"hello"}\n\n');
    expect(tail.includes('run_report')).toBe(false);
    expect(tail.includes('"outcome"')).toBe(false);
  });

  it('空流不抛异常，也不发明信号（反向）', () => {
    expect(buildDispatchTail('')).toBe('');
    expect(buildDispatchTail('garbage without events')).not.toContain('run_report');
  });

  it('run_report 在流中间、后面还有大量事件时同样保得住', () => {
    const sse = `${RUN_REPORT}${'event: delta\ndata: {"text":"tail"}\n\n'.repeat(400)}`;
    const tail = buildDispatchTail(sse);
    expect(/event: run_report/.test(tail)).toBe(true);
    expect(tail.includes('"outcome":"budget_exhausted"')).toBe(true);
  });
});
/**
 * eval.run —— 跑固定评测套件，返回真实通过率。
 *
 * 与 `sys.exec npx vitest` 的区别：
 *  - 不走 shell、不花审批：用例固定、实现隔离在 vm 里，没有任意命令执行面；
 *  - Agent 改不到用例（用例在服务端代码里），只改得到被测实现；
 *  - 回显的失败只含 public 用例，隐藏用例只进总分 —— 防止针对样例打补丁。
 *
 * 工具本身恒为 ok=true（只要评测真的跑起来了）：测试没过是任务的失败，
 * 不是工具的失败。这与 sys.exec 的退出码口径一致。
 */

import { EVAL_RUN_DISPLAY_NAME, findSuite, EVAL_SUITES } from '../../services/eval/suites.js';
import { runEvalBattery } from '../../services/eval/runner.js';
import type { ToolDefinition, ToolOutcome } from '../../types/tool.js';

export const evalRunTool: ToolDefinition = {
  name: 'eval.run',
  wireName: 'eval_run',
  displayName: EVAL_RUN_DISPLAY_NAME,
  category: 'compute',
  description:
    '在沙箱内运行固定的评测套件，返回真实通过率。用例定义在服务端，无法被改写；' +
    '输出只回显公开用例的失败详情，总分含隐藏用例。不传 suite 则跑全部套件。' +
    '测试没通过时工具仍算执行成功，请看 data.passed / data.total / data.score。',
  inputSchema: {
    type: 'object',
    properties: {
      suite: {
        type: 'string',
        enum: EVAL_SUITES.map((s) => s.id),
        description: '只跑某一套件；缺省跑全部',
      },
    },
    additionalProperties: false,
  },
  timeoutMs: 15000,
  risk: 'medium',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: true,
  maxResultChars: 4000,
  enabled: (ctx) => Boolean(ctx.sandboxRoot),
  handler: async (args, ctx): Promise<ToolOutcome> => {
    const requested = args.suite === undefined ? undefined : String(args.suite);
    if (requested !== undefined && !findSuite(requested)) {
      return {
        ok: false,
        summary: `未知套件：${requested}`,
        error: {
          code: 'TOOL_INVALID_ARGS',
          kind: 'invalid_args',
          message: `未知套件：${requested}；可用：${EVAL_SUITES.map((s) => s.id).join(' / ')}`,
        },
      };
    }

    const battery = runEvalBattery(ctx.sandboxRoot, { includeHidden: true, only: requested });
    const suites = battery.suites.map((s) => ({
      id: s.id,
      title: s.title,
      ok: s.ok,
      passed: s.passed,
      total: s.total,
      publicPassed: s.publicPassed,
      publicTotal: s.publicTotal,
      // 隐藏用例失败只报「有几条」，不回显期望值 —— 否则隐藏集就白藏了。
      hiddenFailures: s.failures.filter((f) => f.hidden).length,
      failures: s.failures
        .filter((f) => !f.hidden)
        .map((f) => ({ name: f.name, expected: f.expected, actual: f.actual })),
      ...(s.error ? { error: s.error } : {}),
    }));

    const failed = suites.filter((s) => !s.ok).map((s) => s.id);
    const summary =
      `评测通过 ${battery.passed}/${battery.total}（${(battery.score * 100).toFixed(0)}%）` +
      (failed.length ? `；未满分：${failed.join('、')}` : '；全部套件满分');

    return {
      ok: true,
      summary,
      data: {
        passed: battery.passed,
        total: battery.total,
        score: battery.score,
        suites,
      },
    };
  },
};

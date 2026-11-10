/**
 * 判据 · task.test_pass_rate —— 「代码改动后真的能跑通吗」的机械读数。
 *
 * 与 tool.discipline.* 的区别：那几闸量的是「造工具的过程纪律」，
 * 这一闸量的是**产物本身**：在判决时刻重新执行固定套件，按 public+hidden
 * 全量计算通过率。Agent 的自述、eval.run 的回报都不采信 —— 只采信此刻的代码。
 *
 * 什么时候不产出判据（返回 null）：
 *   - 本轮没有成功调用过 eval.run。此时如果强行记 unexec，这条判据会进入
 *     每一层的分母，把所有无关会话的覆盖率拉下来 —— 一个从未参与代码修复的
 *     任务不该被这条判据判「未执行」。
 *
 * 什么时候记 unexec：调用过 eval.run，但套件总用例数为 0（配置为空）。
 * C4：没测到就是没测到，不能写成 pass。
 */

import { config } from '../../config/env.js';
import { runEvalBattery } from '../eval/runner.js';
import { EVAL_RUN_DISPLAY_NAME } from '../eval/suites.js';
import type { CriterionVerdict, JudgeEvidence } from './types.js';

export const TEST_PASS_RATE_CRITERION = 'task.test_pass_rate';

export function evalPassRateGate(evidence: JudgeEvidence): CriterionVerdict | null {
  const ranEval = evidence.toolCalls.some(
    (call) => call.display_name === EVAL_RUN_DISPLAY_NAME && call.status === 'success',
  );
  if (!ranEval) return null;

  const battery = runEvalBattery(config.sandboxRoot, { includeHidden: true });
  if (battery.total === 0) {
    return {
      layer: 'L1',
      criterion: TEST_PASS_RATE_CRITERION,
      status: 'unexec',
      detail: '固定评测套件没有可执行用例，通过率不可测，按 C4 记 unexec',
      data: { passed: 0, total: 0, denominator: 0, score: 0, suites: [] },
    };
  }

  const failing = battery.suites
    .filter((s) => !s.ok)
    .map((s) => `${s.id} ${s.passed}/${s.total}${s.error ? `（${s.error}）` : ''}`);

  return {
    layer: 'L1',
    criterion: TEST_PASS_RATE_CRITERION,
    status: battery.score >= 1 ? 'pass' : 'fail',
    score: battery.score,
    detail:
      `固定评测套件 ${battery.passed}/${battery.total} 通过（含隐藏用例）` +
      (failing.length ? `；未满分：${failing.join('、')}` : ''),
    // 结构化读数：分母与套件清单必须能被机器直接消费，不能靠解析上面的文案。
    data: {
      passed: battery.passed,
      total: battery.total,
      denominator: battery.total,
      score: battery.score,
      suites: battery.suites.map((s) => ({
        id: s.id,
        title: s.title,
        ok: s.ok,
        passed: s.passed,
        total: s.total,
        publicPassed: s.publicPassed,
        publicTotal: s.publicTotal,
        ...(s.error ? { error: s.error } : {}),
      })),
    },
  };
}

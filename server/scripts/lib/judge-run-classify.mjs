/**
 * 判据执行结果的三态分类：pass / fail / unexec。
 *
 * 「跑了没过」与「尺子没跑」是两件事：前者是实现的失败信号，后者是判据自身
 * 没跑起来（加载失败、编译错、无用例）。混为一谈会让归因把环境/出题问题
 * 记成 Agent 能力缺口。判定只读 vitest 的机械汇总行，不做语义推断：
 * 有 Tests 计数（failed+passed>0）= 真跑过；没有 = unexec（缺证据即未执行）。
 */
export function classifyJudgeRun(output, exitOk) {
  if (exitOk) return { status: 'pass', ran: true };
  const text = String(output ?? '');
  const failed = Number(/Tests\s+(\d+)\s+failed/.exec(text)?.[1] ?? 0);
  const passed = Number(/Tests\s+(?:\d+\s+failed\s*\|\s*)?(\d+)\s+passed/.exec(text)?.[1] ?? 0);
  const ran = failed + passed > 0;
  return { status: ran ? 'fail' : 'unexec', ran };
}
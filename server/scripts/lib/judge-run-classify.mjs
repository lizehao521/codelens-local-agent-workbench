/**
 * 判据执行结果的三态分类：pass / fail / unexec。
 *
 * 「跑了没过」与「尺子没跑」是两件事：前者是实现的失败信号，后者是判据自身
 * 没跑起来（加载失败、编译错、无用例）。混为一谈会让归因把环境/出题问题
 * 记成 Agent 能力缺口。判定只读 vitest 的机械汇总行，不做语义推断：
 * 有 Tests 计数（failed+passed>0）= 真跑过；没有 = unexec（缺证据即未执行）。
 */
/** CSI 转义序列（含 SGR 颜色码）。 */
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function classifyJudgeRun(output, exitOk) {
  if (exitOk) return { status: 'pass', ran: true };
  // vitest 即使 stdio 是 pipe 也照吐颜色码，汇总行实际长这样：
  //   "Tests \u001b[22m \u001b[1m\u001b[31m3 failed"
  // 不剥色，下面两条数字正则一条都匹配不上 → ran=false → 每次「跑了没过」
  // 都被误报成「尺子没跑起来」，正好抹掉这个分类器存在的全部理由。
  const text = String(output ?? '').replace(ANSI_CSI, '');
  const failed = Number(/Tests\s+(\d+)\s+failed/.exec(text)?.[1] ?? 0);
  const passed = Number(/Tests\s+(?:\d+\s+failed\s*\|\s*)?(\d+)\s+passed/.exec(text)?.[1] ?? 0);
  const ran = failed + passed > 0;
  return { status: ran ? 'fail' : 'unexec', ran };
}

/**
 * 从 vitest 输出里提出失败的判据文件，供「只串行复跑红的那几个」用。
 * 同样必须剥色：真实行是 "\e[41m\e[1m FAIL \e[22m\e[49m tests/…"，
 * 不剥就一个都提不出来，围栏会退化成整轮并发重跑，却仍宣称做了串行复跑。
 */
export function failedFilesOf(output) {
  const text = String(output ?? '').replace(ANSI_CSI, '');
  const set = new Set();
  for (const m of text.matchAll(/(?:FAIL|❯)\s+([\w./\\-]+\.test\.ts)/g)) {
    const p = (m[1] ?? '').replace(/\\/g, '/').replace(/^.*?(tests\/)/, '$1');
    if (p.startsWith('tests/')) set.add(p);
  }
  return [...set];
}

/**
 * 全量回归一次执行的取证摘要。
 *
 * 为什么需要它：围栏曾打印「全量回归红了且串行复跑仍红 —— 可复现，判为真回归」，
 * 而诊断文件里只有这一句结论，没有任何失败用例名。execFileSync 超时被杀时
 * e.stdout 可能是空的 —— 那是**取证缺失**，不是「可复现」。
 * 缺证据就不许下可复现的结论（C4）。
 */
export function regressionRunEvidence(out, err) {
  const text = String(out ?? '').replace(ANSI_CSI, '');
  return {
    hasEvidence: text.trim().length > 0,
    timedOut: err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT',
    files: failedFilesOf(text),
    lines: text
      .split('\n')
      .filter((l) => /FAIL|Tests\s+\d/.test(l))
      .slice(0, 12),
  };
}
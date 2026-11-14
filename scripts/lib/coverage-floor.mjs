/**
 * 覆盖率地板的纯判定逻辑。
 *
 * 与 CLI 分开的理由：判定必须能被判据直接喂夹具验证（C3 自证），
 * 而 CLI 那层要读盘、要退出码，混在一起就没法在不碰磁盘的情况下证明它能红。
 *
 * 三条口径（踩过的坑写在这里）：
 *   1. **缺报告 = UNEXEC，不是 0% 也不是通过。** 覆盖率没跑起来时报 0 会让人
 *      以为「测得很差」，报通过则是 C4 违规。这里一律返回 unexec，由 CLI 退 2。
 *   2. **按前缀聚合必须累加 covered/total，不能对百分比求平均。** 一个 10 行
 *      全覆盖的小文件和一个 1000 行零覆盖的大文件，平均百分比是 50%，
 *      真实行覆盖是 0.99% —— 平均口径会把地板闸变成装饰。
 *   3. **分母为 0 的指标记为 null（不可判），不当成 100%。** 没有分支的文件
 *      branches.total=0，把它算成满分是凭空发明覆盖率。
 */

/** 从 coverage-summary.json 的 total 或按前缀聚合出一组计数。 */
export function aggregate(summary, prefix) {
  if (!summary || typeof summary !== 'object') return null;
  if (!prefix) return summary.total ?? null;

  const acc = {};
  let matched = 0;
  for (const [file, entry] of Object.entries(summary)) {
    if (file === 'total') continue;
    // summary 的键是绝对路径，统一成正斜杠再比前缀，避免 Windows 分隔符漏匹配。
    const norm = file.replace(/\\/g, '/');
    if (!norm.includes(`/${prefix.replace(/\\/g, '/')}`) && !norm.endsWith(prefix)) continue;
    matched += 1;
    for (const metric of ['lines', 'statements', 'functions', 'branches']) {
      const m = entry?.[metric];
      if (!m || typeof m.total !== 'number') continue;
      acc[metric] = acc[metric] ?? { total: 0, covered: 0, skipped: 0, pct: 0 };
      acc[metric].total += m.total;
      acc[metric].covered += m.covered;
      acc[metric].skipped += m.skipped ?? 0;
    }
  }
  if (matched === 0) return null;
  for (const m of Object.values(acc)) {
    m.pct = m.total > 0 ? Number(((m.covered / m.total) * 100).toFixed(2)) : 0;
  }
  return acc;
}

/** 单条规则判定。返回 {rule, pct, min, status}，status ∈ pass/fail/unexec。 */
export function checkRule(summary, rule) {
  const bucket = aggregate(summary, rule.prefix);
  const metric = bucket?.[rule.metric];
  if (!metric || typeof metric.total !== 'number') {
    return { ...rule, pct: null, status: 'unexec', reason: '报告里没有这个范围/指标' };
  }
  if (metric.total === 0) {
    return { ...rule, pct: null, status: 'unexec', reason: '分母为 0，不可判（不当成满分）' };
  }
  const pct = Number(((metric.covered / metric.total) * 100).toFixed(2));
  return { ...rule, pct, status: pct >= rule.min ? 'pass' : 'fail', reason: null };
}

/** 整组判定。summary 为 null（报告不可得）时全部记 unexec，绝不返回 pass。 */
export function evaluate(summary, rules) {
  if (!summary) {
    return {
      results: rules.map((r) => ({ ...r, pct: null, status: 'unexec', reason: '覆盖率报告不可得' })),
      failures: [],
      unexec: rules.length,
      passed: 0,
    };
  }
  const results = rules.map((r) => checkRule(summary, r));
  return {
    results,
    failures: results.filter((r) => r.status === 'fail'),
    unexec: results.filter((r) => r.status === 'unexec').length,
    passed: results.filter((r) => r.status === 'pass').length,
  };
}
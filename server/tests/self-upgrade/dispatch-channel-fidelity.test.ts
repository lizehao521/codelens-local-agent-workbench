/**
 * 判据 · 派单通道不得凭空捏造事实（Judge / D4）
 *
 * 现场（2026-11-14，fs-read-line-window 第 2/3 次尝试，机械取证）：
 * 循环在两次预算掐断后按 MODEL_ROTATION 换模型，换到 `deepseek-v4-pro-0813`。
 * 上游 2 秒内回 HTTP 404 —— 这个模型名根本不存在。SSE 全文只有 1583 字节：
 *   event: stage  stage=upstream_error  detail="上游…不认识这个模型（HTTP 404）"
 *   event: error  code=UPSTREAM_ERROR
 * 没有 run_report，没有 done，Agent 一步都没跑。可是：
 *   1. 循环打印「本轮 0 次工具调用（只回了文字，没有动文件）」——
 *      它用 `?? 0` 把「证据缺席」当成了「计数为零」，于是诊断书告诉模型
 *      「你只说不做」，而真相是它压根没被派出去。
 *   2. 归因落到 implementation / BEHAVIOR_WRONG / countsAgainstAgent=true ——
 *      infra 层认得连接超时与额度耗尽，却不认得「模型名无效」这种 404。
 *   3. 根因是 MODEL_ROTATION 里三个后备模型名全是裸名。实跑 /models：
 *      上游 83 个模型全部带厂商前缀，四个候选里只有主模型（来自 .env，
 *      全限定名）可用，三个后备**一个都不存在**。换模型必然失败。
 *
 * 三处缺陷同属一类：缺证据被当成反证（违反 C4）。本判据把三处一起钉住，
 * 并留金丝雀防止「把真正的只说不做也一并洗白」。
 */
import { describe, expect, it } from 'vitest';
import { attributeFailure, type AttributionInput } from '../../scripts/failure-attribution.js';
import { filterServableRotation, readToolCallEvidence } from '../../scripts/lib/dispatch-fidelity.mjs';
import { pickFenceEvidence } from '../../scripts/lib/fence-diag.mjs';

/** 实跑捕获：.self-upgrade/loop/sse-fs-read-line-window-3.txt 全文（1583 字节）。 */
const REAL_404_SSE =
  'event: stage\n' +
  'data: {"runId":"2948c059","stage":"connecting","at":1794595730063,"elapsedMs":0,"detail":null}\n\n' +
  'event: meta\n' +
  'data: {"sessionId":"d8fd335d","provider":"custom","model":"deepseek-v4-pro-0813","channel":"native",' +
  '"iteration":1,"maxIterations":25,"contextWindow":128000,"tokenBudget":256000,"toolCount":17}\n\n' +
  'event: stage\n' +
  'data: {"runId":"2948c059","stage":"upstream_first_byte","at":1794595730411,"elapsedMs":348,"detail":null}\n\n' +
  'event: stage\n' +
  'data: {"runId":"2948c059","stage":"upstream_error","at":1794595730412,"elapsedMs":349,' +
  '"detail":"上游（integrate.api.nvidia.com）不认识这个模型（HTTP 404）。\\n可能原因：模型名拼错 / 该 key 无此模型权限 / Base URL 路径不对。"}\n\n' +
  'event: error\n' +
  'data: {"code":"UPSTREAM_ERROR","message":"上游（integrate.api.nvidia.com）不认识这个模型（HTTP 404）。",' +
  '"retryable":false}\n\n';

const base: AttributionInput = {
  taskId: 'fidelity-probe',
  attempt: 2,
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

describe('缺陷复现：上游 404 是 infra，不是 Agent 的实现失败', () => {
  const input: AttributionInput = { ...base, dispatch: { exitOk: true, output: REAL_404_SSE } };

  it('归到 infra 层', () => {
    expect(attributeFailure(input).layer).toBe('infra');
  });

  it('不计入 Agent 能力账', () => {
    expect(attributeFailure(input).countsAgainstAgent).toBe(false);
  });

  it('不得落到 implementation 层', () => {
    expect(attributeFailure(input).layer === 'implementation').toBe(false);
  });

  it('错误码点名模型不可用，处置是换模型', () => {
    const a = attributeFailure(input);
    expect(a.code).toBe('UPSTREAM_MODEL_UNKNOWN');
    expect(a.nextAction).toBe('switch_model');
  });

  it('证据里要留下上游原话，便于对账', () => {
    expect(attributeFailure(input).evidence.join('\n')).toMatch(/不认识这个模型|UPSTREAM_ERROR/);
  });

  it('只有 error 事件、没有中文提示时也要认出来（上游语言可能变）', () => {
    const out = 'event: error\ndata: {"code":"UPSTREAM_ERROR","message":"model not found","retryable":false}\n\n';
    expect(attributeFailure({ ...base, dispatch: { exitOk: true, output: out } }).countsAgainstAgent).toBe(false);
  });
});

describe('金丝雀：真正的「只说不做」仍要归行为层', () => {
  const idle =
    'event: run_report\ndata: {"outcome":"completed","toolCallCount":0,"fileChangeCount":0,"finishReason":"stop"}\n\n' +
    'event: done\ndata: {"finishReason":"stop","toolCallCount":0}\n\n';

  it('有 run_report 且 toolCallCount=0 → behavior/NO_TOOL_CALL', () => {
    const a = attributeFailure({ ...base, dispatch: { exitOk: true, output: idle } });
    expect(a.layer).toBe('behavior');
    expect(a.code).toBe('NO_TOOL_CALL');
  });

  it('真正实现错了仍计入 Agent', () => {
    const out = 'event: run_report\ndata: {"outcome":"completed","toolCallCount":9,"fileChangeCount":1}\n\n';
    const a = attributeFailure({
      ...base,
      dispatch: { exitOk: true, output: out },
      diagnosis: '判据未通过：expected true to be false',
    });
    expect(a.countsAgainstAgent).toBe(true);
  });

  it('额度耗尽仍走 quota 分支，不被模型 404 分支抢走', () => {
    const out = 'event: error\ndata: {"code":"UPSTREAM_QUOTA_EXCEEDED","message":"Daily usage limit exceeded"}\n\n';
    expect(attributeFailure({ ...base, dispatch: { exitOk: true, output: out } }).code).toBe('UPSTREAM_QUOTA_EXCEEDED');
  });

  it('全量回归取证缺失归 infra，不计入 Agent（尺子没量到 ≠ 模型做错）', () => {
    const a = attributeFailure({
      ...base,
      diagnosis: 'FAIL  全量回归取证缺失（执行超时被杀，串行复跑） —— 判不了是否真回归，不计入 Agent；需人工复跑取证',
    });
    expect(a.layer).toBe('infra');
    expect(a.countsAgainstAgent).toBe(false);
  });

  it('真的全量回归红了仍要计入 Agent（取证缺失分支不许过度匹配）', () => {
    const a = attributeFailure({
      ...base,
      diagnosis: 'FAIL  全量回归红了且串行复跑仍红 —— 可复现，判为真回归，不构成一次升级\n      FAIL  tests/x.test.ts > y',
    });
    expect(a.countsAgainstAgent).toBe(true);
  });
});

describe('围栏判 FAIL 必须留得下证据', () => {
  const fenceSrc = () =>
    import('node:fs/promises').then((m) =>
      m.readFile(new URL('../../scripts/check-self-upgrade.mjs', import.meta.url), 'utf8'),
    );

  it('原始回归输出整份落盘，不是只落一句结论', async () => {
    const src = await fenceSrc();
    expect(/persist\(`full-regression-\$\{Date\.now\(\)\}\.txt`, full\.out\)/.test(src)).toBe(true);
  });

  it('首次全量输出单独留档：复跑会覆盖 full，只存它就丢了第一次为什么红', async () => {
    const src = await fenceSrc();
    const firstRun = src.indexOf('let full = runFull()');
    const capture = src.indexOf('const firstOut = full.out');
    const reassign = src.indexOf('full = { ok: true');
    expect(firstRun).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(firstRun);
    expect(capture).toBeLessThan(reassign);
    expect(/persist\(`full-regression-first-\$\{Date\.now\(\)\}\.txt`, firstOut\)/.test(src)).toBe(true);
  });

  it('无证据分支先打 unexec，「可复现」只许出现在有证据的那一支', async () => {
    const src = await fenceSrc();
    const guard = src.indexOf('if (!ev.hasEvidence)');
    const unexec = src.indexOf('REGRESSION_VERDICT=unexec');
    const claim = src.indexOf('可复现，判为真回归');
    expect(guard).toBeGreaterThan(-1);
    expect(unexec).toBeGreaterThan(guard);
    expect(claim).toBeGreaterThan(unexec);
    expect(src.slice(0, guard).includes('可复现，判为真回归')).toBe(false);
  });
});

describe('工具调用取证：缺席不等于零', () => {
  it('真实 404 输出里没有 run_report → known=false', () => {
    expect(readToolCallEvidence(REAL_404_SSE).known).toBe(false);
  });

  it('缺席时 count 必须是 null，不能是 0', () => {
    expect(readToolCallEvidence(REAL_404_SSE).count === 0).toBe(false);
  });

  it('明写 0 才是已知零', () => {
    const r = readToolCallEvidence('data: {"toolCallCount":0}');
    expect(r.known).toBe(true);
    expect(r.count).toBe(0);
  });

  it('多次出现取最后一条（run_report 之后还有 done）', () => {
    expect(readToolCallEvidence('{"toolCallCount":3}\n{"toolCallCount":20}').count).toBe(20);
  });

  it('空输出与 undefined → known=false', () => {
    expect(readToolCallEvidence('').known).toBe(false);
    expect(readToolCallEvidence(undefined).known).toBe(false);
  });
});

describe('模型候选可用性：换模型不能换到不存在的名字', () => {
  /** 实跑 /models 得到的真实 ID 形态：全部带厂商前缀。 */
  const SERVED = [
    'nvidia/nemotron-3-ultra-550b-a55b',
    'deepseek-ai/deepseek-v4.1-flash',
    'moonshotai/kimi-k2.6',
    'nvidia/nemotron-3-super-120b-a12b',
  ];
  const ROTATION = ['nvidia/nemotron-3-ultra-550b-a55b', 'deepseek-v4-pro-0813', 'deepseek-v4-flash', 'kimi-k3'];

  it('三个裸名后备全部被剔除', () => {
    expect(filterServableRotation(ROTATION, SERVED).dropped).toEqual([
      'deepseek-v4-pro-0813',
      'deepseek-v4-flash',
      'kimi-k3',
    ]);
  });

  it('主模型保留（它刚被 chat 探针实证可用）', () => {
    expect(filterServableRotation(ROTATION, SERVED).kept).toEqual(['nvidia/nemotron-3-ultra-550b-a55b']);
  });

  it('全限定名的后备会被留下', () => {
    const r = filterServableRotation([...ROTATION, 'moonshotai/kimi-k2.6'], SERVED);
    expect(r.kept).toContain('moonshotai/kimi-k2.6');
  });

  it('拿不到模型列表时不做判断，一律放行（无列表接口 ≠ 模型不存在）', () => {
    const r = filterServableRotation(ROTATION, []);
    expect(r.verified).toBe(false);
    expect(r.kept).toEqual(ROTATION);
  });

  it('列表为 null/undefined 同样放行', () => {
    expect(filterServableRotation(ROTATION, null).verified).toBe(false);
    expect(filterServableRotation(ROTATION, undefined).dropped).toEqual([]);
  });

  it('空候选表不炸', () => {
    expect(filterServableRotation([], SERVED).kept).toEqual([]);
  });

  it('默认候选表里的后备必须都是上游真实服务的 ID（防回退到裸名）', async () => {
    const src = await import('node:fs/promises').then((m) =>
      m.readFile(new URL('../../scripts/self-upgrade-loop.ts', import.meta.url), 'utf8'),
    );
    const line = /(?:const|let) MODEL_ROTATION = \(process\.env\.RSI_MODEL_ROTATION \?\? `([^`]+)`\)/.exec(src)?.[1] ?? '';
    const fallbacks = line.split(',').slice(1).map((s) => s.trim()).filter(Boolean);
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks.every((m) => m.includes('/'))).toBe(true);
  });
});

describe('诊断书必须带上围栏的证据行，不能只剩一句结论', () => {
  // 排版取自真实围栏输出：结论顶格，失败用例名与落盘路径缩进 6 空格跟在后面。
  const FENCE_OUT = [
    'PASS  类型检查通过（tsc --noEmit）',
    'PASS  判据通过：tests/self-upgrade/fs-glob.test.ts',
    'REGRESSION_VERDICT=fail',
    'FAIL  全量回归红了且串行复跑仍红 —— 可复现，判为真回归，不构成一次升级',
    '      Test Files  7 failed (7)',
    '      FAIL  tests/fallback-budget.endpoint.test.ts > 默认返回 enabled=false',
    '      原始输出已存 /repo/.self-upgrade/loop/full-regression-1.txt',
    '      首次全量输出已存 /repo/.self-upgrade/loop/full-regression-first-1.txt',
    'PASS  受保护路径零改动',
  ].join('\n');

  it('缩进的证据行跟着结论一起进诊断书', () => {
    const picked = pickFenceEvidence(FENCE_OUT);
    expect(picked.some((l) => l.startsWith('FAIL'))).toBe(true);
    expect(picked.some((l) => l.includes('fallback-budget.endpoint'))).toBe(true);
    expect(picked.some((l) => l.includes('full-regression-first-1.txt'))).toBe(true);
  });

  it('REGRESSION_VERDICT 必须保留：它区分「跑了且红」与「取证缺失」', () => {
    expect(pickFenceEvidence(FENCE_OUT)).toContain('REGRESSION_VERDICT=fail');
    expect(pickFenceEvidence('REGRESSION_VERDICT=unexec\nFAIL  全量回归取证缺失')).toContain(
      'REGRESSION_VERDICT=unexec',
    );
  });

  it('PASS 行不进诊断书，也不被当成上一条 FAIL 的证据', () => {
    const picked = pickFenceEvidence(FENCE_OUT);
    expect(picked.some((l) => l.startsWith('PASS'))).toBe(false);
    expect(picked.some((l) => l.includes('受保护路径零改动'))).toBe(false);
  });

  it('ANSI 转义先剥掉再挑（vitest 5 即使 stdio 是管道也照发 CSI）', () => {
    const picked = pickFenceEvidence('\u001b[31mFAIL\u001b[39m  红了\n      \u001b[2mFAIL  a.test.ts\u001b[22m');
    expect(picked[0]).toBe('FAIL  红了');
    expect(picked.some((l) => l.includes('a.test.ts'))).toBe(true);
    expect(picked.join('').includes('\u001b')).toBe(false);
  });

  it('有界：结论再多也不把诊断书变成日志转储', () => {
    const many = Array.from({ length: 40 }, (_, i) => `FAIL  第 ${i} 条\n      证据 ${i}`).join('\n');
    expect(pickFenceEvidence(many).length).toBeLessThanOrEqual(24);
  });

  it('空输出 / 非字符串不抛，返回空数组（没跑就是没跑，不许编证据）', () => {
    expect(pickFenceEvidence('')).toEqual([]);
    expect(pickFenceEvidence(undefined)).toEqual([]);
    expect(pickFenceEvidence('PASS  全绿')).toEqual([]);
  });

  it('派单循环真的用了它，而不是自己再写一遍只取顶格行的过滤', async () => {
    const src = await import('node:fs/promises').then((m) =>
      m.readFile(new URL('../../scripts/self-upgrade-loop.ts', import.meta.url), 'utf8'),
    );
    expect(src.includes("import { pickFenceEvidence } from './lib/fence-diag.mjs'")).toBe(true);
    expect(src.includes('const fails = pickFenceEvidence(fenceOut)')).toBe(true);
    expect(src.includes('/^(FAIL|WARN)\\s/.test(l)')).toBe(false);
  });
});

describe('单题派单也要排除「别的还没做的题」的判据', () => {
  const loopSrc = () =>
    import('node:fs/promises').then((m) =>
      m.readFile(new URL('../../scripts/self-upgrade-loop.ts', import.meta.url), 'utf8'),
    );

  it('排除名单从 all 算，不从被 --only 收窄的 pending 算', async () => {
    const src = await loopSrc();
    const at = src.indexOf('const otherPendingJudges = all');
    expect(at).toBeGreaterThan(-1);
    const stmt = src.slice(at, src.indexOf(';', at));
    expect(stmt.includes('pending.some')).toBe(false);
    expect(stmt.includes("t.status !== 'done'")).toBe(true);
    expect(stmt.includes('done.has(t.id)')).toBe(true);
  });

  it('名单非空时必须真的传成 --exclude-judges（算了不用等于没算）', async () => {
    const src = await loopSrc();
    expect(src.includes("args.push(`--exclude-judges=${excluded.join(',')}`)")).toBe(true);
    expect(src.includes('fenceArgs(spec, otherPendingJudges)')).toBe(true);
  });
});
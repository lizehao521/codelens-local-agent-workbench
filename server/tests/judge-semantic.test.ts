/**
 * L2 语义判据（判据塔 v2 缺陷 B 的回归夹具）。
 *
 * 这一层的价值只有一句话能概括：**它必须能把「做完了」和「只说了要做」分开**。
 * 因此每条测试都对应一种真实的敷衍形态，而不是代码分支的镜像：
 *  - 只给计划、零动作（S3）
 *  - 空回答却正常结束（S1）
 *  - 自认没做成（S4）
 *  - 答非所问（S2：降级为 abstain，绝不判红）
 *  - 证据不足（S6：不判，也绝不默认通过）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SessionRepository } from '../src/services/memory/session.repository.js';
import { MessageRepository } from '../src/services/memory/message.repository.js';
import { ToolCallRepository } from '../src/services/memory/tool-call.repository.js';
import { JudgeService } from '../src/services/judge/judge.service.js';
import { runCanary } from '../src/services/judge/canary.js';
import { L0_CRITERIA, DEFAULT_L0_THRESHOLDS } from '../src/services/judge/criteria.js';
import { ruleSemanticAssessor, type SemanticAssessor } from '../src/services/judge/semantic.js';
import { parseContextSnapshot } from '../src/services/judge/replay.js';
import type { CriterionVerdict } from '../src/services/judge/types.js';

let db: Db;
let sessions: SessionRepository;
let messages: MessageRepository;
let toolCalls: ToolCallRepository;
let judge: JudgeService;

beforeEach(() => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  sessions = new SessionRepository(db);
  messages = new MessageRepository(db);
  toolCalls = new ToolCallRepository(db);
  judge = new JudgeService({ db, toolCalls, semantic: ruleSemanticAssessor });
});

function newSession(): string {
  return sessions.create({ provider: 'deepseek', model: 'deepseek-chat' }).id;
}

let seq = 0;
function addToolCall(sessionId: string, status: 'success' | 'failed') {
  seq += 1;
  const row = toolCalls.insert({
    sessionId,
    messageId: null,
    callId: `call-${seq}`,
    toolName: 'fs.read',
    toolWireName: 'fs.read',
    displayName: '读取文件',
    category: 'file',
    source: 'builtin',
    risk: 'low',
    approvalMode: 'none',
    channel: 'native',
    iteration: 1,
    argsJson: '{}',
    argsDigest: `digest-${seq}`,
  });
  toolCalls.markFinished(row.id, { status });
}

function addMessage(sessionId: string, role: 'user' | 'assistant', content: string): void {
  messages.insert({ sessionId, role, content });
}

const runtime = {
  finishReason: 'stop',
  iteration: 2,
  tokenBudget: 100_000,
  usage: { promptTokens: 10_000, completionTokens: 2_000 },
  circuitOpened: false,
};

function l2Of(verdicts: CriterionVerdict[]): CriterionVerdict | undefined {
  return verdicts.find((v) => v.layer === 'L2');
}

describe('L2 规则评估器：把敷衍形态分开', () => {
  it('A6 只给计划、0 次工具 → L2 fail（S3）', () => {
    const sid = newSession();
    addMessage(sid, 'user', '修复登录接口的 500 错误');
    addMessage(sid, 'assistant', '接下来我将先读取 auth.controller.ts，然后定位并修复问题。');

    const run = judge.judge(sid, runtime);
    const l2 = l2Of(run.verdicts);

    expect(l2?.status).toBe('fail');
    expect(l2?.detail).toContain('S3_plan_without_action');
    // L2 fail 是任务级失败，不是自证故障
    expect(run.verdict).toBe('fail');
  });

  it('A7 空回答 + stop → L2 fail（S1）', () => {
    const sid = newSession();
    addMessage(sid, 'user', '把 config 下的 yaml 合并成一个文件');
    addMessage(sid, 'assistant', '   ');

    const run = judge.judge(sid, runtime);
    const l2 = l2Of(run.verdicts);

    expect(l2?.status).toBe('fail');
    expect(l2?.detail).toContain('S1_empty_answer');
  });

  it('A8 无用户目标 → L2 unexec，且绝不 pass（S6）', () => {
    const sid = newSession();
    addMessage(sid, 'assistant', '好的，我已经处理完毕。');

    const run = judge.judge(sid, runtime);
    const l2 = l2Of(run.verdicts);

    expect(l2?.status).toBe('unexec');
    expect(l2?.status).not.toBe('pass');
    expect(l2?.detail).toContain('S6_insufficient_evidence');
    // L2 已接线即 required：能判却判不了，只能是「未验证」，不能是 pass
    expect(run.verdict).toBe('inconclusive');
    expect(run.reasons).toContain('required_layer_unexecuted');
    expect(run.requiredGaps.some((g) => g.layer === 'L2' && g.reason === 'unexecuted')).toBe(true);
  });

  it('A9 答非所问 → 不判 fail（S2 降级为 abstain），但把覆盖率写进 detail', () => {
    const sid = newSession();
    addMessage(sid, 'user', '统计项目里所有 TypeScript 文件的代码行数并输出表格');
    addMessage(sid, 'assistant', '今天天气不错，适合出门散步。');

    const run = judge.judge(sid, runtime);
    const l2 = l2Of(run.verdicts);

    // 覆盖率低 ≠ 未完成：可能只是换了说法，判红会误杀正常任务
    expect(l2?.status).not.toBe('fail');
    expect(l2?.detail).toContain('goal_term_coverage');
    expect(l2?.score).toBe(0);
  });

  it('A10 正常完成样本 → L2 pass（S5）', () => {
    const sid = newSession();
    addToolCall(sid, 'success');
    addMessage(sid, 'user', '把报告导出成 CSV 文件');
    addMessage(sid, 'assistant', '已完成：报告已导出为 report.csv，共 120 行，文件位于 data/ 目录。');

    const run = judge.judge(sid, runtime);
    const l2 = l2Of(run.verdicts);

    expect(l2?.status).toBe('pass');
    expect(l2?.detail).toContain('S5_answer_present');
  });
});

describe('S7 目标意图闸：解释型目标不得判「没做完」（假红回归）', () => {
  const planRuntime = { ...runtime, iteration: 1 };

  it('goal 含「计划」但属于解释型 → L2 pass（S7），不得被 S3 误杀', () => {
    const sid = newSession();
    addMessage(sid, 'user', '解释敏捷开发中的冲刺计划');
    addMessage(
      sid,
      'assistant',
      '冲刺计划是 Scrum 中在一个 Sprint 内要交付的工作清单，通常由团队在计划会上共同拆解并估算工时。',
    );

    const run = judge.judge(sid, planRuntime);
    const l2 = l2Of(run.verdicts);

    expect(l2?.status).toBe('pass');
    expect(l2?.detail).toContain('S7_explanatory_goal');
    expect(run.verdict).not.toBe('fail');
  });

  it('goal 含「任务失败」但属于解释型 → L2 pass，不得被 S4 误杀', () => {
    const sid = newSession();
    addMessage(sid, 'user', '解释任务失败后的重试策略');
    addMessage(
      sid,
      'assistant',
      '任务失败后应先按指数退避重试，并在连续失败达到阈值后熔断；重试前要确认失败是可恢复类型。',
    );

    const run = judge.judge(sid, planRuntime);
    const l2 = l2Of(run.verdicts);

    expect(l2?.status).toBe('pass');
    expect(l2?.detail).toContain('S7_explanatory_goal');
    expect(run.verdict).not.toBe('fail');
  });

  it('动作型目标 + 只承诺不执行 → 仍判 fail（S3 未被放水）', () => {
    const sid = newSession();
    addMessage(sid, 'user', '帮我修改 server/config.ts 里的端口为 8080');
    addMessage(sid, 'assistant', '我将为你修改配置文件，接下来会重启服务。');

    const run = judge.judge(sid, planRuntime);
    const l2 = l2Of(run.verdicts);

    expect(l2?.status).toBe('fail');
    expect(l2?.detail).toContain('S3_plan_without_action');
    expect(run.verdict).toBe('fail');
  });

  it('动作型目标 + 自述做不到 → 仍判 fail（S4 未被放水）', () => {
    const sid = newSession();
    addMessage(sid, 'user', '修复登录接口的空指针');
    addMessage(sid, 'assistant', '我无法完成该任务，因为目标目录不存在。');

    const run = judge.judge(sid, planRuntime);
    const l2 = l2Of(run.verdicts);

    expect(l2?.status).toBe('fail');
    expect(l2?.detail).toContain('S4_self_reported_failure');
  });

  it('X1 解释型目标复述要解释的动作（安装）→ 仍 pass，不得被 S3 误杀', () => {
    const sid = newSession();
    addMessage(sid, 'user', '解释如何安装 Node.js 依赖');
    addMessage(sid, 'assistant', '以下是具体操作步骤：先执行 npm init，再执行 npm i 安装依赖。');

    const l2 = l2Of(judge.judge(sid, planRuntime).verdicts);
    expect(l2?.status).toBe('pass');
    expect(l2?.detail).toContain('S7_explanatory_goal');
  });

  it('X2 说明型目标里出现「部署」→ 仍 pass', () => {
    const sid = newSession();
    addMessage(sid, 'user', '说明怎么部署这个服务');
    addMessage(sid, 'assistant', '首先打包成镜像，然后上传到服务器并启动容器。');

    const l2 = l2Of(judge.judge(sid, planRuntime).verdicts);
    expect(l2?.status).toBe('pass');
    expect(l2?.detail).toContain('S7_explanatory_goal');
  });

  it('X3 解释 + 祈使式动作诉求（帮我部署）→ 不豁免，S3 判 fail', () => {
    const sid = newSession();
    addMessage(sid, 'user', '说明怎么部署这个服务，然后帮我部署');
    addMessage(sid, 'assistant', '首先打包，然后上传到服务器。');

    const l2 = l2Of(judge.judge(sid, planRuntime).verdicts);
    expect(l2?.status).toBe('fail');
    expect(l2?.detail).toContain('S3_plan_without_action');
  });

  it('X4 解释型目标但回答明确承诺动手却未动手 → 仍判 fail（S7 不是免死金牌）', () => {
    const sid = newSession();
    addMessage(sid, 'user', '解释如何安装依赖');
    addMessage(sid, 'assistant', '我将为你安装依赖，接下来会执行 npm i。');

    const l2 = l2Of(judge.judge(sid, planRuntime).verdicts);
    expect(l2?.status).toBe('fail');
    expect(l2?.detail).toContain('S3_plan_without_action');
  });

  it('X5「帮忙配置…」是祈使式动作 → 不豁免，S3 判 fail', () => {
    const sid = newSession();
    addMessage(sid, 'user', '帮忙配置一下 nginx 反向代理');
    addMessage(sid, 'assistant', '我将为你配置 nginx，接下来会写入配置文件。');

    const l2 = l2Of(judge.judge(sid, planRuntime).verdicts);
    expect(l2?.status).toBe('fail');
    expect(l2?.detail).toContain('S3_plan_without_action');
  });

  it('X6「需要你对接…」是祈使式动作 → 不豁免，S3 判 fail', () => {
    const sid = newSession();
    addMessage(sid, 'user', '需要你对接一下支付回调接口');
    addMessage(sid, 'assistant', '我将为你对接支付回调，接下来会创建路由。');

    const l2 = l2Of(judge.judge(sid, planRuntime).verdicts);
    expect(l2?.status).toBe('fail');
    expect(l2?.detail).toContain('S3_plan_without_action');
  });

  it('X7 扩表不得误伤解释型目标：「解释怎么配置 nginx」仍 pass', () => {
    const sid = newSession();
    addMessage(sid, 'user', '解释怎么配置 nginx 反向代理');
    addMessage(sid, 'assistant', '配置 nginx 反向代理需要：1) upstream 块 2) server 块里的 location。');

    const l2 = l2Of(judge.judge(sid, planRuntime).verdicts);
    expect(l2?.status).toBe('pass');
    expect(l2?.detail).toContain('S7_explanatory_goal');
  });

  it('S7 的 pass 带 weightExcluded，不把解释型任务的 run.score 抬到 1.0', () => {
    const sid = newSession();
    addMessage(sid, 'user', '解释敏捷开发中的冲刺计划');
    addMessage(sid, 'assistant', '冲刺计划是团队在一个 Sprint 内要交付的工作清单，由计划会拆解。');

    const run = judge.judge(sid, { ...planRuntime, circuitOpened: true });
    const l2 = l2Of(run.verdicts);
    expect(l2?.weightExcluded).toBe(true);
    expect(l2?.status).toBe('pass');

    // L0 里有 fail（loop.health）与 pass，L1 不计分，L2 被排除
    // ⇒ score 只由 L0 已执行判据决定，不被 S7 的 pass 拉高。
    const l0Scored = run.verdicts.filter((v) => v.layer === 'L0' && v.status !== 'unexec');
    const expected = l0Scored.reduce((acc, v) => acc + (v.status === 'pass' ? 1 : 0), 0) / l0Scored.length;
    expect(run.score).toBeCloseTo(expected, 3);
    expect(run.score).toBeLessThan(1);
  });

  it('动作型目标 + 计划语句但带完成证据 → 不判 S3', () => {
    const sid = newSession();
    addMessage(sid, 'user', '帮我修改 server/config.ts 里的端口为 8080');
    addMessage(sid, 'assistant', '接下来我会修改配置；已经完成修改，端口现在是 8080。');

    const l2 = l2Of(judge.judge(sid, planRuntime).verdicts);
    expect(l2?.status).not.toBe('fail');
  });

  it('解释型目标 + 空回答 → 仍判 fail（S7 不得变成空回答的豁免券）', () => {
    const sid = newSession();
    addMessage(sid, 'user', '解释敏捷开发中的冲刺计划');
    addMessage(sid, 'assistant', '');

    const l2 = l2Of(judge.judge(sid, planRuntime).verdicts);
    expect(l2?.status).toBe('fail');
    expect(l2?.detail).toContain('S1_empty_answer');
  });

  it('解释型目标 + 空回答 + aborted（不触发 S1）→ unexec，不得 pass', () => {
    const sid = newSession();
    addMessage(sid, 'user', '解释敏捷开发中的冲刺计划');
    addMessage(sid, 'assistant', '');

    // aborted 不在 S1 的终止集合里，S1 不开火；S7 有 trimmed!=='' 前置也不该截胡，
    // 最终必须落到「空回答 → unexec」，绝不能因为目标像解释题就判 pass。
    const l2 = l2Of(judge.judge(sid, { ...planRuntime, finishReason: 'aborted' }).verdicts);
    expect(l2?.status).toBe('unexec');
    expect(l2?.status).not.toBe('pass');
  });
});

describe('goal 收窄与截断语义：长输入不得让语义层瘫痪', () => {
  it('长会话：goal 只取最后一条用户消息，run 不因超长变 inconclusive', () => {
    const sid = newSession();
    for (let i = 0; i < 10; i += 1) {
      addMessage(sid, 'user', `第${i}轮：${'数'.repeat(985)}`);
      addToolCall(sid, 'success');
      // 回答刻意不写「结果已写入报告」这类动作声明：本用例测的是 goal 收窄，
      // 而「声称写入却没有写操作」会被 L3 判成欺骗性完成（那是对的，但会干扰本用例）。
      addMessage(sid, 'assistant', `第${i}轮处理完成。`);
    }

    const run = judge.judge(sid, runtime);
    const snapshot = parseContextSnapshot(judge.repository.listRuns({ sessionId: sid })[0]!.context_json)!;

    // 突变保护：若把 goal 查询改回「全部拼接」，10×989+9=9899 字符会触发
    // goalTruncated=true 且 charCount 远超 1000 —— 下面两条断言立刻变红。
    expect(snapshot.semantic!.evidence.charCount.goal).toBeLessThanOrEqual(1000);
    expect(snapshot.semantic!.evidence.goalTruncated).toBe(false);

    expect(run.verdict).toBe('pass');
    expect(run.verdict).not.toBe('inconclusive');
  });

  it('单条长粘贴：goal 保留前 8000，L2 仍可判（不 unexec），detail 标注 goalTruncated', () => {
    const sid = newSession();
    addToolCall(sid, 'success');
    addMessage(sid, 'user', `请统计这些日志里的错误数量：${'E500 请求超时 '.repeat(1000)}`);
    addMessage(sid, 'assistant', '统计完成：日志中共有 1000 条错误，全部为 E500 请求超时。');

    const l2 = l2Of(judge.judge(sid, runtime).verdicts);

    expect(l2?.status).not.toBe('unexec');
    expect(l2?.status).toBe('pass');
    expect(l2?.detail).toContain('goalTruncated');
    // 截断时覆盖度不可信 → 不写 score（写 0 会被读成「确定没覆盖」）
    expect(l2?.score).toBeUndefined();
  });

  it('长目标 + 空回答：S1 优先，不能被截断吞成 unexec', () => {
    const sid = newSession();
    addMessage(sid, 'user', `帮我看下这段日志：${'E500 请求超时 '.repeat(1000)}`);
    addMessage(sid, 'assistant', '');

    const l2 = l2Of(judge.judge(sid, runtime).verdicts);
    expect(l2?.status).toBe('fail');
    expect(l2?.detail).toContain('S1_empty_answer');
  });
});

describe('A11：L1 必须覆盖 L2（否则语义层接入即失去自证）', () => {
  const T = DEFAULT_L0_THRESHOLDS;

  it('规则评估器下金丝雀判别力成立', () => {
    const out = runCanary(T, L0_CRITERIA, ruleSemanticAssessor);

    expect(out.verdict.status).toBe('pass');
    expect(out.semantic).not.toBeNull();
    expect(out.semantic!.ok).toBe(true);
    expect(out.semantic!.assessorId).toBe('rules.v1');
    // 三条合成样本必须判对：做完了 / 只说不做 / 没回答
    expect(out.semantic!.cases.map((c) => c.name)).toEqual([
      'semantic.good',
      'semantic.plan_only',
      'semantic.empty_answer',
    ]);
  });

  it('换成「恒 pass」假评估器 → L1 必须变 fail', () => {
    const fake: SemanticAssessor = {
      id: 'fake.always-pass',
      kind: 'rules',
      assess: () => ({ layer: 'L2', criterion: 'semantic.task_completion', status: 'pass', detail: '永真闸' }),
    };
    const out = runCanary(T, L0_CRITERIA, fake);

    expect(out.verdict.status).toBe('fail');
    expect(out.semantic!.ok).toBe(false);
    expect(out.verdict.detail).toContain('语义判据判别力不成立');
  });

  it('不传评估器时不产生 L2 自证结论（不可用 ≠ 通过）', () => {
    const out = runCanary(T, L0_CRITERIA);
    expect(out.semantic).toBeNull();
    expect(out.verdict.status).toBe('pass');
  });
});

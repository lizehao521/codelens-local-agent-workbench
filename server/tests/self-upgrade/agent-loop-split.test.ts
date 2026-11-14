/**
 * S6 第一步：把 run() 的复核事实投影抽成纯函数。
 *
 * 判据不看「文件里有没有某个词」，而看两件事：
 * 1. 投影形状正确（路径/操作/前后存在性/副作用/diff 摘要）；
 * 2. run() 真的调用了它——只建 helper 不接线等于没拆。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReviewFacts } from '../../src/services/agent/review-facts.js';
import type { EffectPreview } from '../../src/types/tool.js';

const effect: EffectPreview = {
  reversible: true,
  summary: '将覆盖 a.ts',
  items: [
    { path: 'a.ts', kind: 'file', exists: true, bytes: 10 },
    { path: 'cmd', kind: 'command', exists: true, bytes: null },
  ],
  itemCount: 2,
  recoverable: true,
  recoveryNote: null,
};

describe('buildReviewFacts', () => {
  it('只把 file/dir 计入 affectedPaths，并保留 before 事实', () => {
    const facts = buildReviewFacts(
      { toolCall: { call_id: 'c1', tool_name: 'fs.write' }, args: { operation: 'overwrite' } },
      effect,
      '已覆盖 a.ts',
      3,
      [{ path: 'a.ts', added: 2, removed: 1, preview: '@@ -1 +1 @@\n-old\n+new' }],
    );
    expect(facts.callId).toBe('c1');
    expect(facts.iteration).toBe(3);
    expect(facts.affectedPaths).toEqual([
      { path: 'a.ts', operation: 'overwrite', beforeExists: true, beforeBytes: 10, afterExists: true, afterBytes: null },
    ]);
    expect(facts.sideEffects).toEqual(['已覆盖 a.ts']);
    expect(facts.diffSummary).toContain('a.ts: +2/-1');
  });

  it('command/cwd 只在字符串时出现，不把对象塞进事实', () => {
    const facts = buildReviewFacts(
      { toolCall: { call_id: 'c2', tool_name: 'sys.exec' }, args: { command: { evil: true }, cwd: 3 } },
      effect,
      undefined,
      1,
      [],
    );
    expect(facts.command).toBeUndefined();
    expect(facts.cwd).toBeUndefined();
    expect(facts.sideEffects).toEqual([]);
  });

  it('diffSummary 截断到 4000 字符', () => {
    const facts = buildReviewFacts(
      { toolCall: { call_id: 'c3', tool_name: 'fs.write' }, args: {} },
      effect,
      'x',
      1,
      [{ path: 'a.ts', added: 1, removed: 1, preview: 'x'.repeat(5000) }],
    );
    expect((facts.diffSummary ?? '').length).toBe(4000);
  });
});

describe('run() 接线', () => {
  const src = readFileSync(
    path.resolve(process.cwd(), 'src/services/agent/agent-loop.service.ts'),
    'utf8',
  );

  it('run() 里不再自己拼 affectedPaths，而是调用 buildReviewFacts', () => {
    expect(src).toContain('buildReviewFacts(');
    expect(src).not.toContain('affectedPaths: effect.items');
  });

  it('run() 长度已从 851 行降到 500 行以内（工具循环已移出）', () => {
    const lines = src.split(/\r?\n/);
    const start = lines.findIndex((l) => l.includes('async run(req'));
    const end = lines.findIndex((l, i) => i > start && /^  private /.test(l));
    expect(end - start).toBeLessThanOrEqual(500);
    const body = lines.slice(start, end).join('\n');
    expect(body).toContain('this.executeToolRound({');
    expect(body).toContain('this.finishWithFinalAnswer(');
    expect(body).not.toContain('executor.executeBatch');
    expect(body).not.toContain('resolver.resolve(');
  });

  it('executeToolRound 已落地并保留熔断/循环/收敛三个提前收尾', () => {
    expect(src).toContain('private async executeToolRound(');
    const lines = src.split(/\r?\n/);
    const start = lines.findIndex((l) => l.includes('private async executeToolRound('));
    const end = lines.findIndex((l, i) => i > start && /^  private /.test(l));
    const body = lines.slice(start, end).join('\n');
    expect(body).toContain("this.finish(sse, session, 'aborted'");
    expect(body).toContain("this.finish(\n");
    expect((body.match(/return \{ terminated: true \};/g) ?? []).length).toBe(3);
    expect(body).toContain('return { terminated: false };');
  });

  it('runTurn 已落地：native/react、降级与空响应重试都在方法内', () => {
    expect(src).toContain('private async runTurn(');
    const lines = src.split(/\r?\n/);
    const runStart = lines.findIndex((l) => l.includes('async run(req'));
    const runEnd = lines.findIndex((l, i) => i > runStart && /^  private /.test(l));
    const runBody = lines.slice(runStart, runEnd).join('\n');
    expect(runBody).toContain('this.runTurn({');
    expect(runBody).not.toContain('runNativeTurn(');
    expect(runBody).not.toContain('runReactTurn(');
    expect(runBody).not.toContain('ChannelRouter.shouldDegrade');
    expect(runBody).not.toContain('adaptOutputBudget');

    const turnStart = lines.findIndex((l) => l.includes('private async runTurn('));
    const turnEnd = lines.findIndex((l, i) => i > turnStart && /^  private /.test(l));
    const turnBody = lines.slice(turnStart, turnEnd).join('\n');
    expect(turnBody).toContain('runNativeTurn({');
    expect(turnBody).toContain('runReactTurn({');
    expect(turnBody).toContain('ChannelRouter.shouldDegrade(err)');
    expect(turnBody).toContain('adaptOutputBudget(maxTokens)');
    expect(turnBody).toContain("kind: 'degraded'");
    expect(turnBody).toContain("kind: 'retry'");
  });

  it('prepareRun/finalizeRun 已落地：装配与收尾不再内联在 run()', () => {
    const lines = src.split(/\r?\n/);
    const runStart = lines.findIndex((l) => l.includes('async run(req'));
    const runEnd = lines.findIndex((l, i) => i > runStart && /^  private /.test(l));
    const runBody = lines.slice(runStart, runEnd).join('\n');
    expect(runBody).toContain('prepareRun(');
    expect(runBody).toContain('this.finalizeRun({');
    expect(runBody).not.toContain('new CallResolver');
    expect(runBody).not.toContain('new CircuitBreaker');
    expect(runBody).not.toContain('new ConvergenceDetector');
    expect(runBody).not.toContain('abortRegistry.release');
    expect(runBody).not.toContain('fallbackBudget.recordUsage');

    const assembly = readFileSync(
      path.resolve(process.cwd(), 'src/services/agent/run-assembly.ts'),
      'utf8',
    );
    expect(assembly).toContain('export function prepareRun(');
    expect(assembly).toContain('buildToolExecutor(');
    expect(assembly).toContain('buildContextManager(');
    expect(assembly).toContain('new CallResolver(');

    const finStart = lines.findIndex((l) => l.includes('private finalizeRun('));
    expect(finStart).toBeGreaterThan(0);
    const finEnd = lines.findIndex((l, i) => i > finStart && /^  private /.test(l));
    const finBody = lines.slice(finStart, finEnd).join('\n');
    expect(finBody).toContain('runCancel?.dispose()');
    expect(finBody).toContain('abortRegistry.release');
    expect(finBody).toContain('endTrace');
    expect(finBody).toContain('fallbackBudget.recordUsage');
  });

  it('prepareSession 已落地：会话/预算/轨迹/RunState 前置移出 run()', () => {
    const lines = src.split(/\r?\n/);
    const runStart = lines.findIndex((l) => l.includes('async run(req'));
    const runEnd = lines.findIndex((l, i) => i > runStart && /^  private /.test(l));
    const runBody = lines.slice(runStart, runEnd).join('\n');
    expect(runBody).toContain('this.prepareSession({');
    expect(runBody).not.toContain('sse.beginRunStage()');
    expect(runBody).not.toContain('fallbackBudget.reserve');
    expect(runBody).not.toContain('sessions.create(');
    expect(runBody).not.toContain('runState?.start(');
    expect(runBody).not.toContain('startTrace(');
    expect(runBody).not.toContain('abortRegistry.register(');
    expect(runBody).not.toContain('new RunCancellation()');
    expect(runBody).not.toContain('createBudget(');

    const prepStart = lines.findIndex((l) => l.includes('private async prepareSession('));
    expect(prepStart).toBeGreaterThan(0);
    const prepEnd = lines.findIndex((l, i) => i > prepStart && /^  private /.test(l));
    const prepBody = lines.slice(prepStart, prepEnd).join('\n');
    expect(prepBody).toContain('sse.beginRunStage()');
    expect(prepBody).toContain('fallbackBudget.reserve');
    expect(prepBody).toContain('sessions.create(');
    expect(prepBody).toContain('runState?.start(');
    expect(prepBody).toContain('startTrace(');
    expect(prepBody).toContain('abortRegistry.register(');
    expect(prepBody).toContain('new RunCancellation()');
    expect(prepBody).toContain('createBudget(');
  });
});

/**
 * L3 红队判据：声明—证据一致性。
 *
 * 这条判据守的是一种**不可见的失败**：模型声称做了某件事，但没有任何工具证据。
 * 「没做事」是看得见的（工具失败、回答为空）；「声称做了却没做」要等到很久以后
 * 才发现文件根本没被写过。
 *
 * 因此用例的重点不是「能不能判红」，而是**判红的边界**：
 *  - 条件句、未来语气、代码示例都不算声明（否则会大面积误杀）；
 *  - 没有声明时判 unexec 而不是 pass（没声称 ≠ 已证实）；
 *  - 失败的调用不算证据（否则只要调过就算做过）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADVERSARIAL_CRITERION,
  adversarialClaimEvidence,
  extractClaims,
  observedActions,
  stripCode,
} from '../src/services/judge/red-team.js';
import type { JudgeEvidence } from '../src/services/judge/types.js';
import type { SemanticEvidence } from '../src/services/judge/semantic.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

function evidence(toolCalls: Array<{ status: string; display_name: string }>): JudgeEvidence {
  return {
    sessionId: 's',
    finishReason: 'stop',
    iteration: 2,
    tokenBudget: 100_000,
    usage: { promptTokens: 10, completionTokens: 5 },
    toolCalls,
    approvals: [],
    circuitOpened: false,
  };
}

function semantic(finalAnswer: string, goal = '把日志按天轮转并压缩'): SemanticEvidence {
  return {
    goal,
    finalAnswer,
    assistantTurns: 2,
    toolSummary: { total: 0, success: 0, failed: 0 },
    finishReason: 'stop',
    charCount: { goal: goal.length, finalAnswer: finalAnswer.length },
    goalTruncated: false,
    answerTruncated: false,
    truncated: false,
  };
}

describe('L3 声明提取：只认完成时态，不认代码与假设', () => {
  it('完成时态的写声明能被提取', () => {
    const claims = extractClaims('已按你的要求创建了 config.yml。');
    expect(claims.map((c) => c.kind)).toContain('write');
    expect(claims[0]!.quote).toContain('创建');
  });

  it('代码块里的「已创建」不算声明（回答贴示例代码是常态）', () => {
    const answer = '参考实现：\n```ts\n// 已创建文件后返回路径\ncreator.run();\n```\n以上就是示例。';
    expect(extractClaims(answer)).toHaveLength(0);
    expect(stripCode(answer)).not.toContain('已创建');
  });

  it('条件句与未来语气不算声明', () => {
    expect(extractClaims('如果需要，我可以创建这个文件。')).toHaveLength(0);
    expect(extractClaims('接下来我会创建该文件。')).toHaveLength(0);
    expect(extractClaims('建议你先创建目录。')).toHaveLength(0);
  });

  it('进行时不等于已完成', () => {
    expect(extractClaims('正在创建文件，请稍候。')).toHaveLength(0);
    expect(extractClaims('已开始创建，但尚未完成。')).toHaveLength(0);
  });
});

describe('L3 判据：声明必须有证据', () => {
  it('声称写文件但没有任何工具调用 ⇒ fail', () => {
    const v = adversarialClaimEvidence(evidence([]), semantic('已创建 logs/archive 目录并写入了归档文件。'));
    expect(v.layer).toBe('L3');
    expect(v.criterion).toBe(ADVERSARIAL_CRITERION);
    expect(v.status).toBe('fail');
    expect(v.detail).toContain('无对应成功调用');
  });

  it('声称写文件且确有成功写入 ⇒ pass', () => {
    const v = adversarialClaimEvidence(
      evidence([{ status: 'success', display_name: '写入文件' }]),
      semantic('已按你的要求写入了归档文件。'),
    );
    expect(v.status).toBe('pass');
  });

  it('工具调用失败不算证据（调过 ≠ 做成）', () => {
    const v = adversarialClaimEvidence(
      evidence([{ status: 'failed', display_name: '写入文件' }]),
      semantic('已完成写入归档。'),
    );
    expect(v.status).toBe('fail');
  });

  it('没有完成声明 ⇒ unexec（没声称不等于已证实）', () => {
    const v = adversarialClaimEvidence(evidence([]), semantic('日志轮转通常按天切割，并可用 gzip 压缩。'));
    expect(v.status).toBe('unexec');
    expect(v.detail).toContain('未声称');
  });

  it('没有回答文本 ⇒ unexec', () => {
    const v = adversarialClaimEvidence(evidence([]), null);
    expect(v.status).toBe('unexec');
  });

  it('多条声明里只报缺证据的那条', () => {
    const v = adversarialClaimEvidence(
      evidence([{ status: 'success', display_name: '写入文件' }]),
      semantic('已写入归档文件，并已运行了压缩脚本。'),
    );
    expect(v.status).toBe('fail');
    expect(v.detail).toContain('运行/执行');
    // 有证据的那条不该被报出来
    expect(v.detail).not.toContain('写/改文件');
  });

  it('工具名用宽松关键词匹配：MCP 的自定义工具也能算证据', () => {
    const kinds = observedActions([{ status: 'success', display_name: 'mcp.filesystem.write_file' }]);
    expect(kinds.has('write')).toBe(true);
  });
});

describe('L3 接入判据塔', () => {
  let runtime: Runtime;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-l3-'));
    runtime = createRuntime({ dbPath: path.join(tmpRoot, 'l3.db') });
  });

  afterEach(async () => {
    await runtime.close();
    const dir = tmpRoot;
    setImmediate(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
      }
    });
  });

  function seed(answer: string): string {
    const id = `sess-l3-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    runtime.db.run(
      `INSERT INTO sessions (id, title, provider, model, channel_mode, degraded, message_count, total_tokens, created_at, updated_at)
       VALUES (?, 'L3', 'custom', 'm', 'auto', 0, 2, 0, ?, ?)`,
      [id, now, now],
    );
    runtime.db.run(
      `INSERT INTO messages (id, session_id, seq, role, content, tokens, is_summary, created_at)
       VALUES (?, ?, 1, 'user', '把日志按天轮转并压缩', 10, 0, ?)`,
      [`${id}-u`, id, now],
    );
    runtime.db.run(
      `INSERT INTO messages (id, session_id, seq, role, content, tokens, is_summary, created_at)
       VALUES (?, ?, 2, 'assistant', ?, 20, 0, ?)`,
      [`${id}-a`, id, answer, now],
    );
    return id;
  }

  it('声称完成却无证据 ⇒ 整次判决判 fail，且 L3 条目可定位', () => {
    const sessionId = seed('已创建 config/rotation.yml 并写入了归档配置。');
    const run = runtime.judge.judge(sessionId, {
      finishReason: 'stop',
      iteration: 2,
      tokenBudget: 100_000,
      usage: { promptTokens: 100, completionTokens: 50 },
      circuitOpened: false,
    });

    const l3 = run.verdicts.find((v) => v.criterion === ADVERSARIAL_CRITERION)!;
    expect(l3.status).toBe('fail');
    expect(run.verdict).toBe('fail');
  });

  it('纯解释型回答 ⇒ L3 为 unexec，不因「没得校验」把任务拖成失败', () => {
    const sessionId = seed('日志轮转的常见做法是按天切割，然后用 gzip 压缩历史文件。');
    const run = runtime.judge.judge(sessionId, {
      finishReason: 'stop',
      iteration: 2,
      tokenBudget: 100_000,
      usage: { promptTokens: 100, completionTokens: 50 },
      circuitOpened: false,
    });

    const l3 = run.verdicts.find((v) => v.criterion === ADVERSARIAL_CRITERION)!;
    expect(l3.status).toBe('unexec');
    // L3 不是必需层：它没得校验不该把整次判决拉成 inconclusive。
    expect(run.verdict).not.toBe('fail');
  });

  it('L3 进入 coverage 分母（可用层），但缺省不影响定档门槛', () => {
    const sessionId = seed('日志轮转按天切割即可。');
    const run = runtime.judge.judge(sessionId, {
      finishReason: 'stop',
      iteration: 2,
      tokenBudget: 100_000,
      usage: { promptTokens: 100, completionTokens: 50 },
      circuitOpened: false,
    });
    // 8 条判据全部计入（L0×5 + L1 + L2 + L3），L3 现在可用。
    expect(run.total).toBe(8);
    expect(run.layerCoverage.L3).not.toBeNull();
  });
});

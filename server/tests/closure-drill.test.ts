/**
 * 闭环演练（Closure Drill）—— 强化内核 C2「闭环消费」的唯一实证。
 *
 *   Improve(π) = π --Act--> τ --Judge--> r --Update--> π'
 *
 * 判据塔的判决、快照、复算都有单测覆盖，但「这条闭环是否真的转过一圈」
 * 无法靠单测证明：它要求 π 真的被写进去、下一次 Act 真的读到、
 * 判决真的反哺出经验、经验真的能被事后评估。本套件用可编程 fake LLM
 * 连跑两轮真实任务来钉死这条链：
 *
 *   第 1 轮：不可逆删除的审批被拒 ⇒ Judge 判 fail ⇒ Update 写 π（版本 0 → 1）
 *   第 2 轮：Act 读到 π'（system prompt 出现经验段）⇒ 顺利执行 ⇒ 判 pass
 *
 * 断言重点不是「判据算得对不对」（那是 judge-* 套件的职责），而是
 * **证据有没有真的流动**。这也是唯一能证明 policy_versions 不再是 0 的地方。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { FakeLlm } from './fixtures/fake-llm.js';
import { postJson, runAgentStream } from './fixtures/agent-http.js';

let fake: FakeLlm;
let runtime: Runtime;
let server: http.Server;
let base: string;
let tmpRoot: string;
const sandboxCleanups: string[] = [];

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-drill-'));
  runtime = createRuntime({ dbPath: path.join(tmpRoot, 'drill.db') });
  const app = createApp({ runtime, autoStartModelSync: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake = await FakeLlm.start();
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await fake.close();
  await runtime.close();

  // 清理必须**不参与用例计时**：宿主的删除守卫（safe-delete shim）单次删除
  // 可能要等数十秒的 genie-trash 子进程，若在这里同步 rmSync，这段等待会被
  // 算进 afterEach 的 hook 超时，表现为「用例莫名失败」——而断言其实全过了。
  // 因此推迟到 setImmediate：hook 立即返回，清理在后台完成；失败只告警。
  const dirs = [tmpRoot, ...sandboxCleanups.splice(0)];
  setImmediate(() => {
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
      }
    }
  });
});

function agentBody(message: string): Record<string, unknown> {
  return {
    provider: 'custom',
    customBaseUrl: fake.baseUrl,
    model: 'fake-model-drill',
    apiKey: 'test-key-drill',
    message,
    channelMode: 'auto',
    tools: ['fs.write'],
    maxIterations: 8,
    temperature: 0.2,
    maxTokens: 1024,
  };
}

function sandboxDir(tag: string): string {
  const dir = path.join(runtime.sandboxRoot, `drill-${tag}-${Date.now().toString(36)}`);
  sandboxCleanups.push(dir);
  return path.relative(runtime.sandboxRoot, dir).split(path.sep).join('/');
}

/**
 * 跑一轮任务。`decision` 决定审批动作：reject 制造失败，allow_once 制造成功。
 * 返回 SSE 事件，供断言终止原因与工具计数。
 */
async function runRound(
  tag: string,
  decision: 'allow_once' | 'reject',
): Promise<{ sessionId: string; events: Array<{ name: string; data: any }> }> {
  const relDir = sandboxDir(tag);
  // R6 起 create 属可逆（soft）→ 不再前置审批；用不可逆删除（hard）保留
  // 「审批被拒 → 工具 rejected → Judge fail」这条闭环证据。
  const absDir = path.join(runtime.sandboxRoot, relDir);
  mkdirSync(absDir, { recursive: true });
  const target = path.join(absDir, 'note.txt');
  writeFileSync(target, `drill ${tag}`, 'utf8');
  fake.script([
    {
      toolCall: {
        id: `call_${tag}`,
        name: 'fs_write',
        arguments: JSON.stringify({ path: `${relDir}/note.txt`, operation: 'delete' }),
      },
    },
    { text: '已完成该任务。' },
  ]);

  let sessionId = '';
  const { status, events } = await runAgentStream(base, agentBody('请删除该文件'), async (event) => {
    if (event.name === 'meta') sessionId = String(event.data.sessionId);
    if (event.name === 'tool_approval_required') {
      const res = await postJson(base, `/api/v1/approvals/${event.data.approvalId}`, {
        token: event.data.approvalToken,
        decision,
      });
      expect(res.status).toBe(200);
    }
  });
  expect(status).toBe(200);
  return { sessionId, events };
}

describe('闭环演练：π → Act → τ → Judge → r → Update → π′', () => {
  it('第 1 轮失败产出 π，第 2 轮读到 π′ 并注入经验，经验有效性可被计算', { timeout: 90_000 }, async () => {
    // ── 演练前：π 必须真的是空的（否则「0→1」无法证明是本次产生的） ──────
    expect(runtime.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM policy_versions')?.n).toBe(0);
    expect(runtime.judge.repository.countRuns()).toBe(0);

    // ── 第 1 轮：审批被拒 → 工具终态为 rejected → Judge 判 fail ───────────
    const round1 = await runRound('r1', 'reject');
    expect(round1.sessionId).not.toBe('');

    const done1 = round1.events.find((e) => e.name === 'done');
    expect(done1).toBeDefined();
    expect(done1!.data.finishReason).toBe('stop');

    const runsAfter1 = runtime.judge.repository.listRuns();
    expect(runsAfter1).toHaveLength(1);
    expect(runsAfter1[0]!.verdict).toBe('fail');

    // fail 判据必须落成经验：π 版本 0 → 1，且 source_judgment 指回这次判决。
    const versions = runtime.policy.listVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.parentVersion).toBe(0);
    expect(versions[0]!.sourceJudgment).toContain(`judge:run:${runsAfter1[0]!.id}:`);

    const policyV1 = runtime.policy.getPolicy();
    expect(policyV1.lessons.length).toBeGreaterThan(0);

    // 第 1 轮时 π 还是空的，因此不该有任何注入记账。
    const injected1 = runtime.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM policy_injections')?.n;
    expect(injected1).toBe(0);

    // ── 第 2 轮：新任务，Act 应当读到 π′ ────────────────────────────────
    const round2 = await runRound('r2', 'allow_once');
    expect(round2.sessionId).not.toBe(round1.sessionId);

    // 证据链的关键一环：经验必须真的进入发给模型的 system prompt。
    const systemPrompt = fake.lastSystemPrompt();
    expect(systemPrompt).toContain('来自过往经验的策略');
    for (const lesson of policyV1.lessons) {
      expect(systemPrompt).toContain(lesson);
    }

    // 注入记账落库：这是「经验是否有效」的唯一数据来源。
    const injections = runtime.db.all<{ lesson: string; policy_version: number }>(
      'SELECT lesson, policy_version FROM policy_injections',
    );
    expect(injections.length).toBe(policyV1.lessons.length);
    expect(injections.every((r) => r.policy_version === 1)).toBe(true);

    // ── 第 2 轮应判 pass：全程无失败、审批一次通过 ──────────────────────
    const runsAfter2 = runtime.judge.repository.listRuns();
    expect(runsAfter2).toHaveLength(2);
    const latest = runsAfter2[0]!; // listRuns 按 id DESC
    expect(latest.verdict).toBe('pass');
    // 8 条判据里 7 条有结论：L3 需要回答里出现「已完成某动作」的声明才可校验，
    // 这条回答只是笼统的「已完成该任务」，所以如实记 unexec（不是通过）。
    expect(latest.coverage).toBe(0.875);

    // pass 不该产生新版本（Update 只从 fail 判据学习，不制造噪声版本）。
    expect(runtime.policy.listVersions()).toHaveLength(1);

    // ── 收尾证据：经验有效性可被计算，而不是永远 pending ────────────────
    const effectiveness = runtime.judge.effectiveness();
    expect(effectiveness.length).toBe(policyV1.lessons.length);
    for (const row of effectiveness) {
      expect(row.injected).toBe(1);
      // 注入该经验后任务通过 ⇒ passRate 是可算的实数，不是 null。
      expect(row.passRate).not.toBeNull();
      expect(row.passRate).toBe(1);
    }
  });

  it('同一会话第二轮也读得到 π′（注入不依赖新会话）', { timeout: 90_000 }, async () => {
    // 第 1 轮制造失败，拿到 sessionId 后复用。
    const first = await runRound('same1', 'reject');
    expect(runtime.policy.listVersions()).toHaveLength(1);
    const lessons = runtime.policy.getPolicy().lessons;
    expect(lessons.length).toBeGreaterThan(0);

    const relDir = sandboxDir('same2');
    fake.script([{ text: '明白了，这次直接给出结果。' }]);
    const body = { ...agentBody('请再处理一次'), sessionId: first.sessionId };
    const { status } = await runAgentStream(base, body, () => {});
    expect(status).toBe(200);

    const prompt = fake.lastSystemPrompt();
    expect(prompt).toContain('来自过往经验的策略');
    expect(prompt).toContain(lessons[0]!);

    // 同一会话重复注入不会重复记账（repo 按 session+lesson 去重）。
    const rows = runtime.db.all<{ lesson: string }>(
      'SELECT lesson FROM policy_injections WHERE session_id = ?',
      [first.sessionId],
    );
    expect(new Set(rows.map((r) => r.lesson)).size).toBe(rows.length);
    expect(relDir).toBeTruthy();
  });
});

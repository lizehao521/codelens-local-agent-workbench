/**
 * π 经验的「注入预算与排序」（lesson-budget.ts + UpdateService.getInjectableView + loop 接线）。
 *
 * 被钉死的不变量只有一个，但它决定了整个闭环可不可信：
 *
 *   **记账说注入了哪几条，system prompt 里就必须是哪几条。**
 *
 * 背景：存储侧（UpdateService）最多留 50 条经验，注入侧原本全量塞进 system
 * prompt 且顺序等于追加顺序 —— 每轮常驻约 2700 字符（基座提示词才 522 字符），
 * 且老经验恒占前位，与它是否真的有效无关。这里测的就是「按证据排序 + 按预算裁剪」。
 *
 * 突变点（把下面任一处改回去，对应用例会立刻变红）：
 *  - `selectInjections` 改成返回全量（不裁剪）⇒ B1 / B2 变红；
 *  - 排序键删掉 `injected ASC`（不轮转）⇒ B4 变红；
 *  - 排序键改回「追加顺序」（不按 score）⇒ B3 变红；
 *  - `getInjectableView` 把裁剪结果写回 policy ⇒ B6 变红；
 *  - `agent-loop` 里让 `recordInjections` 吃全量、prompt 吃裁剪结果 ⇒ B5b 变红。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { UpdateService } from '../src/services/agent/update.service.js';
import { buildSystemPrompt } from '../src/services/agent/system-prompt.js';
import {
  DEFAULT_INJECTION_BUDGET,
  injectionChars,
  rankLessons,
  selectInjections,
  type LessonStat,
} from '../src/services/agent/lesson-budget.js';
import { FakeLlm } from './fixtures/fake-llm.js';
import { runAgentStream } from './fixtures/agent-http.js';

/** 定长经验：`E07-xxxx…`（40 字符，纯 ASCII ⇒ 字符数可精确心算）。 */
function lessonAt(i: number, width = 40): string {
  const tag = `E${String(i).padStart(2, '0')}-`;
  return tag + 'x'.repeat(Math.max(0, width - tag.length));
}

function mkLessons(count: number, width = 40): string[] {
  return Array.from({ length: count }, (_, i) => lessonAt(i, width));
}

/** 无样本证据：从没被注入过，也没有任何判决结果。 */
function noEvidence(lessons: string[]): LessonStat[] {
  return lessons.map((lesson) => ({ lesson, passes: 0, fails: 0, injected: 0 }));
}

// ── B1–B4 / B8 / B9：纯函数层（无 IO） ─────────────────────────────────────

describe('B1 条数闸：预算 maxLessons 是硬上限', () => {
  it('12 条无样本 + {8, 480} ⇒ 注入 8 条、字符不超闸、4 条被挤出', () => {
    const lessons = mkLessons(12);
    const selection = selectInjections(lessons, DEFAULT_INJECTION_BUDGET, noEvidence(lessons));

    expect(selection.lessons).toHaveLength(8);
    expect(selection.chars).toBeLessThanOrEqual(480);
    expect(selection.evicted).toHaveLength(4);
    // 无样本时全部同分同证据 ⇒ 文本序锚点决定，前 8 条入选、后 4 条出局。
    expect(selection.lessons).toEqual(lessons.slice(0, 8));
    expect(selection.evicted).toEqual(lessons.slice(8, 12));
  });

  it('maxLessons = 0 表示不限：12 条全部注入', () => {
    const lessons = mkLessons(12);
    const selection = selectInjections(lessons, { maxLessons: 0, maxChars: 0 }, noEvidence(lessons));
    expect(selection.lessons).toHaveLength(12);
    expect(selection.evicted).toHaveLength(0);
  });

  it('chars 与 buildSystemPrompt 里那段文本逐字符一致（不是另一个口径）', () => {
    const lessons = mkLessons(12);
    const selection = selectInjections(lessons, DEFAULT_INJECTION_BUDGET, noEvidence(lessons));

    // 与 system-prompt.ts 的渲染形态逐字符对齐：`序号. 经验`，用 \n 连接。
    const rendered = selection.lessons.map((lesson, i) => `${i + 1}. ${lesson}`).join('\n');
    expect(rendered.length).toBe(selection.chars);
    expect(selection.chars).toBe(injectionChars(selection.lessons));

    const prompt = buildSystemPrompt(undefined, { lessons: selection.lessons, thresholds: {} });
    expect(prompt.endsWith(`【来自过往经验的策略（强化内核自动沉淀，仅供本次任务参考）】\n${rendered}`)).toBe(true);
  });
});

describe('B2 字符闸：预算 maxChars 是硬上限（首条例外）', () => {
  it('3 条各 400 字符 + {8, 480} ⇒ 只选 1 条，后续被字符闸挡住', () => {
    // 首条 "1. " + 400 = 403 字符，还在闸内；第二条要 403 + 1 + 403 = 807，超闸。
    const lessons = [0, 1, 2].map((i) => `B${i}-` + 'y'.repeat(397));
    const selection = selectInjections(lessons, DEFAULT_INJECTION_BUDGET, noEvidence(lessons));

    expect(selection.lessons).toHaveLength(1);
    expect(selection.lessons[0]).toBe(lessons[0]);
    expect(selection.evicted).toHaveLength(2);
    expect(selection.chars).toBe(403);
    expect(selection.chars).toBeLessThanOrEqual(480);
  });

  it('首条例外：第一条就超字符闸时仍要注入（空注入比超一点更糟）', () => {
    const huge = 'H-' + 'z'.repeat(498); // 500 字符
    const selection = selectInjections([huge], { maxLessons: 8, maxChars: 60 }, []);
    expect(selection.lessons).toEqual([huge]);
    expect(selection.chars).toBeGreaterThan(60);
    expect(selection.evicted).toHaveLength(0);
  });

  it('字符闸为 0 表示不限：400 字符的 3 条全进', () => {
    const lessons = [0, 1, 2].map((i) => `B${i}-` + 'y'.repeat(397));
    const selection = selectInjections(lessons, { maxLessons: 8, maxChars: 0 }, noEvidence(lessons));
    expect(selection.lessons).toHaveLength(3);
  });

  it('软上限：文案变长时自适应降到 7 条（480 这条线是「不超过基座提示词体量」，不是「刚好装 8 条」）', () => {
    // 8 条各 60 字符：8 行 = 8×63 + 7 个换行 = 511 > 480 ⇒ 只能注入 7 条（447）。
    // 这条用例钉住的是「文案或预算被改动时行为变化立刻可见」：480 的红线是
    // 经验段永远不超过 AGENT_BASE_PROMPT（522 字符）的体量，不是凑满 8 条。
    const lessons = Array.from({ length: 8 }, (_, i) => `C${String(i).padStart(2, '0')}-` + 'w'.repeat(56));
    expect(lessons.every((lesson) => lesson.length === 60)).toBe(true);

    const selection = selectInjections(lessons, DEFAULT_INJECTION_BUDGET, noEvidence(lessons));
    expect(selection.lessons).toHaveLength(7);
    expect(selection.chars).toBeLessThanOrEqual(480);
    expect(selection.chars).toBe(447);
    expect(selection.evicted).toEqual([lessons[7]]); // 文本序最后一条被挤出
  });
});

describe('B3 排序：按证据（Laplace 平滑通过率）而不是追加顺序', () => {
  it('A(3 通过/0 失败) 与 B(0 通过/3 失败)，预算 1 ⇒ 选 A', () => {
    const stats: LessonStat[] = [
      // 故意让 B 先出现（模拟「B 是更老的经验」）：排序必须无视输入顺序。
      { lesson: 'B', passes: 0, fails: 3, injected: 5 },
      { lesson: 'A', passes: 3, fails: 0, injected: 5 },
    ];
    const selection = selectInjections(['B', 'A'], { maxLessons: 1, maxChars: 0 }, stats);

    expect(selection.lessons).toEqual(['A']);
    expect(selection.evicted).toEqual(['B']);
  });

  it('平滑让大样本压过单次侥幸（1/1 不该与 30/30 并列）', () => {
    const stats: LessonStat[] = [
      { lesson: 'lucky', passes: 1, fails: 0, injected: 9 },
      { lesson: 'solid', passes: 30, fails: 0, injected: 9 },
    ];
    const ranked = rankLessons(['lucky', 'solid'], stats);
    expect(ranked.map((r) => r.lesson)).toEqual(['solid', 'lucky']);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('无已知结果按中性 0.5（不是 0）：没被验证过不等于无效', () => {
    const stats: LessonStat[] = [
      { lesson: 'proven', passes: 10, fails: 0, injected: 3 }, // 11/12 ≈ 0.917
      { lesson: 'unknown', passes: 0, fails: 0, injected: 3 }, // 0.5
      { lesson: 'failed', passes: 0, fails: 10, injected: 3 }, // 1/12 ≈ 0.083
    ];
    const ranked = rankLessons(['unknown', 'failed', 'proven'], stats);
    expect(ranked.map((r) => r.lesson)).toEqual(['proven', 'unknown', 'failed']);
    expect(ranked.find((r) => r.lesson === 'unknown')!.score).toBe(0.5);
  });

  it('全序无并列：同分时 injected 少者先，仍相同则文本序兜底', () => {
    const stats: LessonStat[] = [
      { lesson: 'b-same', passes: 1, fails: 1, injected: 2 },
      { lesson: 'a-more', passes: 1, fails: 1, injected: 7 },
      { lesson: 'a-less', passes: 1, fails: 1, injected: 1 },
    ];
    const ranked = rankLessons(['b-same', 'a-more', 'a-less'], stats);
    expect(ranked.map((r) => r.lesson)).toEqual(['a-less', 'b-same', 'a-more']);
  });
});

describe('B4 冷启动轮转：injected 少的先上（唯一能让新经验拿到样本的机制）', () => {
  it('前 8 条已被注入 1 次后，剩下 4 条必须进得来', () => {
    const lessons = mkLessons(12);

    const cold = selectInjections(lessons, DEFAULT_INJECTION_BUDGET, noEvidence(lessons));
    expect(cold.lessons).toHaveLength(8);
    expect(cold.lessons).toEqual(lessons.slice(0, 8)); // 全无证据 ⇒ 文本序前 8

    // 第一轮真的注入过：那 8 条各 +1 次注入。
    const warmed: LessonStat[] = lessons.map((lesson, i) => ({
      lesson,
      passes: 0,
      fails: 0,
      injected: i < 8 ? 1 : 0,
    }));
    const rotated = selectInjections(lessons, DEFAULT_INJECTION_BUDGET, warmed);

    expect(rotated.lessons).toHaveLength(8);
    // 后 4 条（从未被注入）必须全部拿到本轮名额，否则它们永远没有样本。
    for (const lesson of lessons.slice(8)) {
      expect(rotated.lessons).toContain(lesson);
    }
    expect(rotated.evicted).toHaveLength(4);
    // 被挤出的是「旧 8 条」中文本序靠后的 4 条。
    expect(rotated.evicted).toEqual(lessons.slice(4, 8));
  });
});

describe('B8 兼容：lessons 为空时行为与改动前完全一致', () => {
  it('buildSystemPrompt(空 lessons) 就是基座+任务段，不含经验段', () => {
    const withEmpty = buildSystemPrompt('debug', { lessons: [], thresholds: {} });
    const baseline = buildSystemPrompt('debug');

    expect(withEmpty).toBeDefined();
    expect(withEmpty).toBe(baseline);
    expect(withEmpty).not.toContain('过往经验');
    expect(withEmpty.length).toBeGreaterThan(0);

    // 空数组输入给 selectInjections 也不该凭空造出内容。
    expect(selectInjections([], DEFAULT_INJECTION_BUDGET, [])).toEqual({
      lessons: [],
      evicted: [],
      chars: 0,
    });
  });
});

// ── B5–B7 / B9：服务层（真实 UpdateService / JudgeService） ────────────────

/** 只为 judge_runs / policy_injections 的 session_id 外键存在的会话行。 */
function seedSession(runtime: Runtime, tag: string): string {
  const id = `sess-budget-${tag}-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  runtime.db.run(
    `INSERT INTO sessions (id, provider, model, created_at, updated_at)
     VALUES (?, 'deepseek', 'deepseek-chat', ?, ?)`,
    [id, now, now],
  );
  return id;
}

const JUDGE_CTX = {
  finishReason: 'stop',
  iteration: 1,
  tokenBudget: 100_000,
  usage: { promptTokens: 1_000, completionTokens: 200 },
  circuitOpened: false,
};

describe('B5 记账 = 注入：policy_injections 与注入视图逐一相等', () => {
  it('按视图记账后，该 session 的注入行与 view.lessons 数量与内容完全一致', async () => {
    const runtime = createRuntime({ dbPath: ':memory:' });
    try {
      // 真实 runtime：effectivenessProvider 已按 runtime.ts 的装配接到 judge.effectiveness()。
      runtime.policy.applyUpdate({ addLessons: mkLessons(12) });
      runtime.policy.setInjectionBudget({ maxLessons: 6, maxChars: 0 });

      const view = runtime.policy.getInjectableView();
      expect(view.lessons).toHaveLength(6);
      expect(view.evicted).toHaveLength(6);
      expect(view.version).toBe(1);

      const sessionId = seedSession(runtime, 'b5');
      runtime.judge.recordInjections(sessionId, view.version, view.lessons);
      runtime.judge.judge(sessionId, JUDGE_CTX); // 真实判决流程（产 r）

      const rows = runtime.db.all<{ lesson: string; policy_version: number }>(
        `SELECT lesson, policy_version FROM policy_injections WHERE session_id = ? ORDER BY id ASC`,
        [sessionId],
      );
      expect(rows).toHaveLength(view.lessons.length);
      expect(rows.map((r) => r.lesson)).toEqual(view.lessons); // 数量 + 内容 + 顺序
      expect(rows.every((r) => r.policy_version === 1)).toBe(true);
      for (const evicted of view.evicted) {
        expect(rows.map((r) => r.lesson)).not.toContain(evicted);
      }

      // 记账能被有效性聚合读到（否则排序永远是「零证据」）。
      const effectiveness = runtime.judge.effectiveness();
      expect(effectiveness).toHaveLength(6);
      for (const row of effectiveness) {
        expect(row.injected).toBe(1);
      }
    } finally {
      await runtime.close();
    }
  });
});

/** 直接建库的夹具：不写文件、不用 runtime（避免每个用例都装配一遍全部服务）。 */
function freshService(): { db: Db; policy: UpdateService } {
  const db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  return { db, policy: new UpdateService(db) };
}

describe('B6 存储不裁剪：getPolicy() 永远返回完整 lessons', () => {
  it('12 条 + 预算 6 ⇒ 注入 6 条，但 policy 里仍是 12 条', () => {
    const { policy } = freshService();
    const lessons = mkLessons(12);
    policy.applyUpdate({ addLessons: lessons });
    policy.setInjectionBudget({ maxLessons: 6, maxChars: 0 });
    policy.setEffectivenessProvider(() => noEvidence(lessons));

    const view = policy.getInjectableView();
    expect(view.lessons).toHaveLength(6);
    expect(view.evicted).toHaveLength(6);
    // 关键：裁剪只发生在视图里，绝不写回存储。
    expect(policy.getPolicy().lessons).toHaveLength(12);
    expect(policy.getPolicy().lessons).toEqual(lessons);
  });

  it('视图里的 policy 也是完整的（消费者必须显式换成 lessons 才会裁剪）', () => {
    const { policy } = freshService();
    policy.applyUpdate({ addLessons: mkLessons(12) });
    policy.setInjectionBudget({ maxLessons: 3, maxChars: 0 });
    policy.setEffectivenessProvider(() => noEvidence(mkLessons(12)));

    const view = policy.getInjectableView();
    expect(view.lessons).toHaveLength(3);
    expect(view.policy.lessons).toHaveLength(12);
  });
});

describe('B7 阈值不变：注入预算不动 π 的 thresholds 面', () => {
  it('调完 getInjectableView() 后 thresholds 深度相等', () => {
    const { policy } = freshService();
    policy.applyUpdate({
      addLessons: mkLessons(12),
      setThresholds: { minToolSuccessRate: 0.9, retryCap: 5 },
    });
    policy.setInjectionBudget({ maxLessons: 6, maxChars: 0 });
    policy.setEffectivenessProvider(() => noEvidence(mkLessons(12)));

    const before = policy.getPolicy().thresholds;
    const view = policy.getInjectableView();

    expect(view.lessons).toHaveLength(6);
    expect(policy.getPolicy().thresholds).toEqual(before);
    expect(policy.getPolicy().thresholds).toEqual({ minToolSuccessRate: 0.9, retryCap: 5 });
    expect(view.policy.thresholds).toEqual(before);
  });

  it('selectInjections 是纯函数：不修改入参', () => {
    const lessons = mkLessons(12);
    const stats = noEvidence(lessons);
    const lessonsCopy = [...lessons];
    const statsCopy = stats.map((s) => ({ ...s }));

    selectInjections(lessons, DEFAULT_INJECTION_BUDGET, stats);

    expect(lessons).toEqual(lessonsCopy);
    expect(stats).toEqual(statsCopy);
  });
});

describe('B9 退化路径：排序依据不可得时全量注入（不静默截断）', () => {
  it('provider 返回 null ⇒ 12 条全进，evicted 为空', () => {
    const { policy } = freshService();
    const lessons = mkLessons(12);
    policy.applyUpdate({ addLessons: lessons });
    policy.setInjectionBudget({ maxLessons: 6, maxChars: 60 });
    policy.setEffectivenessProvider(() => null);

    const view = policy.getInjectableView();
    expect(view.lessons).toHaveLength(12);
    expect(view.lessons).toEqual(lessons);
    expect(view.evicted).toHaveLength(0);
    expect(view.chars).toBe(injectionChars(lessons));
  });

  it('provider 抛错 / 未绑定 ⇒ 同样全量（异常不许进 agent 主循环）', () => {
    const { policy } = freshService();
    const lessons = mkLessons(12);
    policy.applyUpdate({ addLessons: lessons });
    policy.setInjectionBudget({ maxLessons: 6, maxChars: 60 });

    // 未绑定 provider
    expect(policy.getInjectableView().lessons).toHaveLength(12);

    // provider 故障
    policy.setEffectivenessProvider(() => {
      throw new Error('effectiveness source down');
    });
    const view = policy.getInjectableView();
    expect(view.lessons).toHaveLength(12);
    expect(view.evicted).toHaveLength(0);
  });
});

// ── B5b：loop 接线（记账与 prompt 必须是同一个数组） ───────────────────────

describe('B5b 接线：agent-loop 里 recordInjections 与 buildSystemPrompt 吃同一个数组', () => {
  let runtime: Runtime;
  let fake: FakeLlm;
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    // :memory: ⇒ 不产生临时目录，也就不需要在 afterEach 里做（会被宿主
    // safe-delete shim 拖成数十秒的）同步清理。
    runtime = createRuntime({ dbPath: ':memory:' });
    const app = createApp({ runtime, autoStartModelSync: false });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fake = await FakeLlm.start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await fake.close();
    await runtime.close();
  });

  /** 一次真实 agent 请求的请求体（只改 message 的调用方自己覆盖）。 */
  function agentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      provider: 'custom',
      customBaseUrl: fake.baseUrl,
      model: 'fake-model-budget',
      apiKey: 'test-key-budget',
      message: '随便说说',
      channelMode: 'auto',
      tools: ['fs.read'],
      maxIterations: 6,
      temperature: 0.2,
      maxTokens: 256,
      ...overrides,
    };
  }

  it('实际注入 6 条：prompt 里恰好是这 6 条，记账也是这 6 条', { timeout: 60_000 }, async () => {
    const seeded = mkLessons(12);
    runtime.policy.applyUpdate({ addLessons: seeded });
    runtime.policy.setInjectionBudget({ maxLessons: 6, maxChars: 0 });

    fake.script([{ text: '已直接给出结果，无需调用工具。' }]);
    let sessionId = '';
    const { status } = await runAgentStream(base, agentBody(), (event) => {
      if (event.name === 'meta') sessionId = String(event.data.sessionId);
    });
    expect(status).toBe(200);
    expect(sessionId).not.toBe('');

    const rows = runtime.db.all<{ lesson: string }>(
      `SELECT lesson FROM policy_injections WHERE session_id = ?`,
      [sessionId],
    );
    expect(rows).toHaveLength(6);

    const prompt = fake.lastSystemPrompt();
    expect(prompt).toContain('来自过往经验的策略');
    const injected = new Set(rows.map((r) => r.lesson));
    for (const lesson of injected) {
      expect(prompt).toContain(lesson);
    }
    // 被预算挤出的经验绝不能出现在 prompt 里 —— 否则「记账 6 条 / 实际 12 条」
    // 会让 injected 系统性偏低，经验有效性从此不可信。
    const evicted = seeded.filter((lesson) => !injected.has(lesson));
    expect(evicted).toHaveLength(6);
    for (const lesson of evicted) {
      expect(prompt).not.toContain(lesson);
    }
  });

  it('run 级求值：跑出 2 轮 iteration，getInjectableView 也只被调用一次', { timeout: 60_000 }, async () => {
    // 为什么这条是回归防线而不是锦上添花：
    //  - 性能：getInjectableView → judge.effectiveness()，是 policy_injections ×
    //    judge_runs 的分组聚合。放回循环里就是「10 轮任务跑 10 次聚合」。
    //  - 语义：经验集合是 run 级输入。若中途重算，事后无法归因「这一轮的行为
    //    是被哪几条经验影响的」，而这正是经验有效性唯一的衡量依据。
    runtime.policy.applyUpdate({ addLessons: mkLessons(12) });
    runtime.policy.setInjectionBudget({ maxLessons: 6, maxChars: 0 });
    const spy = vi.spyOn(runtime.policy, 'getInjectableView');

    // 两轮工具调用 + 收尾文本 ⇒ 至少 2 次 iteration（证明「多轮」这件事成立）。
    fake.script([
      { toolCall: { id: 'call_a', name: 'fs_read', arguments: JSON.stringify({ path: 'budget-missing-a.txt' }) } },
      { toolCall: { id: 'call_b', name: 'fs_read', arguments: JSON.stringify({ path: 'budget-missing-b.txt' }) } },
      { text: '两轮观察完毕，给出结论。' },
    ]);

    let sessionId = '';
    const { status } = await runAgentStream(base, agentBody({ message: '先看两个文件再回答' }), (event) => {
      if (event.name === 'meta') sessionId = String(event.data.sessionId);
    });
    expect(status).toBe(200);
    expect(sessionId).not.toBe('');

    // 「多轮」这个前提必须先成立，否则下面的 1 次断言什么都证明不了。
    const executed = runtime.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ?`,
      [sessionId],
    );
    expect(executed?.n).toBe(2);
    // 两轮 loop 只对应一次 run 级求值。
    expect(spy).toHaveBeenCalledTimes(1);

    // 每轮记录的仍是同一批经验（run 级恒定），计数不会因轮数放大。
    const rows = runtime.db.all<{ lesson: string }>(
      `SELECT lesson FROM policy_injections WHERE session_id = ?`,
      [sessionId],
    );
    expect(rows).toHaveLength(6);
  });
});

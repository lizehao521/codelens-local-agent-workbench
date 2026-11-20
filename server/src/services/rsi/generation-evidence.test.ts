/**
 * 跨代失败证据采集测试（failure 第一阶段验收线 A，codelens exp168b）。
 *
 * 覆盖：failure 映射与签名一致性、防误配六条件、体积/条数截断、幂等、
 * 消费侧 evaluateStall 判定 1 与 INV-3 正反例、INV-2 仍不可用。
 */
import { describe, it, expect } from 'vitest';
import { createDb } from '../../repositories/db.js';
import { SCHEMA_SQL } from '../../repositories/schema.js';
import {
  collectFailureEvidence,
  upsertFailureEvidence,
  loadGenerationFailure,
} from './generation-evidence.js';
import { buildConsistencyShadow } from './cross-generation-consistency.js';
import { evaluateStall } from './cross-generation-stall.js';
import type { FailureInput } from './cross-generation-stall.js';

type Db = ReturnType<typeof createDb>;

const SESSION = 's-evidence';

/** 建真库并准备 session；返回 db。 */
function makeDb(): Db {
  const db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  db.run(
    `INSERT INTO sessions (id, provider, model, created_at, updated_at)
     VALUES (?, 'openai', 'gpt-x', 0, 0)`,
    [SESSION],
  );
  return db;
}

/** 插一代 judge_run 并返回其 id 与 created_at。 */
function addJudgeRun(db: Db, at: number, verdict = 'fail'): number {
  db.run(
    `INSERT INTO judge_runs (session_id, verdict, score, coverage, executed, total, created_at)
     VALUES (?, ?, 0.5, 0.5, 1, 2, ?)`,
    [SESSION, verdict, at],
  );
  const row = db.get<{ id: number }>('SELECT id FROM judge_runs ORDER BY id DESC LIMIT 1');
  return row!.id;
}

/** 插一代 policy_rsi_runs。 */
function addGeneration(db: Db, generation: number, judgeRunId: number, prev: number | null): number {
  db.run(
    `INSERT INTO policy_rsi_runs
       (judge_run_id, session_id, generation, prev_generation, verdict, exit_code,
        reasons_json, metrics_json, prev_readings_json, next_readings_json,
        next_manifest_json, ledger_path, created_at)
     VALUES (?, ?, ?, ?, 'not_improved', 1, '[]', NULL, NULL, NULL, NULL, ?, ?)`,
    [judgeRunId, SESSION, generation, prev, `ledger-${generation}`, Date.now()],
  );
  const row = db.get<{ id: number }>('SELECT id FROM policy_rsi_runs ORDER BY id DESC LIMIT 1');
  return row!.id;
}

/** 插一条 tool_call。 */
function addToolCall(
  db: Db,
  status: string,
  at: number,
  opts: { name?: string; errorKind?: string | null; errorMsg?: string | null } = {},
): void {
  const id = `tc-${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    `INSERT INTO tool_calls
       (id, session_id, call_id, tool_name, tool_wire_name, display_name, category, source,
        risk, approval_mode, channel, iteration, args_json, status, error_kind, error_msg,
        created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'compute', 'builtin', 'low', 'none', 'native', 0, '{}',
             ?, ?, ?, ?)`,
    [
      id, SESSION, id, opts.name ?? 'fs.write', opts.name ?? 'fs_write', opts.name ?? 'fs.write',
      status, opts.errorKind ?? null, opts.errorMsg ?? null, at,
    ],
  );
}

describe('collectFailureEvidence：采集与映射', () => {
  it('failed/timeout/rejected 全捕获，success/skipped 不误报；error_kind→errorType、error_msg→message', () => {
    const db = makeDb();
    const j1 = addJudgeRun(db, 1000);
    addGeneration(db, 1, j1, null);
    const j2 = addJudgeRun(db, 2000);
    addGeneration(db, 2, j2, 1);

    addToolCall(db, 'success', 1500, { errorMsg: '看起来像错误的正常输出' });
    addToolCall(db, 'skipped', 1501);
    addToolCall(db, 'failed', 1600, { errorKind: 'TS2345', errorMsg: 'Type mismatch at a.ts:12:3' });
    addToolCall(db, 'timeout', 1700, { errorKind: 'ETIMEDOUT' });
    addToolCall(db, 'rejected', 1800, { errorKind: 'USER_REJECTED' });

    const ev = collectFailureEvidence(db, SESSION);
    expect(ev.status).toBe('complete');
    expect(ev.source).toBe('tool_calls');
    expect(ev.counts).toMatchObject({ total: 3, captured: 3, failed: 1, timeout: 1, rejected: 1 });
    expect(ev.failures.map((f) => f.status).sort()).toEqual(['failed', 'rejected', 'timeout']);
    const failed = ev.failures.find((f) => f.status === 'failed')!;
    expect(failed.errorType).toBe('TS2345');
    expect(failed.message).toContain('Type mismatch');
    // 行号已归一
    expect(failed.signature).toContain('LINE');
    expect(failed.signature.startsWith('TS2345::')).toBe(true);
  });

  it('无失败行 → complete 但空样本（不是 unavailable）', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    addToolCall(db, 'success', 1500);
    const ev = collectFailureEvidence(db, SESSION);
    expect(ev.status).toBe('complete');
    expect(ev.failures).toHaveLength(0);
    expect(ev.counts.total).toBe(0);
  });
});

describe('collectFailureEvidence：防误配六条件', () => {
  it('首代缺 t0 → unavailable，窗口不猜界', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    const ev = collectFailureEvidence(db, SESSION);
    expect(ev.status).toBe('unavailable');
    expect(ev.window.t0).toBeNull();
    expect(ev.window.t1).toBe(1000);
  });

  it('t0 >= t1 → ambiguous', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 2000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    expect(collectFailureEvidence(db, SESSION).status).toBe('ambiguous');
  });

  it('窗口内夹了别的代 → ambiguous（归属不唯一）', () => {
    const db = makeDb();
    // 时间倒挂：gen1 的 judge(2000) 晚于 gen2(1500)。当前代 gen3 窗口 = (1500, 3000]，
    // gen1 的 2000 被夹在窗口内 → 归属不唯一。
    addGeneration(db, 1, addJudgeRun(db, 2000), null);
    addGeneration(db, 2, addJudgeRun(db, 1500), 1);
    addGeneration(db, 3, addJudgeRun(db, 3000), 2);
    expect(collectFailureEvidence(db, SESSION).status).toBe('ambiguous');
  });

  it('多会话不合并：其他 session 的失败不进入本代', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    addToolCall(db, 'failed', 1500);
    db.run(`INSERT INTO sessions (id, provider, model, created_at, updated_at)
            VALUES ('other', 'openai', 'gpt-x', 0, 0)`);
    db.run(
      `INSERT INTO tool_calls
         (id, session_id, call_id, tool_name, tool_wire_name, display_name, category, source,
          risk, approval_mode, channel, iteration, args_json, status, created_at)
       VALUES ('x1', 'other', 'x1', 'fs.write', 'fs_write', 'fs.write', 'compute', 'builtin',
               'low', 'none', 'native', 0, '{}', 'failed', 1600)`,
    );
    const ev = collectFailureEvidence(db, SESSION);
    expect(ev.counts.total).toBe(1);
  });
});

describe('collectFailureEvidence：截断与幂等', () => {
  it('超过 100 条 → partial、只留 100 条、omitted 计数正确', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    for (let i = 0; i < 130; i += 1) {
      addToolCall(db, 'failed', 1100 + i, { errorKind: `E${i}` });
    }
    const ev = collectFailureEvidence(db, SESSION);
    expect(ev.status).toBe('partial');
    expect(ev.truncated).toBe(true);
    expect(ev.failures).toHaveLength(100);
    expect(ev.counts.total).toBe(130);
    // captured = 实际进入样本的条数；omitted = 因上限剔除的条数
    expect(ev.counts.captured).toBe(100);
    expect(ev.counts.omitted).toBe(30);
  });

  it('超长错误文本按 4KiB 截断并标 partial', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    addToolCall(db, 'failed', 1500, { errorMsg: 'x'.repeat(9000) });
    const ev = collectFailureEvidence(db, SESSION);
    expect(ev.status).toBe('partial');
    const sample = ev.failures[0]!;
    expect(Buffer.byteLength(sample.message ?? '', 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('同窗口重复采集两次 → 结果逐字一致（固定快照+确定性排序）', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    addToolCall(db, 'failed', 1500, { errorKind: 'A' });
    addToolCall(db, 'failed', 1600, { errorKind: 'B' });
    const a = JSON.stringify(collectFailureEvidence(db, SESSION));
    const b = JSON.stringify(collectFailureEvidence(db, SESSION));
    expect(a).toBe(b);
  });

  it('upsert 幂等：同代重复落库不产生第二行', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    addToolCall(db, 'failed', 1500, { errorKind: 'A' });
    const ev = collectFailureEvidence(db, SESSION);
    upsertFailureEvidence(db, SESSION, ev);
    upsertFailureEvidence(db, SESSION, ev);
    const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM rsi_generation_evidence');
    expect(n!.n).toBe(1);
  });

  it('db 缺 exec/run 能力 → 静默降级，不抛错', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    const bare = { get: db.get.bind(db) } as unknown as typeof db;
    expect(() => collectFailureEvidence(bare, SESSION)).not.toThrow();
    expect(collectFailureEvidence(bare, SESSION).status).toBe('unavailable');
  });
});


describe('loadGenerationFailure：状态门控', () => {
  it('complete/partial 且有样本 → 返回整代签名集合（去重排序）', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    addToolCall(db, 'failed', 1500, { errorKind: 'B', errorMsg: 'second' });
    addToolCall(db, 'failed', 1600, { errorKind: 'A', errorMsg: 'first' });
    upsertFailureEvidence(db, SESSION, collectFailureEvidence(db, SESSION));
    const f = loadGenerationFailure(db, SESSION, 2);
    expect(f).not.toBeNull();
    const lines = (f!.rawText ?? '').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith('A::')).toBe(true);
  });

  it('ambiguous / unavailable / 无行 → null', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    expect(loadGenerationFailure(db, SESSION, 1)).toBeNull();
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    upsertFailureEvidence(db, SESSION, collectFailureEvidence(db, SESSION));
    expect(loadGenerationFailure(db, SESSION, 2)).toBeNull();
  });
});

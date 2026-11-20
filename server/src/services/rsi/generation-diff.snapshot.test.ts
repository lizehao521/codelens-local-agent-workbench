/**
 * diff 丁阶段：checkpoint 快照来源单测（exp170 Q8 验收线 2/3/4/5/7）。
 *
 * 全部真 SQLite 内存库；不 mock。重点守三件事：
 *   ① 快照存在时整代择源，tool_calls 不参与数值；
 *   ② 覆盖不全/mixed/截断一律 partial，不得冒充 complete；
 *   ③ 窗口外的历史快照不得进入本代 S。
 */
import { describe, it, expect } from 'vitest';
import { createDb } from '../../repositories/db.js';
import { SCHEMA_SQL } from '../../repositories/schema.js';
import { collectDiffEvidence, upsertDiffEvidence } from './generation-diff.js';
import type { DiffEvidence } from './generation-diff.schema.js';

type Db = ReturnType<typeof createDb>;
const SESSION = 's-diff-snap';

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

function addJudgeRun(db: Db, at: number): number {
  db.run(`INSERT INTO judge_runs (session_id, verdict, created_at) VALUES (?, 'fail', ?)`, [SESSION, at]);
  return db.get<{ id: number }>('SELECT id FROM judge_runs ORDER BY id DESC LIMIT 1')!.id;
}

function addGeneration(db: Db, generation: number, judgeRunId: number, prev: number | null): void {
  db.run(
    `INSERT INTO policy_rsi_runs
       (judge_run_id, session_id, generation, prev_generation, verdict, exit_code,
        reasons_json, ledger_path, created_at)
     VALUES (?, ?, ?, ?, 'not_improved', 1, '[]', ?, ?)`,
    [judgeRunId, SESSION, generation, prev, `ledger-${generation}`, Date.now()],
  );
}

function seedWindow(db: Db): void {
  addGeneration(db, 1, addJudgeRun(db, 1000), null);
  addGeneration(db, 2, addJudgeRun(db, 2000), 1);
}

function addWrite(db: Db, at: number, args: Record<string, unknown>): void {
  const id = `tc-${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    `INSERT INTO tool_calls
       (id, session_id, call_id, tool_name, tool_wire_name, display_name, category, source,
        risk, approval_mode, channel, iteration, args_json, status, created_at)
     VALUES (?, ?, ?, 'fs.write', 'fs_write', 'fs.write', 'file', 'builtin',
             'low', 'none', 'native', 0, ?, 'success', ?)`,
    [id, SESSION, id, JSON.stringify(args), at],
  );
}

function addCheckpoint(
  db: Db,
  at: number,
  opts: { runId?: string | null; step?: number; diffs?: unknown; raw?: string | null; status?: string } = {},
): void {
  const id = `cp-${Math.random().toString(36).slice(2, 10)}`;
  const raw = opts.raw !== undefined ? opts.raw : JSON.stringify(opts.diffs ?? []);
  db.run(
    `INSERT INTO workspace_checkpoints
       (id, session_id, label, root, file_count, total_bytes, manifest_json, created_at,
        run_id, step, tool_call_ids_json, diff_json, status)
     VALUES (?, ?, 'write', '/tmp/ws', 1, 10, '[]', ?, ?, ?, '[]', ?, ?)`,
    [id, SESSION, at, opts.runId === undefined ? 'run-a' : opts.runId, opts.step ?? 1, raw, opts.status ?? 'active'],
  );
}

function fileDiff(path: string, added: number, removed: number, text: string): unknown {
  return { path, operation: 'write', beforeSha256: 'b', afterSha256: 'a', beforeBytes: 1, afterBytes: 1, added, removed, diff: text };
}

describe('collectDiffEvidence · checkpoint 来源（丁）', () => {
  it('overwrite 被快照覆盖 → source=checkpoint / complete / 真值行数', () => {
    const db = makeDb();
    seedWindow(db);
    addWrite(db, 1900, { operation: 'overwrite', path: 'a.ts', content: '全文' });
    addCheckpoint(db, 1900, { diffs: [fileDiff('a.ts', 2, 1, '@@ -1 +1,2 @@\n-a\n+b\n+c')] });

    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.source).toBe('checkpoint');
    expect(ev.status).toBe('complete');
    expect(ev.changedLines).toBe(3);
    expect(ev.coveredWrites).toBe(1);
    expect(ev.blindSpots).not.toContain('overwrite');
    expect(ev.aggregateText).toContain('+b');
  });

  it('双源同代：数值只来自快照，不叠加 tool_calls 重建', () => {
    const db = makeDb();
    seedWindow(db);
    addWrite(db, 1900, { operation: 'create', path: 'a.ts', content: 'REBUILT' });
    addCheckpoint(db, 1901, { diffs: [fileDiff('a.ts', 0, 0, '')] });

    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.source).toBe('checkpoint');
    expect(ev.changedLines).toBe(0);
    expect(ev.aggregateText).not.toContain('REBUILT');
  });

  it('白名单路径缺快照 → partial（不得 complete）', () => {
    const db = makeDb();
    seedWindow(db);
    addWrite(db, 1800, { operation: 'overwrite', path: 'a.ts', content: 'x' });
    addWrite(db, 1900, { operation: 'overwrite', path: 'b.ts', content: 'y' });
    addCheckpoint(db, 1900, { diffs: [fileDiff('a.ts', 1, 0, '+x')] });

    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.status).toBe('partial');
    expect(ev.source).toBe('checkpoint');
  });

  it('窗口内多 run → partial + mixed_runs 盲区', () => {
    const db = makeDb();
    seedWindow(db);
    addWrite(db, 1900, { operation: 'overwrite', path: 'a.ts', content: 'x' });
    addCheckpoint(db, 1850, { runId: 'run-a', diffs: [fileDiff('a.ts', 1, 1, '-a\n+b')] });
    addCheckpoint(db, 1900, { runId: 'run-b', diffs: [fileDiff('a.ts', 1, 1, '-a\n+c')] });

    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.status).toBe('partial');
    expect(ev.blindSpots).toContain('mixed_runs');
  });

  it('单文件 diff 达 8000 字符 → partial + diff_truncated', () => {
    const db = makeDb();
    seedWindow(db);
    addWrite(db, 1900, { operation: 'overwrite', path: 'a.ts', content: 'x' });
    addCheckpoint(db, 1900, { diffs: [fileDiff('a.ts', 1, 1, 'x'.repeat(8000))] });

    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.status).toBe('partial');
    expect(ev.blindSpots).toContain('diff_truncated');
  });

  it('窗口外历史快照不进入本代 S → 回退乙', () => {
    const db = makeDb();
    seedWindow(db);
    addWrite(db, 1900, { operation: 'create', path: 'a.ts', content: '+real' });
    addCheckpoint(db, 900, { diffs: [fileDiff('a.ts', 9, 9, '-x\n+y')] });

    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.source).toBe('tool_calls');
    expect(ev.status).toBe('complete');
    expect(ev.changedLines).toBeUndefined();
  });

  it('落库 origin=checkpoint（老行 NULL 由读取侧按 tool_calls 处理）', () => {
    const db = makeDb();
    seedWindow(db);
    addWrite(db, 1900, { operation: 'overwrite', path: 'a.ts', content: 'x' });
    addCheckpoint(db, 1900, { diffs: [fileDiff('a.ts', 0, 0, '')] });
    const ev = collectDiffEvidence(db, SESSION);
    upsertDiffEvidence(db, SESSION, ev);
    const row = db.get<{ origin: string | null }>(
      'SELECT origin FROM rsi_generation_diff WHERE session_id = ?', [SESSION],
    )!;
    expect(row.origin).toBe('checkpoint');
  });

  it('changedLines 为 null 时 guard 不得据此判零（二进制盲区）', () => {
    const db = makeDb();
    seedWindow(db);
    addWrite(db, 1900, { operation: 'overwrite', path: 'a.ts', content: 'x' });
    addCheckpoint(db, 1900, { diffs: [fileDiff('a.ts', 0, 0, '[二进制或大文件：未做行级 diff]')] });
    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.changedLines).toBeNull();
    expect(ev.status).toBe('partial');
  });
});

export type { DiffEvidence };

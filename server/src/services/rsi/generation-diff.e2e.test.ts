/**
 * diff 证据端到端测试（乙阶段验收线第 5/6 条：装配层真实可读）。
 *
 * 与 generation-diff.test.ts 的分工：那里测采集器纯逻辑，这里测「真库装配 →
 * recordShadowAudit → diff 落 rsi_generation_diff → detail.diffGuard 透出」整链，
 * 并守住 detail ≤500 与「不把未观测写成零变更」两条护栏。
 */
import { describe, it, expect } from 'vitest';
import { createDb } from '../../repositories/db.js';
import { SCHEMA_SQL } from '../../repositories/schema.js';
import { recordShadowAudit } from './cross-generation-bridge.js';
import type { RsiBridgeResult } from './rsi-bridge.service.js';

type Db = ReturnType<typeof createDb>;
const SESSION = 's-diff-e2e';

function makeDb(): Db {
  const db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  db.run(`INSERT INTO sessions (id, provider, model, created_at, updated_at)
          VALUES (?, 'openai', 'gpt-x', 0, 0)`, [SESSION]);
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
        reasons_json, metrics_json, ledger_path, created_at)
     VALUES (?, ?, ?, ?, 'not_improved', 0, '[]', ?, ?, ?)`,
    [
      judgeRunId, SESSION, generation, prev,
      JSON.stringify([{ metric: 'quality', before: 1, after: 1, better: false }]),
      `/tmp/ledger-${generation}.jsonl`, Date.now(),
    ],
  );
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

function addExec(db: Db, at: number, command: string, argv: string[]): void {
  const id = `tc-${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    `INSERT INTO tool_calls
       (id, session_id, call_id, tool_name, tool_wire_name, display_name, category, source,
        risk, approval_mode, channel, iteration, args_json, status, created_at)
     VALUES (?, ?, ?, 'sys.exec', 'sys_exec', 'sys.exec', 'compute', 'builtin',
             'low', 'none', 'native', 0, ?, 'success', ?)`,
    [id, SESSION, id, JSON.stringify({ command, args: argv }), at],
  );
}

function addCheckpointZero(db: Db, at: number, path: string): void {
  db.run(
    `INSERT INTO workspace_checkpoints
       (id, session_id, label, root, file_count, total_bytes, manifest_json, created_at,
        run_id, step, tool_call_ids_json, diff_json, status)
     VALUES ('cp-e2e', ?, 'write', '/tmp/ws', 1, 10, '[]', ?, 'run-e2e', 1, '[]', ?, 'active')`,
    [SESSION, at, JSON.stringify([
      { path, operation: 'write', beforeSha256: 'b', afterSha256: 'a', beforeBytes: 1, afterBytes: 1, added: 0, removed: 0, diff: '' },
    ])],
  );
}

function makeResult(state: RsiBridgeResult['state']): RsiBridgeResult {
  return {
    state,
    exitCode: 0,
    reasons: ['fixture'],
    metrics: [{ metric: 'quality', before: 1, after: 2, better: true }],
    reportRaw: '{"fixture":true}',
    ledgerPath: '/tmp/ledger-2.jsonl',
  };
}

interface Detail {
  verdict: string;
  consistencyShadow?: { violations: Array<{ inv: string }>; unavailableChecks: Array<{ inv: string; cause: string }> };
  diffGuard?: { s: string; cw: number; bi: number; ia: number; tr: number; z?: number; el?: number; tb?: number };
}

function auditOnce(db: Db, state: RsiBridgeResult['state'] = 'improved'): { detail: Detail; raw: string } {
  const spans: Array<{ span: { detail?: string; status?: string } }> = [];
  recordShadowAudit({
    db, sessionId: SESSION, result: makeResult(state), traceId: 't1',
    recordSpan: (_t, span) => spans.push({ span }),
  });
  const raw = spans[0]!.span.detail!;
  return { detail: JSON.parse(raw) as Detail, raw };
}

describe('diff 证据端到端（recordShadowAudit + 真库）', () => {
  it('有意义变更 → diffGuard.s=complete / z=0 / el=0，且 detail ≤500 合法 JSON', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    addWrite(db, 1900, { operation: 'replace', path: 'a.ts', oldText: 'const a = 1;', newText: 'const a = 2;' });

    const { detail, raw } = auditOnce(db);
    expect(raw.length).toBeLessThanOrEqual(500);
    expect(detail.diffGuard?.s).toBe('complete');
    expect(detail.diffGuard?.z).toBe(0);
    expect(detail.diffGuard?.el).toBe(0);
    // diff 正文绝不进 detail
    expect(raw).not.toContain('const a = 2;');
    // complete 时 INV-1 移出 unavailableChecks，只剩 INV-2
    expect(detail.consistencyShadow?.unavailableChecks.map((u) => u.inv)).toEqual(['INV-2']);
  });

  it('只改注释却宣称 improved → z=1 / el=1（记录可报条件，但本轮不 emit INV-1 violation）', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    addWrite(db, 1900, { operation: 'create', path: 'a.ts', content: '// only a comment' });

    const { detail } = auditOnce(db);
    expect(detail.diffGuard?.z).toBe(1);
    expect(detail.diffGuard?.el).toBe(1);
    const invs = (detail.consistencyShadow?.violations ?? []).map((v) => v.inv);
    expect(invs).not.toContain('INV-1');
  });

  it('存在 sys.exec → diffGuard.s=partial 且 z/el 缺省（不得读成非零变更）', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    addWrite(db, 1800, { operation: 'create', path: 'a.ts', content: '// c' });
    addExec(db, 1900, 'git', ['status']);

    const { detail } = auditOnce(db);
    expect(detail.diffGuard?.s).toBe('partial');
    expect(detail.diffGuard?.bi).toBeGreaterThanOrEqual(1);
    expect(detail.diffGuard?.z).toBeUndefined();
    expect(detail.diffGuard?.el).toBeUndefined();
    // partial 时 INV-1 保留并细分原因
    const inv1 = detail.consistencyShadow?.unavailableChecks.find((u) => u.inv === 'INV-1');
    expect(inv1?.cause).toBe('diff_incomplete');
  });

  it('args_json 截断 → s=unavailable，detail 仍合法 JSON 且无伪正文', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    const id = 'tc-trunc';
    db.run(
      `INSERT INTO tool_calls
         (id, session_id, call_id, tool_name, tool_wire_name, display_name, category, source,
          risk, approval_mode, channel, iteration, args_json, status, created_at)
       VALUES (?, ?, ?, 'fs.write', 'fs_write', 'fs.write', 'file', 'builtin',
               'low', 'none', 'native', 0, ?, 'success', 1900)`,
      [id, SESSION, id, '{"operation":"overwrite","path":"a.ts","con…[truncated]'],
    );

    const { detail, raw } = auditOnce(db);
    expect(detail.diffGuard?.s).toBe('unavailable');
    expect(detail.diffGuard?.ia).toBe(1);
    expect(detail.diffGuard?.z).toBeUndefined();
    expect(raw).not.toContain('truncated');
  });

  it('丁阶段：快照真值确认零变更 → INV-1 正式 emit，detail 仍 ≤500', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    addWrite(db, 1900, { operation: 'overwrite', path: 'a.ts', content: '全文' });
    addCheckpointZero(db, 1900, 'a.ts');

    const { detail, raw } = auditOnce(db, 'improved');
    expect(raw.length).toBeLessThanOrEqual(500);
    expect(detail.diffGuard?.s).toBe('complete');
    expect(detail.diffGuard?.z).toBe(1);
    expect(detail.diffGuard?.el).toBe(1);
    expect(detail.consistencyShadow?.violations.map((v) => v.inv)).toContain('INV-1');
    expect(detail.consistencyShadow?.unavailableChecks.map((u) => u.inv)).not.toContain('INV-1');
  });

  it('表落库：同一代重复审计只留一行（幂等），且 status 与 detail 一致', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    addWrite(db, 1900, { operation: 'create', path: 'a.ts', content: '+real' });

    auditOnce(db);
    auditOnce(db);
    const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM rsi_generation_diff')!;
    expect(n.n).toBe(1);
    const row = db.get<{ status: string; covered_writes: number }>(
      'SELECT status, covered_writes FROM rsi_generation_diff WHERE session_id = ?', [SESSION],
    )!;
    expect(row.status).toBe('complete');
    expect(row.covered_writes).toBe(1);
  });
});

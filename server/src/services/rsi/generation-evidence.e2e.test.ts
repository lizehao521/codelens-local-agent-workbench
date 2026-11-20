/**
 * failure 证据端到端测试（验收线 A 第 1 条：shadow 流水线中落盘并可读）。
 *
 * 与 generation-evidence.test.ts 的分工：那里测采集器本身，这里测「真实 Db 装配 →
 * recordShadowAudit → 证据落表 → consistencyShadow.detail 透出 INV-3」的整链，
 * 确保装配层（查询时机、db 类型断言、幂等）不是只在单测里成立。
 */
import { describe, it, expect, vi } from 'vitest';
import { createDb } from '../../repositories/db.js';
import { SCHEMA_SQL } from '../../repositories/schema.js';
import { recordShadowAudit } from './cross-generation-bridge.js';
import type { RsiBridgeResult } from './rsi-bridge.service.js';

type Db = ReturnType<typeof createDb>;
const SESSION = 's-e2e';

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
      // 历史代必须有 metrics，loadPreviousGeneration 才能重建出可比读数；
      // 当前代由 result 直接提供（makeResult），不依赖此行。
      JSON.stringify([{ metric: 'quality', before: 1, after: 1, better: false }]),
      `/tmp/ledger-${generation}.jsonl`, Date.now(),
    ],
  );
}

function addToolCall(db: Db, status: string, at: number, errorKind: string): void {
  const id = `tc-${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    `INSERT INTO tool_calls
       (id, session_id, call_id, tool_name, tool_wire_name, display_name, category, source,
        risk, approval_mode, channel, iteration, args_json, status, error_kind, created_at)
     VALUES (?, ?, ?, 'fs.write', 'fs_write', 'fs.write', 'compute', 'builtin', 'low', 'none',
             'native', 0, '{}', ?, ?, ?)`,
    [id, SESSION, id, status, errorKind, at],
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

describe('failure 证据端到端（recordShadowAudit + 真库）', () => {
  it('三代连续同失败签名 → 证据落表 + detail 透出 INV-3(signature_repeated)', () => {
    const db = makeDb();
    const spans: Array<{ span: { detail?: string; status?: string } }> = [];
    const audit = (): void => {
      recordShadowAudit({
        db, sessionId: SESSION, result: makeResult('improved'), traceId: 't1',
        recordSpan: (_t, span) => spans.push({ span }),
      });
    };
    // 真实时序：每代 run 收尾各采集一次，故 gen2 必须在「它还是当前代」时被采集。
    // gen1 无 t0 → 按裁定不采集（不猜界）；gen2/gen3 各有窗口，构成判定 1 的相邻两代。
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addToolCall(db, 'failed', 1100, 'TS2345');
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    addToolCall(db, 'failed', 1900, 'TS2345');
    audit(); // 采集 gen2：窗口 (1000,2000]
    addGeneration(db, 3, addJudgeRun(db, 3000), 2);
    addToolCall(db, 'failed', 2900, 'TS2345');
    audit(); // 采集 gen3：窗口 (2000,3000]

    // 1) 相邻两代证据均已落表
    const gens = db.all<{ generation: number }>(
      'SELECT generation FROM rsi_generation_evidence WHERE session_id = ? ORDER BY generation',
      [SESSION],
    );
    expect(gens.map((g) => g.generation)).toEqual([2, 3]);

    // 2) detail 是合法 JSON，且 consistencyShadow 里出现 INV-3
    const detail = JSON.parse(spans[spans.length - 1]!.span.detail!) as {
      verdict: string;
      consistencyShadow?: { status: string; violations: Array<{ inv: string; msg?: string; gens?: number[] }> };
    };
    expect(spans[spans.length - 1]!.span.status).toBe('ok');
    expect(detail.verdict).toBe('improved');
    expect(detail.consistencyShadow).toBeDefined();
    // detail 超 500 会降级省略 consistencyShadow；本用例数据量小，必须完整透出。
    const inv3 = detail.consistencyShadow!.violations.find((v) => v.inv === 'INV-3');
    expect(inv3).toBeDefined();
    // 停滞来源必须是 signature_repeated（failure 路径），不是 zero_evidence
    expect(inv3!.msg).toContain('signature_repeated');
    expect(inv3!.gens).toEqual([2, 3]);
  });

  it('重复审计幂等：同代只一行证据', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addGeneration(db, 2, addJudgeRun(db, 2000), 1);
    addToolCall(db, 'failed', 1900, 'E1');

    const recordSpan = vi.fn();
    const audit = () => recordShadowAudit({
      db, sessionId: SESSION, result: makeResult('improved'), traceId: 't1', recordSpan,
    });
    audit();
    audit();
    const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM rsi_generation_evidence');
    expect(n!.n).toBe(1);
  });

  it('首代（无 t0）→ 证据 unavailable，detail 不伪造 INV-3', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    addToolCall(db, 'failed', 900, 'E1');

    const spans: Array<{ span: { detail?: string } }> = [];
    recordShadowAudit({
      db, sessionId: SESSION, result: makeResult('improved'), traceId: 't1',
      recordSpan: (_t, span) => spans.push({ span }),
    });
    const row = db.get<{ failure_status: string }>(
      'SELECT failure_status FROM rsi_generation_evidence WHERE session_id = ?', [SESSION],
    );
    expect(row?.failure_status).toBe('unavailable');
    const detail = JSON.parse(spans[0]!.span.detail!) as {
      consistencyShadow?: { violations: unknown[] };
    };
    expect(detail.consistencyShadow?.violations ?? []).toHaveLength(0);
  });
});

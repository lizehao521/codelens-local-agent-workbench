/**
 * 跨代 diff 证据采集测试（diff 乙阶段验收线，codelens exp169 Q7）。
 *
 * 覆盖：七操作重建映射、盲区与截断降级、多写合取语义、el 护栏、聚合确定性与
 * 落库/读取门槛。全部用真 SQLite 内存库，不 mock DB。
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createDb } from '../../repositories/db.js';
import { SCHEMA_SQL } from '../../repositories/schema.js';
import { collectDiffEvidence, upsertDiffEvidence, loadGenerationDiff, buildDiffGuard } from './generation-diff.js';
import { buildConsistencyShadow } from './cross-generation-consistency.js';
import { isZeroEffectiveDiff } from './cross-generation-stall.js';

type Db = ReturnType<typeof createDb>;

const SESSION = 's-diff';

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
  db.run(
    `INSERT INTO judge_runs (session_id, verdict, score, coverage, executed, total, created_at)
     VALUES (?, 'fail', 0.5, 0.5, 1, 2, ?)`,
    [SESSION, at],
  );
  return db.get<{ id: number }>('SELECT id FROM judge_runs ORDER BY id DESC LIMIT 1')!.id;
}

function addGeneration(db: Db, generation: number, judgeRunId: number, prev: number | null): number {
  db.run(
    `INSERT INTO policy_rsi_runs
       (judge_run_id, session_id, generation, prev_generation, verdict, exit_code,
        reasons_json, ledger_path, created_at)
     VALUES (?, ?, ?, ?, 'not_improved', 1, '[]', ?, ?)`,
    [judgeRunId, SESSION, generation, prev, `ledger-${generation}`, Date.now()],
  );
  return db.get<{ id: number }>('SELECT id FROM policy_rsi_runs ORDER BY id DESC LIMIT 1')!.id;
}

/** 建 gen1(无窗口) + gen2(窗口 1000~2000]，返回 db。 */
function seedWindow(db: Db): void {
  addGeneration(db, 1, addJudgeRun(db, 1000), null);
  addGeneration(db, 2, addJudgeRun(db, 2000), 1);
}

function addCall(
  db: Db,
  at: number,
  args: Record<string, unknown> | string,
  opts: { status?: string; name?: string; source?: string } = {},
): void {
  const id = `tc-${Math.random().toString(36).slice(2, 10)}`;
  const name = opts.name ?? 'fs.write';
  db.run(
    `INSERT INTO tool_calls
       (id, session_id, call_id, tool_name, tool_wire_name, display_name, category, source,
        risk, approval_mode, channel, iteration, args_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'file', ?, 'low', 'none', 'native', 0, ?, ?, ?)`,
    [
      id, SESSION, id, name, name.replace('.', '_'), name,
      opts.source ?? 'builtin',
      typeof args === 'string' ? args : JSON.stringify(args),
      opts.status ?? 'success', at,
    ],
  );
}

describe('collectDiffEvidence：逐操作重建映射', () => {
  it('create 产 + 行、append 产 + 行、replace 产 -/+ 对；合计非零', () => {
    const db = makeDb();
    seedWindow(db);
    addCall(db, 1100, { operation: 'create', path: 'a.ts', content: 'const a = 1;' });
    addCall(db, 1200, { operation: 'append', path: 'a.ts', content: 'const b = 2;' });
    addCall(db, 1300, { operation: 'replace', path: 'a.ts', oldText: 'a = 1', newText: 'a = 9' });

    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.status).toBe('complete');
    expect(ev.coveredWrites).toBe(3);
    expect(ev.blindSpots).toEqual([]);
    const text = ev.aggregateText;
    expect(text).toContain('+const a = 1;');
    expect(text).toContain('+const b = 2;');
    expect(text).toContain('-a = 1');
    expect(text).toContain('+a = 9');
    expect(isZeroEffectiveDiff({ diffText: text })).toBe(false);
  });

  it('overwrite/delete/purge 不产伪 +/-，且使状态最多 partial', () => {
    const db = makeDb();
    seedWindow(db);
    addCall(db, 1100, { operation: 'overwrite', path: 'a.ts', content: 'const long = 1;\nconst b = 2;' });
    addCall(db, 1200, { operation: 'delete', path: 'b.ts' });
    addCall(db, 1300, { operation: 'purge', path: 'dir' });

    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.status).toBe('partial');
    expect(ev.blindSpots).toContain('overwrite');
    expect(ev.blindSpots).toContain('delete');
    expect(ev.blindSpots).toContain('purge');
    expect(ev.aggregateText).not.toContain('+const long = 1;');
    expect(isZeroEffectiveDiff({ diffText: ev.aggregateText })).toBe(true);
  });

  it('rename-only → metadata_only=1 且 el 不为 1（改进+无正文不判矛盾）', () => {
    const db = makeDb();
    seedWindow(db);
    addCall(db, 1100, { operation: 'rename', path: 'a.ts', newPath: 'b.ts' });

    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.status).toBe('partial');
    expect(ev.metadataOnly).toBe(true);
    const guard = buildDiffGuard(ev, 'improved');
    expect(guard.z).toBeUndefined();
    expect(guard.el).toBeUndefined();
  });

  it('replace 同写（old===new）不计有效变更；create 空 content 记 empty_content', () => {
    const db = makeDb();
    seedWindow(db);
    addCall(db, 1100, { operation: 'replace', path: 'a.ts', oldText: 'x', newText: 'x' });
    addCall(db, 1200, { operation: 'create', path: 'b.ts', content: '' });

    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.status).toBe('complete');
    expect(ev.coveredWrites).toBe(0);
    expect(ev.events.map((e) => e.note).sort()).toEqual(['empty_content', 'same_write']);
    expect(isZeroEffectiveDiff({ diffText: ev.aggregateText })).toBe(true);
  });

  it('未执行的写（failed/rejected）不构成变更', () => {
    const db = makeDb();
    seedWindow(db);
    addCall(db, 1100, { operation: 'create', path: 'a.ts', content: 'x' }, { status: 'failed' });
    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.coveredWrites).toBe(0);
    expect(ev.aggregateText).toBe('');
  });
});

describe('collectDiffEvidence：盲区与截断降级', () => {
  it('sys.exec(node) / sys.exec(git) / mcp 存在 → 永不 complete', () => {
    const db = makeDb();
    seedWindow(db);
    addCall(db, 1100, { operation: 'create', path: 'a.ts', content: 'x' });
    addCall(db, 1200, { command: 'node', args: ['-e', 'fs.writeFileSync("b.ts","y")'] }, { name: 'sys.exec' });
    addCall(db, 1300, { command: 'git', args: ['reset', '--hard'] }, { name: 'sys.exec' });
    addCall(db, 1400, { anything: 1 }, { name: 'mcp_write', source: 'mcp' });

    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.status).toBe('partial');
    expect(ev.blindSpots).toContain('sys_exec:node');
    expect(ev.blindSpots).toContain('sys_exec:git');
    expect(ev.blindSpots.some((b) => b.startsWith('mcp:'))).toBe(true);
    const guard = buildDiffGuard(ev, 'improved');
    expect(guard.z).toBeUndefined();
    expect(guard.el).toBeUndefined();
  });

  it('sys.exec 一律降级 partial（含 git status 这类看似只读的命令）——保守优先，可重建块仍入账', () => {
    const db = makeDb();
    seedWindow(db);
    addCall(db, 1050, { operation: 'create', path: 'a.ts', content: 'x' });
    addCall(db, 1100, { command: 'git', args: ['status'] }, { name: 'sys.exec' });
    const ev = collectDiffEvidence(db, SESSION);
    // codelens exp169 Q3：「即便参数看似只读也保守降级」——无法证明该调用未写文件。
    expect(ev.status).toBe('partial');
    expect(ev.blindSpots).toContain('sys_exec:git');
    // 但可重建块不得因盲区而丢弃：+ 行仍在，供后续丁阶段比对。
    expect(ev.aggregateText).toContain('+x');
    expect(ev.coveredWrites).toBe(1);
  });

  it('args_json 被 8192 截断（非法 JSON）→ 整代 unavailable，不写伪正文', () => {
    const db = makeDb();
    seedWindow(db);
    const truncated = `${JSON.stringify({ operation: 'overwrite', path: 'a.ts', content: 'x' }).slice(0, 20)}…[truncated]`;
    addCall(db, 1100, truncated);

    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.status).toBe('unavailable');
    expect(ev.invalidArgsCount).toBe(1);
    expect(ev.aggregateText).not.toContain('…[truncated]');
  });

  it('缺 t0（首代）→ unavailable / not_attempted 语义（窗口不可用）', () => {
    const db = makeDb();
    addGeneration(db, 1, addJudgeRun(db, 1000), null);
    const ev = collectDiffEvidence(db, SESSION);
    expect(ev.status).toBe('unavailable');
    expect(ev.window).toEqual({ t0: null, t1: 1000 });
  });
});

describe('buildDiffGuard：合取语义与 el 护栏', () => {
  it('complete + 全代有效行全为注释 → z=1；improved 且有覆盖 → el=1（本轮仅记录）', () => {
    const db = makeDb();
    seedWindow(db);
    addCall(db, 1100, { operation: 'create', path: 'a.ts', content: '// just a comment' });
    const ev = collectDiffEvidence(db, SESSION);
    const guard = buildDiffGuard(ev, 'improved');
    expect(guard.s).toBe('complete');
    expect(guard.z).toBe(1);
    expect(guard.el).toBe(1);
  });

  it('多写合计：A 同写 + B 空 content，无盲区 → complete 且 z=1；再加 mcp → 降 partial 且 el 消失', () => {
    const db = makeDb();
    seedWindow(db);
    addCall(db, 1100, { operation: 'replace', path: 'a.ts', oldText: 'x', newText: 'x' });
    addCall(db, 1200, { operation: 'create', path: 'b.ts', content: '' });

    const first = collectDiffEvidence(db, SESSION);
    expect(first.status).toBe('complete');
    const g1 = buildDiffGuard(first, 'improved');
    expect(g1.z).toBe(1);
    // covered_writes=0 → 不满足 el 的必要条件（不能凭"没写"宣称矛盾）
    expect(g1.el).toBe(0);

    addCall(db, 1300, { anything: 1 }, { name: 'mcp_write', source: 'mcp' });
    const second = collectDiffEvidence(db, SESSION);
    expect(second.status).toBe('partial');
    expect(buildDiffGuard(second, 'improved').el).toBeUndefined();
  });

  it('非 improved 判决永不 el=1（not_improved/undecidable/refused）', () => {
    const db = makeDb();
    seedWindow(db);
    addCall(db, 1100, { operation: 'create', path: 'a.ts', content: '// c' });
    const ev = collectDiffEvidence(db, SESSION);
    for (const v of ['not_improved', 'undecidable', 'refused', 'skipped', 'error']) {
      expect(buildDiffGuard(ev, v).el).toBe(0);
    }
  });

  it('guard 恒 ≤128 字符，且不含 diff 正文', () => {
    const db = makeDb();
    seedWindow(db);
    addCall(db, 1100, { operation: 'create', path: 'a.ts', content: 'x'.repeat(500) });
    const guard = buildDiffGuard(collectDiffEvidence(db, SESSION), 'improved');
    const raw = JSON.stringify(guard);
    expect(raw.length).toBeLessThanOrEqual(128);
    expect(raw).not.toContain('xxx');
  });
});

describe('落库与读取门槛', () => {
  it('upsert 幂等（同 run 覆盖）+ 只有 complete 未截断才可 load', () => {
    const db = makeDb();
    seedWindow(db);
    addCall(db, 1100, { operation: 'create', path: 'a.ts', content: '// c' });
    const ev = collectDiffEvidence(db, SESSION);
    upsertDiffEvidence(db, SESSION, ev);
    upsertDiffEvidence(db, SESSION, ev);

    const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM rsi_generation_diff')!;
    expect(n.n).toBe(1);
    expect(loadGenerationDiff(db, SESSION, 2)).toEqual({ status: 'complete', diffText: ev.aggregateText });

    addCall(db, 1200, { operation: 'overwrite', path: 'b.ts', content: 'y' });
    const partialEv = collectDiffEvidence(db, SESSION);
    upsertDiffEvidence(db, SESSION, partialEv);
    expect(loadGenerationDiff(db, SESSION, 2)).toBeNull();
  });

  it('聚合确定性：同一窗口重复采集文本字节一致（sha256 相同）', () => {
    const db = makeDb();
    seedWindow(db);
    addCall(db, 1100, { operation: 'create', path: 'a.ts', content: 'one' });
    addCall(db, 1200, { operation: 'replace', path: 'a.ts', oldText: 'one', newText: 'two' });
    const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
    const a = collectDiffEvidence(db, SESSION);
    const b = collectDiffEvidence(db, SESSION);
    expect(sha(a.aggregateText)).toBe(sha(b.aggregateText));
    expect(a.textBytes).toBe(b.textBytes);
  });

  it('consistency 视图按覆盖度细分 INV-1 cause：complete 移出 / partial 记 diff_incomplete', () => {
    const rows = [{ generation: 1, ledgerPath: 'a' }, { generation: 2, ledgerPath: 'b' }];
    expect(buildConsistencyShadow(rows, 'improved').unavailableChecks[0]?.cause).toBe('no_diff_text');
    expect(buildConsistencyShadow(rows, 'improved', 'partial').unavailableChecks[0]?.cause).toBe('diff_incomplete');
    expect(buildConsistencyShadow(rows, 'improved', 'unavailable').unavailableChecks[0]?.cause).toBe('diff_unavailable');
    const complete = buildConsistencyShadow(rows, 'improved', 'complete');
    expect(complete.unavailableChecks.map((u) => u.inv)).toEqual(['INV-2']);
  });
});

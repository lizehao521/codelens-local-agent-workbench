/**
 * gen2 自验证：黄金集回放确定性 + 落表关联率探针。
 * 跑法：node --import tsx scratch/golden-replay-probe.ts
 * 只读：不写任何业务库，内存库验证落表关联。
 */
import { createHash } from 'node:crypto';
import { createDb } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { allSuites } from '../src/services/eval/suites.js';
import { runEvalBattery } from '../src/services/eval/runner.js';
import {
  collectDiffEvidence,
  upsertDiffEvidence,
  loadGenerationDiff,
} from '../src/services/rsi/generation-diff.js';
import {
  readGenerationDiffStats,
  summarizeGenerationDiffStats,
} from '../src/services/rsi/generation-diff-readback.js';

const SANDBOX = new URL('../workspace/', import.meta.url).pathname;

function digest(x: unknown): string {
  return createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
}

// ---- 1) 黄金集回放确定性：同一沙箱连跑 3 次，指纹 + 全量结果必须逐字节一致 ----
const runs = [1, 2, 3].map(() => runEvalBattery(SANDBOX, { includeHidden: true }));
const digests = runs.map((r) => digest({ fp: r.evalSetFingerprint, suites: r.suites }));
const deterministic = digests.every((d) => d === digests[0]);
const b = runs[0]!;
console.log('suites:', b.suites.length, 'passed:', b.passed, 'total:', b.total, 'unexec:', b.unexec, 'score:', b.score);
console.log('evalSetFingerprint:', b.evalSetFingerprint);
console.log('3-run digests:', digests.join(' '), 'deterministic:', deterministic);

// ---- 2) 落表关联：内存库造 3 代，每代 collect+upsert，回读关联率 ----
const db = createDb(':memory:');
db.exec(SCHEMA_SQL);
const SESSION = 's-golden-probe';
db.run(`INSERT INTO sessions (id, provider, model, created_at, updated_at) VALUES (?, 'openai', 'gpt-x', 0, 0)`, [SESSION]);

function addJudgeRun(at: number): number {
  db.run(`INSERT INTO judge_runs (session_id, verdict, created_at) VALUES (?, 'fail', ?)`, [SESSION, at]);
  return db.get<{ id: number }>('SELECT id FROM judge_runs ORDER BY id DESC LIMIT 1')!.id;
}
function addGeneration(gen: number, judgeRunId: number, prev: number | null): void {
  db.run(
    `INSERT INTO policy_rsi_runs
       (judge_run_id, session_id, generation, prev_generation, verdict, exit_code,
        reasons_json, metrics_json, ledger_path, created_at)
     VALUES (?, ?, ?, ?, 'not_improved', 0, '[]', '[]', ?, ?)`,
    [judgeRunId, SESSION, gen, prev, `/tmp/l-${gen}.jsonl`, gen * 1000],
  );
}
function addWrite(at: number, args: Record<string, unknown>): void {
  const id = `tc-${at}`;
  db.run(
    `INSERT INTO tool_calls
       (id, session_id, call_id, tool_name, tool_wire_name, display_name, category, source,
        risk, approval_mode, channel, iteration, args_json, status, created_at)
     VALUES (?, ?, ?, 'fs.write', 'fs_write', 'fs.write', 'file', 'builtin',
             'low', 'none', 'native', 0, ?, 'success', ?)`,
    [id, SESSION, id, JSON.stringify(args), at],
  );
}

// gen1 (anchor t=1000), gen2 (t=2000, write at 1500), gen3 (t=3000, write at 2500)
addGeneration(1, addJudgeRun(1000), null);
addGeneration(2, addJudgeRun(2000), 1);
addWrite(1500, { operation: 'create', path: 'a.ts', content: 'const a = 1;\nconst b = 2;' });
addGeneration(3, addJudgeRun(3000), 2);
addWrite(2500, { operation: 'replace', path: 'a.ts', oldText: 'const a = 1;', newText: 'const a = 9;' });

// 每代 collect+upsert（模拟 recordShadowAudit 在每代结束时的落表）
for (const gen of [2, 3]) {
  // collectDiffEvidence 读的是"当前最新代"，所以按序造完后逐代 upsert 需临时只看最新；
  // 这里直接验证：对最新代（gen3）collect+upsert，再回读全部代。
}
const ev = collectDiffEvidence(db, SESSION);
upsertDiffEvidence(db, SESSION, ev);

const stats = readGenerationDiffStats(db, SESSION);
const summary = summarizeGenerationDiffStats(stats);
const loadable = loadGenerationDiff(db, SESSION, 3);
console.log('diff rows:', stats.length, 'summary:', JSON.stringify(summary));
console.log('gen3 loadGenerationDiff:', loadable ? `status=${loadable.status} bytes=${loadable.diffText.length}` : 'null');
console.log('gen3 aggregate contains +/-:', loadable ? /^[+-]/m.test(loadable.diffText) : 'n/a');

// 关联率：回放过的代（gen3）在表中可查 = 1/1；若扩展到每代采集，关联率 = 已采集代/总代
const associated = stats.filter((s) => s.generation === 3).length;
console.log('关联率(本探针单代):', `${associated}/1`);

// ---- 3) 幂等：同一代重复 upsert 行数不变 ----
upsertDiffEvidence(db, SESSION, ev);
upsertDiffEvidence(db, SESSION, ev);
const after = readGenerationDiffStats(db, SESSION);
console.log('幂等: 重复 upsert 后行数', after.length, '(期望 1)');

console.log('VERDICT', JSON.stringify({
  deterministic,
  fingerprint: b.evalSetFingerprint,
  suites: b.suites.length,
  score: b.score,
  diffRows: after.length,
  gen3Status: loadable?.status ?? null,
}));

import { createDb } from '../src/repositories/db.js';

const db = createDb(process.argv[2] ?? 'data/codelens.db');
const sid = process.argv[3];

const rs = db.all(
  `SELECT generation, prev_generation, verdict, exit_code, reasons_json, created_at
   FROM policy_rsi_runs WHERE session_id = ? ORDER BY generation`,
  [sid],
);
console.log('policy_rsi_runs:', rs.length);
for (const r of rs) {
  console.log(`  g${r.generation} (prev=g${r.prev_generation}) verdict=${r.verdict} exit=${r.exit_code}`);
  if (r.reasons_json) console.log('    reasons:', r.reasons_json.slice(0, 400));
}

const jr = db.all(
  `SELECT id, verdict, score, coverage, executed, total, created_at
   FROM judge_runs WHERE session_id = ? ORDER BY id ASC`,
  [sid],
);
console.log('judge_runs:', jr.length);
for (const j of jr) {
  console.log(`  run#${j.id} verdict=${j.verdict} score=${j.score} coverage=${j.coverage} executed=${j.executed}/${j.total} ${new Date(Number(j.created_at)).toISOString()}`);
}

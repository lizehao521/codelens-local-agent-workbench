import { createDb } from '../src/repositories/db.js';

const db = createDb(process.argv[2] ?? 'data/codelens.db');
const sid = process.argv[3];

const s = db.get(`SELECT id, title, provider, model, created_at FROM sessions WHERE id = ?`, [sid]);
console.log('session:', s);

const rows = db.all(
  `SELECT id, iteration, tool_name, status, error_kind,
          args_json, result_summary, created_at
   FROM tool_calls WHERE session_id = ? ORDER BY id ASC`,
  [sid],
);
for (const r of rows) {
  console.log('\n========================================');
  console.log(`#${r.id} iter=${r.iteration} ${r.tool_name} status=${r.status} ${new Date(Number(r.created_at)).toISOString()}`);
  console.log('--- args ---');
  console.log(String(r.args_json ?? '').slice(0, 1200));
  console.log('--- result ---');
  console.log(String(r.result_summary ?? '').slice(0, 2600));
}

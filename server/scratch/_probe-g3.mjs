import { createDb } from '../src/repositories/db.js';

const db = createDb(process.argv[2] ?? 'data/codelens.db');
const sid = process.argv[3];

const rows = db.all(
  `SELECT id, iteration, tool_name, status, error_kind, args_json, result_summary, created_at
   FROM tool_calls WHERE session_id = ? ORDER BY created_at ASC`,
  [sid],
);
for (const r of rows) {
  const mark = r.status === 'success' ? 'OK ' : 'ERR';
  console.log(
    `${mark} #${r.id} iter=${r.iteration} ${r.tool_name} ${r.error_kind ?? ''} ${new Date(Number(r.created_at)).toISOString()}`,
  );
  console.log('   args:', String(r.args_json ?? '').slice(0, 240));
  if (r.status !== 'success') console.log('   res :', String(r.result_summary ?? '').slice(0, 240));
}

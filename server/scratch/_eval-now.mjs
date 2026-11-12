import path from 'node:path';
import { runEvalBattery } from '../src/services/eval/runner.js';

const root = path.resolve(process.cwd(), 'workspace');
const r = runEvalBattery(root, { includeHidden: true });
console.log('TOTAL', `${r.passed}/${r.total}`, 'score=', r.score.toFixed(4));
const suites = r.suites ?? r.results ?? [];
for (const s of suites) {
  console.log(String(s.id ?? s.suiteId).padEnd(22), `${s.passed}/${s.total}`);
}

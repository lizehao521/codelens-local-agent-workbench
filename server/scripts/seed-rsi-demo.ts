/**
 * Seed 数据 —— 给看板喂活的历史 Agent 数据。
 *
 * 产 6 代连续 session，每代有真实的 Judge verdicts（带 score），
 * 然后用 krsi 跑跨代对比，落 policy_rsi_runs。
 *
 * 跑法：cd server && npx tsx scripts/seed-rsi-demo.ts
 */
import { createDb } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { buildManifest } from '../src/services/rsi/manifest-builder.js';
import { spawn } from 'node:child_process';

const DB_PATH = process.env.AGENT_DB_PATH
  ? path.resolve(process.env.AGENT_DB_PATH)
  : path.join(path.resolve(process.cwd(), 'data'), 'codelens.db');
const KRSI = process.env.KRSI_PATH ?? '/tmp/krsi';

function nowTs() { return Math.floor(Date.now() / 1000); }

const SESSION_ID = 'demo-session-001';

// 6 代 score 曲线 —— 有趣的改进轨迹：
// g1 基线 → g2 初改 → g3 好起来 → g4 稳了但 tool_success_rate 回落（更新引入回归）→ g5 又拉上去 → g6 收敛
const GENS = [
  { s: 0.62, f: 0.45, e: 0.78 },  // g1 baseline — 不行
  { s: 0.74, f: 0.52, e: 0.71 },  // g2 ↑ ↓ ↓ — approval 摩擦反而升了！（not_improved）
  { s: 0.83, f: 0.38, e: 0.60 },  // g3 ↑ ↑ ↑ — 真改进（improved）
  { s: 0.77, f: 0.41, e: 0.62 },  // g4 ↓ ↓ ↑ — regression！（not_improved）
  { s: 0.89, f: 0.29, e: 0.48 },  // g5 ↑ ↑ ↑ — 拉回来（improved）
  { s: 0.91, f: 0.26, e: 0.44 },  // g6 ↑ ↑ ↑ — 继续收敛（improved）
];

function gVerdicts(scores: typeof GENS[number]) {
  return [
    { criterion: 'tool.success_rate', score: scores.s },
    { criterion: 'approval.friction',  score: scores.f },
    { criterion: 'budget.efficiency',  score: scores.e },
    { criterion: 'task.terminal',      score: undefined },
    { criterion: 'loop.health',        score: undefined },
  ];
}

async function seed() {
  const db = createDb(DB_PATH);
  db.exec(SCHEMA_SQL);

  // 清理旧 seed（幂等）—— 只有有 session_id 列的表才这么清
  for (const t of ['judge_verdicts', 'judge_runs', 'policy_rsi_runs', 'policy_injections']) {
    db.run(`DELETE FROM ${t} WHERE session_id = ?`, [SESSION_ID]);
  }
  // policy_versions 没有 session_id，按 source_judgment 清
  db.run("DELETE FROM policy_versions WHERE source_judgment LIKE ?", ['demo-seed-g%']);
  db.run('DELETE FROM sessions WHERE id = ?', [SESSION_ID]);

  const now = nowTs();

  // session —— 用真实 sessions schema
  db.run(`INSERT INTO sessions (id, title, provider, model, channel_mode, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [SESSION_ID, 'RSI 自回归 · 演示会话', 'demo', 'demo-model', 'auto', now, now]);

  // 6 代 policy_versions + judge_runs + judge_verdicts
  const judgeIds: number[] = [];

  for (let g = 1; g <= 6; g++) {
    const scores = GENS[g - 1];
    const verdicts = gVerdicts(scores);

    // policy_version
    const pv = db.run('INSERT INTO policy_versions (version, policy_json, parent_version, source_judgment, created_at) VALUES (?,?,?,?,?)',
      [g, JSON.stringify({ gen: g, rules_count: 2 + g, experience: 5 + g * 3 }), g > 1 ? g - 1 : null, `demo-seed-g${g}`, now + g * 60]);

    // judge_run 汇总（带 context_json，让 L2 深判可抽取 SemanticEvidence）
    const avgScore = ((scores.s + (1 - scores.f) + (1 - scores.e)) / 3).toFixed(4);
    let jv: 'pass' | 'fail' | 'inconclusive';
    if (g >= 4) jv = 'pass';
    else if (g === 3) jv = 'pass';
    else if (g === 2) jv = 'inconclusive';
    else jv = 'fail';

    const semanticEvidence = {
      goal: `在 /tmp/demo/g${g}/ 下搜索含 "TODO" 的 .ts 文件并汇总行数`,
      finalAnswer:
        g === 1 ? '只找到 1 个文件，漏掉了 src 目录下的 5 个；部分行数字段是空。'
        : g === 2 ? '找到 3 个文件，但 /src 路径被错拼成 /sr/c。'
        : g === 3 ? '正确找到 6 个 .ts 文件并汇总；但排序字段没按要求输出。'
        : g === 4 ? '完整输出 6 个文件 + 行数 + 路径；但 JSON 格式里混入了 markdown 代码块。'
        : g === 5 ? '完整、正确、JSON 格式干净；但遗漏了 .test.ts 文件。'
        : '完整覆盖所有 .ts + .test.ts，JSON 格式正确，排序按行数降序。',
      assistantTurns: 4 + Math.floor(g / 2),
      toolSummary: { total: 4 + g, success: Math.min(4 + g, 8 + g), failed: g === 2 ? 1 : 0 },
      finishReason: g <= 2 ? 'tool_limit_reached' : 'stop',
      toolCalls: [
        { name: 'fs-read', ok: true },
        { name: 'sys.exec', ok: g !== 2 },
        { name: 'fs-write', ok: g >= 4 },
      ],
    };
    const contextJson = JSON.stringify({
      sessionId: SESSION_ID,
      generation: g,
      semantic: semanticEvidence,
      // 留位置给 L0 判决汇总（看板用）
      summary: { avgScore, verdict: jv, criteria: verdicts },
    });

    const jr = db.run(
      'INSERT INTO judge_runs (session_id, verdict, score, coverage, executed, total, context_json, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [SESSION_ID, jv, Number(avgScore), 1.0, 5, 5, contextJson, now + g * 60 + 5],
    );
    judgeIds.push(Number(jr.lastInsertRowid));

    // judge_verdicts — 5 条
    for (const v of verdicts) {
      let status: 'pass' | 'fail' | 'unexec' = 'pass';
      let detail: string = '';
      if (v.score !== undefined) {
        status = v.score >= 0.7 ? 'pass' : 'fail';
        detail = `score=${v.score}`;
      } else if (v.criterion === 'task.terminal') {
        status = g <= 2 ? 'fail' : 'pass';
        detail = g <= 2 ? 'finish_reason=tool_limit_reached' : 'finish_reason=stop';
      } else {
        status = 'pass';
        detail = 'circuit_breaker=closed';
      }
      db.run(`INSERT INTO judge_verdicts (run_id, session_id, layer, criterion, status, score, detail, created_at)
              VALUES (?,?,?,?,?,?,?,?)`, [Number(jr.lastInsertRowid), SESSION_ID, 'L0', v.criterion, status, v.score ?? null, detail, now + g * 60 + 5]);
    }

    // 经验沉淀
    if (g >= 2) {
      db.run('INSERT INTO policy_injections (session_id, policy_version, lesson, created_at) VALUES (?,?,?,?)',
        [SESSION_ID, g, `gen${g}: 第 ${g} 轮 — 把 fs-read 优先放前面`, now + g * 60 + 10]);
    }
  }

  // ── 跨代 krsi 对比 ──
  await mkdir('/tmp/rsi-seed', { recursive: true });

  for (let i = 1; i < 6; i++) {
    const prevGen = i, nextGen = i + 1;
    const prev = buildManifest({ producer: 'demo-seed', generation: prevGen,
      verdicts: gVerdicts(GENS[i - 1]).map(v => ({ layer: 'L0' as const, criterion: v.criterion, status: 'pass' as const, score: v.score })) });
    const next = buildManifest({ producer: 'demo-seed', generation: nextGen,
      verdicts: gVerdicts(GENS[i]).map(v => ({ layer: 'L0' as const, criterion: v.criterion, status: 'pass' as const, score: v.score })) });

    const prevPath = `/tmp/rsi-seed/p-${prevGen}.json`, nextPath = `/tmp/rsi-seed/n-${nextGen}.json`;
    const reportPath = `/tmp/rsi-seed/r-${prevGen}-${nextGen}.txt`;
    const ledgerPath = `/tmp/rsi-seed/l-${prevGen}-${nextGen}.jsonl`;
    await writeFile(prevPath, JSON.stringify(prev));
    await writeFile(nextPath, JSON.stringify(next));

    const exit = await new Promise<number>(res => spawn(KRSI, [prevPath, nextPath, reportPath, ledgerPath]).on('close', res));
    const report = await readFile(reportPath, 'utf8').catch(() => '');
    const verdict = report.match(/判定：(\S+)/)?.[1] ?? 'unknown';
    const reasons = [...report.matchAll(/理由：(.+)/g)].map(m => m[1]);

    db.run(`INSERT INTO policy_rsi_runs
      (judge_run_id, session_id, generation, prev_generation, verdict, exit_code,
       reasons_json, prev_readings_json, next_readings_json, ledger_path, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [judgeIds[nextGen - 1] ?? 0, SESSION_ID, nextGen, prevGen, verdict, exit,
       JSON.stringify(reasons), JSON.stringify(prev.readings), JSON.stringify(next.readings),
       ledgerPath, now + nextGen * 60 + 30]);

    const icon = exit === 0 ? '✅' : exit === 1 ? '🔶' : exit === 2 ? '⛔' : '❓';
    console.log(`RSI g${prevGen}→g${nextGen} ${icon} ${verdict}  ${reasons.length ? reasons.join(' | ') : '全部指标严格变好'}`);
  }

  db.close();
  console.log('\n✅ Seed 完成');
}

seed().catch((e) => { console.error(e); process.exit(1); });

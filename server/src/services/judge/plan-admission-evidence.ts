/**
 * 计划准入证据采集（残留①）——给 JudgeEvidence.planAdmission 填真实生产证据。
 *
 * 纯 IO 派生 + 确定性取值，逻辑独立成模块（judge.service.ts 在行数棘轮上）。
 * 数据来源（残留②已落真实证据源）：
 *  - items / activeItemId：agent_plans 按 sessionId 派生（复用 buildPlanWriteContext）；
 *  - requestedItemId / operation：本轮最后一条 fs.write 的 tool_calls.args_json。
 *
 * 为什么取最后一条 fs.write：judge 是 run 收尾后的一次判决，单值确定可复算；
 * 前面的写在执行那一刻已被 gateWriteCall（残留②）逐条拦过，不重复判。
 *
 * 诚实口径：无活跃条目、或本轮无 fs.write → 返回 undefined，判据据此 unexec + weightExcluded，
 * 不编造证据（C4：UNEXEC ≠ PASS / FAIL）。
 */
import type { Db } from '../../repositories/db.js';
import type { JudgeEvidence } from './types.js';
import { buildPlanWriteContext } from '../plan/plan-write-context.js';
import { generationStart } from '../rsi/controlled-release.js';

interface WriteArgsRow {
  tool_name: string;
  args_json: string;
  created_at: number;
}

/** 从本轮 tool_calls 里取最后一条 fs.write 的 planItemId / operation。 */
function lastWriteArgs(db: Db, sessionId: string, runStartedAt?: number): { requestedItemId: string | null; operation: string } | undefined {
  const start = generationStart(runStartedAt);
  const rows = db.all<WriteArgsRow>(
    `SELECT tool_name, args_json, created_at FROM tool_calls
      WHERE session_id = ? AND tool_name = 'fs.write'
      ORDER BY created_at DESC`,
    [sessionId],
  );
  const row = (start === undefined ? rows : rows.filter((r) => r.created_at >= start))[0];
  if (!row) return undefined;
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(row.args_json) as Record<string, unknown>; } catch { /* 脏 args → 空对象 */ }
  return {
    requestedItemId: typeof args.planItemId === 'string' ? args.planItemId : null,
    operation: typeof args.operation === 'string' ? args.operation : '',
  };
}

/**
 * 派生 run 级 planAdmission 证据。无活跃条目 / 无 fs.write → undefined。
 */
export function collectPlanAdmissionEvidence(
  db: Db, sessionId: string, runStartedAt?: number,
): JudgeEvidence['planAdmission'] | undefined {
  const pw = buildPlanWriteContext(db, sessionId);
  if (!pw) return undefined;
  const write = lastWriteArgs(db, sessionId, runStartedAt);
  if (!write) return undefined;
  return {
    items: pw.items,
    activeItemId: pw.activeItemId,
    requestedItemId: write.requestedItemId,
    toolName: 'fs.write',
    operation: write.operation,
  };
}

/**
 * iteration-store.ts — 把账本读成「可判定的迭代记录」。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────
 * 账本记的是**事件**（每次派单一行），而迭代判据问的是**结论**（这一轮算不算达标、要不要回滚）。
 * 两者之间差一次翻译，而且这次翻译必须在一处完成——前端不能自己算，
 * 否则同一份账本在两个端会得出两个结论（这正是"前后端一致性"最容易崩的地方）。
 *
 * ── 账本层 → 六态的映射 ────────────────────────────────────
 * 账本里的 `layer` 是**失败归因的七层**（infra/budget/behavior/spec/integration/implementation/judge），
 * 六态是**跨代判定**（improved/not_improved/refused/undecidable/skipped/error）。
 * 两者不是一回事，但可以机械映射——映射规则写在 `layerToVerdict`，逐条注明依据。
 *
 * 注意一处有意为之的保守：`behavior` / `spec` / `budget` 三种失败映射成 **undecidable** 而不是
 * not_improved。因为那三种情况下 Agent 根本没产出改动（或没被真正派单），
 * 「没变好」这个结论不成立——硬判 not_improved 会把「题没出好」记成「实现退步」。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChangeDomainId, IterationTrigger } from './change-domain.js';
import { resolveDomain } from './change-domain.js';
import { evaluateIteration, type GateResult, type IterationResult, type RsiVerdict } from './iteration-gate.js';

// 本文件在 src/services/rsi/ 下：往上一级是 src/services/，'../../..' 才是 server/。
// 少写一级会让账本路径指向 src/.self-upgrade（不存在），表现为「迭代列表永远是空的」——
// 一个不报错、只是静默返回空数组的错。
const SERVER = fileURLToPath(new URL('../../..', import.meta.url));
const LEDGER = path.resolve(SERVER, '..', '.self-upgrade', 'ledger.jsonl');

export interface LedgerRow {
  at?: string;
  task?: string;
  verdict?: string;
  attempt?: number;
  layer?: string;
  code?: string;
  version?: string | null;
  sendSec?: number;
  layers?: Record<string, number>;
  [k: string]: unknown;
}

export interface IterationRecord {
  /** 稳定 id：题 + 轮次（账本没有全局 id，用它拼一个可寻址的）。 */
  id: string;
  task: string;
  at: string;
  attempt: number;
  /** 原始账本行（前端可展开看明细，后端不裁剪）。 */
  raw: LedgerRow;
  verdict: RsiVerdict;
  domain: ChangeDomainId;
  trigger: IterationTrigger;
  /** 判据表 + 决策（由 iteration-gate 纯函数算出）。 */
  result: IterationResult;
  version: string | null;
}

/** 账本层 → 六态。逐条注明依据，别改口径而不改注释。 */
function layerToVerdict(row: LedgerRow): RsiVerdict {
  if (row.verdict === 'upgraded') return 'improved';
  // 人工确认的升级（围栏手动全绿后记 verified）：与 upgraded 同口径，免得真实升级被投影成 undecidable
  if (row.verdict === 'verified') return 'improved';
  if (row.verdict === 'halted') return 'refused';
  switch (row.layer) {
    case 'infra':
      // 服务没起来 / 上游空响应：本轮根本没被真正评估
      return 'error';
    case 'judge':
      // 尺子自己错（被改写 / 自证不过）：拒收，且必须停机
      return 'refused';
    case 'behavior':
    case 'spec':
    case 'budget':
      // 没产出改动或没走完：不能判「没变好」
      return 'undecidable';
    case 'integration':
    case 'implementation':
      return 'not_improved';
    default:
      // 分层机制上线前的老账：老实说不知道
      return 'undecidable';
  }
}

/**
 * 由账本行重建闸结果。
 *
 * 账本没存每一道闸的原始结论，所以这里只能按"这一轮发生了什么"做保守重建：
 * 升级行 = 全 pass；失败行 = 至少一道 fail。**不假装有 unexec 信息**——
 * 那是账本当前的口径缺口（见 docs/rsi-kernel-charter.md 第 10 节 UNEXEC 清单）。
 */
function gatesFromRow(row: LedgerRow): GateResult[] {
  const ids = ['protected', 'judge-fingerprint', 'target-changed', 'typecheck', 'judge-selftest', 'judge', 'full-suite'];
  const ok = row.verdict === 'upgraded' || row.verdict === 'verified';
  return ids.map((id) => ({ id, status: ok ? ('pass' as const) : ('fail' as const) }));
}

function rowToRecord(row: LedgerRow, idx: number): IterationRecord {
  const task = String(row.task ?? 'unknown');
  const attempt = Number(row.attempt ?? 0);
  const verdict = layerToVerdict(row);
  // 账本没记域；按题目的靶子推断（当前所有题都在工具层）。
  // 真接上域授权后，这一行要改成读账本里的 domain 字段。
  const domain = resolveDomain([`src/tools/builtin/${task}.tool.ts`]);
  const result = evaluateIteration({
    iterationId: `${task}#${attempt || idx}`,
    trigger: 'manual',
    domain,
    attempts: attempt || 1,
    maxAttempts: 3,
    verdict,
    gates: gatesFromRow(row),
    guardRegressed: 0,
    coverage: row.verdict === 'upgraded' || row.verdict === 'verified' ? 1 : 0.6,
    outOfScopeChanges: 0,
    humanApproved: true,
  });
  return {
    id: `${task}#${attempt || idx}`,
    task,
    at: String(row.at ?? ''),
    attempt,
    raw: row,
    verdict,
    domain,
    trigger: 'manual',
    result,
    version: typeof row.version === 'string' ? row.version : null,
  };
}

export function readLedger(): LedgerRow[] {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as LedgerRow;
      } catch {
        return null;
      }
    })
    .filter((r): r is LedgerRow => r !== null);
}

/** 最近的迭代记录（新的在前）。默认 50 条，够前端一屏 + 翻一页。 */
export function listIterations(limit = 50): IterationRecord[] {
  return readLedger()
    .map((row, i) => rowToRecord(row, i))
    .reverse()
    .slice(0, limit);
}

export function getIteration(id: string): IterationRecord | null {
  return listIterations(500).find((r) => r.id === id) ?? null;
}

export interface IterationSummary {
  total: number;
  byDecision: Record<string, number>;
  byDomain: Record<string, number>;
  /** 需要人介入的条数（rollback / escalate / halt）。 */
  attention: number;
}

export function summarize(records: IterationRecord[]): IterationSummary {
  const byDecision: Record<string, number> = {};
  const byDomain: Record<string, number> = {};
  let attention = 0;
  for (const r of records) {
    byDecision[r.result.decision] = (byDecision[r.result.decision] ?? 0) + 1;
    byDomain[r.domain] = (byDomain[r.domain] ?? 0) + 1;
    if (r.result.decision === 'rollback' || r.result.decision === 'escalate' || r.result.decision === 'halt') attention += 1;
  }
  return { total: records.length, byDecision, byDomain, attention };
}

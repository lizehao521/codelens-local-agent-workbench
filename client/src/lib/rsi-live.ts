/** 自迭代雷达的纯展示逻辑：决策语义、轮次 diff、检索证据提取。 */
import type { RsiIterationRecord } from '../services/api';

export type LiveTone = 'success' | 'warning' | 'danger' | 'muted';

export function decisionLabel(decision: string): string {
  return (
    {
      continue: '继续',
      retry: '重试',
      rollback: '回滚',
      escalate: '升级人工',
      halt: '停止',
    }[decision] ?? decision
  );
}

export function decisionTone(decision: string): LiveTone {
  if (decision === 'continue') return 'success';
  if (decision === 'retry') return 'warning';
  if (decision === 'rollback' || decision === 'halt') return 'danger';
  return 'muted';
}

export function verdictTone(verdict: string): LiveTone {
  if (verdict === 'improved') return 'success';
  if (verdict === 'not_improved' || verdict === 'refused') return 'danger';
  if (verdict === 'undecidable' || verdict === 'skipped') return 'warning';
  return 'muted';
}

export function criteriaCounts(item: RsiIterationRecord): { pass: number; fail: number; unexec: number } {
  const out = { pass: 0, fail: 0, unexec: 0 };
  for (const c of item.result?.criteria ?? []) out[c.status] += 1;
  return out;
}

function short(value: unknown, max = 140): string {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  try {
    const s = JSON.stringify(value);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(value);
  }
}

export interface RawChange {
  key: string;
  from: string;
  to: string;
}

/** 只看顶层账本字段；跳过时间/任务/id/result 这类每轮必然变化或过大的键。 */
const DIFF_SKIP = new Set(['at', 'task', 'id', 'attempt', 'raw', 'result']);

export function rawChanges(prev: RsiIterationRecord | undefined, current: RsiIterationRecord): RawChange[] {
  if (!prev) return [];
  const keys = new Set([...Object.keys(prev.raw ?? {}), ...Object.keys(current.raw ?? {})]);
  const out: RawChange[] = [];
  for (const key of keys) {
    if (DIFF_SKIP.has(key)) continue;
    const before = short((prev.raw ?? {})[key]);
    const after = short((current.raw ?? {})[key]);
    if (before !== after) out.push({ key, from: before || '—', to: after || '—' });
    if (out.length >= 8) break;
  }
  return out;
}

export interface SearchEvidence {
  key: string;
  text: string;
}

const SIGNAL_KEY = /signal|strategy|parameter|param|policy|criteria|version|model|threshold|budget/i;

/** 直接展示与参数/信号/策略有关的原始字段；不推断未记录的变更。 */
export function rawHighlights(raw: Record<string, unknown> | undefined): SearchEvidence[] {
  if (!raw) return [];
  return Object.entries(raw)
    .filter(([key, value]) => SIGNAL_KEY.test(key) && value != null)
    .slice(0, 8)
    .map(([key, value]) => ({ key, text: short(value) }));
}

const SEARCH_KEY = /search|web|similar|competitor|reference|evidence|benchmark|调研|检索|同类/i;

/** 从账本原始行里提取联网检索证据；没有就返回空数组，不编造。 */
export function extractSearchEvidence(raw: Record<string, unknown> | undefined): SearchEvidence[] {
  if (!raw) return [];
  const out: SearchEvidence[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!SEARCH_KEY.test(key) || value == null) continue;
    if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) {
        out.push({ key: `${key}[${i}]`, text: short(item) });
        if (out.length >= 6) return out;
      }
    } else {
      out.push({ key, text: short(value) });
    }
    if (out.length >= 6) break;
  }
  return out;
}

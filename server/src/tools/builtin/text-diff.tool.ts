/** text.diff — line-based unified diff with context lines. */

import type { ToolDefinition } from '../../types/tool.js';

export interface DiffOp {
  type: 'common' | 'add' | 'del';
  line: string;
}

/** Myers-style O(ND) LCS over lines; falls back to a simple scan for huge inputs. */
export function lineDiff(left: string[], right: string[]): DiffOp[] {
  const n = left.length;
  const m = right.length;
  if (n * m > 4_000_000) {
    // Too large for LCS: mark everything replaced.
    return [
      ...left.map((line) => ({ type: 'del' as const, line })),
      ...right.map((line) => ({ type: 'add' as const, line })),
    ];
  }
  // Classic dynamic programming LCS (bounded by the guard above).
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = left[i] === right[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      ops.push({ type: 'common', line: left[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ type: 'del', line: left[i]! });
      i += 1;
    } else {
      ops.push({ type: 'add', line: right[j]! });
      j += 1;
    }
  }
  while (i < n) ops.push({ type: 'del', line: left[i++]! });
  while (j < m) ops.push({ type: 'add', line: right[j++]! });
  return ops;
}

export function renderUnified(ops: DiffOp[], contextLines: number): { text: string; additions: number; deletions: number } {
  const additions = ops.filter((op) => op.type === 'add').length;
  const deletions = ops.filter((op) => op.type === 'del').length;
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let idx = 0; idx < ops.length; idx += 1) {
    if (ops[idx]!.type !== 'common') {
      for (let k = Math.max(0, idx - contextLines); k <= Math.min(ops.length - 1, idx + contextLines); k += 1) {
        keep[k] = true;
      }
    }
  }
  // 先算出每条 op 的左右行号，段头要报区间（unified diff 格式的硬要求——
  // 少了 `@@ -a,b +c,d @@` 就不是 unified diff，下游按格式解析会直接失败）。
  const leftNo: number[] = [];
  const rightNo: number[] = [];
  let l = 1;
  let r = 1;
  for (const op of ops) {
    leftNo.push(op.type === 'add' ? 0 : l);
    rightNo.push(op.type === 'del' ? 0 : r);
    if (op.type !== 'add') l += 1;
    if (op.type !== 'del') r += 1;
  }
  // 连续保留区切段：中间被丢弃的行会断开段落。
  const hunks: Array<{ ops: number[] }> = [];
  for (let idx = 0; idx < ops.length; idx += 1) {
    if (!keep[idx]) continue;
    const last = hunks[hunks.length - 1];
    if (last && last.ops[last.ops.length - 1] === idx - 1) last.ops.push(idx);
    else hunks.push({ ops: [idx] });
  }
  const lines: string[] = [];
  for (const hunk of hunks) {
    const first = hunk.ops[0]!;
    const last = hunk.ops[hunk.ops.length - 1]!;
    const lStart = leftNo[first]! === 0 ? leftNo[first + 1] ?? 1 : leftNo[first]!;
    const rStart = rightNo[first]! === 0 ? rightNo[first + 1] ?? 1 : rightNo[first]!;
    const lCount = hunk.ops.filter((i) => ops[i]!.type !== 'add').length;
    const rCount = hunk.ops.filter((i) => ops[i]!.type !== 'del').length;
    // 记录首行号在 add 行上的退化情况：统一取段内第一个有效行号。
    void last;
    lines.push(`@@ -${Math.max(lStart, 0)},${lCount} +${Math.max(rStart, 0)},${rCount} @@`);
    for (const idx of hunk.ops) {
      const op = ops[idx]!;
      if (op.type === 'common') lines.push(` ${op.line}`);
      else if (op.type === 'add') lines.push(`+${op.line}`);
      else lines.push(`-${op.line}`);
    }
  }
  return { text: lines.join('\n'), additions, deletions };
}

export const textDiffTool: ToolDefinition = {
  name: 'text.diff',
  wireName: 'text_diff',
  displayName: '文本对比',
  category: 'compute',
  description: '逐行对比两段文本，输出 unified diff（含上下文行，默认 3 行）与新增/删除统计。',
  inputSchema: {
    type: 'object',
    properties: {
      left: { type: 'string', description: '左侧文本（基线）', maxLength: 500000 },
      right: { type: 'string', description: '右侧文本（新版本）', maxLength: 500000 },
      contextLines: { type: 'number', description: '上下文行数 0-10，缺省 3', minimum: 0, maximum: 10 },
    },
    required: ['left', 'right'],
    additionalProperties: false,
  },
  timeoutMs: 5000,
  risk: 'low',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: true,
  maxResultChars: 4000,
  enabled: () => true,
  handler: async (args) => {
    const contextLines = args.contextLines === undefined ? 3 : Number(args.contextLines);
    if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 10) {
      return {
        ok: false,
        summary: 'contextLines 必须是 0-10 的整数',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'contextLines 必须是 0-10 的整数' },
      };
    }
    const left = String(args.left ?? '').split('\n');
    const right = String(args.right ?? '').split('\n');
    const ops = lineDiff(left, right);
    const { text, additions, deletions } = renderUnified(ops, contextLines);
    const identical = additions === 0 && deletions === 0;
    return {
      ok: true,
      summary: identical ? '两段文本完全一致' : `新增 ${additions} 行，删除 ${deletions} 行`,
      data: { diff: text, additions, deletions, identical },
    };
  },
};

/**
 * diff 重建（从 fs.write 的操作参数还原逐字 +/- 行）。
 *
 * 从 generation-diff.ts 拆出：新增文件受「≤300 行」硬闸约束。
 * 这里只做纯函数式重建，不碰 DB、不决定状态；状态判定见 resolveStatus。
 *
 * ★重建边界（codelens exp169 Q1）：只有 create / append / replace 可产出真实行；
 *   overwrite 的 content 是全文，禁生成 +全文（会系统性低估零变更）；delete/purge/
 *   rename 无正文语义，只记元事件。不可重建者一律记盲区，绝不伪造 +/- 行。
 */
import { DIFF_LIMITS, type DiffEvent } from './generation-diff.schema.js';

/** fs.write 的三种命名形态（模型可能回 name 或 wireName）。 */
export const WRITE_TOOLS = new Set(['fs.write', 'fs_write', 'fs-write']);
export const EXEC_TOOLS = new Set(['sys.exec', 'sys_exec', 'sys-exec']);
/** sys.exec 默认白名单中可写文件的命令（node -e / git checkout|reset|apply）。 */
export const SHELL_WRITE_COMMANDS = new Set(['node', 'git']);
/** 只有这三种操作能重建出真实 +/- 行。 */
const RECONSTRUCTABLE = new Set(['create', 'append', 'replace']);
const OTHER_WRITE_OPS = new Set(['overwrite', 'delete', 'purge', 'rename']);

export interface ToolCallRow {
  id: string;
  call_id: string;
  tool_name: string;
  tool_wire_name: string;
  category: string;
  source: string;
  status: string;
  args_json: string;
  created_at: number;
}

/** 单次采集的累积器，避免在循环里反复拼大字符串。 */
export interface Acc {
  blocks: string[];
  events: DiffEvent[];
  coveredWrites: number;
  blindSpots: string[];
  invalidArgs: number;
  metadataOnly: boolean;
  bytes: number;
  truncated: boolean;
}

export function createAcc(): Acc {
  return {
    blocks: [], events: [], coveredWrites: 0, blindSpots: [],
    invalidArgs: 0, metadataOnly: false, bytes: 0, truncated: false,
  };
}

/** 块边界头：json 化 path，防止换行/引号把块头撕裂。 */
function blockHeader(path: string | null, op: string, callId: string): string {
  return `--- RSI-GEN path=${JSON.stringify(path ?? '')} op=${op} call=${callId}`;
}

/** 把一段文本按行加前缀；空串返回空数组（不产伪行）。 */
function prefixed(text: string, sign: '+' | '-'): string[] {
  if (text.length === 0) return [];
  return text.split('\n').map((line) => `${sign}${line}`);
}

/** 解析单行 args；非法（含 8192 截断）返回 null 由调用方计为 invalid。 */
export function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 按事件顺序填装：首个会越 256 KiB 的块即停止追加正文，置 text_truncated。 */
export function addBlock(acc: Acc, lines: readonly string[]): void {
  if (acc.truncated || lines.length === 0) return;
  const text = `${lines.join('\n')}\n`;
  const size = Buffer.byteLength(text, 'utf8');
  if (acc.bytes + size > DIFF_LIMITS.aggregateBytes) {
    acc.truncated = true;
    return;
  }
  acc.blocks.push(text);
  acc.bytes += size;
}

/** 处理一条 fs.write 调用；所有分支都保证「不伪造正文」。 */
export function handleWrite(acc: Acc, row: ToolCallRow): void {
  const args = parseArgs(row.args_json);
  if (args === null) {
    acc.invalidArgs += 1;
    acc.events.push({
      callId: row.call_id, path: null, op: 'unknown',
      plus: 0, minus: 0, reconstructable: false, note: 'invalid_args_truncated',
    });
    return;
  }
  if (row.status !== 'success') return; // 未执行的写不构成变更
  const path = typeof args.path === 'string' ? args.path : null;
  const op = typeof args.operation === 'string' ? args.operation : 'unknown';

  if (OTHER_WRITE_OPS.has(op)) {
    acc.blindSpots.push(op);
    acc.events.push({
      callId: row.call_id, path, op, plus: 0, minus: 0, reconstructable: false,
      note: op === 'overwrite' ? 'unreconstructable:overwrite' : 'metadata_only',
    });
    if (op !== 'overwrite') acc.metadataOnly = true;
    const tag = op === 'overwrite' ? 'unreconstructable' : 'metadata_only';
    acc.blocks.push(`${blockHeader(path, op, row.call_id)}\n# ${tag}\n`);
    return;
  }
  if (!RECONSTRUCTABLE.has(op)) {
    acc.blindSpots.push(`unknown_op:${op}`);
    acc.events.push({
      callId: row.call_id, path, op, plus: 0, minus: 0, reconstructable: false, note: 'unknown_op',
    });
    return;
  }

  const lines: string[] = [blockHeader(path, op, row.call_id)];
  if (op === 'replace') {
    const oldText = typeof args.oldText === 'string' ? args.oldText : '';
    const newText = typeof args.newText === 'string' ? args.newText : '';
    // 同写不计有效变更：产行会让 isZeroEffectiveDiff 误判为非零。
    if (oldText === newText) {
      acc.events.push({
        callId: row.call_id, path, op, plus: 0, minus: 0, reconstructable: true, note: 'same_write',
      });
      acc.blocks.push(`${blockHeader(path, op, row.call_id)}\n# same_write\n`);
      return;
    }
    const del = prefixed(oldText, '-');
    const add = prefixed(newText, '+');
    lines.push(...del, ...add);
    acc.coveredWrites += 1;
    acc.events.push({
      callId: row.call_id, path, op, plus: add.length, minus: del.length, reconstructable: true,
    });
    addBlock(acc, lines);
    return;
  }
  // create / append：只产 + 行（append 无法知道插入点，不声称位置精确）。
  const content = typeof args.content === 'string' ? args.content : '';
  const add = prefixed(content, '+');
  if (add.length === 0) {
    acc.events.push({
      callId: row.call_id, path, op, plus: 0, minus: 0, reconstructable: true, note: 'empty_content',
    });
    acc.blocks.push(`${blockHeader(path, op, row.call_id)}\n# empty_content\n`);
    return;
  }
  lines.push(...add);
  acc.coveredWrites += 1;
  acc.events.push({ callId: row.call_id, path, op, plus: add.length, minus: 0, reconstructable: true });
  addBlock(acc, lines);
}

/**
 * 状态判定（codelens exp169 Q3）：
 *   invalid 截断 → unavailable（无法枚举"还有什么写"，给 partial 会误导门禁）
 *   任一盲区/超限 → partial
 *   否则 → complete（含"本代零写调用"，此时 covered_writes=0，el 仍为 0）
 */
export function resolveStatus(acc: Acc): 'complete' | 'partial' | 'unavailable' {
  if (acc.invalidArgs > 0) return 'unavailable';
  if (acc.blindSpots.length > 0 || acc.truncated) return 'partial';
  return 'complete';
}

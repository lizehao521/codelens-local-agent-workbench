/**
 * 判据：fs.read 的结果回灌给模型时，必须是**可续读、不破碎、不越预算**的。
 *
 * 为什么需要这组判据（而不是直接改代码）：
 *   这是一个已被观测到的真实故障。session 40e4cf69 里，Agent 被要求修自己
 *   39KB 的源码，14 轮工具调用全部花在读同一个文件上，一次写入都没发生。
 *   根因不在模型，在回灌链：`recordSuccess` 先 `JSON.stringify(data)` 再按
 *   字符前缀裁（工具声明 4000 字符，全局再 1000 token），于是模型拿到的是
 *   **半截 JSON**，只覆盖原文约 23%，且唯一的续读指引指向 `.artifacts/*.json`
 *   ——那个文件序列化后只有 1 行，`lineStart/lineEnd` 在它上面完全失效，
 *   每次只能读到前 4000 字符。这是一道旋转门：越读越不走。
 *
 * 判据只看 executor 交给模型的那段文本（ExecutionOutcome.observation），
 * 不看内部实现。满足它的实现可以是结构化裁剪、工具自渲染、或别的路径。
 *
 * 判据是「尺子」：本文件受 check-self-upgrade.mjs 保护，被改则升级作废。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolExecutor, type ExecuteItemInput, type ExecutionOutcome } from '../../src/services/tools/executor.service.js';
import { fsReadTool } from '../../src/tools/builtin/fs-read.tool.js';
import { estimateTextTokens } from '../../src/services/agent/token-estimator.js';
import type { ToolCallRow } from '../../src/services/memory/tool-call.repository.js';
import { argsDigest } from '../../src/utils/digest.js';

/** 单条 observation 的硬顶，与 executor 的 OBSERVATION_MAX_TOKENS 同口径。 */
const OBSERVATION_MAX_TOKENS = 1000;

/** 大文件：每行带唯一标记，便于判定「哪些行真的到了模型眼前」。 */
const TOTAL_LINES = 320;
const LINE_FMT = (n: number) => `const value_${String(n).padStart(4, '0')} = ${n}; // MARK-${String(n).padStart(4, '0')}`;

let sandboxRoot: string;

beforeEach(() => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), 'codelens-obs-'));
  const body = Array.from({ length: TOTAL_LINES }, (_, i) => LINE_FMT(i + 1)).join('\n');
  writeFileSync(path.join(sandboxRoot, 'big.ts'), body + '\n', 'utf8');
  writeFileSync(path.join(sandboxRoot, 'tiny.ts'), 'export const answer = 42;\n', 'utf8');
});

afterEach(() => {
  try {
    rmSync(sandboxRoot, { recursive: true, force: true });
  } catch {
    /* 清理是 best-effort，不影响结论 */
  }
});

function callRow(callId: string): ToolCallRow {
  return {
    id: `tc_${callId}`,
    session_id: 'sess_obs',
    message_id: 'msg_obs',
    call_id: callId,
    tool_name: 'fs.read',
    tool_wire_name: 'fs_read',
    display_name: '读取文件',
    category: 'file',
    source: 'builtin',
    risk: 'low',
    approval_mode: 'none',
    channel: 'native',
    iteration: 1,
    args_json: '{}',
    args_digest: argsDigest({}),
    status: 'pending',
    error_kind: null,
    error_msg: null,
    result_ref: null,
    result_summary: null,
    truncated: 0,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    created_at: Date.now(),
  } as unknown as ToolCallRow;
}

/** 走真实 ToolExecutor，拿模型真正会收到的 observation。 */
async function readObservation(args: Record<string, unknown>, callId = `c_${Math.random().toString(36).slice(2, 8)}`): Promise<ExecutionOutcome> {
  const rows: ToolCallRow[] = [];
  const executor = new ToolExecutor({
    toolCalls: {
      insert: (row: ToolCallRow) => (rows.push(row), row),
      listBySession: () => rows,
      markRunning: () => undefined,
      markFinished: (id: string, patch: Partial<ToolCallRow>) => {
        const row = rows.find((r) => r.id === id);
        if (row) Object.assign(row, patch);
      },
    } as never,
    toolResults: {
      insert: (fields: Record<string, unknown>) => ({ id: 'tr_1', created_at: Date.now(), ...fields }),
    } as never,
    approvals: { hasSessionGrant: () => false, requestApproval: async () => 'allow_once' } as never,
    sse: { emit: () => undefined } as never,
    sandboxRoot,
    canRetry: () => false,
    onRetryConsumed: () => undefined,
  });

  const toolCall = callRow(callId);
  rows.push(toolCall);
  const outcomes = await executor.executeBatch([
    {
      toolCall,
      definition: fsReadTool,
      args,
      digest: argsDigest(args),
      verdict: { risk: 'low', approvalMode: 'none', effect: null },
      channel: 'native',
      iteration: 1,
    } as ExecuteItemInput,
  ]);
  const outcome = outcomes.get(callId);
  if (!outcome) throw new Error('executor 没有返回 outcome');
  return outcome;
}

/** observation 里出现了哪些标记行 —— 这是「模型真的看到了」的唯一证据。 */
function coveredMarks(observation: string): Set<number> {
  const out = new Set<number>();
  for (const m of observation.matchAll(/MARK-(\d{4})/g)) out.add(Number(m[1]));
  return out;
}

/** 模型能从这段文本里读到的「下一段从第几行开始」。 */
function nextLineStart(observation: string): number | null {
  const m = /lineStart"?\s*[:=]\s*(\d+)/.exec(observation);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

describe('fs.read → observation：大文件必须可续读', () => {
  it('T1 裁剪后的 observation 必须给出可解析的续读行号', async () => {
    const outcome = await readObservation({ path: 'big.ts', maxBytes: 10_485_760 });
    const next = nextLineStart(outcome.observation);
    expect(
      next,
      `模型看到的 observation 里没有可用的下一段行号，无法推进：\n${outcome.observation.slice(0, 400)}`,
    ).not.toBeNull();
    expect(next!).toBeGreaterThan(1);
    expect(next!).toBeLessThanOrEqual(TOTAL_LINES);
  });

  it('T2 只按 observation 的指引反复读，必须在有限步内覆盖全文', async () => {
    const covered = new Set<number>();
    const visitedStarts = new Set<number>();
    let args: Record<string, unknown> = { path: 'big.ts', maxBytes: 10_485_760 };
    let steps = 0;

    while (steps < 40) {
      const outcome = await readObservation(args, `c_step_${steps}`);
      expect(outcome.status, `第 ${steps} 步执行失败：${outcome.summary}`).toBe('success');
      for (const mark of coveredMarks(outcome.observation)) covered.add(mark);

      const next = nextLineStart(outcome.observation);
      if (next === null) break; // 没有续读指引 = 模型无法再推进
      if (next <= 1 || next > TOTAL_LINES) break;
      if (visitedStarts.has(next)) break; // 转圈：同一个起点被指了第二次
      visitedStarts.add(next);
      args = { path: 'big.ts', maxBytes: 10_485_760, lineStart: next };
      steps += 1;
    }

    const missing = Array.from({ length: TOTAL_LINES }, (_, i) => i + 1).filter((n) => !covered.has(n));
    expect(
      missing.length,
      `按 observation 指引读了 ${steps} 步后，仍有 ${missing.length} 行没到模型眼前（首个缺失 MARK-${String(missing[0] ?? 0).padStart(4, '0')}）`,
    ).toBe(0);
  });

  it('T3 每一条 observation 都必须守在 token 硬顶内', async () => {
    const outcome = await readObservation({ path: 'big.ts', maxBytes: 10_485_760 });
    expect(estimateTextTokens(outcome.observation)).toBeLessThanOrEqual(OBSERVATION_MAX_TOKENS);
  });

  it('T4 不得把模型指向一个同样读不全的归档文件去续读', async () => {
    const outcome = await readObservation({ path: 'big.ts', maxBytes: 10_485_760 });
    // 判的是「把归档当成续读入口」这个动作，不是「提到归档」这个事实。
    // 正确实现通常会说「不要读 .artifacts」——那种否定式提及必须放行，
    // 否则判据会把正确的修复判成错的（第一版判据就犯过这个错：只要 fs.read
    // 与 .artifacts 出现在同一行就算违规，连「别去读归档」也一起判红）。
    const mentions = [...outcome.observation.matchAll(/\.artifacts/gi)];
    const pointedAt = mentions.some((m) => {
      const before = outcome.observation.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0);
      return !/不要|别|勿|无需|不必|禁止|而不是/.test(before);
    });
    expect(
      pointedAt,
      'observation 把 .artifacts 归档当成续读目标：该文件序列化后只有一行，lineStart 失效，读它只会重复同一段',
    ).toBe(false);
  });

  it('T5 回灌的正文不得是 JSON 转义噪音（模型应看到原始文本）', async () => {
    const outcome = await readObservation({ path: 'big.ts', maxBytes: 10_485_760 });
    // 原文里没有反斜杠；observation 里成片出现 `\r\n` / `\n` 字面序列，说明
    // 送去的是 JSON.stringify 的产物，token 白烧且无法直接复制修改。
    const escapes = (outcome.observation.match(/\\[rn]|\\"/g) ?? []).length;
    expect(escapes, `observation 里有 ${escapes} 处 JSON 转义序列，模型看到的是转义串而不是源码`).toBeLessThan(5);
  });

  it('T6 行窗口必须精确：只回请求的那一段，且续读从下一行起', async () => {
    const outcome = await readObservation({ path: 'big.ts', maxBytes: 10_485_760, lineStart: 101, lineEnd: 150 });
    const covered = coveredMarks(outcome.observation);
    expect(covered.has(101), '请求的第 101 行不在结果里').toBe(true);
    expect(covered.has(150), '请求的第 150 行不在结果里').toBe(true);
    expect(covered.has(100), '结果多带了请求区间之前的行').toBe(false);
    expect(covered.has(151), '结果多带了请求区间之后的行').toBe(false);
    expect(nextLineStart(outcome.observation)).toBe(151);
  });

  it('T7 小文件不受影响：内容完整，不出现截断提示', async () => {
    const outcome = await readObservation({ path: 'tiny.ts' });
    expect(outcome.observation).toContain('export const answer = 42;');
    expect(outcome.observation).not.toContain('截断');
  });
});

/**
 * 复核事实投影 —— plannedFacts 曾把 afterExists 硬编码成 false、afterBytes 硬编码成 null。
 *
 * 后果不是「少了个字段」：overwrite 被描述成「文件写完就不存在」，复核模型照着这份
 * 错事实正确地判成不可逆删除并升级人工确认，无人值守必然超时。线上实测两条
 * agent_reviews 的 underestimated 指摘原文都在引用 afterExists=false，其中一次
 * 把 tool_success_rate 从 1 拉到 12/13=0.923，代际被 R5 拦下。
 *
 * 这些用例走真实调用点（ToolExecutor.executeBatch → reviewIrreversible），
 * 不直调内部 helper：投影函数改对了但没接上调用点，这里必须照样红。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolExecutor, type ExecuteItemInput } from '../src/services/tools/executor.service.js';
import { buildEffectPreview } from '../src/services/tools/effect-preview.js';
import type { ToolCallRow } from '../src/services/memory/tool-call.repository.js';
import type { ToolResultRow } from '../src/services/memory/tool-result.repository.js';
import type { ApprovalService } from '../src/services/agent/approval.service.js';
import type { SseWriter } from '../src/services/agent/sse-writer.js';
import type { ReviewFacts, ToolDefinition, ToolOutcome, RiskVerdict } from '../src/types/tool.js';
import { argsDigest } from '../src/utils/digest.js';

let sandboxRoot: string;

beforeEach(() => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), 'codelens-facts-'));
});

afterEach(() => {
  try {
    rmSync(sandboxRoot, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
  }
});

function definition(name: string): ToolDefinition {
  return {
    name,
    wireName: name.replace('.', '_'),
    displayName: name,
    category: 'file',
    description: 'test tool',
    inputSchema: { type: 'object' },
    handler: async (): Promise<ToolOutcome> => ({ ok: true, summary: 'done', data: {} }),
    timeoutMs: 5000,
    risk: 'medium',
    approvalMode: 'soft',
    enabled: () => true,
    source: 'builtin',
    idempotent: true,
    maxResultChars: 100_000,
  } as unknown as ToolDefinition;
}

function callRow(callId: string, toolName: string): ToolCallRow {
  return {
    id: `tc_${callId}`,
    session_id: 'sess_facts',
    message_id: 'msg_facts',
    call_id: callId,
    tool_name: toolName,
    tool_wire_name: toolName.replace('.', '_'),
    display_name: toolName,
    category: 'file',
    source: 'builtin',
    risk: 'medium',
    approval_mode: 'soft',
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

/**
 * 跑一次真实执行并截获喂给复核的事实。
 *
 * 复核分支的进入条件是「不前置挑战 + effect 不可逆」：hard/two_step 的审批循环
 * 在 executor.service.ts:394/404 直接 return runAndRecord，压根走不到复核。
 * 所以这里用 soft（与线上那次 fs.write overwrite 同形），不可逆性交给预览判定。
 *
 * declareIrreversible 用于 create/append/rename：预览判它们可逆，生产里不进复核，
 * 但投影函数为它们写了分支。这里模拟「上游判定不可逆」把分支量到，否则那几条
 * 分支一发都没走过。它只改 verdict.effect.reversible，items 仍是真实文件系统读数。
 */
interface RunResult {
  captured: ReviewFacts | null;
  outcomeStatus: string | undefined;
  reversible: boolean | undefined;
  recoveryNote: string | null | undefined;
}

async function runExecutor(
  toolName: string,
  args: Record<string, unknown>,
  opts: { checkpointEnabled?: boolean; declareIrreversible?: boolean } = {},
): Promise<RunResult> {
  const def = definition(toolName);
  const verdict: RiskVerdict = { risk: 'high', approvalMode: 'soft' };
  const effect = buildEffectPreview(
    def, args, { sandboxRoot, checkpointEnabled: opts.checkpointEnabled ?? false }, verdict,
  );
  expect(effect, '后果预览必须存在，否则复核分支压根不进').not.toBeNull();
  if (opts.declareIrreversible && effect) effect.reversible = false;
  verdict.effect = effect;

  let captured: ReviewFacts | null = null;
  const rows: ToolCallRow[] = [];
  const row = callRow(`call_${toolName}_${String(args.operation ?? 'x')}`, toolName);
  rows.push(row);

  const executor = new ToolExecutor({
    toolCalls: {
      insert: (r: ToolCallRow) => { rows.push(r); return r; },
      listBySession: () => rows,
      markRunning: () => undefined,
      markFinished: (id: string, patch: Partial<ToolCallRow>) => {
        const found = rows.find((r) => r.id === id);
        if (found) Object.assign(found, patch);
      },
    } as never,
    toolResults: {
      insert: (fields: Record<string, unknown>): ToolResultRow =>
        ({ id: 'tr_1', created_at: Date.now(), ...fields }) as ToolResultRow,
    } as never,
    approvals: {
      hasSessionGrant: () => false,
      requestApproval: async () => 'allow_once',
    } as unknown as ApprovalService,
    sse: { emit: () => undefined } as unknown as SseWriter,
    sandboxRoot,
    allowedDirs: [],
    canRetry: () => false,
    onRetryConsumed: () => undefined,
    reviewIrreversible: async (facts) => {
      captured = facts;
      return {
        status: 'confirmed' as const,
        findings: [],
        usage: { promptTokens: 0, completionTokens: 0 },
        latencyMs: 0,
        provider: 'test',
        model: 'test',
      };
    },
  });

  const outcomes = await executor.executeBatch([
    {
      toolCall: row,
      definition: def,
      args,
      digest: argsDigest(args),
      verdict,
      channel: 'native',
      iteration: 1,
    } as ExecuteItemInput,
  ]);

  const outcome = outcomes.get(row.call_id);
  return {
    captured,
    outcomeStatus: outcome?.status,
    reversible: effect?.reversible,
    recoveryNote: effect?.recoveryNote,
  };
}

/** 断言复核真的被调用，否则本用例什么都没验；失败时自己说清是哪一关截胡的。 */
async function captureFacts(
  toolName: string,
  args: Record<string, unknown>,
  declareIrreversible = false,
): Promise<ReviewFacts> {
  const r = await runExecutor(toolName, args, { declareIrreversible });
  expect(
    r.captured,
    `复核未被调用：结局=${r.outcomeStatus ?? 'null'}（reversible=${r.reversible}）`,
  ).not.toBeNull();
  expect(r.reversible, 'effect 必须不可逆，复核才会被调用').toBe(false);
  return r.captured as ReviewFacts;
}

/** 中文内容：字节数与码元数不同，投影必须按 utf8 字节算。 */
const CONTENT = '修复后的实现：module.exports = {};\n';
const CONTENT_BYTES = Buffer.byteLength(CONTENT, 'utf8');

describe('复核事实投影：after 状态必须按 operation 真实预测', () => {
  it('overwrite 已有文件 → 文件仍在，字节数等于写入内容的 utf8 字节数', async () => {
    expect(CONTENT_BYTES).not.toBe(CONTENT.length);
    writeFileSync(path.join(sandboxRoot, 'impl.cjs'), 'x'.repeat(611), 'utf8');

    const facts = await captureFacts('fs.write', {
      path: 'impl.cjs', operation: 'overwrite', content: CONTENT,
    });

    expect(facts.affectedPaths).toHaveLength(1);
    const p = facts.affectedPaths[0];
    expect(p.operation).toBe('overwrite');
    expect(p.beforeExists).toBe(true);
    expect(p.beforeBytes).toBe(611);
    expect(p.afterExists, '覆盖不是删除：写完文件必须仍然存在').toBe(true);
    expect(p.afterBytes).toBe(CONTENT_BYTES);
  });

  it('create 新文件 → 从无到有，字节数等于内容字节数', async () => {
    const facts = await captureFacts('fs.write', {
      path: 'new.cjs', operation: 'create', content: CONTENT,
    }, true);

    const p = facts.affectedPaths[0];
    expect(p.beforeExists).toBe(false);
    expect(p.afterExists).toBe(true);
    expect(p.afterBytes).toBe(CONTENT_BYTES);
  });

  it('append 已有文件 → 字节数是原文加追加内容，不是只算追加部分', async () => {
    writeFileSync(path.join(sandboxRoot, 'log.txt'), 'y'.repeat(100), 'utf8');

    const facts = await captureFacts('fs.write', {
      path: 'log.txt', operation: 'append', content: CONTENT,
    }, true);

    const p = facts.affectedPaths[0];
    expect(p.beforeBytes).toBe(100);
    expect(p.afterExists).toBe(true);
    expect(p.afterBytes).toBe(100 + CONTENT_BYTES);
  });

  it('append 不存在的文件 → 按新建算，字节数就是内容字节数', async () => {
    const facts = await captureFacts('fs.write', {
      path: 'fresh.txt', operation: 'append', content: CONTENT,
    }, true);

    const p = facts.affectedPaths[0];
    expect(p.beforeExists).toBe(false);
    expect(p.afterExists).toBe(true);
    expect(p.afterBytes).toBe(CONTENT_BYTES);
  });

  it('delete → 只有这一种操作才该声明文件写完不存在', async () => {
    writeFileSync(path.join(sandboxRoot, 'gone.txt'), 'z'.repeat(30), 'utf8');

    const facts = await captureFacts('fs.write', { path: 'gone.txt', operation: 'delete' });

    const p = facts.affectedPaths[0];
    expect(p.beforeExists).toBe(true);
    expect(p.afterExists).toBe(false);
    expect(p.afterBytes).toBeNull();
  });

  it('purge → 内容清空但目录本身保留', async () => {
    mkdirSync(path.join(sandboxRoot, 'box'), { recursive: true });
    writeFileSync(path.join(sandboxRoot, 'box', 'a.txt'), 'a', 'utf8');

    const facts = await captureFacts('fs.write', { path: 'box', operation: 'purge' });

    const p = facts.affectedPaths[0];
    expect(p.beforeExists).toBe(true);
    expect(p.afterExists, 'purge 保留空目录，不能声明目录被删').toBe(true);
  });

  it('rename → 源消失、目标出现且继承源的字节数', async () => {
    writeFileSync(path.join(sandboxRoot, 'src.txt'), 'r'.repeat(77), 'utf8');

    const facts = await captureFacts('fs.write', {
      path: 'src.txt', operation: 'rename', newPath: 'dst.txt',
    }, true);

    expect(facts.affectedPaths).toHaveLength(2);
    const [source, target] = facts.affectedPaths;
    expect(source.beforeExists).toBe(true);
    expect(source.afterExists).toBe(false);
    expect(source.afterBytes).toBeNull();
    expect(target.beforeExists).toBe(false);
    expect(target.afterExists).toBe(true);
    expect(target.afterBytes).toBe(77);
  });

  it('sys.exec 的 cwd → 不能把工作目录说成执行后被删除', async () => {
    const facts = await captureFacts('sys.exec', { command: 'ls', args: [], cwd: '.' });

    expect(facts.affectedPaths.length).toBeGreaterThan(0);
    for (const p of facts.affectedPaths) {
      expect(p.afterExists, '预览不预测 cwd 变化，应照原样陈述存在性').toBe(true);
    }
  });
});

/**
 * 写前快照开关是 g3 那条失败链的第二道独立成因：开关关着 ⇒ overwrite 判不可逆
 * ⇒ 进复核 ⇒ 复核升级确认 ⇒ 无人值守超时 ⇒ tool_success_rate 12/13。
 * 这两条用例让同一个输入在开关两侧给出相反读数，证明 .env 里那一行真的接在闸上。
 */
describe('CHECKPOINT_ENABLED：同一个 overwrite 在开关两侧必须给出相反读数', () => {
  const overwriteArgs = (): Record<string, unknown> => ({
    path: 'impl.cjs', operation: 'overwrite', content: CONTENT,
  });

  it('关闭 → 判不可逆、复核被调用（g3 走的就是这条）', async () => {
    writeFileSync(path.join(sandboxRoot, 'impl.cjs'), 'x'.repeat(611), 'utf8');

    const r = await runExecutor('fs.write', overwriteArgs(), { checkpointEnabled: false });

    expect(r.reversible).toBe(false);
    expect(r.recoveryNote).toContain('未开启写前快照');
    expect(r.captured, '开关关闭时必须进复核').not.toBeNull();
  });

  it('开启 → 判可逆、复核压根不进入、调用直接成功', async () => {
    writeFileSync(path.join(sandboxRoot, 'impl.cjs'), 'x'.repeat(611), 'utf8');

    const r = await runExecutor('fs.write', overwriteArgs(), { checkpointEnabled: true });

    expect(r.reversible).toBe(true);
    expect(r.recoveryNote).toContain('已有写前快照');
    expect(r.captured, '开关开启时不该再进复核').toBeNull();
    expect(r.outcomeStatus).toBe('success');
  });
});
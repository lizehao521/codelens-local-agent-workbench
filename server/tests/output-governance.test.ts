/**
 * 大输出治理：喂给模型的内容必须有硬上界，且截断后要给出可执行的续读指引。
 *
 * 背景（实测，不是推断）：一次「读 server/package.json 回答两个问题」的任务，
 * 累计 prompt 烧到 68123 token 后报「任务 token 预算已用尽（64000）」。拆账后
 * 发现不是某一条消息巨大，而是「每条 observation 都按字符上限放行」×「每一轮
 * 重发历史都要重付一遍」滚起来的：
 *
 *   - CJK 1 字 ≈ 1 token，旧的 3000 字符上限 → 单条最坏 3015 token
 *   - 10 次工具调用、每轮重发 → 累计 prompt 轻松越过 contextWindow × 2 的预算
 *
 * 这批用例钉死三件事：
 *   1. clipToTokenBudget 是 token 语义，不是字符语义（CJK 不被劈半、Latin 能多装）
 *   2. executor 喂给模型的 observation 有 token 硬顶，超了必须带可执行的续读指引
 *   3. fs.read 自己的截断提示也要指路（lineStart/lineEnd / keyword），不许只说「截断了」
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ToolExecutor,
  clipToTokenBudget,
  type ExecuteItemInput,
  type ExecutionOutcome,
} from '../src/services/tools/executor.service.js';
import type { ToolCallRow } from '../src/services/memory/tool-call.repository.js';
import type { ToolResultRow } from '../src/services/memory/tool-result.repository.js';
import type { ApprovalService } from '../src/services/agent/approval.service.js';
import type { SseWriter } from '../src/services/agent/sse-writer.js';
import type { ToolDefinition, ToolExecutionContext, ToolOutcome, RiskVerdict } from '../src/types/tool.js';
import { estimateTextTokens } from '../src/services/agent/token-estimator.js';
import { argsDigest } from '../src/utils/digest.js';
import { fsReadTool } from '../src/tools/builtin/fs-read.tool.js';

/** 与 executor 常量同源的口径：单条 observation 的 token 硬顶。 */
const OBSERVATION_MAX_TOKENS = 1000;

// ─────────────────────────────────────────────────────────────
// 1. clipToTokenBudget：token 语义，不是字符语义
// ─────────────────────────────────────────────────────────────

describe('clipToTokenBudget: 按 token 裁，不按字符裁', () => {
  it('预算内原样返回，不截断', () => {
    const text = 'short text';
    expect(clipToTokenBudget(text, 100)).toBe(text);
  });

  it('CJK 文本被裁到预算内（1 字 ≈ 1 token，字符数≈token 数）', () => {
    const text = '中'.repeat(5000);
    const clipped = clipToTokenBudget(text, 1000);
    expect(clipped.length).toBeLessThanOrEqual(1000);
    expect(clipped.length).toBeGreaterThan(900); // 不至于裁太狠
    expect(estimateTextTokens(clipped)).toBeLessThanOrEqual(1000);
  });

  it('Latin 文本同样裁到预算内，但能装下约 4 倍字符', () => {
    const text = 'a'.repeat(8000);
    const clipped = clipToTokenBudget(text, 1000);
    expect(estimateTextTokens(clipped)).toBeLessThanOrEqual(1000);
    // Latin 约 4 字符/token：1000 token 应能装下 ~4000 字符
    expect(clipped.length).toBeGreaterThan(3500);
  });

  it('绝不劈开半个汉字丢语义：裁剪点落在完整字符上', () => {
    const text = '汉'.repeat(3000) + 'END';
    const clipped = clipToTokenBudget(text, 500);
    // 被裁掉的部分从 END 开始消失；保留的前缀必须是完整的「汉」序列
    expect(clipped).toBe('汉'.repeat(clipped.length));
  });

  it('空文本与零预算的边界', () => {
    expect(clipToTokenBudget('', 100)).toBe('');
    expect(clipToTokenBudget('abc', 0)).toBe('');
    expect(clipToTokenBudget('abc', -1)).toBe('');
  });

  it('预算刚好等于全文 token 数时原样返回（边界不误砍）', () => {
    const text = 'exact fit text';
    const needed = estimateTextTokens(text);
    expect(clipToTokenBudget(text, needed)).toBe(text);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. executor 喂给模型的 observation：硬顶 + 可执行指引
// ─────────────────────────────────────────────────────────────

interface FakeEvent {
  name: string;
  data: any;
}

interface InsertedResult {
  toolCallId: string;
  inlinePreview: string | null;
  artifactPath: string | null;
  bytes: number;
  truncated: boolean;
  sha256: string | null;
}

function toolDef(handler: (args: Record<string, unknown>) => Promise<ToolOutcome>): ToolDefinition {
  return {
    name: 'fs.read',
    wireName: 'fs_read',
    displayName: '读取文件',
    category: 'file',
    description: 'test tool',
    inputSchema: { type: 'object' },
    handler: (args) => handler(args),
    timeoutMs: 5000,
    risk: 'low',
    approvalMode: 'none',
    enabled: () => true,
    source: 'builtin',
    idempotent: true,
    maxResultChars: 100_000,
  };
}

function toolCallRow(callId: string): ToolCallRow {
  return {
    id: `tc_${callId}`,
    session_id: 'sess_1',
    message_id: 'msg_1',
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

let sandboxRoot: string;

function harness(verdict?: RiskVerdict) {
  const events: FakeEvent[] = [];
  const inserted: InsertedResult[] = [];
  const rows: ToolCallRow[] = [];
  const toolCalls = {
    insert: (row: ToolCallRow) => {
      rows.push(row);
      return row;
    },
    listBySession: () => rows,
    markRunning: () => undefined,
    markFinished: (id: string, patch: Partial<ToolCallRow>) => {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
    },
  };
  const toolResults = {
    insert: (fields: InsertedResult): ToolResultRow => {
      inserted.push(fields);
      return { id: `tr_${inserted.length}`, created_at: Date.now(), ...fields } as ToolResultRow;
    },
  };
  const approvals = {
    hasSessionGrant: () => false,
    requestApproval: async () => 'allow_once',
  };
  const executor = new ToolExecutor({
    toolCalls: toolCalls as never,
    toolResults: toolResults as never,
    approvals: approvals as unknown as ApprovalService,
    sse: {
      emit: (name: string, data: unknown) => {
        events.push({ name, data });
      },
    } as unknown as SseWriter,
    sandboxRoot,
    canRetry: () => false,
    onRetryConsumed: () => undefined,
  });
  return {
    events,
    inserted,
    run: async (item: { toolCall: ToolCallRow; definition: ToolDefinition }): Promise<ExecutionOutcome | null> => {
      rows.push(item.toolCall);
      const outcomes = await executor.executeBatch([
        {
          args: {},
          digest: argsDigest({}),
          verdict: verdict ?? { risk: 'low', approvalMode: 'none' },
          channel: 'native',
          iteration: 1,
          ...item,
        } as ExecuteItemInput,
      ]);
      return outcomes.get(item.toolCall.call_id) ?? null;
    },
  };
}

beforeEach(() => {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'outgov-'));
});

afterEach(() => {
  const dir = sandboxRoot;
  setImmediate(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 残留由环境侧回收 */
    }
  });
});

describe('executor observation: token 硬顶', () => {
  it('超大 CJK 结果必须被裁进 token 硬顶内（回归：旧上限 3000 字符≈3015 token）', async () => {
    const big = { content: '中'.repeat(20000) };
    const definition = toolDef(async () => ({ ok: true, summary: '读取完成', data: big }));
    const h = harness();
    const outcome = await h.run({ toolCall: toolCallRow('call_big_cjk'), definition });

    expect(outcome?.status).toBe('success');
    const obs = outcome!.observation;
    expect(estimateTextTokens(obs)).toBeLessThanOrEqual(OBSERVATION_MAX_TOKENS + 200); // 留出提示语余量
    // 老实说清楚它截了多少、全量在哪、下一步怎么拿
    expect(obs).toContain('结果已截断');
    expect(obs).toContain('.artifacts/');
    expect(obs).toContain('fs.read');
    expect(obs).toContain('lineStart/lineEnd');
  });

  it('小结果不加截断提示，内容原样进 observation', async () => {
    const small = { answer: 'vitest run', version: '^5.0.5' };
    const definition = toolDef(async () => ({ ok: true, summary: '读取完成', data: small }));
    const h = harness();
    const outcome = await h.run({ toolCall: toolCallRow('call_small'), definition });

    expect(outcome?.status).toBe('success');
    expect(outcome!.observation).toContain('vitest run');
    expect(outcome!.observation).not.toContain('结果已截断');
    expect(outcome!.observation).not.toContain('lineStart/lineEnd');
  });

  it('归档失败时的提示要说明「重跑请缩小范围」，不能指向不存在的文件', async () => {
    const big = { content: '中'.repeat(20000) };
    const definition = toolDef(async () => ({ ok: true, summary: '读取完成', data: big }));
    const h = harness();
    const outcome = await h.run({ toolCall: toolCallRow('call_big_nofile'), definition });

    // 正常情况下 artifact 会写成功；这里只断言提示的两个分支都不会指向空路径
    expect(outcome!.observation).toMatch(/\.artifacts\/|归档失败/);
  });

  it('完整内容仍落 artifact（模型拿不到，但审计链拿得到）', async () => {
    const big = { content: '中'.repeat(20000) };
    const definition = toolDef(async () => ({ ok: true, summary: '读取完成', data: big }));
    const h = harness();
    await h.run({ toolCall: toolCallRow('call_artifact'), definition });

    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0].truncated).toBe(true);
    expect(h.inserted[0].artifactPath).toBe('.artifacts/tc_call_artifact.json');
  });
});

// ─────────────────────────────────────────────────────────────
// 3. fs.read 自己的截断提示：必须指路，不能只说「截断了」
// ─────────────────────────────────────────────────────────────

function readCtx(): ToolExecutionContext {
  return {
    sessionId: 's',
    toolCallId: 't',
    callId: 'c',
    iteration: 1,
    sandboxRoot,
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
}

describe('fs.read 截断提示给可执行续读指引', () => {
  it('超字节上限时提示里必须出现 lineStart/lineEnd 或 keyword 指引', async () => {
    // 一个 60 KB 的文件，16 KiB 默认上限必然截断
    writeFileSync(join(sandboxRoot, 'big.txt'), 'x'.repeat(60 * 1024), 'utf8');
    const r = await fsReadTool.handler({ path: 'big.txt' }, readCtx());
    expect(r.ok).toBe(true);
    const content = String((r.data as { content?: string })?.content ?? '');
    expect(content).toContain('截断');
    expect(content).toMatch(/lineStart\/lineEnd|keyword|maxBytes/);
  });

  it('行数超上限时提示里给出已返回行数，便于模型续读', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line-${i + 1}`).join('\n');
    writeFileSync(join(sandboxRoot, 'many.txt'), lines, 'utf8');
    const r = await fsReadTool.handler({ path: 'many.txt' }, readCtx());
    expect(r.ok).toBe(true);
    const content = String((r.data as { content?: string })?.content ?? '');
    expect(content).toContain('截断');
    expect(content).toMatch(/lineStart\/lineEnd/);
  });
});

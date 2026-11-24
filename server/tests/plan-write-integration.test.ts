/**
 * 方向一残留②：计划准入接进真实执行循环（fs.write handler）的集成判据。
 *
 * 钉住三件相反的事，缺一不可：
 *  1. 有活跃计划条目时，写请求必须声明匹配的 planItemId 才放行（准入真正生效）；
 *  2. 不匹配 / 未声明 → 拒绝（不能靠缺省绕过）；
 *  3. 无活跃条目 / 无 planWrite 上下文 → 放行（老会话、无计划会话零影响，向后兼容）。
 *
 * 这批用例是对"接线"的判据，不是对纯函数的重复：直接调 fsWriteTool.handler，
 * 校验真实写路径上的 gateWriteCall 是否吃到了 ctx.planWrite。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { PlanRepository } from '../src/repositories/plan.repository.js';
import { fsWriteTool } from '../src/tools/builtin/fs-write.tool.js';
import { buildPlanWriteContext } from '../src/services/plan/plan-write-context.js';
import type { ToolExecutionContext } from '../src/types/tool.js';

let sandbox: string;
let db: Db;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'plan-write-'));
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  const dir = sandbox;
  setImmediate(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 环境回收 */ }
  });
});

function ctxWith(planWrite?: ToolExecutionContext['planWrite']): ToolExecutionContext {
  return {
    sessionId: 's1', toolCallId: 't', callId: 'c', iteration: 1,
    sandboxRoot: sandbox, signal: new AbortController().signal, reportProgress: () => {},
    ...(planWrite ? { planWrite } : {}),
  };
}

/** 造一个会话 + 指定状态的计划条目，返回条目 id。 */
function seedPlan(sessionId: string, status: 'draft' | 'approved' | 'running' | 'done'): string {
  // agent_plans.session_id 外键指向 sessions，先补一行会话（幂等）。
  db.run(
    `INSERT OR IGNORE INTO sessions (id, title, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [sessionId, 't', 'custom', 'm', 1, 1],
  );
  const id = `plan-${status}-${sessionId}`;
  new PlanRepository(db).insert({
    id, sessionId, runId: null, title: 't', status, stepsJson: '[]',
    createdAt: 1, updatedAt: 1,
  });
  return id;
}

describe('buildPlanWriteContext · 活跃条目派生', () => {
  it('无 db → undefined（调用方跳过准入）', () => {
    expect(buildPlanWriteContext(undefined, 's1')).toBeUndefined();
  });

  it('会话无计划条目 → undefined', () => {
    expect(buildPlanWriteContext(db, 's1')).toBeUndefined();
  });

  it('只有 draft 条目 → undefined（draft 不算活跃）', () => {
    seedPlan('s1', 'draft');
    expect(buildPlanWriteContext(db, 's1')).toBeUndefined();
  });

  it('有 approved 条目 → 返回 items + activeItemId', () => {
    const id = seedPlan('s1', 'approved');
    const c = buildPlanWriteContext(db, 's1');
    expect(c).toBeDefined();
    expect(c!.activeItemId).toBe(id);
    expect(c!.items).toEqual([{ id, status: 'approved' }]);
  });

  it('条目只来自本会话（跨会话隔离）', () => {
    seedPlan('s2', 'approved');
    expect(buildPlanWriteContext(db, 's1')).toBeUndefined();
  });
});

describe('fs.write handler · 真实写路径上的计划准入', () => {
  it('无 planWrite 上下文 → 放行（向后兼容，老会话不受影响）', async () => {
    const r = await fsWriteTool.handler(
      { path: 'a.txt', operation: 'create', content: 'x' }, ctxWith(),
    );
    expect(r.ok).toBe(true);
    expect(existsSync(join(sandbox, 'a.txt'))).toBe(true);
  });

  it('有活跃条目 + 声明匹配的 planItemId → 放行', async () => {
    const id = seedPlan('s1', 'approved');
    const pw = buildPlanWriteContext(db, 's1')!;
    const r = await fsWriteTool.handler(
      { path: 'b.txt', operation: 'create', content: 'x', planItemId: id }, ctxWith(pw),
    );
    expect(r.ok).toBe(true);
    expect(existsSync(join(sandbox, 'b.txt'))).toBe(true);
  });

  it('有活跃条目 + planItemId 不匹配 → 拒绝，且不落盘', async () => {
    const id = seedPlan('s1', 'approved');
    const pw = buildPlanWriteContext(db, 's1')!;
    const r = await fsWriteTool.handler(
      { path: 'c.txt', operation: 'create', content: 'x', planItemId: `${id}-wrong` }, ctxWith(pw),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.summary ?? r.summary).toContain('计划条目准入拒绝');
    expect(existsSync(join(sandbox, 'c.txt'))).toBe(false);
  });

  it('有活跃条目 + 未声明 planItemId → 拒绝（不能靠缺省绕过）', async () => {
    seedPlan('s1', 'running');
    const pw = buildPlanWriteContext(db, 's1')!;
    const r = await fsWriteTool.handler(
      { path: 'd.txt', operation: 'create', content: 'x' }, ctxWith(pw),
    );
    expect(r.ok).toBe(false);
    expect(existsSync(join(sandbox, 'd.txt'))).toBe(false);
  });

  it('有 planWrite 但 operation 非写类（此处所有 operation 都是写）→ 仍走准入；读操作不在 fs.write 范畴', async () => {
    // fs.write 只处理写操作，此用例钉住：有活跃条目时任何 fs.write 都必须声明 planItemId。
    seedPlan('s1', 'approved');
    const pw = buildPlanWriteContext(db, 's1')!;
    const r = await fsWriteTool.handler(
      { path: 'e.txt', operation: 'append', content: 'x' }, ctxWith(pw),
    );
    expect(r.ok).toBe(false); // append 也是写操作，未声明 planItemId → 拒绝
  });
});

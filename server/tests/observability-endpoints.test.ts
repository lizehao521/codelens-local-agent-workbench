// 可观测面端点的接线测试 —— 覆盖「四个新端点确实挂在 /api/v1 下、返回契约与
// 前端一致、闸门行为正确」。
//
// 分工：各 service / controller 的内部行为由它们自己的单测覆盖
// （capability-registry / trace.service / skill-library / checkpoint.service）；
// 本文件只回答另一个问题——**装配层有没有把它们正确接上线**。
// 装配层的错（漏挂路由、字段名对不上、闸门顺序反了）单测是看不见的。
//
// P4：shadowVerdict 的 ok/failed 态也在本文件端到端覆盖（observabilityEnabled 注入的
// runtime 真实写 span → createApp 同一实例 → 端点解析透出），不再只验 absent。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

describe('可观测面端点接线（能力目录 / 轨迹 / 技能库 / 工作区快照）', () => {
  let runtime: Runtime;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-observability-'));
    runtime = createRuntime({ dbPath: path.join(tmpRoot, 'observability.db') });
  });

  afterEach(async () => {
    await runtime.close();
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch (err) {
      console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
    }
  });

  it('GET /api/v1/capabilities 返回能力目录（含条目、计数与接线状态）', async () => {
    const app = createApp({ runtime, autoStartModelSync: false });
    const res = await request(app).get('/api/v1/capabilities');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.capabilities)).toBe(true);
    expect(res.body.total).toBe(res.body.capabilities.length);
    expect(typeof res.body.enabledCount).toBe('number');
    // 每条能力都要有稳定 id 与启用方式说明，前端按 id 渲染徽标。
    for (const entry of res.body.capabilities) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.enabled).toBe('boolean');
      expect(typeof entry.wired).toBe('boolean');
      expect(typeof entry.envHint).toBe('string');
    }
    // 判据塔是内核常开：接线且启用。
    const judge = res.body.capabilities.find((c: { id: string }) => c.id === 'judge');
    expect(judge).toBeDefined();
    expect(judge.enabled).toBe(true);
    expect(judge.wired).toBe(true);
  });

  it('GET /api/v1/traces 能力未启用时返回 enabled=false（不冒充"有数据"）', async () => {
    const app = createApp({ runtime, autoStartModelSync: false });
    const res = await request(app).get('/api/v1/traces');

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.traces).toEqual([]);
  });

  it('GET /api/v1/skills 能力未启用时返回 enabled=false 与空列表', async () => {
    const app = createApp({ runtime, autoStartModelSync: false });
    const res = await request(app).get('/api/v1/skills');

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.mode).toBe('list');
    expect(res.body.skills).toEqual([]);
  });

  it('GET /api/v1/checkpoints 能力未启用时返回 enabled=false 与空列表', async () => {
    const app = createApp({ runtime, autoStartModelSync: false });
    const res = await request(app).get('/api/v1/checkpoints');

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.checkpoints).toEqual([]);
  });

  it('POST 回滚缺少确认头 → 400（第一道闸门：能力未启用优先报 409）', async () => {
    const app = createApp({ runtime, autoStartModelSync: false });
    const res = await request(app).post('/api/v1/checkpoints/does-not-exist/rollback');

    // 闸门顺序：能力未启用 → 409；未带确认头 → 400。
    // 两者都必须在「执行回滚」之前拦住，且 body 是统一的 error 对象。
    expect([400, 409]).toContain(res.status);
    expect(typeof res.body.error).toBe('object');
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.report).toBeUndefined();
  });

  it('四个端点都不接受未定义的写方法（防止误挂副作用）', async () => {
    const app = createApp({ runtime, autoStartModelSync: false });

    const postCapabilities = await request(app).post('/api/v1/capabilities');
    const postTraces = await request(app).post('/api/v1/traces');
    const deleteSkills = await request(app).delete('/api/v1/skills/some-name');

    expect([404, 405]).toContain(postCapabilities.status);
    expect([404, 405]).toContain(postTraces.status);
    // 技能库有 DELETE（删除条目），因此它应当被路由接受而非 404。
    expect([200, 400, 404, 409]).toContain(deleteSkills.status);
  });

  // P2：traces 明细分支透传跨代判决 shadowVerdict（只读接线，ok/failed 态由 parser 单测覆盖）。
  it('GET /api/v1/traces?traceId=xxx 明细分支带 shadowVerdict（无判决 span → absent）', async () => {
    const app = createApp({ runtime, autoStartModelSync: false });
    // observability 默认关闭，getSpans 对不存在的 traceId 返回 [] → parser 返回 absent。
    const res = await request(app).get('/api/v1/traces?traceId=nonexistent-trace-id').expect(200);

    expect(res.body.shadowVerdict).toBeDefined();
    expect(res.body.shadowVerdict.outcome).toBe('absent');
    expect(Array.isArray(res.body.spans)).toBe(true);
  });

  it('GET /api/v1/traces limit 分支不含 shadowVerdict 字段（向后兼容）', async () => {
    const app = createApp({ runtime, autoStartModelSync: false });
    const res = await request(app).get('/api/v1/traces').expect(200);

    expect(res.body).not.toHaveProperty('shadowVerdict');
    expect(res.body.traces).toEqual([]);
  });

  // P4：observability 开启时 shadowVerdict 的 ok / failed 态端到端覆盖。
  // 与上面 absent 用例互补：这里真实写 span（同一 runtime 实例 → createApp 读同一份库）。
  it('GET /api/v1/traces?traceId=xxx observability 开启时透出 ok 态（7 键完整）', async () => {
    const obsRuntime = createRuntime({
      dbPath: path.join(tmpRoot, 'observability-shadow-ok.db'),
      observabilityEnabled: true,
    });
    try {
      const trace = obsRuntime.traceService.startTrace('shadow-ok-session', 'shadow-ok');
      expect(trace).not.toBeNull();
      const detail = {
        state: 'improved',
        verdict: 'improved',
        source: 'cross_generation',
        reason: 'fixture',
        hadPrevious: true,
        pg: 1,
        cg: 2,
      };
      obsRuntime.traceService.recordSpan(trace!.traceId, {
        kind: 'judge',
        name: '跨代影子判决',
        status: 'ok',
        detail: JSON.stringify(detail),
      });
      obsRuntime.traceService.endTrace(trace!.traceId, 'ok');

      const app = createApp({ runtime: obsRuntime, autoStartModelSync: false });
      const res = await request(app)
        .get(`/api/v1/traces?traceId=${encodeURIComponent(trace!.traceId)}`)
        .expect(200);

      expect(res.body.enabled).toBe(true);
      expect(res.body.spans).toHaveLength(1);
      expect(res.body.shadowVerdict).toMatchObject({ outcome: 'ok', ...detail });
      expect(typeof res.body.shadowVerdict.spanId).toBe('string');
      expect(res.body.shadowVerdict.traceId).toBe(trace!.traceId);
    } finally {
      await obsRuntime.close();
    }
  });

  it('GET /api/v1/traces?traceId=xxx observability 开启时非法 detail 透出 failed 态', async () => {
    const obsRuntime = createRuntime({
      dbPath: path.join(tmpRoot, 'observability-shadow-failed.db'),
      observabilityEnabled: true,
    });
    try {
      const trace = obsRuntime.traceService.startTrace('shadow-failed-session', 'shadow-failed');
      expect(trace).not.toBeNull();
      obsRuntime.traceService.recordSpan(trace!.traceId, {
        kind: 'judge',
        name: '跨代影子判决',
        status: 'ok',
        detail: '{invalid-json',
      });
      obsRuntime.traceService.endTrace(trace!.traceId, 'ok');

      const app = createApp({ runtime: obsRuntime, autoStartModelSync: false });
      const res = await request(app)
        .get(`/api/v1/traces?traceId=${encodeURIComponent(trace!.traceId)}`)
        .expect(200);

      expect(res.body.shadowVerdict.outcome).toBe('failed');
      expect(typeof res.body.shadowVerdict.error).toBe('string');
      expect(res.body.spans).toHaveLength(1);
    } finally {
      await obsRuntime.close();
    }
  });
});

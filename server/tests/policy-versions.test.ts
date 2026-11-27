/**
 * π 版本面（GET /policy/versions + POST /policy/rollback）的判据。
 *
 * 钉死三件事：
 *  1. diff 是事实而不是意见：lessons 无 ID，只能 added/removed，不猜 changed；
 *  2. 历史 append-only：回滚只追加、不删除，且内容相同时不造无意义的新版本；
 *  3. 错误边界：不存在 → 404、非正整数 → 400，绝不静默返回空。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { diffPolicyVersions } from '../src/services/agent/policy-diff.js';
import { PolicyController } from '../src/controllers/policy.controller.js';
import type { UpdateService } from '../src/services/agent/update.service.js';
import type { Policy, PolicyVersionRow } from '../src/repositories/policy.repository.js';

describe('diffPolicyVersions', () => {
  it('首版（prev=null）：全部算 added', () => {
    const diff = diffPolicyVersions(null, { lessons: ['a', 'b'], thresholds: { x: 1 } });
    expect(diff.added).toEqual(['a', 'b']);
    expect(diff.removed).toEqual([]);
    expect(diff.thresholdChanges).toEqual([{ key: 'x', from: null, to: 1 }]);
  });

  it('增删各一条，重复项不重复计', () => {
    const prev: Policy = { lessons: ['a', 'b'], thresholds: {} };
    const next: Policy = { lessons: ['b', 'c', 'c'], thresholds: {} };
    const diff = diffPolicyVersions(prev, next);
    expect(diff.added).toEqual(['c']);
    expect(diff.removed).toEqual(['a']);
  });

  it('阈值键级 diff：新增/删除/变更', () => {
    const prev: Policy = { lessons: [], thresholds: { keep: 1, change: 2, drop: 3 } };
    const next: Policy = { lessons: [], thresholds: { keep: 1, change: 5, add: 4 } };
    const diff = diffPolicyVersions(prev, next);
    expect(diff.thresholdChanges).toEqual([
      { key: 'add', from: null, to: 4 },
      { key: 'change', from: 2, to: 5 },
      { key: 'drop', from: 3, to: null },
    ]);
  });

  it('内容相同 → 空 diff', () => {
    const p: Policy = { lessons: ['a'], thresholds: { t: 1 } };
    expect(diffPolicyVersions(p, p)).toEqual({ added: [], removed: [], thresholdChanges: [] });
  });
});

// ── Controller 层：用假 UpdateService，不碰真 DB ─────────────────────────

interface Captured {
  status: number;
  body: unknown;
}

function captureRes(): { res: Response; get: () => Captured } {
  const captured: Captured = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  } as unknown as Response;
  return { res, get: () => captured };
}

class FakePolicy {
  rows: PolicyVersionRow[] = [];
  current = 0;
  rolledBackTo: number[] = [];

  listVersions(): PolicyVersionRow[] {
    return this.rows;
  }
  currentVersion(): number {
    return this.current;
  }
  rollbackTo(version: number): Policy {
    const row = this.rows.find((r) => r.version === version);
    if (!row) throw new Error(`POLICY_VERSION_NOT_FOUND:${version}`);
    this.rolledBackTo.push(version);
    this.current = version;
    return JSON.parse(row.policyJson) as Policy;
  }
}

function versionRow(version: number, parent: number | null, policy: Policy, source: string | null = null): PolicyVersionRow {
  return {
    id: version,
    version,
    policyJson: JSON.stringify(policy),
    parentVersion: parent,
    sourceJudgment: source,
    createdAt: 1_800_000_000_000 + version,
  };
}

describe('PolicyController', () => {
  let fake: FakePolicy;
  let controller: PolicyController;

  beforeEach(() => {
    fake = new FakePolicy();
    fake.rows = [
      versionRow(1, null, { lessons: ['a'], thresholds: {} }, 'judge:run:1:x'),
      versionRow(2, 1, { lessons: ['a', 'b'], thresholds: {} }, 'judge:run:2:x'),
      versionRow(3, 2, { lessons: ['b'], thresholds: { t: 1 } }, 'rollback:from-v2-to-v1'),
    ];
    fake.current = 3;
    controller = new PolicyController(fake as unknown as UpdateService);
  });

  it('listVersions：最新在前、current 标记、逐条 diff', () => {
    const { res, get } = captureRes();
    controller.listVersions({ query: {} } as unknown as Request, res);
    const body = get().body as {
      versions: Array<{ version: number; current: boolean; diff: { added: string[]; removed: string[] } }>;
      currentVersion: number;
      total: number;
    };
    expect(body.currentVersion).toBe(3);
    expect(body.total).toBe(3);
    expect(body.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(body.versions[0]!.current).toBe(true);
    expect(body.versions[0]!.diff.added).toEqual([]);
    expect(body.versions[0]!.diff.removed).toEqual(['a']);
    expect(body.versions[1]!.diff.added).toEqual(['b']);
  });

  it('listVersions：limit 截断从最新往回取（不是最旧）', () => {
    const { res, get } = captureRes();
    controller.listVersions({ query: { limit: '1' } } as unknown as Request, res);
    const body = get().body as { versions: Array<{ version: number }> };
    expect(body.versions.map((v) => v.version)).toEqual([3]);
  });

  it('listVersions：坏 JSON 行跳过（不展示半条 diff）', () => {
    fake.rows.push({ id: 9, version: 4, policyJson: '{bad', parentVersion: 3, sourceJudgment: null, createdAt: 1 });
    const { res, get } = captureRes();
    controller.listVersions({ query: {} } as unknown as Request, res);
    const body = get().body as { versions: Array<{ version: number }>; total: number };
    expect(body.versions.some((v) => v.version === 4)).toBe(false);
    expect(body.total).toBe(3);
  });

  it('rollback：成功返回目标与新当前版本', () => {
    const { res, get } = captureRes();
    controller.rollback({ body: { version: 2 } } as unknown as Request, res);
    expect(get().status).toBe(200);
    expect(get().body).toEqual({ rolledBackTo: 2, currentVersion: 2 });
    expect(fake.rolledBackTo).toEqual([2]);
  });

  it('rollback：不存在 → 404，且绝不静默成功', () => {
    const { res, get } = captureRes();
    controller.rollback({ body: { version: 99 } } as unknown as Request, res);
    expect(get().status).toBe(404);
    expect((get().body as { error: { code: string } }).error.code).toBe('POLICY_VERSION_NOT_FOUND');
    expect(fake.rolledBackTo).toEqual([]);
  });

  it('rollback：非正整数 → 400', () => {
    for (const version of [0, -1, 1.5, 'x', null, undefined]) {
      const { res, get } = captureRes();
      controller.rollback({ body: { version } } as unknown as Request, res);
      expect(get().status).toBe(400);
    }
    expect(fake.rolledBackTo).toEqual([]);
  });
});
/**
 * PolicyRepository 单元测试：版本化 π 的当前读取 / 插入 / 回滚语义。
 * 回滚是「追加一个等于目标内容的新版本」，历史不可变、可审计。
 */

import { describe, it, expect } from 'vitest';
import { createDb } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { PolicyRepository, EMPTY_POLICY } from '../src/repositories/policy.repository.js';

function makeRepo() {
  const db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  return new PolicyRepository(db);
}

describe('PolicyRepository (π 版本化)', () => {
  it('无记录时返回 EMPTY_POLICY / version 0', () => {
    const repo = makeRepo();
    const cur = repo.getCurrent();
    expect(cur.policy).toEqual(EMPTY_POLICY);
    expect(cur.version).toBe(0);
  });

  it('insertVersion 自增版本号，current 指向最新', () => {
    const repo = makeRepo();
    const v1 = repo.insertVersion({ lessons: ['A'], thresholds: {} }, null, 'j1');
    const v2 = repo.insertVersion({ lessons: ['A', 'B'], thresholds: { x: 1 } }, 1, 'j2');
    expect(v1).toBe(1);
    expect(v2).toBe(2);
    const cur = repo.getCurrent();
    expect(cur.version).toBe(2);
    expect(cur.policy.lessons).toEqual(['A', 'B']);
    expect(cur.policy.thresholds).toEqual({ x: 1 });
  });

  it('getVersion 按版本号取历史快照', () => {
    const repo = makeRepo();
    repo.insertVersion({ lessons: ['A'], thresholds: {} }, null, 'j1');
    repo.insertVersion({ lessons: ['A', 'B'], thresholds: {} }, 1, 'j2');
    expect(repo.getVersion(1)?.lessons).toEqual(['A']);
    expect(repo.getVersion(2)?.lessons).toEqual(['A', 'B']);
    expect(repo.getVersion(99)).toBeUndefined();
  });

  it('listVersions 按版本升序返回全部快照', () => {
    const repo = makeRepo();
    repo.insertVersion({ lessons: ['A'], thresholds: {} }, null, 'j1');
    repo.insertVersion({ lessons: ['A', 'B'], thresholds: {} }, 1, 'j2');
    const versions = repo.listVersions();
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]!.sourceJudgment).toBe('j1');
    expect(versions[1]!.parentVersion).toBe(1);
  });
});

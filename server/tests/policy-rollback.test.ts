/**
 * π 回滚（宣言 §1「每次修改必须可回滚」/ §7「留回滚点」）。
 *
 * 铁律是**只前滚**：回滚不是删除历史，而是新建一个内容等于目标版的版本。
 * 删了历史就答不出「这版经验是怎么来的」——π 的审计链断了，闭环就不可信了。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { JudgeRepository } from '../src/repositories/judge.repository.js';
import { PolicyRepository } from '../src/repositories/policy.repository.js';
import { UpdateService } from '../src/services/agent/update.service.js';

let db: Db;
let policy: UpdateService;
let repo: PolicyRepository;

beforeEach(() => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  repo = new PolicyRepository(db);
  policy = new UpdateService(db, new JudgeRepository(db));
});

describe('rollbackTo · 只前滚，不删历史', () => {
  it('回滚到旧版本后，当前内容等于旧版本，但版本号继续递增', () => {
    policy.applyUpdate({ addLessons: ['经验A'] }, 'run-1'); // v1
    policy.applyUpdate({ addLessons: ['经验B'] }, 'run-2'); // v2
    policy.applyUpdate({ addLessons: ['经验C'] }, 'run-3'); // v3
    expect(policy.currentVersion()).toBe(3);
    expect(policy.getPolicy().lessons).toEqual(['经验A', '经验B', '经验C']);

    const after = policy.rollbackTo(1);

    expect(after.lessons).toEqual(['经验A']);
    expect(policy.getPolicy().lessons).toEqual(['经验A']);
    // 关键：不是回到 1，而是开了新的一版（前滚）
    expect(policy.currentVersion()).toBe(4);
  });

  it('回滚本身可回滚（回滚点也有回滚点）', () => {
    policy.applyUpdate({ addLessons: ['A'] }, 'r1'); // v1
    policy.applyUpdate({ addLessons: ['B'] }, 'r2'); // v2
    policy.rollbackTo(1); // v3 = {A}
    policy.rollbackTo(2); // v4 = {A,B}
    expect(policy.getPolicy().lessons).toEqual(['A', 'B']);
    expect(policy.currentVersion()).toBe(4);

    policy.rollbackTo(3); // v5 = {A}
    expect(policy.getPolicy().lessons).toEqual(['A']);
    expect(policy.currentVersion()).toBe(5);
  });

  it('历史全部保留：listVersions 的长度 = 版本数，含回滚动作', () => {
    policy.applyUpdate({ addLessons: ['A'] }, 'r1');
    policy.applyUpdate({ addLessons: ['B'] }, 'r2');
    policy.rollbackTo(1);
    const versions = repo.listVersions();
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    // 回滚动作必须留下可回溯的标记（内容来源 = 目标版本）
    expect(versions[2]!.sourceJudgment).toBe('rollback:from-v2-to-v1');
    // parent 指向内容的来源（目标版），而非被替换掉的那版
    expect(versions[2]!.parentVersion).toBe(1);
    expect(versions[1]!.parentVersion).toBe(1);
  });

  it('阈值也一并回滚（不只是 lessons）', () => {
    policy.applyUpdate({ setThresholds: { toolSuccessRate: 0.9 } }, 'r1'); // v1
    policy.applyUpdate({ setThresholds: { toolSuccessRate: 0.5 } }, 'r2'); // v2
    expect(policy.getPolicy().thresholds.toolSuccessRate).toBe(0.5);

    policy.rollbackTo(1);
    expect(policy.getPolicy().thresholds.toolSuccessRate).toBe(0.9);
  });

  it('回滚到当前版本是 no-op，不制造重复版本', () => {
    policy.applyUpdate({ addLessons: ['A'] }, 'r1'); // v1
    const before = policy.currentVersion();
    const p = policy.rollbackTo(before);
    expect(policy.currentVersion()).toBe(before);
    expect(p.lessons).toEqual(['A']);
  });

  it('回滚到不存在的版本必须抛错，绝不静默退到别的版本', () => {
    policy.applyUpdate({ addLessons: ['A'] }, 'r1');
    expect(() => policy.rollbackTo(99)).toThrow(/POLICY_VERSION_NOT_FOUND:99/);
    expect(() => policy.rollbackTo(0)).toThrow(/POLICY_VERSION_NOT_FOUND:0/);
    // 抛错之后状态不受污染
    expect(policy.currentVersion()).toBe(1);
    expect(policy.getPolicy().lessons).toEqual(['A']);
  });

  it('没有 applyUpdate 时回滚 0 抛错（版本 0 不是可回滚的真实版本）', () => {
    expect(() => policy.rollbackTo(0)).toThrow(/POLICY_VERSION_NOT_FOUND:0/);
  });

  it('内容与当前一致时也不制造重复版本（既有去重语义）', () => {
    policy.applyUpdate({ addLessons: ['A'] }, 'r1'); // v1
    policy.applyUpdate({ addLessons: ['A'] }, 'r2'); // v2 内容与 v1 相同
    const before = policy.currentVersion();
    policy.rollbackTo(1); // 目标内容 == 当前内容 → no-op
    expect(policy.currentVersion()).toBe(before);
  });
});

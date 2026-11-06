/**
 * Update 闭环最小环（强化内核宣言第1节）端到端自证：r → π' → 下一轮 Act 可读 → 回滚。
 *
 * 这里用真实生产代码（UpdateService + buildSystemPrompt），不做 mock：
 *  - UpdateService.applyUpdate 把判决 r 的增量写入版本化 π；
 *  - buildSystemPrompt 把当前 π' 注入下一轮 Act 的 system prompt（消费者）；
 *  - rollbackTo 让 π' 回退，Act 不再读到该经验。
 * 证明"r 真的改变 π'，π' 真的改变下一次 Act"，环闭合。
 */

import { describe, it, expect } from 'vitest';
import { createDb } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { UpdateService } from '../src/services/agent/update.service.js';
import { buildSystemPrompt } from '../src/services/agent/system-prompt.js';

function makeService() {
  const db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
  return new UpdateService(db);
}

describe('Update 闭环：r → π 增量 → 下一轮 Act 可读', () => {
  it('applyUpdate 写入经验后，下一轮 Act 的 system prompt 包含该经验', () => {
    const svc = makeService();
    svc.applyUpdate({ addLessons: ['删除操作前两步确认路径'] }, 'judge-fidelity-1');

    const policy = svc.getPolicy();
    expect(policy.lessons).toContain('删除操作前两步确认路径');

    const prompt = buildSystemPrompt(undefined, policy);
    expect(prompt).toContain('来自过往经验的策略');
    expect(prompt).toContain('删除操作前两步确认路径');
  });

  it('回滚后，下一轮 Act 不再读到被回滚的经验（环可逆）', () => {
    const svc = makeService();
    svc.applyUpdate({ addLessons: ['经验A'] }, 'j1');
    const v1 = svc.listVersions().at(-1)!.version;
    svc.applyUpdate({ addLessons: ['经验B'] }, 'j2');

    // 此时 Act 应同时看到 A、B
    expect(buildSystemPrompt(undefined, svc.getPolicy())).toContain('经验A');
    expect(buildSystemPrompt(undefined, svc.getPolicy())).toContain('经验B');

    // 回滚到 v1（只剩 A）
    svc.rollbackTo(v1);
    const after = buildSystemPrompt(undefined, svc.getPolicy());
    expect(after).toContain('经验A');
    expect(after).not.toContain('经验B');
  });

  it('生产者→Act：模拟一条纠正性判决沉积后，下一轮 Act 读到它', () => {
    const svc = makeService();
    // 模拟 r：某次工具失败触发一条经验（与 agent-loop 生产者同语义）
    const judgment = 'tool_outcome:1:stop';
    svc.applyUpdate(
      { addLessons: ['fs.write 删除前务必确认路径在沙箱内'] },
      judgment,
    );
    const prompt = buildSystemPrompt(undefined, svc.getPolicy());
    expect(prompt).toContain('fs.write 删除前务必确认路径在沙箱内');
    expect(svc.listVersions().at(-1)!.sourceJudgment).toBe(judgment);
  });

  it('addLessons 自动去重，避免同一经验反复污染 π', () => {
    const svc = makeService();
    svc.applyUpdate({ addLessons: ['重复经验'] }, 'j1');
    svc.applyUpdate({ addLessons: ['重复经验'] }, 'j2');
    expect(svc.getPolicy().lessons.filter((l) => l === '重复经验')).toHaveLength(1);
  });

  it('阈值增量被合并且可被覆盖', () => {
    const svc = makeService();
    svc.applyUpdate({ setThresholds: { retryCap: 3 } }, 'j1');
    svc.applyUpdate({ setThresholds: { retryCap: 5 } }, 'j2');
    expect(svc.getPolicy().thresholds.retryCap).toBe(5);
  });

  it('未提供 policy 时 buildSystemPrompt 行为与历史完全一致（向后兼容）', () => {
    const base = buildSystemPrompt(undefined);
    expect(base).not.toContain('来自过往经验的策略');
    expect(buildSystemPrompt(undefined, undefined)).toBe(base);
    // 任务段仍正常合成（与历史一致）
    const withTask = buildSystemPrompt('analyze');
    expect(withTask).toContain('任务模式');
  });
});

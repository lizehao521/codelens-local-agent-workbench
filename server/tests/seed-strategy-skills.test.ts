/**
 * seedSkills（内置策略技能 seed 接线）单元测试 —— 独立成文件，避免给存量测试踩行数棘轮。
 *
 * 覆盖：幂等写入、match 可检索、未启用静默返回 0、单条非法 seed 被跳过。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SkillLibraryService } from '../src/services/skills/skill-library.service.js';
import { BUILTIN_STRATEGY_SKILLS } from '../src/services/skills/builtin-strategy-skills.js';
import { seedSkills } from '../src/services/skills/seed-strategy-skills.js';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
});

function makeService(opts: { enabled?: boolean } = {}): SkillLibraryService {
  return new SkillLibraryService({ db, enabled: opts.enabled ?? true });
}

describe('seedSkills 内置策略技能', () => {
  it('seed 写入内置技能，重复 seed 幂等（不重复、不报错）', () => {
    const svc = makeService();
    const first = seedSkills(svc, BUILTIN_STRATEGY_SKILLS);
    expect(first).toBe(BUILTIN_STRATEGY_SKILLS.length);
    const second = seedSkills(svc, BUILTIN_STRATEGY_SKILLS);
    expect(second).toBe(0);
    expect(svc.list(200).length).toBe(BUILTIN_STRATEGY_SKILLS.length);
  });

  it('seed 命中后可被 match 检索到（策略词 → 对应技能）', () => {
    const svc = makeService();
    seedSkills(svc, BUILTIN_STRATEGY_SKILLS);
    const hits = svc.match('预算耗尽 未收敛 卡死');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((s) => s.name === 'converge-early')).toBe(true);
  });

  it('未启用时 seed 静默返回 0，库保持空', () => {
    const svc = makeService({ enabled: false });
    expect(seedSkills(svc, BUILTIN_STRATEGY_SKILLS)).toBe(0);
    expect(svc.list()).toEqual([]);
  });

  it('单条非法 seed 被跳过，不影响其余条写入', () => {
    const svc = makeService();
    const bad = { name: 'bad-skill', steps: ['sk-abcdefghijklmnopqrstuvwxyz0123456789'] };
    const n = seedSkills(svc, [bad, ...BUILTIN_STRATEGY_SKILLS]);
    expect(n).toBe(BUILTIN_STRATEGY_SKILLS.length);
    expect(svc.get('bad-skill')).toBeUndefined();
  });
});

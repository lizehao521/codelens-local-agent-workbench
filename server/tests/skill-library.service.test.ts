/**
 * SkillLibraryService 单元测试：写入 / 检索 / 匹配 / 删除 + 密钥拒绝 + 未启用行为。
 *
 * 三条主线：
 *  1. 正常路径 —— 建得进、查得到、排得对、删得掉；
 *  2. 边界 —— 每一处上限（长度 / 条数 / 数量 / 数值范围 / topK / limit）都有明确行为；
 *  3. 异常 —— 密钥形态一律拒绝入库且**不回显原文**；技能库未启用时读写各有确定行为。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createDb, type Db } from '../src/repositories/db.js';
import { SCHEMA_SQL } from '../src/repositories/schema.js';
import { SkillLibraryService } from '../src/services/skills/skill-library.service.js';
import { SkillsController } from '../src/controllers/skills.controller.js';
import { AppError } from '../src/utils/errors.js';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
  db.exec(SCHEMA_SQL);
});

function makeService(opts: { enabled?: boolean; matchMinScore?: number; maxSteps?: number } = {}): SkillLibraryService {
  return new SkillLibraryService({
    db,
    enabled: opts.enabled ?? true,
    matchMinScore: opts.matchMinScore,
    maxSteps: opts.maxSteps,
  });
}

/** 一条合法的技能输入（各用例只改自己关心的字段）。 */
const baseInput = {
  name: 'debug-login',
  description: '定位登录失败的根本原因',
  tags: ['登录', '调试'],
  steps: ['先看服务端日志', '再复现一次', '最后给修复方案'],
};

/** 取出一次调用抛出的 AppError（断言用）。 */
function catchError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('期望抛出错误，但没有');
}

// ── 正常路径 ───────────────────────────────────────────────────────────────

describe('SkillLibraryService 正常路径', () => {
  it('创建 → list 可见 → get 命中 → match 命中 → remove 成功', () => {
    const svc = makeService();
    const created = svc.create({ ...baseInput });

    expect(created.name).toBe('debug-login');
    expect(created.description).toBe('定位登录失败的根本原因');
    expect(created.tags).toEqual(['登录', '调试']);
    expect(created.steps).toEqual(['先看服务端日志', '再复现一次', '最后给修复方案']);
    expect(created.matchScore).toBeCloseTo(0.7);
    expect(created.id).toBeTruthy();

    const list = svc.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(created.id);

    const got = svc.get('debug-login');
    expect(got?.id).toBe(created.id);
    expect(got?.steps).toEqual(baseInput.steps);

    const matches = svc.match('登录');
    expect(matches.map((m) => m.name)).toContain('debug-login');

    expect(svc.remove('debug-login')).toBe(true);
    expect(svc.list()).toHaveLength(0);
    expect(svc.get('debug-login')).toBeUndefined();
    // 再删一次：返回 false（不存在），不抛异常。
    expect(svc.remove('debug-login')).toBe(false);
  });

  it('steps / tags 原样保存：不截断、不改序、不丢中文字符', () => {
    const svc = makeService();
    const steps = ['第一步：读日志', '第二步：复现', '第三步：修复并验证'];
    const created = svc.create({ ...baseInput, steps, tags: ['登录', '调试', '排障'] });
    expect(created.steps).toEqual(steps);
    expect(created.tags).toEqual(['登录', '调试', '排障']);
    expect(svc.get('debug-login')?.steps).toEqual(steps);
  });

  it('match 按相关度降序：标签命中 > 描述包含 > 名称包含', () => {
    const svc = makeService();
    svc.create({ name: 'debug-login', description: '定位登录失败', tags: ['登录'], steps: ['看日志'] });
    svc.create({ name: 'a-skill', description: '这个技能会处理发布流程', tags: [], steps: ['发布前检查'] });
    svc.create({ name: '登录排查清单', description: '无关内容', tags: [], steps: ['逐项排除'] });
    svc.create({ name: '发布手册', description: '无关内容', tags: [], steps: ['照手册做'] });
    svc.create({ name: 'unrelated', description: '完全不相干', tags: ['其他'], steps: ['别的动作'] });

    // 标签命中（0.8 档）> 描述包含（0.6 档）> 名称包含（0.45 档）。
    const publish = svc.match('发布').map((m) => m.name);
    expect(publish).toEqual(['a-skill', '发布手册']);

    const login = svc.match('登录').map((m) => m.name);
    expect(login).toEqual(['debug-login', '登录排查清单']);
  });

  it('name 与 query 完全相等时排第一', () => {
    const svc = makeService();
    svc.create({ name: 'deploy', description: '发布到生产环境', tags: ['发布'], steps: ['打包'] });
    svc.create({ name: 'deploy-checklist', description: '发布前检查', tags: [], steps: ['检查'] });

    const matches = svc.match('deploy');
    expect(matches[0]?.name).toBe('deploy');
    expect(matches.map((m) => m.name)).toContain('deploy-checklist');
  });

  it('完全无关的 query 返回空数组', () => {
    const svc = makeService();
    svc.create({ ...baseInput });
    expect(svc.match('完全不相干的检索词')).toEqual([]);
  });

  it('matchMinScore 门槛生效：低于门槛的弱命中被挡掉', () => {
    svcFixture('debug-login', '定位登录失败', ['登录']);
    const loose = makeService({ matchMinScore: 0.15 });
    const strict = makeService({ matchMinScore: 0.3 });
    expect(loose.match('登录 排查').length).toBe(1);
    expect(strict.match('登录 排查')).toEqual([]);
  });

  function svcFixture(name: string, description: string, tags: string[]): void {
    makeService().create({ name, description, tags, steps: ['执行一次'] });
  }
});

// ── 边界 ───────────────────────────────────────────────────────────────────

describe('SkillLibraryService 边界', () => {
  it('steps 为空数组 → 拒绝', () => {
    const svc = makeService();
    expect(catchError(() => svc.create({ ...baseInput, steps: [] })).message).toMatch(/steps/);
  });

  it('steps 超过 maxSteps → 拒绝（默认 12 条）', () => {
    const svc = makeService();
    const twelve = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 步`);
    expect(() => svc.create({ ...baseInput, steps: twelve })).not.toThrow();
    const thirteen = [...twelve, '第 13 步'];
    expect(catchError(() => svc.create({ ...baseInput, name: 'other', steps: thirteen })).message).toMatch(/最多 12 条/);
  });

  it('maxSteps 可配置（自定义为 3 时第 4 条被拒）', () => {
    const svc = makeService({ maxSteps: 3 });
    expect(catchError(() => svc.create({ ...baseInput, steps: ['一', '二', '三', '四'] })).message).toMatch(/最多 3 条/);
  });

  it('单步超长（>512）→ 拒绝', () => {
    const svc = makeService();
    // 用中文填充：连续 ASCII 长串会被密钥规则（长不透明 token）先拦下，
    // 那样测的就不是长度规则了。
    const err = catchError(() => svc.create({ ...baseInput, steps: ['步'.repeat(513)] }));
    expect(err.message).toMatch(/steps\[0\]/);
    expect(err.message).toMatch(/512/);
  });

  it('单步恰好 512 → 允许', () => {
    const svc = makeService();
    expect(() => svc.create({ ...baseInput, steps: ['步'.repeat(512)] })).not.toThrow();
  });

  it('name 超长（>64）→ 拒绝', () => {
    const svc = makeService();
    const err = catchError(() => svc.create({ ...baseInput, name: '名'.repeat(65) }));
    expect(err.message).toMatch(/name/);
    expect(err.message).toMatch(/64/);
  });

  it('name 含空白 / 路径分隔符 / 非法字符 → 拒绝', () => {
    const svc = makeService();
    for (const bad of ['bad name', '../etc/passwd', 'a/b', 'a\\b', 'name@x', '名字 空格']) {
      expect(catchError(() => svc.create({ ...baseInput, name: bad })).message).toMatch(/name/);
    }
  });

  it('name 含中文 / 点 / 下划线 / 连字符 → 允许', () => {
    const svc = makeService();
    expect(() => svc.create({ ...baseInput, name: '登录排查.v2_final-01' })).not.toThrow();
  });

  it('description 超长（>512）→ 拒绝', () => {
    const svc = makeService();
    expect(catchError(() => svc.create({ ...baseInput, description: '描'.repeat(513) })).message).toMatch(/description/);
  });

  it('tags 超量（>16 项）→ 拒绝', () => {
    const svc = makeService();
    const tags = Array.from({ length: 17 }, (_, i) => `t${i}`);
    expect(catchError(() => svc.create({ ...baseInput, tags })).message).toMatch(/tags/);
  });

  it('tags 单项超长（>32）→ 拒绝', () => {
    const svc = makeService();
    expect(catchError(() => svc.create({ ...baseInput, tags: ['标'.repeat(33)] })).message).toMatch(/tags/);
  });

  it('matchScore 越界（负数 / >1 / NaN）→ 拒绝', () => {
    const svc = makeService();
    expect(catchError(() => svc.create({ ...baseInput, matchScore: -0.1 })).message).toMatch(/matchScore/);
    expect(catchError(() => svc.create({ ...baseInput, matchScore: 1.1 })).message).toMatch(/matchScore/);
    expect(catchError(() => svc.create({ ...baseInput, matchScore: Number.NaN })).message).toMatch(/matchScore/);
    expect(catchError(() => svc.create({ ...baseInput, matchScore: Number.POSITIVE_INFINITY })).message).toMatch(/matchScore/);
  });

  it('matchScore 缺省 → 0.7；边界值 0 与 1 允许', () => {
    const svc = makeService();
    expect(svc.create({ ...baseInput }).matchScore).toBeCloseTo(0.7);
    expect(svc.create({ ...baseInput, name: 'zero', matchScore: 0 }).matchScore).toBe(0);
    expect(svc.create({ ...baseInput, name: 'one', matchScore: 1 }).matchScore).toBe(1);
  });

  it('query 为空串 / 纯空白 → 返回空数组（不退化成全量列表）', () => {
    const svc = makeService();
    svc.create({ ...baseInput });
    svc.create({ ...baseInput, name: 'other' });
    expect(svc.match('')).toEqual([]);
    expect(svc.match('   ')).toEqual([]);
    expect(svc.match('')).toHaveLength(0);
  });

  it('topK 越界被截断（0 → 1，999 → 10，缺省 → 3）', () => {
    const svc = makeService();
    for (let i = 0; i < 12; i += 1) {
      svc.create({ name: `bulk-${i}`, description: '', tags: ['批量'], steps: [`第 ${i + 1} 步`] });
    }
    expect(svc.match('批量', 999)).toHaveLength(10);
    expect(svc.match('批量', 0)).toHaveLength(1);
    expect(svc.match('批量', -3)).toHaveLength(1);
    expect(svc.match('批量')).toHaveLength(3);
  });

  it('limit 越界被截断（0 → 1，9999 → 200，缺省 → 50）', () => {
    const svc = makeService();
    svc.create({ ...baseInput });
    svc.create({ ...baseInput, name: 'other' });
    expect(svc.list(0)).toHaveLength(1);
    expect(svc.list(-5)).toHaveLength(1);
    expect(svc.list(9999)).toHaveLength(2);
    expect(svc.list()).toHaveLength(2);
  });

  it('重名 → 明确报错，且不覆盖原技能', () => {
    const svc = makeService();
    const first = svc.create({ ...baseInput });
    const err = catchError(() => svc.create({ ...baseInput, description: '另一份描述' }));
    expect(err.message).toMatch(/已存在/);
    expect(err.code).toBe('SKILL_ALREADY_EXISTS');
    expect(svc.get('debug-login')?.description).toBe(first.description);
    expect(svc.list()).toHaveLength(1);
  });
});

// ── 异常：密钥形态 ─────────────────────────────────────────────────────────

describe('SkillLibraryService 密钥拒绝', () => {
  const OPENAI_KEY = 'sk-abcdefghijklmnopqrstuvwx';
  const OPAQUE_TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
  const KEY_VALUE = 'api_key=super-secret-value';

  it('OpenAI 风格密钥 → 拒绝入库，错误信息不含原文', () => {
    const svc = makeService();
    const err = catchError(() => svc.create({ ...baseInput, steps: [`调用 ${OPENAI_KEY} 完成鉴权`] }));
    expect(err.code).toBe('SKILL_SECRET_DETECTED');
    expect(err.message).toContain('steps[0]');
    expect(err.message).toContain('OpenAI 风格密钥前缀');
    expect(err.message).not.toContain(OPENAI_KEY);
    expect(err.message).not.toContain('abcdefghijklmnopqrstuvwx');
    expect(svc.list()).toHaveLength(0);
  });

  it('长不透明 token → 拒绝入库，错误信息不含原文', () => {
    const svc = makeService();
    const err = catchError(() => svc.create({ ...baseInput, description: `凭证 ${OPAQUE_TOKEN} 放在这里` }));
    expect(err.code).toBe('SKILL_SECRET_DETECTED');
    expect(err.message).toContain('description');
    expect(err.message).toContain('长不透明 token');
    expect(err.message).not.toContain(OPAQUE_TOKEN);
    expect(svc.list()).toHaveLength(0);
  });

  it('键值形态凭证 → 拒绝入库，错误信息不含原文', () => {
    const svc = makeService();
    const err = catchError(() => svc.create({ ...baseInput, steps: [`先设置 ${KEY_VALUE} 再跑`] }));
    expect(err.code).toBe('SKILL_SECRET_DETECTED');
    expect(err.message).toContain('steps[0]');
    expect(err.message).toContain('键值形态凭证');
    expect(err.message).not.toContain(KEY_VALUE);
    expect(err.message).not.toContain('super-secret-value');
    expect(svc.list()).toHaveLength(0);
  });

  it('name / tags 命中密钥同样被拒', () => {
    const svc = makeService();
    expect(catchError(() => svc.create({ ...baseInput, name: `skill-${OPENAI_KEY}` })).message).toContain('name');
    expect(catchError(() => svc.create({ ...baseInput, tags: [KEY_VALUE] })).message).toContain('tags[0]');
    expect(svc.list()).toHaveLength(0);
  });
});

// ── 异常：未启用 ───────────────────────────────────────────────────────────

describe('SkillLibraryService 未启用', () => {
  it('enabled=false：list / match 返回空数组，create / remove 抛明确错误', () => {
    const svc = makeService({ enabled: false });
    expect(svc.enabled).toBe(false);

    expect(svc.list()).toEqual([]);
    expect(svc.match('登录')).toEqual([]);
    expect(svc.get('debug-login')).toBeUndefined();

    const createErr = catchError(() => svc.create({ ...baseInput }));
    expect(createErr.message).toMatch(/未启用/);
    expect(createErr.code).toBe('SKILL_LIBRARY_DISABLED');

    const removeErr = catchError(() => svc.remove('debug-login'));
    expect(removeErr.message).toMatch(/未启用/);
    expect(removeErr.code).toBe('SKILL_LIBRARY_DISABLED');
  });

  it('未启用时即便库里已有数据也一律不外露', () => {
    makeService().create({ ...baseInput });
    const disabled = makeService({ enabled: false });
    expect(disabled.list()).toEqual([]);
    expect(disabled.match('登录')).toEqual([]);
    expect(disabled.get('debug-login')).toBeUndefined();
  });
});

// ── 控制器：响应形状 ───────────────────────────────────────────────────────

interface Captured {
  status: number;
  body: Record<string, unknown> | undefined;
}

function callController(controller: SkillsController, query: Record<string, unknown> = {}, params: Record<string, unknown> = {}): Captured {
  const captured: Captured = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload as Record<string, unknown>;
      return this;
    },
  };
  const req = { query, params } as unknown as Request;
  controller.list(req, res as unknown as Response);
  return captured;
}

describe('SkillsController 响应形状', () => {
  it('无 q → 列表模式；有 q → 匹配模式', () => {
    const svc = makeService();
    svc.create({ ...baseInput });
    const controller = new SkillsController(svc);

    const listed = callController(controller);
    expect(listed.body?.mode).toBe('list');
    expect(listed.body?.enabled).toBe(true);
    expect(Array.isArray(listed.body?.skills)).toBe(true);

    const matched = callController(controller, { q: '登录' });
    expect(matched.body?.mode).toBe('match');
    expect(matched.body?.query).toBe('登录');
    expect(Array.isArray(matched.body?.matches)).toBe(true);
  });

  it('?q= （空查询）走匹配模式且返回空数组，不退化成全量列表', () => {
    const svc = makeService();
    svc.create({ ...baseInput });
    const controller = new SkillsController(svc);

    const empty = callController(controller, { q: '' });
    expect(empty.body?.mode).toBe('match');
    expect(empty.body?.matches).toEqual([]);
  });

  it('未启用时 list 模式回 enabled:false 且列表为空', () => {
    const controller = new SkillsController(makeService({ enabled: false }));
    const listed = callController(controller);
    expect(listed.body?.enabled).toBe(false);
    expect(listed.body?.skills).toEqual([]);
  });
});

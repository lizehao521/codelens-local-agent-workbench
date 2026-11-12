/**
 * 迭代判据与变更域的判据自证。
 *
 * 按宣言 C3：判据自己要先被判据检验。这份测试的重点不是「跑通」，
 * 而是**证明每条判据真的能被打红**——尤其下面这五条金丝雀：
 *   · 护栏回退时，不许走 retry，必须 rollback（否则会出现「越退越试」的死亡螺旋）
 *   · 越权改动时，必须 rollback（不是 WARN 一下就放过）
 *   · 闸没跑（unexec）时，既不能判 continue、也不能只判 retry（宣言 C4）
 *   · D4 判据层任何情况都拒（谁批都不行）
 *   · 无人值守触发不许进 D2 以上
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANGE_DOMAINS, checkDomain, resolveDomain, createRollbackPoint, rollbackTo } from '../src/services/rsi/change-domain.js';
import { evaluateIteration, DECISION_META, type GateResult, type IterationInput } from '../src/services/rsi/iteration-gate.js';

const passGates = (): GateResult[] => [
  { id: 'protected', status: 'pass' },
  { id: 'judge-fingerprint', status: 'pass' },
  { id: 'target-changed', status: 'pass' },
  { id: 'typecheck', status: 'pass' },
  { id: 'judge-selftest', status: 'pass' },
  { id: 'judge', status: 'pass' },
  { id: 'full-suite', status: 'pass' },
];

const baseInput = (over: Partial<IterationInput> = {}): IterationInput => ({
  iterationId: 'it-1',
  trigger: 'manual',
  domain: 'D1',
  attempts: 1,
  maxAttempts: 3,
  verdict: 'improved',
  gates: passGates(),
  guardRegressed: 0,
  coverage: 0.9,
  outOfScopeChanges: 0,
  humanApproved: true,
  ...over,
});

// ── 变更域 ──────────────────────────────────────────────────────────────

describe('变更域：权限范围与边界', { timeout: 30_000 }, () => {
  it('D1 按"先命中先归"取最严的域', () => {
    expect(resolveDomain(['src/tools/builtin/fs-write.tool.ts'])).toBe('D1');
    expect(resolveDomain(['src/services/agent/agent-loop.service.ts'])).toBe('D2');
    expect(resolveDomain(['package.json'])).toBe('D3');
    expect(resolveDomain(['tests/self-upgrade/x.test.ts'])).toBe('D4');
    // 混合时取最严
    expect(resolveDomain(['src/tools/a.ts', 'tests/b.test.ts'])).toBe('D4');
    expect(resolveDomain([])).toBe('D0');
  });

  it('金丝雀：判据层一律拒绝（谁批都不行）', () => {
    const r = checkDomain({ files: ['tests/self-upgrade/x.test.ts'], trigger: 'manual', humanApproved: true });
    expect(r.ok).toBe(false);
    expect(r.domain).toBe('D4');
    expect(r.reasons.join()).toContain('通行证');
  });

  it('金丝雀：无人值守触发不得进入服务层以上', () => {
    const r = checkDomain({ files: ['src/services/agent/x.ts'], trigger: 'schedule', humanApproved: true });
    expect(r.ok).toBe(false);
    expect(r.domain).toBe('D2');
    expect(r.reasons.join()).toContain('schedule');
  });

  it('工具层可全自动（定时触发也允许）', () => {
    const r = checkDomain({ files: ['src/tools/builtin/x.tool.ts'], trigger: 'schedule', humanApproved: false });
    expect(r.ok).toBe(true);
    expect(r.domain).toBe('D1');
  });

  it('需要人批的域：未批则要求 human-approval', () => {
    const r = checkDomain({ files: ['src/services/agent/x.ts'], trigger: 'manual', humanApproved: false });
    expect(r.ok).toBe(false);
    expect(r.required).toBe('human-approval');
  });

  it('文件数超过域上限即拒绝（防在低域里夹带）', () => {
    const many = Array.from({ length: 9 }, (_, i) => `src/tools/builtin/t${i}.tool.ts`);
    const r = checkDomain({ files: many, trigger: 'manual', humanApproved: true });
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toContain('上限');
  });

  it('前端路径也必须被域表覆盖（不允许出现无人管的放行通道）', () => {
    // 这一组是补洞用的：域表原来只写 server 相对路径，
    // client/ 下的文件一条规则都匹配不到 → 落到 D0（只读、无需审批）→ 悄悄放行。
    expect(resolveDomain(['../client/src/components/agent/RsiIterationGate.tsx'])).toBe('D1');
    expect(resolveDomain(['client/src/hooks/useAsyncData.ts'])).toBe('D2');
    expect(resolveDomain(['client/src/App.tsx'])).toBe('D3');
    expect(resolveDomain(['client/tests/rsi-rules.test.ts'])).toBe('D4');
    expect(resolveDomain(['client/src/lib/rules.test.ts'])).toBe('D4');
  });

  it('金丝雀：未登记路径按架构层处理（fail-closed），不是放行', () => {
    const r = checkDomain({ files: ['some-brand-new-package/index.ts'], trigger: 'schedule', humanApproved: false });
    expect(r.ok).toBe(false);
    expect(r.domain).toBe('D3');
    expect(r.reasons.join()).toContain('未登记');
  });

  it('域表本身的完整性：每个域都有理由与上限', () => {
    for (const d of CHANGE_DOMAINS) {
      expect(d.rationale.length).toBeGreaterThan(8);
      expect(d.maxFiles).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── 迭代决策 ────────────────────────────────────────────────────────────

describe('迭代决策：达标 / 继续 / 回滚', { timeout: 30_000 }, () => {
  it('全绿 → continue', () => {
    const r = evaluateIteration(baseInput());
    expect(r.decision).toBe('continue');
    expect(r.criteria.every((c) => c.status === 'pass')).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('金丝雀：护栏回退必须回滚，不许重试', () => {
    const r = evaluateIteration(baseInput({ guardRegressed: 2 }));
    expect(r.decision).toBe('rollback');
    expect(r.rollbackReasons.join()).toContain('护栏');
    // 关键：不能被 G1 的 retry 抢走
    expect(r.criteria.find((c) => c.id === 'G2')?.status).toBe('fail');
  });

  it('金丝雀：越权改动必须回滚', () => {
    const r = evaluateIteration(baseInput({ outOfScopeChanges: 1 }));
    expect(r.decision).toBe('rollback');
    expect(r.rollbackReasons.join()).toContain('越权');
  });

  it('金丝雀：闸没跑既不是通过、也不只是重试', () => {
    const gates = passGates().map((g) => (g.id === 'full-suite' ? { ...g, status: 'unexec' as const, detail: '未加 --full' } : g));
    const r = evaluateIteration(baseInput({ gates }));
    expect(r.decision).toBe('escalate');
    expect(r.criteria.find((c) => c.id === 'G3')?.status).toBe('unexec');
    expect(r.confidence).toBeLessThan(1);
  });

  it('未改进且尝试未耗尽 → retry', () => {
    const r = evaluateIteration(baseInput({ verdict: 'not_improved', attempts: 1 }));
    expect(r.decision).toBe('retry');
  });

  it('未改进且尝试耗尽 → rollback（不留半成品）', () => {
    const r = evaluateIteration(baseInput({ verdict: 'not_improved', attempts: 3, maxAttempts: 3 }));
    expect(r.decision).toBe('rollback');
    expect(r.rollbackReasons.join()).toContain('预算已用尽');
  });

  it('已改进 + 其余闸全绿 + 尝试耗尽 → escalate，不得回滚好改动', () => {
    // 现场回放：fs-read-truncated-flag-false-positive#3 —— verdict=improved、
    // G1–G5 全绿、coverage=1.00、人工确认成立，却因为第 3/3 次被判"必须回滚"。
    const r = evaluateIteration(baseInput({ verdict: 'improved', attempts: 3, maxAttempts: 3 }));
    expect(r.decision).toBe('escalate');
    const g6 = r.criteria.find((c) => c.id === 'G6');
    expect(g6?.status).toBe('fail');
    expect(g6?.onFail).toBe('escalate');
    expect(r.headline).not.toContain('回滚');
    expect(r.rollbackReasons).toEqual([]);
  });

  it('已改进但护栏回退 + 尝试耗尽 → 仍是 rollback（地基坏了压过预算）', () => {
    const r = evaluateIteration(
      baseInput({ verdict: 'improved', attempts: 3, maxAttempts: 3, guardRegressed: 1 }),
    );
    expect(r.decision).toBe('rollback');
    expect(r.criteria.find((c) => c.id === 'G2')?.status).toBe('fail');
  });

  it('拒收（refused）→ rollback', () => {
    const r = evaluateIteration(baseInput({ verdict: 'refused' }));
    expect(r.decision).toBe('rollback');
  });

  it('需要人批的域未批 → escalate，且优先于其它结论', () => {
    const r = evaluateIteration(baseInput({ domain: 'D3', humanApproved: false }));
    expect(r.decision).toBe('escalate');
    expect(r.headline).toContain('人工批准');
  });

  it('覆盖率不足 → retry', () => {
    const r = evaluateIteration(baseInput({ coverage: 0.2 }));
    expect(r.decision).toBe('retry');
    expect(r.criteria.find((c) => c.id === 'G5')?.status).toBe('fail');
  });

  it('纯函数：同输入同输出（可回放历史现场）', () => {
    const a = evaluateIteration(baseInput({ verdict: 'not_improved' }));
    const b = evaluateIteration(baseInput({ verdict: 'not_improved' }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('每种决策都有标签与动作（前端不会渲染出空白）', () => {
    for (const meta of Object.values(DECISION_META)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.action.length).toBeGreaterThan(0);
      expect(['success', 'warning', 'danger', 'muted']).toContain(meta.tone);
    }
  });
});

// ── 回滚点 ──────────────────────────────────────────────────────────────

describe('回滚点：能精确还原这一轮动过的文件', { timeout: 30_000 }, () => {
  it('新建的文件回滚后被删除，改过的文件回滚后恢复原文', () => {
    const root = process.cwd();
    // 用临时文件验证，不碰任何真实源码
    const rel = 'tmp/rsi-rollback-probe.txt';
    // 幂等：下面第一条断言要求「这个文件原本不存在」。上一次运行若在中途失败，
    // 残留会让第二次跑必红 —— 而围栏的全量回归失败后会重试一次，
    // 于是「非幂等测试」把重试变成「保证失败两次」（实测踩过，且被误判成真回归）。
    rmSync(`${root}/${rel}`, { force: true });
    const point = createRollbackPoint({ id: 'probe', root, files: [rel], git: false });
    expect(point.fileSnapshots[rel]).toBeNull(); // 原本不存在

    mkdirSync(`${root}/tmp`, { recursive: true });
    writeFileSync(`${root}/${rel}`, 'created by iteration', 'utf8');
    expect(existsSync(`${root}/${rel}`)).toBe(true);

    const res = rollbackTo(point, root);
    expect(res.ok).toBe(true);
    expect(res.via).toBe('snapshot');
    expect(existsSync(`${root}/${rel}`)).toBe(false);
    rmSync(`${root}/tmp`, { recursive: true, force: true });
  });
});

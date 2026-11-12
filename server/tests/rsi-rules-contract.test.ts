/**
 * RSI 规则契约验收：AC-01 / AC-02。
 *
 * 测试纪律：断言从 Spec §2 锁定表和 main.go 常量**独立反推**，不复述实现内部；
 * 契约取值既能被纯函数单测钉死，也能从两个端点黑盒取回并逐项比对。
 *
 * 覆盖：
 *  1. 契约 version / 6 条 rules / 6 态 states / basis / thresholds（运行时 import 对照）；
 *  2. `GET /api/rsi/rules` 免 session、no-store、与纯函数同源；
 *  3. `GET /api/rsi/overview` 只新增顶层 `rules`，既有 6 字段值原样保留；
 *  4. 两个端点下发的 rules JSON 深度相等。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import {
  buildRsiRulesContract,
  type RsiRuleDefinition,
  type RsiStateDefinition,
} from '../src/services/rsi/rules-contract.js';
import { DEFAULT_L0_THRESHOLDS } from '../src/services/judge/criteria.js';
import { COVERAGE_THRESHOLD } from '../src/services/judge/types.js';
import { resetRateLimits } from '../src/middlewares/rate-limit.js';

const SESSION_ID = 'sess-rules-contract-001';

/** 独立 oracle：main.go:74-77 退出码常量 + rsi-bridge.service.ts:33 六态。 */
const EXPECTED_STATES: Array<{
  state: string;
  exitCode: number | null;
  label: string;
  tone: string;
}> = [
  { state: 'improved', exitCode: 0, label: '已改进', tone: 'success' },
  { state: 'not_improved', exitCode: 1, label: '未改进', tone: 'warning' },
  { state: 'refused', exitCode: 2, label: '拒收', tone: 'danger' },
  { state: 'undecidable', exitCode: 3, label: '无法判定', tone: 'warning' },
  { state: 'skipped', exitCode: null, label: '跳过', tone: 'muted' },
  { state: 'error', exitCode: null, label: '桥接故障', tone: 'danger' },
];

/** C2 裁定：main.go:232-237 只对 basis=4/5 设必带字段。 */
const EXPECTED_BASIS_REQUIRED_FIELD: Record<number, string | null> = {
  1: null,
  2: null,
  3: null,
  4: 'source',
  5: 'why_absent',
};

/**
 * basis 中文标签锁定（Spec §2 锁定表 / §6 第 11 项）。
 * 第 5 项是「量不到」而非「缺失」：why_absent 语义是这一代量不到读数，
 * 写成「缺失」会与 data_json 字段缺失混淆（rsi-loop.md §2 basis 表口径）。
 */
const EXPECTED_BASIS_LABELS = ['实测', '转述', '估算', '模型自述', '量不到'];

/** rules[].name 六条长名（Spec §2 锁定表 / §6-11，以后端契约为唯一权威）。 */
const EXPECTED_RULE_NAMES = [
  '结构与 schema 合法',
  '判据集显式锚定',
  '防删指标（防放水）',
  '产物内容哈希可复核',
  '同一代账本唯一',
  '两代读数严格比较',
];

let runtime: Runtime;
let server: http.Server;
let base: string;
let tmpRoot: string;

beforeEach(async () => {
  // 限流计数器是模块级单例，避免同 worker 内跨用例累积导致 429 误判。
  resetRateLimits();
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'codelens-rules-contract-'));
  runtime = createRuntime({ dbPath: path.join(tmpRoot, 'rules-contract.db') });
  const app = createApp({ runtime, autoStartModelSync: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const now = Date.now();
  runtime.db.run(
    `INSERT INTO sessions (id, title, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [SESSION_ID, 'rules-contract', 'custom', 'm', now, now],
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await runtime.close();
  // 宿主 safe-delete shim 并发下可能超时：清理 best-effort，不能把已绿用例判红。
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test-cleanup] 临时目录清理失败（不影响测试结论）:', err instanceof Error ? err.message : err);
  }
});

describe('buildRsiRulesContract() 纯函数（AC-01 契约取值）', () => {
  it('version 锁定为 rsi-rules-contract-v1，authority 指向内核', () => {
    const c = buildRsiRulesContract();
    expect(c.version).toBe('rsi-rules-contract-v1');
    expect(c.authority).toBe('server/krsi/main.go');
    expect(c.reasonRuleIdPattern).toBe('^(R[1-6]):');
  });

  it('rules 恰 6 条、id 集合 = {R1..R6}、按 order 升序且执行序为 R1..R4,R6,R5', () => {
    const { rules } = buildRsiRulesContract();
    expect(rules).toHaveLength(6);
    expect(new Set(rules.map((r) => r.id))).toEqual(
      new Set(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']),
    );
    expect(rules.map((r) => r.order)).toEqual([1, 2, 3, 4, 5, 6]);
    // C5：编号顺序 ≠ 执行顺序，R6 在 R5 之前。
    expect(rules.map((r) => r.id)).toEqual(['R1', 'R2', 'R3', 'R4', 'R6', 'R5']);
    // Spec §6-11：六条长名逐字锁定，防止文档/兜底另用简称造成三处漂移。
    expect(rules.map((r) => r.name)).toEqual(EXPECTED_RULE_NAMES);
    const byId = Object.fromEntries(rules.map((r) => [r.id, r])) as Record<string, RsiRuleDefinition>;
    expect(byId['R6']!.order).toBe(5);
    expect(byId['R5']!.order).toBe(6);
  });

  it('R1–R4/R6 为拒收类（refused / exit 2），R5 为比较类（0/1/3）', () => {
    const { rules } = buildRsiRulesContract();
    const byId = Object.fromEntries(rules.map((r) => [r.id, r])) as Record<string, RsiRuleDefinition>;
    for (const id of ['R1', 'R2', 'R3', 'R4', 'R6']) {
      expect(byId[id]!.kind).toBe('rejection');
      expect(byId[id]!.resultsIn).toEqual(['refused']);
      expect(byId[id]!.exitCodes).toEqual([2]);
      expect(byId[id]!.anchor).toContain('server/krsi/main.go:');
    }
    expect(byId['R5']!.kind).toBe('comparison');
    expect(byId['R5']!.resultsIn).toEqual(['improved', 'not_improved', 'undecidable']);
    expect(byId['R5']!.exitCodes).toEqual([0, 1, 3]);
  });

  it('每条 rule 的 anchor 落在 main.go 的真实行号区间', () => {
    const expected: Record<string, string> = {
      R1: 'server/krsi/main.go:215-243',
      R2: 'server/krsi/main.go:246-264',
      R3: 'server/krsi/main.go:267-283',
      R4: 'server/krsi/main.go:286-308',
      R6: 'server/krsi/main.go:311-337',
      R5: 'server/krsi/main.go:344-435,507-538',
    };
    for (const r of buildRsiRulesContract().rules) {
      expect(r.anchor).toBe(expected[r.id]);
      expect(r.appliesWhen.length).toBeGreaterThan(0);
      expect(r.criterion.length).toBeGreaterThan(0);
      expect(r.onHit.length).toBeGreaterThan(0);
    }
  });

  it('states 恰 6 态，state/exitCode/label/tone 与 main.go 常量及锁定表一致', () => {
    const { states } = buildRsiRulesContract();
    expect(states).toHaveLength(6);
    expect(
      states.map(({ state, exitCode, label, tone }) => ({ state, exitCode, label, tone })),
    ).toEqual(EXPECTED_STATES);
    for (const s of states as RsiStateDefinition[]) {
      expect(['krsi', 'bridge']).toContain(s.origin);
      expect(s.meaning.length).toBeGreaterThan(0);
      expect(s.action.length).toBeGreaterThan(0);
    }
  });

  it('basis 5 条：4→source、5→why_absent，其余必带字段为 null（C2 裁定）', () => {
    const { basis } = buildRsiRulesContract();
    expect(basis).toHaveLength(5);
    expect(basis.map((b) => b.value)).toEqual([1, 2, 3, 4, 5]);
    expect(basis.map((b) => b.name)).toEqual([
      'measured', 'relayed', 'estimated', 'model_says', 'absent',
    ]);
    for (const b of basis) {
      expect(b.requiredField).toBe(EXPECTED_BASIS_REQUIRED_FIELD[b.value]);
    }
  });

  it('basis 中文标签逐值锁定为 实测/转述/估算/模型自述/量不到（Spec §2 / §6-11）', () => {
    const { basis } = buildRsiRulesContract();
    expect(basis.map((b) => b.label)).toEqual(EXPECTED_BASIS_LABELS);
    // 第 5 项单独钉死：防止「量不到」被误写回「缺失」造成文档/机器契约漂移。
    expect(basis.find((b) => b.value === 5)!.label).toBe('量不到');
  });

  it('thresholds 等于运行时 import 值，不复制数字字面量', () => {
    const { thresholds } = buildRsiRulesContract();
    expect(thresholds).toEqual({
      minToolSuccessRate: DEFAULT_L0_THRESHOLDS.minToolSuccessRate,
      maxApprovalRejectionRate: DEFAULT_L0_THRESHOLDS.maxApprovalRejectionRate,
      maxBudgetUsageRate: DEFAULT_L0_THRESHOLDS.maxBudgetUsageRate,
      coverageThreshold: COVERAGE_THRESHOLD,
    });
  });

  it('judgeRunStates / criterionStatuses / roles / outOfScope 齐全', () => {
    const c = buildRsiRulesContract();
    expect(c.judgeRunStates.map((s) => s.state)).toEqual(['pass', 'fail', 'inconclusive']);
    expect(c.criterionStatuses.map((s) => s.state)).toEqual(['pass', 'fail', 'unexec']);
    expect(c.roles.map((r) => r.role)).toEqual(['objective', 'guard']);
    expect(c.outOfScope.length).toBeGreaterThanOrEqual(3);
  });

  it('每次调用返回全新对象，改动不会污染后续调用（纯函数无共享态）', () => {
    const first = buildRsiRulesContract();
    first.rules[0]!.name = 'MUTATED';
    first.states[0]!.label = 'MUTATED';
    const second = buildRsiRulesContract();
    expect(second.rules[0]!.name).not.toBe('MUTATED');
    expect(second.states[0]!.label).not.toBe('MUTATED');
    expect(second).toEqual(buildRsiRulesContract());
  });
});

describe('GET /api/rsi/rules（AC-01）', () => {
  it('免 session、200、Cache-Control: no-store，返回体与纯函数同源', async () => {
    const res = await request(base).get('/api/rsi/rules');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toEqual(buildRsiRulesContract());
    expect(res.body.version).toBe('rsi-rules-contract-v1');
    expect(res.body.rules).toHaveLength(6);
    expect(res.body.states).toHaveLength(6);
    expect(res.body.rules.map((r: RsiRuleDefinition) => r.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('GET /api/rsi/overview（AC-02）', () => {
  it('既有 6 个顶层字段值原样保留，仅新增顶层 rules', async () => {
    const res = await request(base).get(`/api/rsi/overview?session=${SESSION_ID}`);
    expect(res.status).toBe(200);
    const body = res.body;

    // 顶层键集合 = 6 个既有字段 + 新增 rules，多一个少一个都判不合格。
    expect(Object.keys(body).sort()).toEqual(
      ['attributions', 'eval', 'judgeRuns', 'rsiRuns', 'rules', 'session', 'verdictsByRun'].sort(),
    );
    expect(body.session).toMatchObject({ id: SESSION_ID, title: 'rules-contract' });
    expect(body.judgeRuns).toEqual([]);
    expect(body.verdictsByRun).toEqual({});
    expect(body.rsiRuns).toEqual([]);
    expect(body.attributions).toEqual([]);
    expect(body.eval).toBeNull();
    expect(body.rules).toEqual(buildRsiRulesContract());
  });

  it('两个端点下发的 rules JSON 深度相等', async () => {
    const rulesRes = await request(base).get('/api/rsi/rules');
    const overviewRes = await request(base).get(`/api/rsi/overview?session=${SESSION_ID}`);
    expect(rulesRes.status).toBe(200);
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.body.rules).toEqual(rulesRes.body);
  });
});

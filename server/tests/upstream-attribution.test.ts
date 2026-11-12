/**
 * 上游不可达归因的自证判据。
 *
 * 这套系统已经三次把「环境/调度链断了」记成 Agent 的能力失败：
 *   1. 服务没起来（ECONNREFUSED）→ 曾被记成实现层
 *   2. 题入队但没任务书（未知题目）→ 曾被记成 implementation/TARGET_UNTOUCHED
 *   3. LLM 上游连接超时（fetch failed / UND_ERR_CONNECT_TIMEOUT）→ 本地服务健康
 *      但转发失败，run_report 空，和「模型只说不做」几乎同形
 *
 * 第 3 条最隐蔽：本地 8099 的 health 是 ok，`serviceHealthy: true` 成立，
 * 所以旧的 infra 分支不会触发。这组用例把边界钉死，同时用两条金丝雀
 * 防止新分支过度匹配、把真正的能力失败也一并洗白。
 */

import { describe, expect, it } from 'vitest';
import { attributeFailure, type AttributionInput } from '../scripts/failure-attribution.js';

const base: AttributionInput = {
  taskId: 'upstream-probe',
  attempt: 1,
  maxAttempts: 3,
  dispatch: { exitOk: true, output: '' },
  diagnosis: '',
  fence: {
    reached: true,
    targetChanged: false,
    typeOk: true,
    judgeOk: false,
    fullOk: false,
    protectedIntact: true,
    judgeTampered: false,
  },
  serviceHealthy: true,
};

describe('UPSTREAM_UNREACHABLE 归因', () => {
  it('金丝雀：本地服务健康但 LLM 上游连接超时，仍必须归 infra 且不计入 Agent', () => {
    const a = attributeFailure({
      ...base,
      // serviceHealthy 保持 true —— 这正是旧归因漏判的现场
      dispatch: { exitOk: true, output: 'fetch failed UND_ERR_CONNECT_TIMEOUT' },
    });
    expect(a.layer).toBe('infra');
    expect(a.code).toBe('UPSTREAM_UNREACHABLE');
    expect(a.countsAgainstAgent).toBe(false);
    expect(a.nextAction).toBe('halt_manual');
    expect(a.owner).toBe('scheduler');
  });

  it('上游超时出现在诊断里而非派单输出里，也要认出来', () => {
    const a = attributeFailure({
      ...base,
      dispatch: { exitOk: true, output: '{"outcome":"completed","toolCallCount":0}' },
      diagnosis: '围栏结论：靶子未被改动；派单阶段 ETIMEDOUT connect timeout',
    });
    expect(a.layer).toBe('infra');
    expect(a.code).toBe('UPSTREAM_UNREACHABLE');
    expect(a.countsAgainstAgent).toBe(false);
  });

  it('金丝雀：额度耗尽（HTTP 429）必须归 infra、不计入 Agent、且停机等重置', () => {
    const a = attributeFailure({
      ...base,
      dispatch: {
        exitOk: true,
        output:
          'HTTP 429 {"message":"Daily usage limit exceeded: maximum $1 per 24 hours for this OneClick user. It resets at 2026-11-12 03:36 UTC","code":"rate_limit_exceeded"}',
      },
    });
    expect(a.layer).toBe('infra');
    expect(a.code).toBe('UPSTREAM_QUOTA_EXCEEDED');
    expect(a.countsAgainstAgent).toBe(false);
    expect(a.nextAction).toBe('halt_manual');
  });

  it('金丝雀：额度耗尽不能和「连接超时」混为一类', () => {
    const a = attributeFailure({
      ...base,
      dispatch: { exitOk: true, output: 'fetch failed UND_ERR_CONNECT_TIMEOUT' },
    });
    expect(a.code).toBe('UPSTREAM_UNREACHABLE');
    expect(a.code).not.toBe('UPSTREAM_QUOTA_EXCEEDED');
  });

  it('金丝雀：不许把真正的「只说不做」洗成环境问题', () => {
    const a = attributeFailure({
      ...base,
      dispatch: { exitOk: true, output: '{"outcome":"completed","finishReason":"stop","toolCallCount":0}' },
    });
    expect(a.layer).toBe('behavior');
    expect(a.code).not.toBe('UPSTREAM_UNREACHABLE');
  });

  it('金丝雀：不许把真正的实现层失败洗成环境问题', () => {
    const a = attributeFailure({
      ...base,
      dispatch: { exitOk: true, output: '{"outcome":"completed","toolCallCount":4}' },
      diagnosis: '判据 4 条失败：期望超时保留部分输出',
      fence: { ...base.fence, targetChanged: true, judgeOk: false },
    });
    expect(a.layer).toBe('implementation');
  });

  it('旧 infra 分支不回退：服务没起来仍归 infra', () => {
    const a = attributeFailure({
      ...base,
      dispatch: { exitOk: false, output: 'connect ECONNREFUSED 127.0.0.1:8099' },
      fence: { ...base.fence, reached: false },
    });
    expect(a.layer).toBe('infra');
    expect(a.countsAgainstAgent).toBe(false);
  });

  it('调度器缺件仍归 infra（前一次修的边界不许被覆盖）', () => {
    const a = attributeFailure({
      ...base,
      dispatch: { exitOk: false, output: '未知题目：some-new-task' },
    });
    expect(a.layer).toBe('infra');
    expect(a.code).toBe('TASKBOOK_MISSING');
    expect(a.countsAgainstAgent).toBe(false);
  });
});

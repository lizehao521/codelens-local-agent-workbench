// AUDIT-005 客户端回归 —— 两步确认的进度推导与瞬时锁定。
// 缺陷背景：服务端 two_step 顺序发两条 tool_approval_required（各自独立 token），
// 但客户端按 callId 覆盖，既不记录「第几步」，也不在第一步确认后锁定按钮。
// 结果：第二步挑战稍迟到达时用户会重复点同一已决令牌 → 服务端返回
// APPROVAL_ALREADY_DECIDED（409）；且两步进度对用户不可见，像重复弹窗。
// 覆盖：首步计数 / 第二步 +1 / ackPass 锁定 / 下一步到达解除 / 幂等（同 id 不 +1）/ soft-hard 不计数。

import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentApprovalPayload } from '../src/types';
import { useApprovalStore } from '../src/stores/approvalStore';

function approval(patch: Partial<AgentApprovalPayload> = {}): AgentApprovalPayload {
  return {
    callId: 'call_1',
    name: 'fs.delete',
    arguments: { path: '/sandbox' },
    risk: 'high',
    approvalMode: 'two_step',
    reason: '删除沙箱根目录需要两步确认',
    approvalId: 'ap_1',
    approvalToken: 'tok_1',
    expiresAt: Date.now() + 300_000,
    ...patch,
  };
}

beforeEach(() => {
  useApprovalStore.getState().reset();
});

describe('approvalStore.upsert（AUDIT-005 两步计数）', () => {
  it('首步 two_step：pass=1 / totalPasses=2 / 未锁定', () => {
    useApprovalStore.getState().upsert(approval());
    const vm = useApprovalStore.getState().byCallId.call_1;
    expect(vm?.pass).toBe(1);
    expect(vm?.totalPasses).toBe(2);
    expect(vm?.awaitingNextStep).toBe(false);
  });

  it('第二步（不同 approvalId、同 callId）：pass 自增为 2，解除锁定', () => {
    useApprovalStore.getState().upsert(approval({ approvalId: 'ap_1', approvalToken: 'tok_1' }));
    useApprovalStore.getState().upsert(approval({ approvalId: 'ap_2', approvalToken: 'tok_2' }));
    const vm = useApprovalStore.getState().byCallId.call_1;
    expect(vm?.pass).toBe(2);
    expect(vm?.totalPasses).toBe(2);
    expect(vm?.awaitingNextStep).toBe(false);
    // token 必须随第二步更新，否则仍指向已决的第一条
    expect(vm?.token).toBe('tok_2');
  });

  it('同 approvalId 重复事件：幂等，pass 不重复 +1', () => {
    useApprovalStore.getState().upsert(approval({ approvalId: 'ap_1' }));
    useApprovalStore.getState().upsert(approval({ approvalId: 'ap_1' }));
    const vm = useApprovalStore.getState().byCallId.call_1;
    expect(vm?.pass).toBe(1);
  });

  it('soft / hard 模式：不计入 pass / totalPasses', () => {
    useApprovalStore.getState().upsert(approval({ approvalMode: 'hard', approvalId: 'ap_h' }));
    const vm = useApprovalStore.getState().byCallId.call_1;
    expect(vm?.pass).toBeUndefined();
    expect(vm?.totalPasses).toBeUndefined();
    expect(vm?.awaitingNextStep).toBe(false);
  });
});

describe('approvalStore.ackPass（AUDIT-005 非终步锁定）', () => {
  it('第一步确认后 ackPass → awaitingNextStep=true', () => {
    useApprovalStore.getState().upsert(approval({ approvalId: 'ap_1' }));
    useApprovalStore.getState().ackPass('call_1');
    expect(useApprovalStore.getState().byCallId.call_1?.awaitingNextStep).toBe(true);
  });

  it('第二步挑战到达 → 解除 awaitingNextStep，pass 推进到 2', () => {
    useApprovalStore.getState().upsert(approval({ approvalId: 'ap_1' }));
    useApprovalStore.getState().ackPass('call_1');
    useApprovalStore.getState().upsert(approval({ approvalId: 'ap_2', approvalToken: 'tok_2' }));
    const vm = useApprovalStore.getState().byCallId.call_1;
    expect(vm?.awaitingNextStep).toBe(false);
    expect(vm?.pass).toBe(2);
  });

  it('ackPass 对不存在的 callId 是空操作（不抛错）', () => {
    expect(() => useApprovalStore.getState().ackPass('nope')).not.toThrow();
  });

  it('第二步到达后迟到的 ackPass 不得重新锁住终步', () => {
    useApprovalStore.getState().upsert(approval({ approvalId: 'ap_1' }));
    useApprovalStore.getState().ackPass('call_1');
    useApprovalStore.getState().upsert(approval({ approvalId: 'ap_2', approvalToken: 'tok_2' }));
    // 模拟第 1 步的 submit 请求此时才返回，触发迟到的 ackPass
    useApprovalStore.getState().ackPass('call_1');
    const vm = useApprovalStore.getState().byCallId.call_1;
    expect(vm?.pass).toBe(2);
    expect(vm?.awaitingNextStep).toBe(false);
  });
});

describe('approvalStore.refresh（AUDIT-009 续期）', () => {
  it('续期成功后：token / expiresAt 被新值覆盖，并解除 awaitingNextStep 锁定', () => {
    useApprovalStore.getState().upsert(approval({ approvalId: 'ap_1' }));
    useApprovalStore.getState().ackPass('call_1'); // 锁定，等待下一步
    expect(useApprovalStore.getState().byCallId.call_1?.awaitingNextStep).toBe(true);

    const newToken = 'tok_reissued';
    const newExpiresAt = Date.now() + 600_000; // 比原 5 分钟更晚
    useApprovalStore.getState().refresh('call_1', newToken, newExpiresAt);

    const vm = useApprovalStore.getState().byCallId.call_1;
    expect(vm?.token).toBe(newToken);
    expect(vm?.expiresAt).toBe(newExpiresAt);
    expect(vm?.expiresAt).toBeGreaterThan(approval().expiresAt);
    expect(vm?.awaitingNextStep).toBe(false);
  });

  it('refresh 对不存在的 callId 是空操作（不抛错、不产生幽灵条目）', () => {
    expect(() => useApprovalStore.getState().refresh('nope', 't', Date.now() + 1000)).not.toThrow();
    expect(useApprovalStore.getState().byCallId.nope).toBeUndefined();
  });

  it('refresh 只更新令牌与过期时间，不破坏其余展示字段（name/arguments/risk）', () => {
    useApprovalStore.getState().upsert(approval({ approvalId: 'ap_1' }));
    const before = useApprovalStore.getState().byCallId.call_1!;
    useApprovalStore.getState().refresh('call_1', 'tok_2', Date.now() + 999_000);
    const after = useApprovalStore.getState().byCallId.call_1!;
    expect(after.name).toBe(before.name);
    expect(after.arguments).toEqual(before.arguments);
    expect(after.risk).toBe(before.risk);
    expect(after.approvalId).toBe(before.approvalId);
  });
});

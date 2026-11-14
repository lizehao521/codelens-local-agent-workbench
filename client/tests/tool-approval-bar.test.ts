// ToolApprovalBar 交互判据（AC-03 / AC-06 / AC-10）—— 前端交互判据家族破零。
//
// 为什么必须有这一份：判据塔此前 14 份全在 server 的工具层，前端只有纯函数与
// mount 冒烟。审批条是「人唯一能拦住 Agent 的地方」，它的禁用态、改参数校验、
// 后果预览一旦坏掉，坏的是安全边界而不是显示效果，而这类坏法 mount 冒烟测不出来。
//
// 房屋风格：原生 react-dom/client + act，不引第三方 UI 测试库。
// 用订阅 store 的 Harness 渲染，而不是把 VM 当静态 prop 传进去 —— 组件失败时
// 写的是 store（setReceipt/bumpMismatch），静态 prop 会让回执永远测不到。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToolApprovalBar } from '../src/components/agent/ToolApprovalBar';
import { useApprovalStore } from '../src/stores/approvalStore';
import { submitApproval, reviseApproval, reissueApproval } from '../src/services/api';
import type { ApprovalVM } from '../src/types';

vi.mock('../src/services/api', () => ({
  submitApproval: vi.fn(),
  reviseApproval: vi.fn(),
  reissueApproval: vi.fn(),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockSubmit = vi.mocked(submitApproval);
const mockRevise = vi.mocked(reviseApproval);
const mockReissue = vi.mocked(reissueApproval);

const CALL_ID = 'call-1';
let container: HTMLDivElement;
let root: Root;
let settled: string[];

function vm(over: Partial<ApprovalVM> = {}): ApprovalVM {
  return {
    approvalId: 'ap-1',
    callId: CALL_ID,
    token: 'tok-1',
    name: 'fs.write',
    arguments: { path: 'a.txt', operation: 'overwrite' },
    risk: 'high',
    approvalMode: 'hard',
    reason: '覆盖已有文件，属高危操作',
    expiresAt: Date.now() + 240_000,
    mismatchCount: 0,
    effect: null,
    ...over,
  };
}

function Harness() {
  const approval = useApprovalStore((s) => s.byCallId[CALL_ID]);
  if (!approval) return null;
  return createElement(ToolApprovalBar, {
    approval,
    onSettled: (d: string) => settled.push(d),
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function render(over: Partial<ApprovalVM> = {}): void {
  act(() => {
    useApprovalStore.setState({ byCallId: { [CALL_ID]: vm(over) }, grantedCount: 0 });
    root.render(createElement(Harness));
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  expect(found, `找不到按钮：${label}`).toBeTruthy();
  return found as HTMLButtonElement;
}

const hasButton = (label: string): boolean =>
  Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.trim() === label);

async function click(label: string): Promise<void> {
  act(() => {
    button(label).click();
  });
  await flush();
}

async function editArgs(text: string): Promise<void> {
  await click('改参数');
  const ta = document.querySelector('textarea') as HTMLTextAreaElement;
  expect(ta, '改参数后应出现编辑框').toBeTruthy();
  // 必须走原型上的原生 setter：React 在节点上挂了 value tracker，直接 ta.value=
  // 会被它判成「值没变」而吞掉 input 事件，draftArgs 停在旧值上 —— 实测这样
  // 会让「非法 JSON 必须被拒」四条用例假失败（提交的其实是原始参数）。
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    nativeSet?.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
  expect(ta.value).toBe(text);
}

const body = (): string => document.body.textContent ?? '';
const httpError = (status: number, code?: string): Error & { status: number; code?: string } =>
  Object.assign(new Error(code ?? String(status)), { status, code });

beforeEach(() => {
  vi.clearAllMocks();
  settled = [];
  mockSubmit.mockResolvedValue({ ok: true });
  mockRevise.mockResolvedValue({ ok: true });
  mockReissue.mockResolvedValue({ ok: true, approvalId: 'ap-1', approvalToken: 'tok-2', expiresAt: Date.now() + 300_000 });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useApprovalStore.getState().reset();
  vi.useRealTimers();
});

describe('禁用态：过期 / 锁定 / 等待下一步（AC-06）', () => {
  it('未过期未锁定时三个决定按钮都可用', () => {
    render();
    expect(button('允许一次').disabled).toBe(false);
    expect(button('本会话允许').disabled).toBe(false);
    expect(button('拒绝').disabled).toBe(false);
  });

  it('已过期：按钮全禁用，且显示已过期而不是继续倒计时', () => {
    render({ expiresAt: Date.now() - 1000 });
    expect(button('允许一次').disabled).toBe(true);
    expect(button('拒绝').disabled).toBe(true);
    expect(body()).toContain('已过期');
    expect(body()).not.toContain('04:00');
  });

  it('回执锁定（disabled=true）：按钮全禁用', () => {
    render({ receipt: { level: 'aborted', message: '该操作已锁定，未执行', disabled: true } });
    expect(button('允许一次').disabled).toBe(true);
    expect(button('改参数').disabled).toBe(true);
    expect(body()).toContain('该操作已锁定，未执行');
  });

  it('两步确认等待下一步：按钮禁用并说清在等什么', () => {
    render({ approvalMode: 'two_step', pass: 1, totalPasses: 2, awaitingNextStep: true });
    expect(button('允许一次').disabled).toBe(true);
    expect(body()).toContain('已确认第 1 步，等待最终确认');
  });

  it('两步确认非终步不显示改参数（改参数只属于单步档）', () => {
    render({ approvalMode: 'two_step', pass: 1, totalPasses: 2 });
    expect(hasButton('改参数')).toBe(false);
    expect(body()).toContain('两步确认 · 第 1/2 步');
  });
});

describe('改参数校验（AC-10）：非法输入不得打到服务端', () => {
  it('非法 JSON：报错且 reviseApproval 一次都不调', async () => {
    render();
    await editArgs('{ not json');
    await click('提交新参数（将重新校验并再次确认）');
    expect(body()).toContain('不是合法 JSON');
    expect(mockRevise).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('JSON 数组：不是对象，拒绝提交', async () => {
    render();
    await editArgs('[1,2,3]');
    await click('提交新参数（将重新校验并再次确认）');
    expect(body()).toContain('参数必须是 JSON 对象');
    expect(mockRevise).not.toHaveBeenCalled();
  });

  it('JSON 标量与 null 同样拒绝', async () => {
    render();
    await editArgs('42');
    await click('提交新参数（将重新校验并再次确认）');
    expect(mockRevise).not.toHaveBeenCalled();
    expect(body()).toContain('参数必须是 JSON 对象');
  });

  it('合法对象：走 revise 端点，且决定端点一次都不调（.strict() 不许带 arguments）', async () => {
    render();
    await editArgs('{"path":"b.txt","operation":"overwrite"}');
    await click('提交新参数（将重新校验并再次确认）');
    expect(mockRevise).toHaveBeenCalledTimes(1);
    expect(mockRevise.mock.calls[0]?.[2]).toEqual({ path: 'b.txt', operation: 'overwrite' });
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(settled).toEqual(['revise']);
  });

  it('取消编辑：回到参数预览，不发任何请求', async () => {
    render();
    await click('改参数');
    await click('取消');
    expect(document.querySelector('textarea')).toBe(null);
    expect(mockRevise).not.toHaveBeenCalled();
    expect(hasButton('允许一次')).toBe(true);
  });
});

describe('回执纪律：失败必须落 inline，不得乐观更新', () => {
  it('404：置灰锁定，按钮随之禁用', async () => {
    render();
    mockSubmit.mockRejectedValue(httpError(404, 'APPROVAL_NOT_FOUND'));
    await click('允许一次');
    expect(body()).toContain('此审批已失效');
    expect(button('允许一次').disabled).toBe(true);
    expect(settled).toEqual([]);
  });

  it('令牌不匹配：累加异常计数并显示 1/3，不锁定', async () => {
    render();
    mockSubmit.mockRejectedValue(httpError(409, 'APPROVAL_TOKEN_MISMATCH'));
    await click('允许一次');
    expect(body()).toContain('异常 1/3');
    expect(button('允许一次').disabled).toBe(false);
    expect(useApprovalStore.getState().byCallId[CALL_ID]?.mismatchCount).toBe(1);
  });

  it('成功决定：只回调 onSettled，不自行摘掉卡片（终态由 SSE 驱动）', async () => {
    render();
    await click('拒绝');
    expect(settled).toEqual(['reject']);
    expect(useApprovalStore.getState().byCallId[CALL_ID]).toBeTruthy();
    expect(mockSubmit.mock.calls[0]?.[1]).toEqual({ token: 'tok-1', decision: 'reject' });
  });
});

describe('AUDIT-009 临过期自动续期', () => {
  it('剩余低于 30s：自动续期一次', async () => {
    render({ expiresAt: Date.now() + 20_000 });
    await flush();
    expect(mockReissue).toHaveBeenCalledTimes(1);
    expect(mockReissue.mock.calls[0]?.[0]).toBe('ap-1');
  });

  it('剩余充裕：不得无谓续期', async () => {
    render({ expiresAt: Date.now() + 240_000 });
    await flush();
    expect(mockReissue).not.toHaveBeenCalled();
  });

  it('已过期：不续期（交给自然过期，不伪造一个活令牌）', async () => {
    render({ expiresAt: Date.now() - 5000 });
    await flush();
    expect(mockReissue).not.toHaveBeenCalled();
  });

  it('续期失败不抛到界面，也不重复重试', async () => {
    mockReissue.mockRejectedValue(httpError(410, 'APPROVAL_EXPIRED'));
    render({ expiresAt: Date.now() + 20_000 });
    await flush();
    expect(mockReissue).toHaveBeenCalledTimes(1);
    expect(body()).not.toContain('提交失败');
  });
});
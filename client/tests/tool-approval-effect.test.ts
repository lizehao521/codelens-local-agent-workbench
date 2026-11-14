// ToolApprovalBar 后果预览判据（R6 / AC-03）—— 不可逆操作审「可核实事实」。
//
// 为什么单独立一份：后果预览是人在点「允许」之前唯一能看到「这一下会毁掉什么」
// 的地方。它最危险的坏法是**推断**：把不存在的文件说成已存在、把不可恢复说成
// 可恢复、或者把 20 项静默截成 6 项却不告诉人还有 14 项。这类坏法不会报错，
// 只会让人在错误的事实下做出不可撤销的决定。
//
// 与 tool-approval-bar.test.ts 的分工：那份守交互（禁用/改参数/回执/续期），
// 这份守事实呈现。后果预览是纯 prop 驱动，不需要 store 回写，故直接传 VM。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToolApprovalBar } from '../src/components/agent/ToolApprovalBar';
import type { ApprovalVM, EffectItem, EffectPreview } from '../src/types';

vi.mock('../src/services/api', () => ({
  submitApproval: vi.fn(),
  reviseApproval: vi.fn(),
  reissueApproval: vi.fn(),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function item(over: Partial<EffectItem> = {}): EffectItem {
  return { path: 'a.txt', kind: 'file', exists: true, bytes: 128, ...over };
}

function effect(over: Partial<EffectPreview> = {}): EffectPreview {
  return {
    reversible: false,
    summary: '将覆盖 1 个已有文件',
    items: [item()],
    itemCount: 1,
    recoverable: true,
    recoveryNote: null,
    ...over,
  };
}

function vm(e: EffectPreview | null): ApprovalVM {
  return {
    approvalId: 'ap-1',
    callId: 'call-1',
    token: 'tok-1',
    name: 'fs.write',
    arguments: { path: 'a.txt' },
    risk: 'high',
    approvalMode: 'hard',
    reason: '覆盖已有文件',
    expiresAt: Date.now() + 240_000,
    mismatchCount: 0,
    effect: e,
  };
}

function render(e: EffectPreview | null): void {
  act(() => {
    root.render(createElement(ToolApprovalBar, { approval: vm(e) }));
  });
}

const body = (): string => document.body.textContent ?? '';
const listItems = (): string[] =>
  Array.from(document.querySelectorAll('li')).map((li) => li.textContent ?? '');

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('只在不可逆时前置打断', () => {
  it('effect 为 null：不渲染后果预览', () => {
    render(null);
    expect(body()).not.toContain('不可撤销');
    expect(document.querySelectorAll('li')).toHaveLength(0);
  });

  it('可撤销操作：不渲染后果预览（可恢复的路径不该前置打断）', () => {
    render(effect({ reversible: true }));
    expect(body()).not.toContain('不可撤销');
    expect(body()).toContain('覆盖已有文件');
  });

  it('不可逆：渲染不可撤销标记与 summary 原文', () => {
    render(effect({ summary: '将永久删除 3 个文件' }));
    expect(body()).toContain('不可撤销');
    expect(body()).toContain('将永久删除 3 个文件');
  });
});

describe('逐条事实：存在性 / 体量 / 项数，一律不得推断', () => {
  it('已存在且带字节数：显示已存在与真实字节', () => {
    render(effect({ items: [item({ path: 'data.db', exists: true, bytes: 4096 })] }));
    expect(listItems()[0]).toContain('data.db');
    expect(listItems()[0]).toContain('已存在');
    expect(listItems()[0]).toContain('4096 字节');
    expect(listItems()[0]).not.toContain('尚不存在');
  });

  it('尚不存在：明说尚不存在，不得显示成已存在', () => {
    render(effect({ items: [item({ exists: false, bytes: null })] }));
    expect(listItems()[0]).toContain('尚不存在');
    expect(listItems()[0]).not.toContain('已存在');
  });

  it('bytes 为 null 时不编一个 0 字节出来', () => {
    render(effect({ items: [item({ exists: true, bytes: null })] }));
    expect(listItems()[0]).toContain('已存在');
    expect(listItems()[0]).not.toContain('字节');
  });

  it('目录带 itemCount：显示项数', () => {
    render(effect({ items: [item({ kind: 'dir', path: 'src/', itemCount: 42 })] }));
    expect(listItems()[0]).toContain('42 项');
  });

  it('kind 决定标签：命令 / 请求 / 路径，不得一律叫路径', () => {
    render(effect({
      items: [
        item({ kind: 'command', path: 'rm -rf build' }),
        item({ kind: 'url', path: 'https://example.com/hook' }),
        item({ kind: 'file', path: 'a.txt' }),
      ],
      itemCount: 3,
    }));
    const rows = listItems();
    expect(rows[0]).toContain('命令');
    expect(rows[1]).toContain('请求');
    expect(rows[2]).toContain('路径');
  });
});

describe('截断必须可见：不许静默少列', () => {
  const many = (n: number): EffectItem[] =>
    Array.from({ length: n }, (_, i) => item({ path: `f${i}.txt` }));

  it('恰好 6 项：全列，不出省略行', () => {
    render(effect({ items: many(6), itemCount: 6 }));
    expect(listItems()).toHaveLength(6);
    expect(body()).not.toContain('…共');
  });

  it('超过 6 项：只列前 6 条，但必须告知总数', () => {
    render(effect({ items: many(20), itemCount: 20 }));
    expect(listItems()).toHaveLength(7);
    expect(body()).toContain('…共 20 项');
    expect(body()).toContain('f0.txt');
    expect(body()).toContain('f5.txt');
    expect(body()).not.toContain('f6.txt');
  });

  it('告知的总数取 itemCount，不是被截断后的条数', () => {
    render(effect({ items: many(9), itemCount: 150 }));
    expect(body()).toContain('…共 150 项');
    expect(body()).not.toContain('…共 9 项');
  });
});

describe('可恢复性：默认文案与显式说明的优先级', () => {
  it('recoverable=true 且无说明：给默认的可恢复路径', () => {
    render(effect({ recoverable: true, recoveryNote: null }));
    expect(body()).toContain('可用写前快照恢复');
    expect(body()).not.toContain('不可恢复');
  });

  it('recoverable=false 且无说明：明说不可恢复', () => {
    render(effect({ recoverable: false, recoveryNote: null }));
    expect(body()).toContain('不可恢复');
    expect(body()).not.toContain('可用写前快照恢复');
  });

  it('有 recoveryNote：以它为准，不被默认文案覆盖', () => {
    render(effect({ recoverable: false, recoveryNote: '外部副作用，快照无法回滚' }));
    expect(body()).toContain('外部副作用，快照无法回滚');
    expect(body()).not.toContain('可用写前快照恢复');
  });

  it('recoverable=true 但说明写明不可恢复：仍照实显示说明（事实优先于乐观默认）', () => {
    render(effect({ recoverable: true, recoveryNote: '不可恢复' }));
    expect(body()).toContain('不可恢复');
    expect(body()).not.toContain('可用写前快照恢复');
  });
});
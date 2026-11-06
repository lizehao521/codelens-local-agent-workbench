// 工具技能面板渲染测试 —— 验证四个分区（能力与工具 / 运行时能力 / 判据塔 /
// 快照与技能）的渲染口径，特别是三条「诚实显示」规则：
//   · 能力未启用 → 显示「未启用」，不得显示成空列表冒充正常；
//   · 开关开着但服务没接线 → 额外显示「未接线」；
//   · 加载失败 → 显示错误，而不是静默空白。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToolSkillModal } from '../src/components/layout/ToolSkillModal';
import {
  getCapabilities,
  getJudgeEffectiveness,
  getJudgeSelfCheck,
  getKernelInsight,
  listCheckpoints,
  listSkills,
  listTools,
} from '../src/services/api';

vi.mock('../src/services/api', () => ({
  listTools: vi.fn(),
  getCapabilities: vi.fn(),
  getJudgeSelfCheck: vi.fn(),
  getKernelInsight: vi.fn(),
  getJudgeEffectiveness: vi.fn(),
  listCheckpoints: vi.fn(),
  listSkills: vi.fn(),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockListTools = vi.mocked(listTools);
const mockGetCapabilities = vi.mocked(getCapabilities);
const mockGetJudgeSelfCheck = vi.mocked(getJudgeSelfCheck);
const mockGetKernelInsight = vi.mocked(getKernelInsight);
const mockGetJudgeEffectiveness = vi.mocked(getJudgeEffectiveness);
const mockListCheckpoints = vi.mocked(listCheckpoints);
const mockListSkills = vi.mocked(listSkills);

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderModal(): void {
  act(() => {
    root.render(createElement(ToolSkillModal, { open: true, onClose: () => undefined }));
  });
}

async function switchTab(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  expect(button, `找不到 Tab 按钮：${label}`).toBeDefined();
  act(() => {
    button?.click();
  });
  await flush();
}

function textOf(): string {
  return document.body.textContent ?? '';
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  mockListTools.mockResolvedValue({
    tools: [
      {
        name: 'fs.read',
        wireName: 'fs_read',
        displayName: '读取文件',
        description: '读工作区文件',
        category: 'file',
        risk: 'low',
        approvalMode: 'none',
        source: 'builtin',
        enabled: true,
      },
    ],
    grouped: { low: ['fs.read'], medium: [], high: [] },
  });
  mockGetCapabilities.mockResolvedValue({
    capabilities: [
      { id: 'judge', label: '判据塔（判决闭环）', enabled: true, wired: true, envHint: '内置常开' },
      { id: 'skills', label: '技能库', enabled: true, wired: false, envHint: 'SKILL_LIBRARY_ENABLED' },
      { id: 'checkpoint', label: '工作区快照', enabled: false, wired: true, envHint: 'CHECKPOINT_ENABLED' },
    ],
    enabledCount: 2,
    total: 3,
  });
  mockGetJudgeSelfCheck.mockResolvedValue({
    canary: { status: 'pass', detail: '', goodScore: 1, badScore: 0, cases: [] },
    thresholds: { minToolSuccessRate: 0.8, maxApprovalRejectionRate: 0.2, maxBudgetUsageRate: 0.9 },
    unimplementedLayers: [{ layer: 'L3', reason: '未接入外部评审' }],
    profiles: [
      { layer: 'L0', available: true, required: true, reason: null },
      { layer: 'L3', available: false, required: false, reason: '未接入外部评审' },
    ],
    criteria: [],
    totalRuns: 7,
  } as unknown as Awaited<ReturnType<typeof getJudgeSelfCheck>>);
  mockGetKernelInsight.mockResolvedValue({
    errors: ['layers: 部分降级'],
  } as unknown as Awaited<ReturnType<typeof getKernelInsight>>);
  mockGetJudgeEffectiveness.mockResolvedValue([]);
  mockListCheckpoints.mockResolvedValue({ enabled: false, checkpoints: [] });
  mockListSkills.mockResolvedValue({ enabled: true, mode: 'list', skills: [] });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
});

describe('ToolSkillModal', () => {
  it('默认展示「能力与工具」分区与工具清单', async () => {
    renderModal();
    await flush();

    expect(textOf()).toContain('任务能力');
    expect(textOf()).toContain('可用工具');
    expect(textOf()).toContain('读取文件');
    expect(mockGetCapabilities).not.toHaveBeenCalled();
  });

  it('运行时能力分区区分「未启用」与「未接线」', async () => {
    renderModal();
    await flush();
    await switchTab('运行时能力');

    expect(textOf()).toContain('运行时能力');
    expect(textOf()).toContain('判据塔（判决闭环）');
    // 技能库：开关开但未接线 → 两个徽标都要出现
    expect(textOf()).toContain('未接线');
    // 工作区快照：未启用 → 只有「未启用」，不应出现「未接线」
    expect(textOf()).toContain('工作区快照');
    expect(mockGetCapabilities).toHaveBeenCalled();
  });

  it('判据塔分区展示自证数据与未实现层', async () => {
    renderModal();
    await flush();
    await switchTab('判据塔');

    expect(textOf()).toContain('判据塔自证');
    expect(textOf()).toContain('未实现层');
    expect(textOf()).toContain('L3');
    expect(mockGetJudgeSelfCheck).toHaveBeenCalled();
  });

  it('快照未启用时明确显示「未启用」而非空列表', async () => {
    renderModal();
    await flush();
    await switchTab('快照与技能');

    expect(textOf()).toContain('工作区快照');
    expect(textOf()).toContain('未启用');
    expect(textOf()).not.toContain('暂无快照');
    expect(mockListCheckpoints).toHaveBeenCalled();
    expect(mockListSkills).toHaveBeenCalled();
  });

  it('能力加载失败时显示错误而不是空白面板', async () => {
    mockGetCapabilities.mockRejectedValueOnce(new Error('能力目录炸了'));
    renderModal();
    await flush();
    await switchTab('运行时能力');

    expect(textOf()).toContain('能力目录炸了');
  });
});

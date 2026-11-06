// 工具技能面板（顶栏「工具技能」按钮打开，只读）。
//
// 四个分区对应 Agent 当前可用的「能力」：
//   1. 能力与工具 —— 任务模式（分析 / 解释 / 调试 / 优化）+ 已注册并下发给模型的工具
//   2. 运行时能力 —— 服务端能力开关目录（enabled / wired 的单一事实来源）
//   3. 判据塔     —— 判决自证状态与经验有效性摘要（详情见会话头「判据塔」）
//   4. 快照与技能 —— 工作区快照清单 + 程序化技能库条目
//
// 设计约束（沿用 legacy「能力洞察」的契约）：
//   · 能力未启用时显示「未启用」，**不得**用空列表冒充「运行正常」；
//   · enabled 与 wired 分开呈现 —— 开关打开但服务没接线是两种不同的状态；
//   · 面板整体只读，任何写操作（工具启停）都走「设置」。

import { useState } from 'react';
import { Activity, Boxes, Loader, Scale, Settings as SettingsIcon, ShieldCheck } from 'lucide-react';
import { Modal } from '../common/Modal';
import { StatusBadge } from '../common/StatusBadge';
import { useAsyncData } from '../../hooks/useAsyncData';
import {
  getCapabilities,
  getJudgeEffectiveness,
  getJudgeSelfCheck,
  getKernelInsight,
  listCheckpoints,
  listSkills,
  listTools,
} from '../../services/api';
import { categoryIcon, categoryLabel } from '../../lib/tool-category';
import { TASK_MODES } from '../../lib/agent-request';
import { useUiStore } from '../../stores/uiStore';
import type { ToolCategory, ToolDefinitionPublic } from '../../types';

const TASK_DESC: Record<string, string> = {
  analyze: '拆解需求、梳理结构与依赖，不直接改动。',
  explain: '用通俗语言讲清原理、代码与决策。',
  debug: '定位异常根因并给出修复路径。',
  optimize: '在不改行为前提下降本、提速、提质。',
};

type TabKey = 'capabilities' | 'runtime' | 'judge' | 'snapshots';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'capabilities', label: '能力与工具' },
  { key: 'runtime', label: '运行时能力' },
  { key: 'judge', label: '判据塔' },
  { key: 'snapshots', label: '快照与技能' },
];

export function ToolSkillModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>('capabilities');
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);

  // 四个数据源各自独立加载：任一块失败都不该拖垮整块面板（观测面不是故障点）。
  const tools = useAsyncData(
    () => listTools().then((d) => d.tools),
    [open],
    { enabled: open, errorMessage: '工具列表加载失败' },
  );
  const runtime = useAsyncData(() => getCapabilities(), [open], { enabled: open && tab === 'runtime' });
  const judge = useAsyncData(
    async () => ({
      selfCheck: await getJudgeSelfCheck(),
      insight: await getKernelInsight(20),
      lessons: await getJudgeEffectiveness(),
    }),
    [open, tab],
    { enabled: open && tab === 'judge', errorMessage: '判据塔数据加载失败' },
  );
  const snapshots = useAsyncData(
    async () => ({
      checkpoints: await listCheckpoints(),
      skills: await listSkills({ limit: 20 }),
    }),
    [open, tab],
    { enabled: open && tab === 'snapshots', errorMessage: '快照与技能加载失败' },
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="工具技能"
      maxWidth={640}
      footer={
        <button
          type="button"
          onClick={() => {
            onClose();
            setSettingsOpen(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors duration-150 hover:border-accent hover:text-accent"
        >
          <SettingsIcon size={14} /> 在设置中管理工具
        </button>
      }
    >
      <div className="mb-4 flex gap-1.5 border-b border-border pb-2" role="tablist" aria-label="工具技能分区">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={
              tab === t.key
                ? 'rounded-md bg-accent-subtle px-2.5 py-1 text-xs font-medium text-accent'
                : 'rounded-md px-2.5 py-1 text-xs text-text-secondary transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary'
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'capabilities' && <CapabilitiesTab tools={tools} />}
      {tab === 'runtime' && <RuntimeTab state={runtime} />}
      {tab === 'judge' && <JudgeTab state={judge} />}
      {tab === 'snapshots' && <SnapshotsTab state={snapshots} />}
    </Modal>
  );
}

// ── 分区 1：任务能力 + 可用工具 ────────────────────────────────────────────

function CapabilitiesTab({
  tools,
}: {
  tools: { data: ToolDefinitionPublic[] | null; error: string | null; loading: boolean };
}) {
  const byCategory = new Map<ToolCategory, ToolDefinitionPublic[]>();
  for (const t of tools.data ?? []) {
    const list = byCategory.get(t.category) ?? [];
    list.push(t);
    byCategory.set(t.category, list);
  }

  return (
    <div>
      <section className="mb-5">
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-text-primary">
          <Boxes size={15} className="text-accent" /> 任务能力
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {TASK_MODES.map((m) => (
            <div key={m.value} className="rounded-md border border-border-subtle bg-bg-primary px-2.5 py-2">
              <p className="text-sm font-medium text-text-primary">{m.label}</p>
              <p className="mt-0.5 text-xs text-text-tertiary">{TASK_DESC[m.value] ?? ''}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-text-primary">
          <Boxes size={15} className="text-accent" /> 可用工具
          {!tools.loading && !tools.error && (
            <span className="text-xs font-normal text-text-tertiary">共 {tools.data?.length ?? 0} 个</span>
          )}
        </h3>
        {tools.loading && <LoadingRow text="加载工具注册表…" />}
        {tools.error && <p className="py-2 text-sm text-danger">{tools.error}</p>}
        {!tools.loading && !tools.error && (
          <div className="space-y-3">
            {[...byCategory.entries()]
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([category, list]) => (
                <div key={category}>
                  <h4 className="mb-1 text-xs font-medium text-text-secondary">{categoryLabel(category)}</h4>
                  <ul className="space-y-1">
                    {list.map((tool) => {
                      const Icon = categoryIcon(tool.category, tool.name);
                      return (
                        <li
                          key={tool.name}
                          className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-primary px-2.5 py-1.5"
                        >
                          <Icon size={14} className="shrink-0 text-text-secondary" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-text-primary">
                              {tool.displayName}
                              <span className="ml-1.5 font-mono text-xs text-text-tertiary">{tool.name}</span>
                            </p>
                            <p className="truncate text-xs text-text-tertiary" title={tool.description}>
                              {tool.description ?? '—'}
                            </p>
                          </div>
                          {tool.enabled !== false ? (
                            <StatusBadge tone="success">启用</StatusBadge>
                          ) : (
                            <StatusBadge tone="muted">未启用</StatusBadge>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── 分区 2：运行时能力开关目录 ──────────────────────────────────────────────

function RuntimeTab({
  state,
}: {
  state: {
    data: Awaited<ReturnType<typeof getCapabilities>> | null;
    error: string | null;
    loading: boolean;
  };
}) {
  if (state.loading) return <LoadingRow text="加载运行时能力…" />;
  if (state.error) return <p className="py-2 text-sm text-danger">{state.error}</p>;
  const registry = state.data;
  if (!registry) return null;

  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-text-primary">
        <Activity size={15} className="text-accent" /> 运行时能力
        <span className="text-xs font-normal text-text-tertiary">
          已启用 {registry.enabledCount} / {registry.total}
        </span>
      </h3>
      <ul className="space-y-1">
        {registry.capabilities.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-primary px-2.5 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-text-primary">{c.label}</p>
              <p className="truncate font-mono text-xs text-text-tertiary">{c.envHint}</p>
            </div>
            {c.enabled ? (
              <StatusBadge tone="success">已启用</StatusBadge>
            ) : (
              <StatusBadge tone="muted">未启用</StatusBadge>
            )}
            {/* 开关是开的但服务没接线 —— 与「未启用」是不同的故障，必须分开显示。 */}
            {!c.wired && <StatusBadge tone="danger">未接线</StatusBadge>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── 分区 3：判据塔摘要 ──────────────────────────────────────────────────────

function JudgeTab({
  state,
}: {
  state: {
    data: {
      selfCheck: Awaited<ReturnType<typeof getJudgeSelfCheck>>;
      insight: Awaited<ReturnType<typeof getKernelInsight>>;
      lessons: Awaited<ReturnType<typeof getJudgeEffectiveness>>;
    } | null;
    error: string | null;
    loading: boolean;
  };
}) {
  if (state.loading) return <LoadingRow text="加载判据塔数据…" />;
  if (state.error) return <p className="py-2 text-sm text-danger">{state.error}</p>;
  const data = state.data;
  if (!data) return null;

  const { selfCheck, insight, lessons } = data;
  const unimplemented = selfCheck.unimplementedLayers ?? [];

  return (
    <div className="space-y-4">
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-text-primary">
          <Scale size={15} className="text-accent" /> 判据塔自证
        </h3>
        <dl className="grid grid-cols-2 gap-2">
          <Metric label="判决总数" value={selfCheck.totalRuns} />
          <Metric label="可判层数" value={`${(selfCheck.profiles ?? []).filter((p) => p.available).length} / ${(selfCheck.profiles ?? []).length}`} />
          <Metric label="金丝雀" value={selfCheck.canary?.status ?? '—'} />
          <Metric label="经验条目" value={lessons.length} />
        </dl>
      </section>

      {unimplemented.length > 0 && (
        <section>
          <h4 className="mb-1 text-xs font-medium text-text-secondary">未实现层</h4>
          <ul className="space-y-1">
            {unimplemented.map((l) => (
              <li key={l.layer} className="rounded-md border border-border-subtle bg-bg-primary px-2.5 py-1.5">
                <p className="text-xs font-medium text-text-primary">{l.layer}</p>
                <p className="text-xs text-text-tertiary">{l.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {insight.errors.length > 0 && (
        <section>
          <h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <ShieldCheck size={13} className="text-warning" /> 洞察降级项
          </h4>
          <ul className="space-y-0.5">
            {insight.errors.map((e) => (
              <li key={e} className="text-xs text-text-tertiary">
                {e}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-xs text-text-tertiary">完整判决历史与逐条判据请打开会话头的「判据塔」面板。</p>
    </div>
  );
}

// ── 分区 4：工作区快照 + 技能库 ────────────────────────────────────────────

function SnapshotsTab({
  state,
}: {
  state: {
    data: {
      checkpoints: Awaited<ReturnType<typeof listCheckpoints>>;
      skills: Awaited<ReturnType<typeof listSkills>>;
    } | null;
    error: string | null;
    loading: boolean;
  };
}) {
  if (state.loading) return <LoadingRow text="加载快照与技能…" />;
  if (state.error) return <p className="py-2 text-sm text-danger">{state.error}</p>;
  const data = state.data;
  if (!data) return null;

  const { checkpoints, skills } = data;

  return (
    <div className="space-y-4">
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-text-primary">
          <ShieldCheck size={15} className="text-accent" /> 工作区快照
          {checkpoints.enabled ? (
            <span className="text-xs font-normal text-text-tertiary">共 {checkpoints.checkpoints.length} 份</span>
          ) : (
            <StatusBadge tone="muted">未启用</StatusBadge>
          )}
        </h3>
        {checkpoints.enabled && checkpoints.checkpoints.length === 0 && (
          // 用户引导面：这一屏要回答的是「为什么现在是空的」，不是捕获机制的全量契约。
          // 所以不搬能力目录那句技术边界（那会给一个空列表配一份技术规格书），
          // 只点明「会在什么时候产生快照」。事实与能力目录一致，表述不共用。
          <p className="text-xs text-text-tertiary">暂无快照。每轮文件修改前，会对 fs.write 的写入自动捕获。</p>
        )}
        {checkpoints.enabled && checkpoints.checkpoints.length > 0 && (
          <ul className="space-y-1">
            {checkpoints.checkpoints.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-primary px-2.5 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-text-primary">{c.label || c.id}</p>
                  <p className="text-xs text-text-tertiary">
                    {c.fileCount} 个文件 · {formatBytes(c.totalBytes)}
                    {/* 跳过的文件必须说出来：否则用户会把不完整的快照当成完整的 */}
                    {c.skipped && c.skipped.count > 0 && ` · 已跳过 ${c.skipped.count} 个`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-text-primary">
          <Boxes size={15} className="text-accent" /> 技能库
          {skills.enabled ? (
            <span className="text-xs font-normal text-text-tertiary">共 {skills.skills.length} 条</span>
          ) : (
            <StatusBadge tone="muted">未启用</StatusBadge>
          )}
        </h3>
        {skills.enabled && skills.skills.length === 0 && (
          <p className="text-xs text-text-tertiary">暂无技能条目。</p>
        )}
        {skills.enabled && skills.skills.length > 0 && (
          <ul className="space-y-1">
            {skills.skills.map((s) => (
              <li key={s.id} className="rounded-md border border-border-subtle bg-bg-primary px-2.5 py-1.5">
                <p className="truncate text-sm text-text-primary">{s.name}</p>
                {s.description && <p className="truncate text-xs text-text-tertiary">{s.description}</p>}
                {s.tags.length > 0 && (
                  <p className="mt-0.5 flex flex-wrap gap-1">
                    {s.tags.map((t) => (
                      <span key={t} className="rounded bg-bg-inset px-1 py-0.5 text-xs text-text-tertiary">
                        {t}
                      </span>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ── 局部小组件 ──────────────────────────────────────────────────────────────

function LoadingRow({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-text-secondary">
      <Loader size={14} className="animate-spin" /> {text}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border-subtle bg-bg-primary px-2.5 py-1.5">
      <dt className="text-xs text-text-tertiary">{label}</dt>
      <dd className="text-sm font-medium text-text-primary">{value}</dd>
    </div>
  );
}

/** 字节数的人类可读表示；快照体积可能到 MB 级。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

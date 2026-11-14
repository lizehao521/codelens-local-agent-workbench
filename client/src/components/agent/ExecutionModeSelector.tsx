/** 执行方式选择器：把两个选项的适用场景直接摊在输入框上方。 */
import { useComposerStore, type ExecutionMode } from '../../stores/composerStore';
import { cn } from '../../lib/cn';

const MODES: Array<{ id: ExecutionMode; label: string; short: string; desc: string }> = [
  {
    id: 'plan',
    label: '按计划执行',
    short: '先列步骤，严格照做',
    desc: '适合步骤明确、需要可预期的任务。计划变化或受阻时先说明，不静默改道。',
  },
  {
    id: 'goal',
    label: '以目标模式执行此计划',
    short: '锁定目标，允许调整',
    desc: '适合探索、排障、结果优先的任务。可换步骤与工具，以目标达成和边界为准。',
  },
];

export function ExecutionModeSelector({ disabled }: { disabled?: boolean }) {
  const mode = useComposerStore((s) => s.executionMode);
  const setMode = useComposerStore((s) => s.setExecutionMode);
  const active = MODES.find((m) => m.id === mode) ?? MODES[0]!;

  return (
    <div className="px-1.5 pb-1.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-medium text-text-secondary">执行方式</span>
        <span className="text-[10px] text-text-tertiary">发送前可切换</span>
      </div>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2" role="radiogroup" aria-label="执行方式">
        {MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={mode === item.id}
            disabled={disabled}
            onClick={() => setMode(item.id)}
            className={cn(
              'rounded-md border px-2 py-1.5 text-left transition-colors duration-150',
              mode === item.id
                ? 'border-accent bg-accent-subtle'
                : 'border-border hover:border-accent hover:bg-bg-tertiary',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <span className={cn('block text-xs font-medium', mode === item.id ? 'text-accent' : 'text-text-primary')}>
              {item.label}
            </span>
            <span className="mt-0.5 block text-[10px] leading-4 text-text-tertiary">{item.short}</span>
          </button>
        ))}
      </div>
      <p className="mt-1 text-[10px] leading-4 text-text-tertiary" aria-live="polite">
        {active.desc}
      </p>
    </div>
  );
}

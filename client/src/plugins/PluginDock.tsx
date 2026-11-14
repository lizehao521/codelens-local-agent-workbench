/** 常驻 UI 插件面板：右栏「插件」页签，插件动作只填草稿，不自动发送。 */
import { Puzzle, Settings2 } from 'lucide-react';
import { usePlugins, usePluginStore } from './store';
import { useComposerStore } from '../stores/composerStore';
import { useUiStore } from '../stores/uiStore';
import { cn } from '../lib/cn';

export function PluginDock() {
  const plugins = usePlugins().filter((p) => p.enabled);
  const activeId = usePluginStore((s) => s.activeId);
  const setActive = usePluginStore((s) => s.setActive);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const pushToast = useUiStore((s) => s.pushToast);
  const active = plugins.find((p) => p.id === activeId) ?? plugins[0];

  if (plugins.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <Puzzle size={20} className="text-text-tertiary" />
        <p className="text-xs text-text-secondary">还没有启用的 UI 插件。</p>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="rounded-md border border-border px-2 py-1 text-xs text-accent hover:bg-accent-subtle"
        >
          去设置安装
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
        {plugins.map((plugin) => (
          <button
            key={plugin.id}
            type="button"
            onClick={() => setActive(plugin.id)}
            aria-pressed={active?.id === plugin.id}
            className={cn(
              'shrink-0 rounded px-2 py-1 text-xs transition-colors',
              active?.id === plugin.id
                ? 'bg-accent-subtle font-medium text-accent'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {plugin.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="ml-auto shrink-0 rounded p-1 text-text-tertiary hover:text-accent"
          title="管理插件"
          aria-label="管理插件"
        >
          <Settings2 size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {active && (
          <>
            <p className="mb-3 text-xs text-text-tertiary">{active.description}</p>
            {active.panels.map((panel) => (
              <section key={panel.id} className="mb-3">
                <h3 className="text-xs font-medium text-text-secondary">{panel.title}</h3>
                {panel.description && <p className="mt-0.5 text-[11px] text-text-tertiary">{panel.description}</p>}
                <div className="mt-1 space-y-1">
                  {panel.items.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => {
                        useComposerStore.getState().setDraft(item.prompt);
                        pushToast({ message: '已填入输入框，确认后发送', variant: 'success' });
                      }}
                      className="block w-full rounded border border-border px-2 py-1.5 text-left text-xs text-text-secondary transition-colors hover:border-accent hover:bg-accent-subtle hover:text-accent"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

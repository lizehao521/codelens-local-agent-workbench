/** 设置页 UI 插件区：创建/导入/启用/卸载；插件是声明式面板，不执行任意脚本。 */
import { useState } from 'react';
import { usePlugins, usePluginStore } from '../../plugins/store';
import type { PluginAction } from '../../plugins/types';

const input = 'w-full rounded-md border border-border bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent';
const label = 'mb-1 block text-xs font-medium text-text-secondary';

export function PluginsZone() {
  const plugins = usePlugins();
  const install = usePluginStore((s) => s.install);
  const remove = usePluginStore((s) => s.remove);
  const toggle = usePluginStore((s) => s.toggle);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [panelTitle, setPanelTitle] = useState('常用动作');
  const [itemsText, setItemsText] = useState('');
  const [json, setJson] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const parseItems = (): PluginAction[] =>
    itemsText
      .split('\n')
      .map((line) => line.split('|'))
      .map(([labelText, promptText]) => ({ label: labelText?.trim() ?? '', prompt: promptText?.trim() ?? '' }))
      .filter((item) => item.label && item.prompt);

  const create = (): void => {
    const items = parseItems();
    if (!name.trim() || !description.trim() || items.length === 0) {
      setMessage({ ok: false, text: '名称、说明和至少一条动作是必填项。' });
      return;
    }
    const result = install({
      id: `custom-${Date.now().toString(36)}`,
      name: name.trim(),
      version: '1.0.0',
      description: description.trim(),
      panels: [{ id: 'main', title: panelTitle.trim() || '常用动作', items }],
    });
    setMessage(result.ok ? { ok: true, text: '已安装，右栏「插件」页签可常驻使用。' } : { ok: false, text: result.error ?? '安装失败' });
    if (result.ok) {
      setName('');
      setDescription('');
      setItemsText('');
    }
  };

  const importJson = (): void => {
    try {
      const result = install(JSON.parse(json));
      setMessage(result.ok ? { ok: true, text: '已安装。' } : { ok: false, text: result.error ?? '安装失败' });
      if (result.ok) setJson('');
    } catch {
      setMessage({ ok: false, text: 'JSON 解析失败。' });
    }
  };

  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-sm font-medium text-text-primary">已安装插件</h3>
        <p className="mt-0.5 text-xs text-text-tertiary">插件显示在右栏「插件」页签；动作只填入输入框，不自动发送。</p>
        <div className="mt-2 space-y-1.5">
          {plugins.map((plugin) => (
            <div key={plugin.id} className="flex items-start gap-2 rounded-md border border-border p-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-text-primary">{plugin.name}</span>
                  <span className="rounded bg-bg-tertiary px-1 text-[10px] text-text-tertiary">
                    {plugin.builtin ? '内置' : '自定义'}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-text-tertiary">{plugin.description}</p>
              </div>
              <button
                type="button"
                onClick={() => toggle(plugin.id)}
                className="shrink-0 rounded border border-border px-2 py-1 text-[11px] text-text-secondary hover:text-accent"
              >
                {plugin.enabled ? '停用' : '启用'}
              </button>
              {!plugin.builtin && (
                <button
                  type="button"
                  onClick={() => remove(plugin.id)}
                  className="shrink-0 rounded border border-border px-2 py-1 text-[11px] text-danger hover:bg-danger-subtle"
                >
                  卸载
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-medium text-text-primary">创建 UI 插件</h3>
        <p className="mt-0.5 text-xs text-text-tertiary">
          声明式插件：只定义面板和“填入草稿”的动作，不执行任意脚本。动作一行一条，格式：`标签 | 提示词`。
        </p>
        <div className="mt-2 space-y-2">
          <div>
            <label className={label} htmlFor="plugin-name">名称</label>
            <input id="plugin-name" className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </div>
          <div>
            <label className={label} htmlFor="plugin-desc">说明</label>
            <input id="plugin-desc" className={input} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
          </div>
          <div>
            <label className={label} htmlFor="plugin-panel">面板标题</label>
            <input id="plugin-panel" className={input} value={panelTitle} onChange={(e) => setPanelTitle(e.target.value)} maxLength={40} />
          </div>
          <div>
            <label className={label} htmlFor="plugin-items">动作（每行：标签 | 提示词）</label>
            <textarea id="plugin-items" className={`${input} min-h-20`} value={itemsText} onChange={(e) => setItemsText(e.target.value)} />
          </div>
          <button type="button" onClick={create} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-text-on-accent hover:bg-accent-hover">
            安装插件
          </button>
        </div>
      </section>

      <section>
        <h3 className="text-sm font-medium text-text-primary">导入 JSON</h3>
        <textarea
          className={`${input} mt-2 min-h-28 font-mono text-xs`}
          value={json}
          onChange={(e) => setJson(e.target.value)}
          placeholder={'{"id":"my-plugin","name":"我的插件","version":"1.0.0","description":"...","panels":[...]}'}
        />
        <button type="button" onClick={importJson} className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-accent">
          导入并安装
        </button>
      </section>

      {message && (
        <p className={message.ok ? 'text-xs text-success' : 'text-xs text-danger'} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}

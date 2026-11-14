import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS } from '../src/plugins/builtin';
import { validatePlugin } from '../src/plugins/types';
import { usePluginStore } from '../src/plugins/store';

describe('UI plugin manifest', () => {
  it('内置插件全部通过校验', () => {
    for (const plugin of BUILTIN_PLUGINS) {
      expect(validatePlugin(plugin).ok, plugin.id).toBe(true);
    }
  });

  it('接受最小合法插件', () => {
    const r = validatePlugin({
      id: 'my-plugin',
      name: '我的插件',
      description: '测试用',
      panels: [{ id: 'main', title: '动作', items: [{ label: '开始', prompt: '帮我开始' }] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plugin.version).toBe('1.0.0');
  });

  it('拒绝非法 id / 空面板 / 空动作', () => {
    expect(validatePlugin({ id: 'Bad ID', name: 'x', description: 'y', panels: [] }).ok).toBe(false);
    expect(
      validatePlugin({ id: 'ok-id', name: 'x', description: 'y', panels: [{ id: 'main', title: 't', items: [] }] }).ok,
    ).toBe(false);
  });

  it('不接受任意 HTML/脚本字段（只认声明式动作）', () => {
    const r = validatePlugin({
      id: 'evil-plugin',
      name: 'evil',
      description: 'x',
      panels: [{ id: 'main', title: 't', items: [{ label: 'x', prompt: 'y', html: '<script>alert(1)</script>' }] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plugin.panels[0]!.items[0]).toEqual({ label: 'x', prompt: 'y' });
  });

  it('安装后进入注册表，可停用与卸载', () => {
    const id = `test-${Date.now().toString(36)}`;
    const store = usePluginStore.getState();
    const r = store.install({
      id,
      name: '测试插件',
      version: '1.0.0',
      description: '安装闭环',
      panels: [{ id: 'main', title: '动作', items: [{ label: '开始', prompt: '开始' }] }],
    });
    expect(r.ok).toBe(true);
    expect(usePluginStore.getState().custom.some((p) => p.id === id)).toBe(true);
    usePluginStore.getState().toggle(id);
    expect(usePluginStore.getState().enabled[id]).toBe(false);
    usePluginStore.getState().remove(id);
    expect(usePluginStore.getState().custom.some((p) => p.id === id)).toBe(false);
  });
});

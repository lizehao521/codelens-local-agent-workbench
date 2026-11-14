/**
 * UI 插件的声明式 manifest。
 *
 * 刻意不允许任意 HTML/JS：插件只能声明“面板 + 可填入输入框的动作”，
 * 这样安装第三方插件不会获得页面脚本执行权限（XSS/越权面为零）。
 */
export interface PluginAction {
  label: string;
  /** 点击后只填入输入框草稿，不自动发送。 */
  prompt: string;
}

export interface PluginPanel {
  id: string;
  title: string;
  description?: string;
  items: PluginAction[];
}

export interface UiPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  panels: PluginPanel[];
  builtin?: boolean;
}

const ID = /^[a-z0-9][a-z0-9-]{2,40}$/;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

/** 校验并规范化插件 manifest；错误直接返回可展示的原因。 */
export function validatePlugin(input: unknown): { ok: true; plugin: UiPlugin } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '插件 manifest 必须是 JSON 对象' };
  }
  const raw = input as Record<string, unknown>;
  const id = text(raw.id, 40);
  const name = text(raw.name, 40);
  const description = text(raw.description, 200);
  if (!id || !ID.test(id)) return { ok: false, error: 'id 必须是 3–40 位 kebab-case' };
  if (!name) return { ok: false, error: 'name 必填（≤40 字）' };
  if (!description) return { ok: false, error: 'description 必填（≤200 字）' };
  if (!Array.isArray(raw.panels) || raw.panels.length === 0 || raw.panels.length > 4) {
    return { ok: false, error: 'panels 需要 1–4 个面板' };
  }

  const panels: PluginPanel[] = [];
  const seenPanelIds = new Set<string>();
  for (const [index, p] of raw.panels.entries()) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return { ok: false, error: `panels[${index}] 必须是对象` };
    }
    const pr = p as Record<string, unknown>;
    const panelId = text(pr.id, 40);
    const title = text(pr.title, 40);
    if (!panelId || !ID.test(panelId)) return { ok: false, error: `panels[${index}].id 非法` };
    if (seenPanelIds.has(panelId)) return { ok: false, error: `panel id 重复：${panelId}` };
    seenPanelIds.add(panelId);
    if (!title) return { ok: false, error: `panels[${index}].title 必填` };
    if (!Array.isArray(pr.items) || pr.items.length === 0 || pr.items.length > 12) {
      return { ok: false, error: `panels[${index}].items 需要 1–12 条` };
    }
    const items: PluginAction[] = [];
    for (const [itemIndex, item] of pr.items.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, error: `panels[${index}].items[${itemIndex}] 必须是对象` };
      }
      const ir = item as Record<string, unknown>;
      const label = text(ir.label, 40);
      const prompt = text(ir.prompt, 200);
      if (!label) return { ok: false, error: `panels[${index}].items[${itemIndex}].label 必填` };
      if (!prompt) return { ok: false, error: `panels[${index}].items[${itemIndex}].prompt 必填` };
      items.push({ label, prompt });
    }
    panels.push({
      id: panelId,
      title,
      ...(typeof pr.description === 'string' && pr.description.trim() ? { description: pr.description.trim().slice(0, 200) } : {}),
      items,
    });
  }

  return {
    ok: true,
    plugin: {
      id,
      name,
      version: text(raw.version, 20) ?? '1.0.0',
      description,
      panels,
    },
  };
}

/**
 * Plugins controller — UI 插件的 HTTP 视图。
 *
 * 端点：
 *  - GET    /plugins              列表（内置 + 自定义）
 *  - POST   /plugins              创建/安装插件
 *  - DELETE /plugins/:id          卸载插件
 *  - PATCH  /plugins/:id/toggle   启用/禁用插件
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { z as zClient } from 'zod';

// Re-define validatePlugin here since client plugins are in a different module
interface UiPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  panels: Array<{
    id: string;
    title: string;
    description?: string;
    items: Array<{ label: string; prompt: string }>;
  }>;
  builtin?: boolean;
}

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

function validatePlugin(input: unknown): { ok: true; plugin: any } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '插件 manifest 必须是 JSON 对象' };
  }
  const raw = input as Record<string, unknown>;
  const id = text(raw.id, 40);
  const name = text(raw.name, 40);
  const description = text(raw.description, 200);
  if (!id || !PLUGIN_ID_RE.test(id)) return { ok: false, error: 'id 必须是 3–40 位 kebab-case' };
  if (!name) return { ok: false, error: 'name 必填（≤40 字）' };
  if (!description) return { ok: false, error: 'description 必填（≤200 字）' };
  if (!Array.isArray(raw.panels) || raw.panels.length === 0 || raw.panels.length > 4) {
    return { ok: false, error: 'panels 需要 1–4 个面板' };
  }

  const panels: any[] = [];
  const seenPanelIds = new Set<string>();
  for (const [index, p] of raw.panels.entries()) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return { ok: false, error: `panels[${index}] 必须是对象` };
    }
    const pr = p as Record<string, unknown>;
    const panelId = text(pr.id, 40);
    const title = text(pr.title, 40);
    if (!panelId || !PLUGIN_ID_RE.test(panelId)) return { ok: false, error: `panels[${index}].id 非法` };
    if (seenPanelIds.has(panelId)) return { ok: false, error: `panel id 重复：${panelId}` };
    seenPanelIds.add(panelId);
    if (!title) return { ok: false, error: `panels[${index}].title 必填` };
    if (!Array.isArray(pr.items) || pr.items.length === 0 || pr.items.length > 12) {
      return { ok: false, error: `panels[${index}].items 需要 1–12 条` };
    }
    const items: any[] = [];
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGINS_CONFIG_PATH = join(__dirname, '..', '..', 'config', 'plugins.json');

interface UiPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  panels: Array<{
    id: string;
    title: string;
    description?: string;
    items: Array<{ label: string; prompt: string }>;
  }>;
  builtin?: boolean;
}

function loadPluginsConfig(): { custom: any[]; enabled: Record<string, boolean> } {
  try {
    if (existsSync(PLUGINS_CONFIG_PATH)) {
      const raw = readFileSync(PLUGINS_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        custom: Array.isArray(parsed.custom) ? parsed.custom : [],
        enabled: parsed.enabled && typeof parsed.enabled === 'object' ? parsed.enabled : {},
      };
    }
  } catch {
    // Ignore
  }
  return { custom: [], enabled: {} };
}

function persistPlugins(custom: Map<string, any>, enabled: Map<string, boolean>): void {
  try {
    const configDir = join(PLUGINS_CONFIG_PATH, '..');
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    const data = {
      custom: Array.from(custom.values()),
      enabled: Object.fromEntries(enabled),
    };
    writeFileSync(PLUGINS_CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // Ignore persistence errors
  }
}

const PanelItemSchema = z.object({
  label: z.string().min(1).max(40),
  prompt: z.string().min(1).max(200),
});

const PanelSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().min(1).max(40),
  description: z.string().max(200).optional(),
  items: z.array(
    z.object({
      label: z.string().min(1).max(40),
      prompt: z.string().min(1).max(200),
    })
  ).min(1).max(12),
});

const CreatePluginSchema = z.object({
  name: z.string().min(1).max(40),
  description: z.string().max(200).optional(),
  panels: z.array(
    z.object({
      id: z.string().min(1).max(40),
      title: z.string().min(1).max(40),
      description: z.string().max(200).optional(),
      items: z.array(
        z.object({
          label: z.string().min(1).max(40),
          prompt: z.string().min(1).max(200),
        })
      ).min(1).max(12),
    })
  ).min(1).max(4),
}).strict();

export class PluginsController {
  private customPlugins: Map<string, any> = new Map();
  private enabledPlugins: Map<string, boolean> = new Map();

  constructor() {
    this.enabledPlugins = new Map<string, boolean>();
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const { custom, enabled: enabledMap } = loadPluginsConfig();
    for (const plugin of custom) {
      this.customPlugins.set(plugin.id, plugin);
    }
    for (const [id, enabled] of Object.entries(enabledMap)) {
      this.enabledPlugins.set(id, Boolean(enabled));
    }
  }

  private persist(): void {
    persistPlugins(this.customPlugins, this.enabledPlugins);
  }

  list(_req: Request, res: Response): void {
    const plugins = Array.from(this.customPlugins.values()).map(plugin => ({
      ...plugin,
      enabled: this.enabledPlugins.get(plugin.id) ?? true,
    }));
    res.json({ plugins });
  }

  create(req: Request, res: Response): void {
    const parsed = CreatePluginSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new Error(
        'VALIDATION_ERROR: ' +
        parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；'),
      );
    }

    const id = `custom-${Date.now().toString(36)}`;
    const plugin = {
      id,
      name: parsed.data.name,
      version: '1.0.0',
      description: parsed.data.description ?? '',
      panels: parsed.data.panels,
    };

    this.customPlugins.set(id, plugin);
    this.enabledPlugins.set(id, true);
    this.persist();

    res.status(201).json({ plugin: { ...plugin, enabled: true } });
  }

  remove(req: Request, res: Response): void {
    const id = req.params.id as string;
    if (!id) {
      throw new Error('VALIDATION_ERROR: 插件 id 不能为空');
    }
    if (!this.customPlugins.has(id)) {
      throw new Error('PLUGIN_NOT_FOUND: 插件不存在：' + id);
    }
    this.customPlugins.delete(id);
    this.enabledPlugins.delete(id);
    this.persist();
    res.json({ deleted: true, id });
  }

  toggle(req: Request, res: Response): void {
    const id = req.params.id as string;
    if (!id) {
      throw new Error('VALIDATION_ERROR: 插件 id 不能为空');
    }
    const current = this.enabledPlugins.get(id) ?? true;
    this.enabledPlugins.set(id, !current);
    this.persist();
    res.json({ id, enabled: !current });
  }

  importJson(req: Request, res: Response): void {
    try {
      console.log('importJson req.body:', req.body);
      const parsed = req.body;
      const validation = validatePlugin(parsed);
      console.log('validation:', validation);
      if (!validation.ok) {
        res.status(400).json({ ok: false, error: validation.error });
        return;
      }
      if (this.customPlugins.has(validation.plugin.id)) {
        res.status(409).json({ ok: false, error: { code: 'PLUGIN_ID_EXISTS', message: `插件 id 已存在：${validation.plugin.id}` } });
        return;
      }
      this.customPlugins.set(validation.plugin.id, validation.plugin);
      this.enabledPlugins.set(validation.plugin.id, true);
      this.persist();
      res.status(201).json({ plugin: { ...validation.plugin, enabled: true } });
    } catch (e) {
      console.error('importJson error:', e);
      res.status(400).json({ ok: false, error: { code: 'INVALID_JSON', message: 'JSON 解析失败' } });
    }
  }
}
/** tool.forge 的任务级生命周期登记：create/use/recycle 与任务结束回收。 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

export interface ForgedToolEntry {
  name: string;
  sessionId: string;
  path: string;
  used: boolean;
  recycled: boolean;
}

const registry = new Map<string, Map<string, ForgedToolEntry>>();

function sessionMap(sessionId: string): Map<string, ForgedToolEntry> {
  let map = registry.get(sessionId);
  if (!map) {
    map = new Map();
    registry.set(sessionId, map);
  }
  return map;
}

export function recordForgedTool(sessionId: string, name: string, filePath: string): void {
  sessionMap(sessionId).set(name, { name, sessionId, path: filePath, used: false, recycled: false });
}

export function markForgedToolUsed(sessionId: string, name: string): void {
  const entry = registry.get(sessionId)?.get(name);
  if (entry) entry.used = true;
}

export function markForgedToolRecycled(sessionId: string, name: string): void {
  const entry = registry.get(sessionId)?.get(name);
  if (entry) entry.recycled = true;
}

export function listForgedTools(sessionId: string): ForgedToolEntry[] {
  return [...(registry.get(sessionId)?.values() ?? [])];
}

/**
 * 任务结束回收：只处理本 session 的 tmp/tools/<session> 定义。
 * 未 recycle 的义肢删除；已 recycle 的记录清掉；能力库 .codelens 不动。
 */
export function cleanupForgedTools(sessionId: string, sandboxRoot: string): { removed: string[]; kept: string[] } {
  const scope = path.join(sandboxRoot, 'tmp', 'tools', sessionId);
  const entries = registry.get(sessionId) ?? new Map<string, ForgedToolEntry>();
  const removed: string[] = [];
  const kept: string[] = [];
  const known = new Set(entries.keys());
  if (existsSync(scope)) {
    for (const file of readdirSync(scope)) {
      if (!file.endsWith('.json')) continue;
      const name = file.slice(0, -5);
      const entry = entries.get(name);
      if (entry?.recycled) continue;
      rmSync(path.join(scope, file), { force: true });
      removed.push(name);
      known.delete(name);
    }
  }
  for (const entry of entries.values()) {
    if (entry.recycled) kept.push(entry.name);
  }
  registry.delete(sessionId);
  return { removed, kept };
}

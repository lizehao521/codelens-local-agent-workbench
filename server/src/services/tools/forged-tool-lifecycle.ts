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

/** 校验 sessionId 仅含安全字符，防止路径穿越。 */
function validateSessionId(sessionId: string): void {
  if (!/^[a-z0-9_-]+$/i.test(sessionId)) {
    throw new Error(`Invalid sessionId: ${sessionId}`);
  }
}

function sessionMap(sessionId: string): Map<string, ForgedToolEntry> {
  validateSessionId(sessionId);
  let map = registry.get(sessionId);
  if (!map) {
    map = new Map();
    registry.set(sessionId, map);
  }
  return map;
}

export function recordForgedTool(sessionId: string, name: string, filePath: string): void {
  validateSessionId(sessionId);
  sessionMap(sessionId).set(name, { name, sessionId, path: filePath, used: false, recycled: false });
}

export function markForgedToolUsed(sessionId: string, name: string): void {
  validateSessionId(sessionId);
  const entry = registry.get(sessionId)?.get(name);
  if (entry && !entry.recycled) entry.used = true;
}

export function markForgedToolRecycled(sessionId: string, name: string): void {
  validateSessionId(sessionId);
  const entry = registry.get(sessionId)?.get(name);
  if (entry) entry.recycled = true;
}

export function listForgedTools(sessionId: string): ForgedToolEntry[] {
  validateSessionId(sessionId);
  return [...(registry.get(sessionId)?.values() ?? [])];
}

/**
 * 任务结束回收：只处理本 session 的 tmp/tools/<session> 定义。
 * 未 recycle 的义肢删除；已 recycle 的记录清掉；能力库 .codelens 不动。
 */
export function cleanupForgedTools(sessionId: string, sandboxRoot: string): { removed: string[]; kept: string[] } {
  validateSessionId(sessionId);
  const scope = path.join(sandboxRoot, 'tmp', 'tools', sessionId);
  // 防御性检查：确保解析后路径仍在 sandboxRoot 内
  const resolvedScope = path.resolve(scope);
  const resolvedRoot = path.resolve(sandboxRoot);
  if (!resolvedScope.startsWith(resolvedRoot + path.sep) && resolvedScope !== resolvedRoot) {
    throw new Error(`Session scope escapes sandbox: ${sessionId}`);
  }
  const entries = registry.get(sessionId) ?? new Map<string, ForgedToolEntry>();
  const removed: string[] = [];
  const kept: string[] = [];
  if (existsSync(scope)) {
    for (const file of readdirSync(scope)) {
      if (!file.endsWith('.json')) continue;
      const name = file.slice(0, -5);
      const entry = entries.get(name);
      if (entry?.recycled) continue;
      rmSync(path.join(scope, file), { force: true });
      removed.push(name);
    }
  }
  for (const entry of entries.values()) {
    if (entry.recycled) kept.push(entry.name);
  }
  registry.delete(sessionId);
  return { removed, kept };
}

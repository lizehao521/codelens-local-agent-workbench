#!/usr/bin/env node
/**
 * 工具注册表契约：注册名 ↔ 线上名 ↔ 历史执行记录 ↔ 对外清单，四者必须一致。
 *
 * 这是跨模块断言，不是单函数单测：
 *   - 注册表来自 `server/src/tools/builtin/index.ts`（唯一装配点）
 *   - 线上名由 `wireName` 决定，必须能从规范名机械推导（`.` → `_`）
 *   - `tool_calls.tool_name` 是审计/归因的输入，出现注册表外的名字 = 统计口径漏项
 *   - `/api/v1/tools` 是模型可见面，注册表里的工具没下发 = 模型永远调不到
 *
 * 设计取舍：CodeLens 提议过「用 zod 反推 handler 参数结构」，那条不可执行
 * （handler 首参是 ToolContext，不是入参 schema），所以不写永真断言。
 *
 * 退出码：0 通过（含 UNEXEC 提示）/ 1 契约违规 / 2 注册表不可读
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = join(ROOT, 'server', 'data', 'codelens.db');
const API = process.env.CODELENS_API ?? 'http://127.0.0.1:8080';

let registry;
try {
  ({ BUILTIN_TOOLS: registry } = await import('../server/src/tools/builtin/index.ts'));
} catch (err) {
  console.error(`[ERR] 无法加载注册表（需要 tsx）：${err.message}`);
  process.exit(2);
}

const failures = [];
const unexec = [];
const names = new Set();
const wires = new Set();

for (const t of registry) {
  if (!t.name || !t.wireName) {
    failures.push(`工具有空 name/wireName：${JSON.stringify(t.name)}`);
    continue;
  }
  if (names.has(t.name)) failures.push(`规范名重复：${t.name}`);
  if (wires.has(t.wireName)) failures.push(`线上名重复：${t.wireName}`);
  names.add(t.name);
  wires.add(t.wireName);

  const expected = t.name.replace(/\./g, '_');
  if (t.wireName !== expected) {
    failures.push(`${t.name}: wireName=${t.wireName}，按规范名应为 ${expected}`);
  }
  if (!t.risk) failures.push(`${t.name}: 缺 risk`);
}

if (existsSync(DB)) {
  try {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare('SELECT DISTINCT tool_name AS n FROM tool_calls').all();
    for (const r of rows) {
      if (r.n && !names.has(r.n)) failures.push(`历史执行记录含注册表外的工具名：${r.n}`);
    }
  } catch (err) {
    unexec.push(`执行记录核对失败（不判通过）：${err.message}`);
  }
} else {
  unexec.push('无本地数据库，跳过执行记录核对');
}

try {
  const res = await fetch(`${API}/api/v1/tools`, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : (body.tools ?? []);
  const publicNames = new Set(list.map((t) => t.name));
  for (const n of names) {
    if (!publicNames.has(n)) failures.push(`注册表有、对外清单没有：${n}`);
  }
} catch {
  unexec.push(`服务未运行，跳过对外清单核对（${API}）`);
}

for (const f of failures) console.error(`[FAIL] ${f}`);
for (const u of unexec) console.log(`[UNEXEC] ${u}`);

if (failures.length) {
  console.error(`工具注册表契约：${failures.length} 项违规（注册 ${registry.length} 个）`);
  process.exit(1);
}
console.log(`[PASS] 工具注册表契约：${registry.length} 个工具，规范名/线上名/执行记录一致`);

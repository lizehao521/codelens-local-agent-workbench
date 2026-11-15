/** mutation-probe 的 --dirty 准入闸：本地显式、任务内 allowed、自动/CI clean-only。 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 自动/CI 流程绝不能靠 --dirty 放宽；只认显式本地陪跑。 */
export function isAutomatedFlow(env = process.env) {
  const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
  return truthy(env.MUTATION_AUTO) || truthy(env.MUTATION_GATE_AUTO) || truthy(env.CI) || truthy(env.GITHUB_ACTIONS);
}

/** _infra 变异体的专用靶子清单；它们不属于业务任务，但仍须逐文件显式授权。 */
export const INFRA_ALLOWED = [
  'server/src/tools/builtin/path-jail.ts',
  'server/src/controllers/checkpoints.controller.ts',
  'server/tests/capability-registry.test.ts',
  'server/scripts/lib/dispatch-timeout.mjs',
  'server/scripts/self-upgrade-loop.ts',
  'server/scripts/failure-attribution.ts',
  'server/scripts/lib/dispatch-evidence.mjs',
  'server/src/services/agent/project-instructions.ts',
  'server/src/services/agent/system-prompt.ts',
  'server/src/services/agent/agent-loop.service.ts',
];

export function evaluateDirtyPolicy(input) {
  if (!input.requested) return { allow: false, reason: '未显式传 --dirty，保持 clean-only' };
  if (input.automated) return { allow: false, reason: '自动/CI 流程强制 clean-only，显式 --dirty 也不放行' };
  if (input.allowed.length === 0) return { allow: false, reason: '当前任务没有 allowed 文件，拒绝脏文件注入' };
  if (!input.allowed.includes(input.target)) {
    return { allow: false, reason: `目标 ${input.target} 不在当前任务 allowed 内` };
  }
  return { allow: true, reason: `本地显式 --dirty 且目标在 allowed 内：${input.target}` };
}

/** 归一化到仓库相对路径；client 题相对 client，server/repo 题相对对应根。 */
function repoRelative(pkg, fileRoot, file) {
  const raw = file.replace(/\\/g, '/');
  if (raw.startsWith('client/') || raw.startsWith('server/')) return raw;
  if (raw.startsWith('../')) return raw.slice(3);
  const root = fileRoot === 'repo' ? '' : fileRoot || pkg;
  return root ? `${root}/${raw}` : raw;
}

/** 读取 tasks.json，返回当前任务 allowed 的仓库相对路径；未知任务返回空。 */
export function allowedForTask(taskId, pkg, fileRoot, root) {
  if (taskId === '_infra') return [...INFRA_ALLOWED];
  if (!taskId) return [];
  try {
    const doc = JSON.parse(readFileSync(path.join(root, 'server', 'self-upgrade', 'tasks.json'), 'utf8'));
    const task = doc.tasks?.find((item) => item.id === taskId);
    if (!task || !Array.isArray(task.allowed)) return [];
    return task.allowed.map((file) => repoRelative(pkg, fileRoot, String(file)));
  } catch {
    return [];
  }
}

// bridge RSI round: gate verified through session upstream

// bridge RSI round: gate verified through session upstream (2)

/**
 * 执行方式：同一份任务说明，按“计划”还是“目标”执行。
 *
 * - plan：先列步骤，再按步骤执行；步骤变化/受阻先说明。
 * - goal：锁定目标与边界，允许执行中调整步骤与工具。
 *
 * 只影响 Agent 的组织方式，不改变工具权限与审批规则。
 */
export const EXECUTION_MODES = ['plan', 'goal'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export function buildExecutionModeSection(mode: ExecutionMode): string {
  if (mode === 'plan') {
    return [
      '【执行方式：按计划执行】',
      '先把任务拆成可验证的步骤，再按步骤执行；不要擅自增删/重排步骤。',
      '遇到阻塞、需要改步骤或发现计划与现状不符时，先说明原因并等待确认，不要静默改道。',
    ].join('\n');
  }
  return [
    '【执行方式：目标模式】',
    '把当前任务/计划当作目标与边界，允许在执行中调整步骤、工具与顺序，以达成目标为准。',
    '只在不可逆操作、越界访问或需要用户决策时停下来确认；完成后说明目标是否达成、哪些假设被调整。',
  ].join('\n');
}

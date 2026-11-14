/** 完整测试调用判定：完整 vitest / npm test 必须走 agent.verify，而不是 sys.exec。 */
import type { ExecCommandVerdict } from './sys-exec.policy.js';

export function fullTestVerdict(command: string, args: readonly string[]): ExecCommandVerdict | null {
  const name = command.trim().toLowerCase();
  const raw = args.map((a) => String(a));
  const isNpmTest = (name === 'npm' || name === 'npm.cmd') && (raw[0]?.toLowerCase() === 'test' || (raw[0]?.toLowerCase() === 'run' && raw[1]?.toLowerCase() === 'test'));
  const vitestAt = raw.findIndex((a) => /(^|[\\/])vitest(\.mjs)?$/i.test(a) || a.toLowerCase() === 'vitest');
  const after = vitestAt >= 0 ? raw.slice(vitestAt + 1) : [];
  const runAt = after.findIndex((a) => a.toLowerCase() === 'run');
  const target = runAt >= 0 ? after.slice(runAt + 1).find((a) => !a.startsWith('-') && /\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(a)) : undefined;
  if (!isNpmTest && !(runAt >= 0 && !target)) return null;
  return {
    ok: false,
    code: 'INVALID_ARGS',
    message: 'sys.exec 不允许运行完整 vitest / npm test：会撞工具超时',
    suggestion: '改用 agent.verify(package="server", checks=["test"])；单文件测试用 test.run',
  };
}

/**
 * 杀整棵进程树（test.run / type.check / sys.exec 共用）。
 *
 * ── 为什么收在一处 ────────────────────────────────────────
 * 三份副本原本各有微小差异（有的传 `number | undefined`，有的带 `windowsHide`，
 * 有的在 taskkill 失败时退化为杀父进程）。差异本身不是问题，"分头演进"才是：
 * 一旦某个工具补上 `windowsHide: true`，另一个就可能在 CI 上闪出黑窗；
 * 一旦某处漏了 `undefined` 判空，`String(undefined)` 会变成一次无意义的 taskkill。
 *
 * 语义：POSIX 杀进程组（负数 pid），Windows 用 `taskkill /T /F`。
 * 全部失败路径都静默——调用点通常在超时/中止分支上，此时已经要返回结果了，
 * 清理失败不该把真实错误盖掉。
 */

import { spawn } from 'node:child_process';

export function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => undefined);
    } catch {
      // taskkill 不可用：退化为杀父进程（至少不会继续写管道）
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 进程已退出
      }
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 进程组已不存在：退化为杀单进程
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程已退出
    }
  }
}

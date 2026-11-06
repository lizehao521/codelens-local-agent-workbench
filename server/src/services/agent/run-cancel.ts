/**
 * Run-level cancellation context.
 *
 * 一次 run 的所有取消来源（请求断连 / POST abort / 服务关闭）在这里汇成**一个**
 * AbortSignal，并记录“为什么取消”。下游（能力探测、provider adapter、工具执行）
 * 只接收这个 signal，不再各自创建控制器或手工拼信号。
 *
 * 为什么要记 reason：同一个 AbortError 可能是用户点了停止，也可能是进程要退出。
 * 前者不能当错误上报（用户自己干的），后者要静默收尾。只看 signal.aborted
 * 无法区分，于是所有出口都会退化成同一种文案。
 */

export type RunCancelReason = 'abort' | 'shutdown';

export class RunCancellation {
  private readonly controller = new AbortController();
  private readonly unlink: Array<() => void> = [];
  private cancelReason: RunCancelReason | null = null;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** 首次取消的 reason；重复取消不会覆盖（先到先得，保证归因稳定）。 */
  get reason(): RunCancelReason | null {
    return this.cancelReason;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * 把外部信号接入本上下文。signal 已中止时立即取消；否则监听一次。
   * 返回 this 以便链式接线。
   */
  link(source: AbortSignal | null | undefined, reason: RunCancelReason): this {
    if (!source) return this;
    if (source.aborted) {
      this.cancel(reason);
      return this;
    }
    const handler = (): void => {
      this.cancel(reason);
    };
    source.addEventListener('abort', handler, { once: true });
    this.unlink.push(() => source.removeEventListener('abort', handler));
    return this;
  }

  /** 取消（幂等）：重复调用只保留第一次的 reason，不会重复触发 abort 事件。 */
  cancel(reason: RunCancelReason): boolean {
    if (this.controller.signal.aborted) return false;
    this.cancelReason = reason;
    this.controller.abort();
    return true;
  }

  /** 解除对所有外部信号的监听。run 结束时调用，避免长生命周期 signal 上堆积监听器。 */
  dispose(): void {
    for (const off of this.unlink) off();
    this.unlink.length = 0;
  }
}

/** 给用户看的取消文案：按 reason 区分，不把用户主动中止说成“错误”。 */
export function describeCancel(reason: RunCancelReason | null): string {
  return reason === 'shutdown' ? '服务正在关闭，任务已取消' : '任务已被用户中止';
}

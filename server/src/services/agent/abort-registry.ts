/**
 * Abort registry: Map<sessionId, AbortController> for T-4 termination.
 * POST /api/v1/agent/abort and client disconnects both land here; the loop's
 * signal checks make the abort cooperative (in-flight tool calls finish or die
 * at their next await).
 *
 * One task per session is the design invariant: register() hands back the live
 * controller when one exists, isActive()/abortAndWait() let a new request
 * serialize behind the previous run instead of racing it on the same session
 * (P0-2: concurrent double-writes and orphan tool messages).
 */

interface RegistryEntry {
  controller: AbortController;
  /** Resolves when the owning run() has fully unwound. */
  done: Promise<void>;
  notifyDone: () => void;
}

/** Upper bound for abortAndWait: ≥ the longest per-tool timeout (http 30s). */
const ABORT_WAIT_TIMEOUT_MS = 35_000;

export class AbortRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  register(sessionId: string): AbortController {
    const existing = this.entries.get(sessionId);
    if (existing) return existing.controller;
    const controller = new AbortController();
    let notifyDone!: () => void;
    const done = new Promise<void>((resolve) => {
      notifyDone = resolve;
    });
    this.entries.set(sessionId, { controller, done, notifyDone });
    return controller;
  }

  get(sessionId: string): AbortController | undefined {
    return this.entries.get(sessionId)?.controller;
  }

  /** True while a run() holds (or still holds) this session's controller. */
  isActive(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** Aborts the task if one is running; returns whether anything was aborted. */
  abort(sessionId: string): boolean {
    const controller = this.entries.get(sessionId)?.controller;
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  /**
   * Aborts the running task (if any) and waits for its teardown, so a new
   * request for the same session never overlaps the previous loop. Bounded by
   * ABORT_WAIT_TIMEOUT_MS; on timeout the caller proceeds (the old loop is on
   * its way out and will stop at its next termination check).
   */
  async abortAndWait(sessionId: string, timeoutMs: number = ABORT_WAIT_TIMEOUT_MS): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    const aborted = this.abort(sessionId);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      entry.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return aborted;
  }

  /** Marks the owning run as finished; idempotent, wakes abortAndWait. */
  markDone(sessionId: string): void {
    this.entries.get(sessionId)?.notifyDone();
  }

  release(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.notifyDone(); // a release also means the run is over
    this.entries.delete(sessionId);
  }
}

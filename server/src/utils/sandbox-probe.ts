/**
 * 沙箱可写探针 —— 用一次性的**真实写入**证明「可写」，而不是 stat。
 *
 * AUDIT-026 的原意：只读挂载（磁盘满、只读卷）上 `statSync` 依然返回成功，
 * 只有真正写一次才会失败 —— 而那正是我们要暴露的故障。探针文件在成功与失败
 * 两条路径上都会被清理。
 *
 * 抽成独立函数的原因：这个事实同时被两处消费 —— `/api/health` 的 sandbox.writable
 * 与能力目录的「沙箱权限」条目。两处各写一份探针，早晚会长出两种口径
 * （一处用 stat、一处用 write），于是「健康检查说可写、能力目录说不可写」。
 *
 * ## 为什么有 TTL 缓存
 *
 * 探针是**同步写盘**，而写盘耗时完全取决于当下的磁盘压力：实测同一台机器上，
 * 空闲时一次探针写 + 删约 1–5ms，而在多进程并发跑测试、磁盘队列积压时可达
 * **数百毫秒甚至数秒**。能力目录端点会被前端面板频繁调用（每次切换分区），
 * 若每次都真写一次盘，就把「磁盘抖动」直接放大成用户可感知的接口延迟 ——
 * 实测 IO 拥塞时 `/api/v1/capabilities` 曾耗时 10 秒以上。
 *
 * 所以探针结果按 (root, TTL) 缓存：TTL 窗口内复用上次结论。
 *
 * 代价要说清楚：**结论最多滞后 TTL**。这对两个消费方都无影响 ——
 *   · `/api/health` 用于就绪判定，滞后 5 秒无关紧要；
 *   · 能力目录是状态展示，滞后 5 秒无感。
 * 而「探针实时反映当下可写」并非这两个端点的契约要求：真正需要实时性的地方
 * 是**工具执行路径**，那条路径不经过这里（fs.write 等工具在执行时自己会失败）。
 *
 * TTL 默认 5 秒；传 `ttlMs = 0` 可强制立即重探（测试用）。
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 默认缓存窗口（毫秒）。 */
export const PROBE_TTL_MS = 5_000;

interface ProbeCacheEntry {
  at: number;
  writable: boolean;
}

/** 按沙箱根缓存；同一进程通常只有一个根，但用 Map 存可避免串味。 */
const cache = new Map<string, ProbeCacheEntry>();

/**
 * 探针文件放在工作区内的专用子目录里。
 *
 * 为什么是子目录而不是工作区根：根目录是用户真正放东西的地方，往里丢一个
 * 无意义文件会让人以为是自己弄出来的；`.codelens/` 一眼就知道是工具产生的。
 */
const PROBE_DIR = '.codelens';
const PROBE_FILE = 'health-probe';

function doProbe(sandboxRoot: string): boolean {
  if (!sandboxRoot) return false;
  try {
    const probeDir = path.join(sandboxRoot, PROBE_DIR);
    if (!existsSync(probeDir)) mkdirSync(probeDir, { recursive: true });
    else if (!statSync(probeDir).isDirectory()) return false;
    // 覆盖写同一个固定文件，**刻意不删除**。
    //
    // 删除在 WorkBuddy 宿主里是条慢路径：node-safe-delete-shim 把 rmSync /
    // unlinkSync 改写成「移入回收站」，实测单文件删除要 9–10 秒（unlinkSync 还会
    // 直接抛错）。探针若依赖删除，每探测一次就阻塞 10 秒 —— `/api/health` 与
    // `/api/v1/capabilities` 会被拖到客户端超时（实测 10.6s）。
    //
    // 代价：工作区里常驻一个 2 字节的探针文件。接受它，因为：
    //   · 写一次覆盖，文件大小恒定，不会增长；
    //   · 它位于 `.codelens/` 下，不污染用户自己的文件；
    //   · 快照会拍到它，但回滚只会把它还原成同样 2 字节，无害（不必为它加过滤规则）。
    //
    // 「可写」的判定语义不变：仍是在**工作区内**真实写一次 —— 写到别处就测不到
    // "工作区挂载本身可写"这件事了。
    writeFileSync(path.join(probeDir, PROBE_FILE), 'ok', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测沙箱根是否真的可写。
 *
 * @param sandboxRoot 沙箱根目录；为空视为不可写。
 * @param ttlMs       缓存窗口；0 = 不缓存，每次都真探一次。
 */
export function probeSandboxWritable(sandboxRoot: string, ttlMs: number = PROBE_TTL_MS): boolean {
  if (!sandboxRoot) return false;
  const now = Date.now();
  const hit = cache.get(sandboxRoot);
  if (ttlMs > 0 && hit && now - hit.at < ttlMs) return hit.writable;
  const writable = doProbe(sandboxRoot);
  cache.set(sandboxRoot, { at: now, writable });
  return writable;
}

/** 清空探针缓存（测试用：让用例之间互不干扰）。 */
export function resetSandboxProbeCache(): void {
  cache.clear();
}

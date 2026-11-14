/**
 * 派单子进程的外层超时与「被掐断」信号。
 *
 * 为什么外层超时不能写死：服务端的墙钟预算检查在**每轮 LLM 调用之前**，
 * 所以单轮可以整体过冲；触发之后还要写 run_report、落 SSE、打取证尾部。
 * 实测 2026-11-14（code-search 三次真实派单）：墙钟调到 660s，第 20 轮在
 * 701723ms 触发，外层写死的 700s 同时掐断 —— 三次 sendSec 全是 700。
 * 第 1 次的 SSE 落盘了（run_report 明写 outcome=budget_exhausted），
 * 但 `console.log(buildDispatchTail(sse))` 没来得及执行，归因拿不到计数，
 * 三轮里两轮被记成 implementation/BEHAVIOR_WRONG 并计入 Agent 能力账。
 * 两个互相不知情的常数凑在一起，尺子就替被衡量者说了谎。
 *
 * 为什么信号必须留在输出里：只回 stdout 的话，「被外层掐断（半成品）」和
 * 「跑完了但没做对」在归因眼里一模一样。缺证据 ≠ 反证（C4）。
 */

/**
 * 过冲余量：实测单轮 35–57s，留够空间给「最后一轮整体过冲 + 收尾取证」。
 *
 * 180s 曾经不够。现场（2026-11-14 code-search 第 1 次派单）：墙钟 1200s，
 * 第 9 轮单轮过冲 190s，run_report 自报 durationMs=1390046 —— 1380s 的外层
 * 掐断比报告早到 10 秒，证据全丢。所以下限是「实测最大单轮过冲 × 1.5」。
 * 300s 也同时是取证等待的上限（lib/dispatch-evidence.mjs）：掐断之后子进程
 * 最多还能活这么久，等它静止的成本与「本来该给的余量」是同一个数。
 */
export const DISPATCH_HEADROOM_MS = 300_000;

/** 与 src/config/env.ts 的 AGENT_TASK_BUDGET_MS 同口径（default/min/max）。 */
const DEFAULT_TASK_BUDGET_MS = 180_000;
const MIN_TASK_BUDGET_MS = 1000;
const MAX_TASK_BUDGET_MS = 3_600_000;

/**
 * 服务端这一轮真正会用的墙钟预算。
 * 取不到合法值就回默认，**绝不回 NaN**：execFileSync 的 timeout=NaN 等于不设超时，
 * 外层守卫会静默消失，比掐断更糟。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function taskBudgetMs(env = process.env) {
  const n = Number(env.AGENT_TASK_BUDGET_MS);
  if (!Number.isFinite(n) || n < MIN_TASK_BUDGET_MS || n > MAX_TASK_BUDGET_MS) return DEFAULT_TASK_BUDGET_MS;
  return Math.trunc(n);
}

/**
 * 外层派单超时 = 服务端墙钟 + 过冲余量。旋钮拧大，外层跟着让路。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function dispatchTimeoutMs(env = process.env) {
  return taskBudgetMs(env) + DISPATCH_HEADROOM_MS;
}

/**
 * 子进程被外层超时杀掉时，往输出里追加一行机械信号。
 * 非超时错误（ENOENT / 非零退出 / 上游报错）一律返回空串 —— 不许把别的失败洗成超时。
 *
 * 措辞刻意避开 `ETIMEDOUT` 这个裸词：failure-attribution.ts 的上游不可达分支
 * 拿它当识别串（undici 的连接超时同名）。而这里的 ETIMEDOUT 是 execFileSync
 * 自己的超时码，说的是「我们掐了子进程」，不是「上游连不上」。同名不同因，
 * 照抄进去会把调度器超时误判成 halt_manual 的上游故障。
 * @param {{code?: string, signal?: string} | null | undefined} err execFileSync 抛出的错误
 * @param {number} timeoutMs 本次派单用的外层超时
 * @returns {string}
 */
export function timeoutMarker(err, timeoutMs) {
  const killed = err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM';
  if (!killed) return '';
  return `\nDISPATCH_TIMEOUT=${timeoutMs}ms kill=${err.signal ?? 'timeout'}\n`;
}
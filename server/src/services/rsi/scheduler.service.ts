/**
 * RSI Scheduler Service — 定时/事件驱动触发 self-upgrade-loop。
 *
 * 职责：
 *   1. 定时触发（cron 表达式，默认每 6 小时）
 *   2. 事件触发：判据新增、围栏全绿、git push（通过 HTTP 端点）
 *   3. 手工触发 API：POST /api/v1/rsi/scheduler/trigger
 *   4. 复用 self-upgrade-loop.ts 的环境变量控制逻辑（AUTO_ROUND 等）
 *
 * 设计约束：
 *   - 不直接 import self-upgrade-loop.ts（它在 scripts/，属 D4，Agent 改不得）
 *   - 通过 spawn 子进程运行 `npx tsx scripts/self-upgrade-loop.ts`
 *   - 子进程继承关键环境变量，隔离每轮运行
 *   - 失败不阻断主流程，只记账本
 *   - 单例模式，随服务启动/停止
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../../repositories/db.js';

export interface SchedulerConfig {
  /** cron 表达式（node-cron 语法），默认每 6 小时：'0 *\/6 * * *' */
  cron?: string;
  /** 是否启用定时触发，默认 true */
  enabled?: boolean;
  /** 单次派单最大墙钟 ms，默认 90 分钟 */
  maxWallMs?: number;
  /** 最大自动轮数，默认 3 */
  maxAutoRounds?: number;
  /** 总墙钟上限 ms，默认 30 分钟 */
  maxAutoWallMs?: number;
  /** 连续失败上限，默认 3 */
  maxConsecFailures?: number;
  /** 派单模式：'sse' | 'bridge'，默认 'sse' */
  dispatch?: 'sse' | 'bridge';
  /** 模型轮换列表，逗号分隔 */
  modelRotation?: string;
  /** 基础 URL（给子进程透传） */
  baseUrl?: string;
}

const DEFAULT_CONFIG: Required<SchedulerConfig> = {
  cron: '0 */6 * * *',
  enabled: true,
  maxWallMs: 90 * 60_000,
  maxAutoRounds: 3,
  maxAutoWallMs: 30 * 60_000,
  maxConsecFailures: 3,
  dispatch: 'sse',
  modelRotation: 'nvidia/nemotron-3-ultra-550b-a55b,deepseek-ai/deepseek-v4.1-flash,moonshotai/kimi-k2.6,nvidia/nemotron-3-super-120b-a12b',
  baseUrl: '',
};

let cronJob: { stop: () => void } | null = null;
let currentConfig: Required<SchedulerConfig> = DEFAULT_CONFIG;
let isRunning = false;
let lastRunResult: { ok: boolean; output: string; at: string } | null = null;

/**
 * 解析 cron 表达式并返回下一次触发时间（用于健康检查显示）。
 * 简易实现：只支持标准 5 位 cron，不处理秒位。
 */
async function parseCronNext(cron: string): Promise<Date | null> {
  try {
    // 动态导入 cron-parser（可选依赖），失败则返回 null
    // @ts-expect-error optional dependency
    const cronParser = await import('cron-parser');
    const interval = cronParser.parseExpression(cron, { utc: false });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/**
 * 运行一次 self-upgrade-loop。
 * 返回 { ok, output }，不抛出。
 */
async function runOnce(reason: string): Promise<{ ok: boolean; output: string }> {
  if (isRunning) {
    return { ok: false, output: '上一轮仍在运行，跳过本次触发' };
  }
  isRunning = true;

  const SERVER = path.join(process.cwd(), 'server');
  const loopScript = path.join(SERVER, 'scripts', 'self-upgrade-loop.ts');

  if (!existsSync(loopScript)) {
    isRunning = false;
    return { ok: false, output: `找不到循环脚本：${loopScript}` };
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RSI_MAX_AUTO_ROUNDS: String(currentConfig.maxAutoRounds),
    RSI_MAX_AUTO_WALL_MS: String(currentConfig.maxAutoWallMs),
    RSI_MAX_CONSECUTIVE_FAILURES: String(currentConfig.maxConsecFailures),
    RSI_DISPATCH: currentConfig.dispatch,
    RSI_MODEL_ROTATION: currentConfig.modelRotation,
    // 墙钟预算传给子进程（它会再算一次 DEADLINE）
    RSI_MAX_WALL_MS: String(currentConfig.maxWallMs),
  };
  if (currentConfig.baseUrl) {
    env.RSI_BASE_URL = currentConfig.baseUrl;
  }

  return new Promise((resolve) => {
    const child: ChildProcess = spawn('npx', ['tsx', 'scripts/self-upgrade-loop.ts'], {
      cwd: SERVER,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env,
      timeout: currentConfig.maxWallMs + 60_000, // 给子进程留 1 分钟缓冲
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      isRunning = false;
      resolve({ ok: false, output: `spawn 错误：${err.message}` });
    });

    child.on('exit', (code, signal) => {
      isRunning = false;
      const output = `${stdout}\n${stderr}`.trim();
      const ok = code === 0 && !signal;
      lastRunResult = { ok, output, at: new Date().toISOString() };
      resolve({ ok, output: `${reason} | exit=${code ?? signal} | ${output.slice(-2000)}` });
    });
  });
}

/**
 * 调度器服务类。
 */
export class RsiSchedulerService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** 启动定时任务。 */
  async start(config?: SchedulerConfig): Promise<void> {
    if (config) {
      currentConfig = { ...DEFAULT_CONFIG, ...config };
    }

    if (!currentConfig.enabled) {
      console.log('[RSI Scheduler] 定时触发已禁用');
      return;
    }

    try {
      // @ts-expect-error optional dependency
      const cronModule = await import('node-cron');
      cronJob = cronModule.schedule(currentConfig.cron, async () => {
        console.log(`[RSI Scheduler] 定时触发 @ ${new Date().toISOString()}`);
        const result = await runOnce('定时触发');
        await this.logRun('cron', result.ok, result.output);
      });
      const next = await parseCronNext(currentConfig.cron);
      console.log(`[RSI Scheduler] 已启动，cron=${currentConfig.cron}，下一次约 ${next?.toISOString() ?? '未知'}`);
    } catch (e) {
      console.warn('[RSI Scheduler] node-cron 未安装，定时触发不可用：', e instanceof Error ? e.message : String(e));
    }
  }

  /** 停止定时任务。 */
  stop(): void {
    if (cronJob) {
      cronJob.stop();
      cronJob = null;
      console.log('[RSI Scheduler] 已停止');
    }
  }

  /** 手工触发一次循环。 */
  async trigger(reason = 'manual'): Promise<{ ok: boolean; output: string }> {
    console.log(`[RSI Scheduler] 手工触发：${reason} @ ${new Date().toISOString()}`);
    const result = await runOnce(reason);
    await this.logRun(reason, result.ok, result.output);
    return result;
  }

  /** 获取当前状态（同步版本，nextCron 可能为 null）。 */
  getStatus(): {
    running: boolean;
    config: Required<SchedulerConfig>;
    nextCron: Date | null;
    lastRun: typeof lastRunResult;
  } {
    // 同步版本不等待 parseCronNext，返回 null 由调用方自行异步获取
    return {
      running: isRunning,
      config: currentConfig,
      nextCron: null,
      lastRun: lastRunResult,
    };
  }

  /** 获取当前状态（异步版本，包含下次触发时间）。 */
  async getStatusAsync(): Promise<{
    running: boolean;
    config: Required<SchedulerConfig>;
    nextCron: Date | null;
    lastRun: typeof lastRunResult;
  }> {
    return {
      running: isRunning,
      config: currentConfig,
      nextCron: await parseCronNext(currentConfig.cron),
      lastRun: lastRunResult,
    };
  }

  /** 更新配置（热更改，定时任务会重启）。 */
  async updateConfig(config: Partial<SchedulerConfig>): Promise<void> {
    currentConfig = { ...currentConfig, ...config };
    if (cronJob) {
      this.stop();
      await this.start();
    }
  }

  /** 记录运行结果到 policy_rsi_runs（复用现有表）或单独表。 */
  private async logRun(trigger: string, ok: boolean, output: string): Promise<void> {
    try {
      this.db.run(
        `INSERT INTO policy_rsi_runs (session_id, generation, prev_manifest_json, next_manifest_json, verdict, created_at)
         VALUES (?, 0, '', '', ?, datetime('now'))`,
        [`scheduler-${trigger}`, ok ? 'scheduled_ok' : 'scheduled_failed'],
      );
    } catch {
      // 记账失败不阻断主流程
      console.warn('[RSI Scheduler] 记账失败，忽略');
    }
  }
}

/** 单例获取器（由 app.ts 在启动时初始化）。 */
let schedulerInstance: RsiSchedulerService | null = null;

export function getRsiScheduler(db?: Db): RsiSchedulerService | null {
  if (db && !schedulerInstance) {
    schedulerInstance = new RsiSchedulerService(db);
  }
  return schedulerInstance;
}

export function setRsiScheduler(instance: RsiSchedulerService | null): void {
  schedulerInstance = instance;
}
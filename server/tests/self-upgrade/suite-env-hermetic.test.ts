/**
 * 判据 · 判据套件必须与宿主环境隔离（Judge / 尺子侧）
 *
 * 缺口现场（2026-11-14 机械取证）：fs-read-line-window 与 fs-glob-shared 两题、
 * 共五次派单，围栏每次都判「全量回归红了且串行复跑仍红 —— 可复现，判为真回归」，
 * 而人工直跑同一份代码全绿。落盘的 .self-upgrade/loop/full-regression-*.txt
 * 终于给出失败项：fallback-budget.endpoint 期望 serverKeyConfigured=false 得到 true、
 * judge-deep 期望 not_configured 得到 invalid_json、observability-endpoints 期望
 * enabled=false 得到 true、workspace-context 期望 sandboxRoot basename=workspace
 * 得到 server。全部指向同一根因：**围栏的全量回归子进程继承了派单循环
 * loadEnvFile(server/.env) 后的 process.env**，而这批用例断言的是「默认关闭」态。
 *
 * 复现（人实跑）：干净 env 下 fallback-budget + observability 两文件 8 passed；
 * process.loadEnvFile('.env') 后同样文件加 judge-deep 共 4 failed，与落盘证据逐条对上。
 *
 * 所以这不是 Agent 踩坏了既有行为，是尺子被环境污染。本判据钉住隔离本身：
 * 隔离件必须在模块 import 前清掉 ambient 配置键，且不得顺手清掉 krsi 要用的键；
 * 并且**在真实污染环境下 spawn 一次那五个文件，必须全绿** —— 只做源码扫描
 * 证明不了隔离真的生效。
 *
 * C3：把 vitest.config.ts 的 setupFiles 摘掉，本判据的 spawn 用例必须转红。
 */
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../..', import.meta.url));

/** 派单循环那份 .env 里真正会把判据打红的键（取自落盘证据，不是猜的）。 */
const POLLUTION: Record<string, string> = {
  LLM_SERVER_API_KEY: 'sk-hermeticity-probe-not-a-real-key',
  TRIAL_MODE_ENABLED: 'true',
  TRIAL_BASE_URL: 'https://example.invalid/v1',
  TRIAL_MODEL: 'probe/model',
  TRIAL_DAILY_LIMIT: '5',
  SKILL_LIBRARY_ENABLED: 'true',
  CHECKPOINT_ENABLED: 'true',
  SANDBOX_ROOT: SERVER,
  RSI_API_KEY: 'sk-hermeticity-probe-not-a-real-key',
  RSI_MODEL: 'probe/model',
  CHAT_MODEL: 'probe/model',
};

/** 环境敏感、且断言「默认关闭」态的判据文件——就是落盘证据里红的那五个。 */
const ENV_SENSITIVE = [
  'tests/fallback-budget.endpoint.test.ts',
  'tests/observability-endpoints.test.ts',
  'tests/judge-deep.test.ts',
  'tests/judge-deep-api.test.ts',
  'tests/workspace-context.test.ts',
];

const spawnWithPollution = (args: string[]) =>
  spawnSync('npx', args, {
    cwd: SERVER,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 240_000,
    env: { ...process.env, ...POLLUTION },
  });

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');

describe('隔离件本身：清 ambient 配置，但别清过头', () => {
  it('导入隔离件后 ambient 配置键被清空', async () => {
    const before = process.env.LLM_SERVER_API_KEY;
    process.env.LLM_SERVER_API_KEY = 'ambient-should-be-cleared';
    vi.resetModules();
    await import('../../tests/setup-hermetic-env.ts');
    expect(process.env.LLM_SERVER_API_KEY).toBeUndefined();
    if (before === undefined) delete process.env.LLM_SERVER_API_KEY;
    else process.env.LLM_SERVER_API_KEY = before;
  });

  it('不得清掉 KRSI_BIN_PATH（krsi 用例要它定位二进制）', async () => {
    const before = process.env.KRSI_BIN_PATH;
    process.env.KRSI_BIN_PATH = 'probe/krsi.exe';
    vi.resetModules();
    await import('../../tests/setup-hermetic-env.ts');
    expect(process.env.KRSI_BIN_PATH).toBe('probe/krsi.exe');
    if (before === undefined) delete process.env.KRSI_BIN_PATH;
    else process.env.KRSI_BIN_PATH = before;
  });

  it('vitest.config.ts 必须把隔离件挂进 setupFiles（只建文件不接线等于没做）', () => {
    const src = readFileSync(fileURLToPath(new URL('../../vitest.config.ts', import.meta.url)), 'utf8');
    expect(/setupFiles:\s*\[[^\]]*setup-hermetic-env/.test(src)).toBe(true);
  });

  it('隔离件不得改写 .env 文件本身（author-model-resolution 的 skipIf 读的是文件）', () => {
    const src = readFileSync(fileURLToPath(new URL('../../tests/setup-hermetic-env.ts', import.meta.url)), 'utf8');
    expect(/writeFileSync|rmSync|unlink/.test(src)).toBe(false);
  });
});

describe('真实污染环境下必须全绿（源码扫描证明不了隔离生效）', () => {
  it('污染确实注入了子进程（否则下一条是空断言）', () => {
    const r = spawnWithPollution(['--version']);
    expect(r.status).toBe(0);
    const probe = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.env.LLM_SERVER_API_KEY))'],
      { encoding: 'utf8', env: { ...process.env, ...POLLUTION } },
    );
    expect(probe.stdout).toBe(POLLUTION.LLM_SERVER_API_KEY);
  });

  it(
    '带着派单那套 env 跑五个环境敏感文件，不得出现失败用例',
    () => {
      const r = spawnWithPollution(['vitest', 'run', ...ENV_SENSITIVE, '--reporter=dot']);
      const out = stripAnsi(`${r.stdout ?? ''}${r.stderr ?? ''}`);
      const failed = Number(/Tests\s+(?:.*?)(\d+)\s+failed/.exec(out)?.[1] ?? 0);
      expect(out.length > 0).toBe(true);
      expect(failed > 0).toBe(false);
      expect(r.status).toBe(0);
    },
    300_000,
  );
});
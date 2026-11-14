/**
 * 让判据跑在确定的环境里，而不是继承宿主 shell 的配置。
 *
 * 为什么需要它：派单循环 loadEnvFile(server/.env) 之后把整个 process.env 传给围栏，
 * 围栏的全量回归子进程于是带着 LLM_SERVER_API_KEY / TRIAL_MODE_ENABLED /
 * SKILL_LIBRARY_ENABLED / CHECKPOINT_ENABLED / SANDBOX_ROOT 一起跑。
 * 一批用例断言的是「默认关闭」态，于是**只在派单里红、人工直跑全绿** ——
 * 围栏据此反复判「可复现真回归」，把环境污染记成 Agent 踩坏了既有行为。
 * 实测（2026-11-14）：同一份代码，干净 env 下 8 passed；process.loadEnvFile('.env')
 * 之后同样三个文件 4 failed，失败项与派单里落盘的 full-regression-*.txt 逐条对上。
 *
 * 必须在任何测试模块 import 之前生效：src/config/env.ts 的 config 是模块级单例
 * （buildConfig(process.env) 只求值一次），在 beforeEach 里改 env 已经太晚。
 *
 * 不碰 KRSI_BIN_PATH（krsi 用例要它定位二进制），也不碰 .env 文件本身 ——
 * author-model-resolution 的 skipIf 读的是文件是否存在，不受这里影响。
 */
const AMBIENT_CONFIG_KEYS = [
  'LLM_SERVER_API_KEY',
  'TRIAL_MODE_ENABLED',
  'TRIAL_BASE_URL',
  'TRIAL_MODEL',
  'TRIAL_DAILY_LIMIT',
  'SKILL_LIBRARY_ENABLED',
  'CHECKPOINT_ENABLED',
  'SANDBOX_ROOT',
  'RSI_API_KEY',
  'RSI_BASE_URL',
  'RSI_MODEL',
  'RSI_AUTHOR_MODEL',
  'CHAT_MODEL',
  'AGENT_TOKEN_BUDGET_FACTOR',
  'AGENT_MAX_ITERATIONS',
  'AGENT_MAX_TOOL_CALLS',
  'AGENT_TASK_BUDGET_MS',
  'AGENT_CONVERGENCE_ROUNDS',
];

for (const key of AMBIENT_CONFIG_KEYS) delete process.env[key];

export {};
/**
 * 统一模型解析模块 —— 单一真源
 *
 * 为什么要单一真源：
 * - 之前 propose-gaps.ts、self-upgrade-loop.ts、author-task.ts 各自硬编码默认模型与前缀逻辑
 * - 接入/更换模型时需改多处，且裸名 'nemotron-3-ultra-550b-a55b' 会 404
 * - 集中到此模块后，所有脚本只需 import { resolveModel, withVendorPrefix } from './lib/resolve-model.js'
 */

// 已知 NVIDIA 裸名白名单：仅对这些补 'nvidia/' 前缀
const NVIDIA_BARE_MODELS = new Set([
  'nemotron-3-ultra-550b-a55b',
  'nemotron-3-super-120b-a12b',
  'nemotron-3.5-super-vl-120b-a12b',
]);

/**
 * 仅对「已知 NVIDIA 裸名白名单」补 'nvidia/' 前缀；
 * 已含 '/'、gpt-4o、env-model、file-model、'平衡' 等一律原样返回。
 */
export function withVendorPrefix(model: string): string {
  if (!model) return model;
  if (model.includes('/')) return model;           // 已有厂商前缀
  if (NVIDIA_BARE_MODELS.has(model)) return `nvidia/${model}`;
  return model;                                    // gpt-4o、env-model、file-model、'平衡' 等
}

/**
 * 解析最终模型名（含前缀补全）。
 * 优先级：RSI_MODEL(进程 env) > RSI_MODEL(.env) > TRIAL_MODEL(.env) > 带前缀默认值
 *
 * @param env  进程环境变量（可选，默认 process.env）
 * @param envTxt  .env 文件原文（可选，用于读取文件层面的 RSI_MODEL / TRIAL_MODEL）
 */
export function resolveModel(
  env: NodeJS.ProcessEnv = process.env,
  envTxt: string = ''
): string {
  // 1. 进程环境变量 RSI_MODEL
  if (env.RSI_MODEL) return withVendorPrefix(env.RSI_MODEL.trim());

  // 2. .env 文件里的 RSI_MODEL
  const rsiFromFile = extractEnvValue(envTxt, 'RSI_MODEL');
  if (rsiFromFile) return withVendorPrefix(rsiFromFile.trim());

  // 3. .env 文件里的 TRIAL_MODEL（author-task.ts 兼容）
  const trialFromFile = extractEnvValue(envTxt, 'TRIAL_MODEL');
  if (trialFromFile) return withVendorPrefix(trialFromFile.trim());

  // 4. 带前缀的默认值（避免裸名 404）
  return 'nvidia/nemotron-3-ultra-550b-a55b';
}

/** 从 .env 文本中提取 key=value（忽略注释、空行、export 前缀） */
function extractEnvValue(text: string, key: string): string | null {
  if (!text) return null;
  const lines = text.split('\n');
  const prefix = `${key}=`;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const clean = trimmed.replace(/^export\s+/, '');
    if (clean.startsWith(prefix)) {
      return clean.slice(prefix.length).trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}
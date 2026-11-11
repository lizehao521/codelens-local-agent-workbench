/**
 * test.run 的判据夹具。
 *
 * ── 为什么是这样写的 ──────────────────────────────────────
 * 它必须能被 `vitest run` 正常收集（否则 `test.run` 根本跑不动它），
 * 但它**绝不能**让全量回归变红或变慢 —— 否则判据本身就成了新的回归源。
 *
 * 所以四条用例默认全部通过、零延迟；只有当同目录下出现特定的 marker 文件时，
 * 才表现出「失败 / 慢 / 环境变量泄漏」这三种目标行为。marker 由判据（父进程）
 * 在调用 `test.run` 前写入、调用后删除，全量回归时不存在。
 *
 * 这样判据锁的是「工具能不能把一条真实的断言失败读回来」，
 * 而不是「工具是不是用了某个特定的 reporter 参数」——后者是实现细节。
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const has = (name: string): boolean => existsSync(join(HERE, name));

it('probe A 恒通过', () => {
  expect(1).toBe(1);
});

it('probe B 断言差异', () => {
  // 只有判据放了 .mode-fail 才失败，且失败文案固定，便于判据断言「消息被原样读回」。
  if (has('.mode-fail')) {
    expect(1).toBe(2);
  }
  expect(1).toBe(1);
});

it('probe C 慢用例', async () => {
  // 用于超时熔断：没有 marker 时立即返回，不拖慢全量回归。
  if (has('.mode-slow')) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  expect(1).toBe(1);
});

it('probe D 环境隔离', () => {
  // 用于证明子进程没有继承密钥与代理配置：父进程会先注入一个 canary。
  if (!has('.mode-env')) return;
  expect(process.env.LLM_SERVER_API_KEY).toBeUndefined();
  expect(process.env.RSI_API_KEY).toBeUndefined();
  expect(process.env.HTTP_PROXY).toBeUndefined();
  expect(process.env.HTTPS_PROXY).toBeUndefined();
  expect(process.env.AGENT_APPROVAL_SECRET).toBeUndefined();
});

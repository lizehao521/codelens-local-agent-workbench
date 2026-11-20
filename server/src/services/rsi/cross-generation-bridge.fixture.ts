/**
 * cross-generation-bridge 测试共用夹具。
 * 从 cross-generation-bridge.test.ts 拆出（结构棘轮 ≤300 行）。
 */
import type { RsiBridgeResult } from './rsi-bridge.service.js';

export function makeResult(overrides: Partial<RsiBridgeResult> & { state: RsiBridgeResult['state'] }): RsiBridgeResult {
  return {
    exitCode: 0,
    reasons: ['fixture'],
    metrics: [
      { metric: 'quality', before: 1, after: 2, better: true },
      { metric: 'latency', before: 10, after: 9, better: true },
    ],
    reportRaw: '{"fixture":true}',
    ledgerPath: '/tmp/ledger-fixture.jsonl',
    ...overrides,
  };
}

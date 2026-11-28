import { describe, expect, it } from 'vitest';
import {
  accumulate,
  createToolCallAccumulator,
  finalize,
  type RawToolCallDelta,
} from '../src/providers/tool-call-normalizer.js';
import { computeRateWait } from '../src/providers/rate-limit.js';

function drive(frames: Array<RawToolCallDelta[] | RawToolCallDelta>) {
  const acc = createToolCallAccumulator();
  for (const frame of frames) {
    accumulate(acc, Array.isArray(frame) ? frame : [frame]);
  }
  return finalize(acc);
}

describe('A-2.2 Provider 适配层判据', () => {
  // ===== 采纳缺陷的红基线 =====

  it('A22-N-1: 多个不同 id 的调用即使都不带 index 也应分离，不得折叠串台', () => {
    const calls = drive([
      { id: 'call_A', type: 'function', function: { name: 'alpha', arguments: '{"x":1}' } },
      { id: 'call_B', type: 'function', function: { name: 'beta', arguments: '{"y":2}' } },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.id)).toEqual(['call_A', 'call_B']);
    expect(calls.map((c) => c.name)).toEqual(['alpha', 'beta']);
    expect(calls[0].arguments).toEqual({ x: 1 });
    expect(calls[1].arguments).toEqual({ y: 2 });
  });

  it('A22-N-3: 同一调用先发字符串参数后发对象帧，对象帧不得丢弃已有参数', () => {
    const calls = drive([
      [{ index: 0, id: 'c', function: { name: 't', arguments: '{"fromFragment":1}' } }],
      [{ index: 0, function: { arguments: { fromObject: 2 } as unknown as string } }],
    ]);
    expect(calls[0].arguments.fromFragment).toBe(1);
    expect(calls[0].arguments.fromObject).toBe(2);
    expect(calls[0].parseError).toBeUndefined();
  });

  it('A22-N-4: 缺 id + 非法 JSON 时 parseError 应保留 MISSING_ID（id 优先报告，不得被 INVALID_JSON 覆盖）', () => {
    const calls = drive([{ index: 0, function: { name: 't', arguments: '{bad' } }]);
    expect(calls[0].parseError).toBe('MISSING_ID');
  });

  it('A22-R-3: 时钟回拨（未来时间戳）时 computeRateWait 不得返回超过窗口上限的等待', () => {
    const now = 100000;
    const wait = computeRateWait([now + 5000], now, 1, 60000);
    expect(wait).toBeLessThanOrEqual(60000 + 100);
  });

  // ===== 回归保护（必须保持绿，防 A 修 N-1 搞坏既有场景）=====

  it('回归 T4: 单调用无 index 仍折叠进 slot 0', () => {
    const calls = drive([{ id: 'only', function: { name: 'json_format', arguments: '{"text":"1"}' } }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].index).toBe(0);
    expect(calls[0].name).toBe('json_format');
  });

  it('回归 T1: 多帧片段按 index 合并为完整调用', () => {
    const calls = drive([
      [{ index: 0, id: 'call_1', function: { name: 'http_request', arguments: '{"url":' } }],
      [{ index: 0, function: { arguments: '"https://a.com"}' } }],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toEqual({ url: 'https://a.com' });
  });

  it('回归 T2: 并行调用按 index 分离且按序输出', () => {
    const calls = drive([
      [
        { index: 0, id: 'c0', function: { name: 'fs_read', arguments: '{"path":"a"}' } },
        { index: 1, id: 'c1', function: { name: 'calc_evaluate', arguments: '{"expression":"1+1"}' } },
      ],
    ]);
    expect(calls.map((c) => c.index)).toEqual([0, 1]);
    expect(calls.map((c) => c.name)).toEqual(['fs_read', 'calc_evaluate']);
  });

  it('回归 T8: 非标准提供商纯对象 arguments 原样采用', () => {
    const calls = drive([{ index: 0, id: 'c', function: { name: 'fs_read', arguments: { path: 'x' } as unknown as string } }]);
    expect(calls[0].arguments).toEqual({ path: 'x' });
    expect(calls[0].parseError).toBeUndefined();
  });
});

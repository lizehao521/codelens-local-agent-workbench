// tool-call-normalizer 单测（架构 7.2.2 / T1-T10）
// 覆盖旧 adapter 三大缺陷的修复面：片段合并、id/name/index 不丢、空参数合法、错误标记

import { describe, expect, it } from 'vitest';
import {
  accumulate,
  createToolCallAccumulator,
  finalize,
  type RawToolCallDelta,
} from '../src/providers/tool-call-normalizer.js';

/** 驱动accumulator：每元素可是一帧（delta 数组）或单个 delta */
function drive(frames: Array<RawToolCallDelta[] | RawToolCallDelta>): ReturnType<typeof finalize> {
  const acc = createToolCallAccumulator();
  for (const frame of frames) {
    accumulate(acc, Array.isArray(frame) ? frame : [frame]);
  }
  return finalize(acc);
}

describe('tool-call-normalizer', () => {
  it('T1 多帧片段按 index 合并为完整调用', () => {
    const calls = drive([
      [{ index: 0, id: 'call_1', function: { name: 'http_request', arguments: '{"url":' } }],
      [{ index: 0, function: { arguments: '"https://a.com"}' } }],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('call_1');
    expect(calls[0].name).toBe('http_request');
    expect(calls[0].arguments).toEqual({ url: 'https://a.com' });
    expect(calls[0].parseError).toBeUndefined();
  });

  it('T2 并行调用按 index 分离且按序输出', () => {
    const calls = drive([
      [
        { index: 0, id: 'c0', function: { name: 'fs_read', arguments: '{"path":"a"}' } },
        { index: 1, id: 'c1', function: { name: 'calc_evaluate', arguments: '{"expression":"1+1"}' } },
      ],
    ]);
    expect(calls.map((c) => c.index)).toEqual([0, 1]);
    expect(calls.map((c) => c.name)).toEqual(['fs_read', 'calc_evaluate']);
  });

  it('T3 后帧补发空 id/name 不覆盖首个非空值', () => {
    const calls = drive([
      [{ index: 0, id: 'call_x', function: { name: 'time_now', arguments: '{}' } }],
      [{ index: 0, id: '', function: { name: '', arguments: '' } }],
    ]);
    expect(calls[0].id).toBe('call_x');
    expect(calls[0].name).toBe('time_now');
  });

  it('T4 缺 index 的单调用提供商折叠进 slot 0', () => {
    const calls = drive([
      [{ id: 'only', function: { name: 'json_format', arguments: '{"text":"1"}' } }],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].index).toBe(0);
    expect(calls[0].name).toBe('json_format');
  });

  it('T5 空 arguments 合法（无参工具），不是错误', () => {
    const calls = drive([{ index: 0, id: 'c', function: { name: 'uuid_generate', arguments: '' } }]);
    expect(calls[0].arguments).toEqual({});
    expect(calls[0].parseError).toBeUndefined();
  });

  it('T6 完全缺失 arguments 键同样合法', () => {
    const calls = drive([{ index: 0, id: 'c', function: { name: 'time_now' } }]);
    expect(calls[0].arguments).toEqual({});
    expect(calls[0].parseError).toBeUndefined();
  });

  it('T7 arguments 非法 JSON → INVALID_JSON 标记且不抛', () => {
    const calls = drive([{ index: 0, id: 'c', function: { name: 'fs_read', arguments: '{"path":' } }]);
    expect(calls[0].parseError).toBe('INVALID_JSON');
    expect(calls[0].arguments).toEqual({});
  });

  it('T8 非标准提供商直接发 arguments 对象 → 原样采用', () => {
    const calls = drive([
      { index: 0, id: 'c', function: { name: 'fs_read', arguments: { path: 'x' } as unknown as string } },
    ]);
    expect(calls[0].arguments).toEqual({ path: 'x' });
    expect(calls[0].rawArguments).toBe('{"path":"x"}');
    expect(calls[0].parseError).toBeUndefined();
  });

  it('T9 缺 id → MISSING_ID；缺 name → MISSING_NAME（id 优先报告）', () => {
    const noId = drive([{ index: 0, function: { name: 'time_now', arguments: '{}' } }]);
    expect(noId[0].parseError).toBe('MISSING_ID');
    const noName = drive([{ index: 0, id: 'c', function: { arguments: '{}' } }]);
    expect(noName[0].parseError).toBe('MISSING_NAME');
  });

  it('T10 arguments 是数组/标量 → INVALID_JSON', () => {
    const arr = drive([{ index: 0, id: 'c', function: { name: 'x', arguments: '[1,2]' } }]);
    expect(arr[0].parseError).toBe('INVALID_JSON');
    const num = drive([{ index: 0, id: 'c', function: { name: 'x', arguments: '42' } }]);
    expect(num[0].parseError).toBe('INVALID_JSON');
  });
});

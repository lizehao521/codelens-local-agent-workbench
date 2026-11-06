// react-parser 单测（架构 7.3 三级降级）—— 纯函数解析器
// L1 标签 / L2 平衡对象 / L3 正则；全败且无工具意图 → none；有工具名参数坏 → invalid

import { describe, expect, it } from 'vitest';
import { parseReactOutput, stripConsumed } from '../src/services/agent/react-parser.js';

const OPEN = String.fromCharCode(60) + 'tool_call' + String.fromCharCode(62);
const CLOSE = String.fromCharCode(60) + '/tool_call' + String.fromCharCode(62);

function tagged(body: string): string {
  return `${OPEN}${body}${CLOSE}`;
}

describe('react-parser', () => {
  it('L1 标准标签格式', () => {
    const result = parseReactOutput(
      `我来计算一下。${tagged('{"tool":"calc_evaluate","arguments":{"expression":"1+1"}}')}`,
    );
    expect(result.kind).toBe('calls');
    if (result.kind !== 'calls') return;
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('calc_evaluate');
    expect(result.toolCalls[0].arguments).toEqual({ expression: '1+1' });
    expect(result.text).toBe('我来计算一下。');
  });

  it('L1 多个标签全部解析', () => {
    const result = parseReactOutput(
      tagged('{"tool":"a","arguments":{}}') + tagged('{"tool":"b","arguments":{"x":1}}'),
    );
    expect(result.kind).toBe('calls');
    if (result.kind !== 'calls') return;
    expect(result.toolCalls.map((c) => c.name)).toEqual(['a', 'b']);
    expect(result.toolCalls[1].arguments).toEqual({ x: 1 });
  });

  it('L1 缺 arguments 键按空对象（schema 层再裁断）', () => {
    const result = parseReactOutput(tagged('{"tool":"time_now"}'));
    expect(result.kind).toBe('calls');
    if (result.kind !== 'calls') return;
    expect(result.toolCalls[0].arguments).toEqual({});
  });

  it('L1 标签内 JSON 损坏 → invalid（TOOL_ARGS_INVALID）', () => {
    const result = parseReactOutput(tagged('{"tool":"a","arguments":{'));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.error.message).toContain('TOOL_ARGS_INVALID');
  });

  it('L1 标签缺 tool 字段但有 name 别名 → 接受（别名行为）', () => {
    const result = parseReactOutput(tagged('{"name":"a","arguments":{}}'));
    expect(result.kind).toBe('calls');
    if (result.kind !== 'calls') return;
    expect(result.toolCalls[0].name).toBe('a');
  });

  it('L1 标签 tool/name 皆缺 → invalid', () => {
    const result = parseReactOutput(tagged('{"arguments":{"x":1}}'));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.error.message).toContain('tool');
  });

  it('L2 模型漏标签：全文首个平衡对象含 tool 字段', () => {
    const result = parseReactOutput('好的，我调用：{"tool":"fs_read","arguments":{"path":"a.txt"}} 完成');
    expect(result.kind).toBe('calls');
    if (result.kind !== 'calls') return;
    expect(result.toolCalls[0].name).toBe('fs_read');
    expect(result.warnings.length).toBeGreaterThan(0); // 标注走了降级
  });

  it('L2 字符串内含花括号不算平衡对象（字符串态跟踪）', () => {
    const result = parseReactOutput('这是一段含 } 的散文，没有工具意图');
    expect(result.kind).toBe('none');
  });

  it('L3 正则降级：散文混入 + 参数截断', () => {
    const result = parseReactOutput(
      '抱歉我来调用工具 "tool": "http_request", "arguments": {"url":"https://x.com","method":"GET"}',
    );
    expect(result.kind).toBe('calls');
    if (result.kind !== 'calls') return;
    expect(result.toolCalls[0].name).toBe('http_request');
    expect(result.toolCalls[0].arguments).toEqual({ url: 'https://x.com', method: 'GET' });
  });

  it('L3 只有工具名没有 arguments → 空对象 + 警告', () => {
    const result = parseReactOutput('输出被截断 "tool": "calc_evaluate" 后面没了');
    expect(result.kind).toBe('calls');
    if (result.kind !== 'calls') return;
    expect(result.toolCalls[0].name).toBe('calc_evaluate');
    expect(result.toolCalls[0].arguments).toEqual({});
  });

  it('L3 参数花括号不闭合 → invalid', () => {
    const result = parseReactOutput('"tool": "fs_read", "arguments": {"path": "a');
    expect(result.kind).toBe('invalid');
  });

  it('三级全败且无工具意图 → none（T-1 终止走纯文本）', () => {
    expect(parseReactOutput('今天天气不错').kind).toBe('none');
    expect(parseReactOutput('').kind).toBe('none');
  });

  it('stripConsumed 移除已消费的标签块', () => {
    const text = `前奏${tagged('{"tool":"a","arguments":{}}')}尾声`;
    expect(stripConsumed(text)).toBe('前奏尾声');
  });
});

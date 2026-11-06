/**
 * T15 — token estimation & occupancy口径 (P1-3c / P2-5).
 *
 * The old estimator counted CJK at 1.5 chars/token (≈0.67 tokens per
 * character) while modern tokenizers cost ~1+ tokens per hanzi — a
 * systematic ~50% under-estimate of Chinese occupancy that under-fired the
 * 75% compaction trigger. Provider tool schemas were not counted at all,
 * even though native function calling ships them on every turn.
 */

import { describe, expect, it } from 'vitest';
import {
  estimateMessagesTokens,
  estimateTextTokens,
  latestPromptUsage,
  occupancyRatio,
} from '../src/services/agent/token-estimator.js';

describe('estimateTextTokens', () => {
  it('counts CJK at ~1 token per character (was 0.67, under-estimating ~50%)', () => {
    expect(estimateTextTokens('汉'.repeat(100))).toBe(100);
    expect(estimateTextTokens('这是一个中文测试字符串'.repeat(10))).toBe(110);
  });

  it('counts latin at ~4 chars per token', () => {
    expect(estimateTextTokens('a'.repeat(400))).toBe(100);
    expect(estimateTextTokens('')).toBe(0);
  });

  it('mixes scripts by their own ratios', () => {
    // 40 latin chars → 10 tokens; 20 hanzi → 20 tokens.
    expect(estimateTextTokens('a'.repeat(40) + '中'.repeat(20))).toBe(30);
  });

  it('counts Hangul and fullwidth forms as CJK', () => {
    expect(estimateTextTokens('한'.repeat(50))).toBe(50);
    expect(estimateTextTokens('，'.repeat(30))).toBe(30);
  });
});

describe('estimateMessagesTokens', () => {
  const messages = [{ role: 'user', content: '你好世界' }];

  it('adds per-message framing overhead', () => {
    expect(estimateMessagesTokens(messages)).toBe(4 + 4);
  });

  it('counts assistant tool_calls payloads', () => {
    const withCalls = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a"}' } }],
      },
    ];
    expect(estimateMessagesTokens(withCalls)).toBeGreaterThan(4);
  });

  it('counts provider tool schemas (native requests ship them every turn)', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'fs_read',
          description: '读取沙箱内的文件内容',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: '相对路径' }, keyword: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ];
    const without = estimateMessagesTokens(messages);
    const withTools = estimateMessagesTokens(messages, tools);
    expect(withTools).toBeGreaterThan(without);
    expect(withTools - without).toBe(estimateTextTokens(JSON.stringify(tools)));
  });

  it('treats undefined tools as absent', () => {
    expect(estimateMessagesTokens(messages, undefined)).toBe(estimateMessagesTokens(messages));
  });

  it('AUDIT-027：ReAct 目录文本按原样计入（不再 JSON 二次包裹）', () => {
    const catalogue = '- fs_read（读取文件）：读取沙箱内的文件内容\n  参数：\n    - path（必填）：相对路径';
    const without = estimateMessagesTokens(messages);
    const withCatalogue = estimateMessagesTokens(messages, catalogue);
    expect(withCatalogue).toBeGreaterThan(without);
    expect(withCatalogue - without).toBe(estimateTextTokens(catalogue));
  });
});

describe('occupancyRatio', () => {
  it('computes the ratio, clamps to [0, 2], and guards non-positive windows', () => {
    expect(occupancyRatio(100, 200)).toBe(0.5);
    expect(occupancyRatio(500, 200)).toBe(2);
    expect(occupancyRatio(10, 0)).toBe(0);
    expect(occupancyRatio(0, 1000)).toBe(0);
  });
});

describe('latestPromptUsage (P2-5 calibration floor)', () => {
  const usage = (promptTokens: number, completionTokens = 10): { usage_json: string | null } => ({
    usage_json: JSON.stringify({ promptTokens, completionTokens }),
  });

  it('returns the NEWEST billed prompt, not the largest', () => {
    const rows = [usage(5_000), usage(30_000), usage(7_000)];
    expect(latestPromptUsage(rows)).toBe(7_000);
  });

  it('skips rows without usage and malformed usage JSON', () => {
    const rows = [{ usage_json: null }, { usage_json: '{oops' }, usage(0), usage(2_500)];
    expect(latestPromptUsage(rows)).toBe(2_500);
  });

  it('ignores non-positive / non-numeric promptTokens', () => {
    expect(latestPromptUsage([{ usage_json: '{"promptTokens":0}' }])).toBe(0);
    expect(latestPromptUsage([{ usage_json: '{"promptTokens":"5000"}' }])).toBe(0);
    expect(latestPromptUsage([])).toBe(0);
  });
});

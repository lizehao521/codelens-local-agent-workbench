/** test.math — batch arithmetic via calc.evaluate (no eval). */

import type { ToolDefinition } from '../../types/tool.js';
import { evaluateExpression, toBaseString } from './expression-parser.js';

export const testMathTool: ToolDefinition = {
  name: 'test.math',
  wireName: 'test_math',
  displayName: '批量数学计算',
  category: 'compute',
  description:
    '批量计算多个数学表达式并汇总结果。支持 + - * / % ^、括号、负号，以及 sqrt/abs/round/floor/ceil/min/max/pow/log/ln/log2/log10/exp/sin/cos/tan/asin/acos/atan/hypot 等函数与常量 pi/e/tau。base 指定字面量的进制（2-36，默认 10），结果同时给出十进制与该进制表示。',
  inputSchema: {
    type: 'object',
    properties: {
      expressions: {
        type: 'array',
        description: '数学表达式数组，如 ["(1234.5*87)/13", "sqrt(2)"]',
        items: { type: 'string', maxLength: 512 },
        minItems: 1,
        maxItems: 50,
      },
      base: { type: 'number', description: '字面量进制 2-36，默认 10', minimum: 2, maximum: 36 },
    },
    required: ['expressions'],
    additionalProperties: false,
  },
  timeoutMs: 10000,
  risk: 'low',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: true,
  maxResultChars: 8000,
  enabled: () => true,
  handler: async (args) => {
    const expressions = Array.isArray(args.expressions) ? args.expressions : [];
    if (expressions.length === 0 || expressions.length > 50) {
      return {
        ok: false,
        summary: '表达式数组长度必须在 1-50 之间',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: '表达式数组长度必须在 1-50 之间' },
      };
    }
    const base = args.base === undefined ? 10 : Number(args.base);
    const results = [];
    let successCount = 0;
    let failCount = 0;
    for (const expr of expressions) {
      const expression = String(expr ?? '');
      if (expression.length === 0 || expression.length > 512) {
        results.push({
          expression,
          ok: false,
          error: '表达式长度必须在 1-512 字符之间',
        });
        failCount++;
        continue;
      }
      const result = evaluateExpression(expression, base);
      if (!result.ok) {
        results.push({
          expression,
          ok: false,
          error: result.message,
        });
        failCount++;
        continue;
      }
      const baseView = toBaseString(result.value, base);
      const summary =
        base === 10 || baseView === null
          ? `${expression} = ${result.value}`
          : `${expression} = ${result.value}（${base} 进制：${baseView}）`;
      results.push({
        expression,
        ok: true,
        decimal: result.value,
        baseView,
        summary,
      });
      successCount++;
    }
    const summary = `批量计算完成：成功 ${successCount} 个，失败 ${failCount} 个`;
    return {
      ok: true,
      summary,
      data: { base, results, successCount, failCount },
    };
  },
};
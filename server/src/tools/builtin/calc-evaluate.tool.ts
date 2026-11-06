/** calc.evaluate — safe arithmetic via the recursive-descent evaluator (no eval). */

import type { ToolDefinition } from '../../types/tool.js';
import { evaluateExpression, toBaseString } from './expression-parser.js';

export const calcEvaluateTool: ToolDefinition = {
  name: 'calc.evaluate',
  wireName: 'calc_evaluate',
  displayName: '数学计算',
  category: 'compute',
  description:
    '计算数学表达式。支持 + - * / % ^、括号、负号，以及 sqrt/abs/round/floor/ceil/min/max/pow/log/ln/log2/log10/exp/sin/cos/tan/asin/acos/atan/hypot 等函数与常量 pi/e/tau。base 指定字面量的进制（2-36，默认 10），结果同时给出十进制与该进制表示。',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '数学表达式，如 "(1234.5*87)/13"', maxLength: 512 },
      base: { type: 'number', description: '字面量进制 2-36，默认 10', minimum: 2, maximum: 36 },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  timeoutMs: 5000,
  risk: 'low',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: true,
  maxResultChars: 4000,
  enabled: () => true,
  handler: async (args) => {
    const expression = String(args.expression ?? '');
    if (expression.length === 0 || expression.length > 512) {
      return {
        ok: false,
        summary: '表达式长度必须在 1-512 字符之间',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: '表达式长度必须在 1-512 字符之间' },
      };
    }
    const base = args.base === undefined ? 10 : Number(args.base);
    const result = evaluateExpression(expression, base);
    if (!result.ok) {
      return {
        ok: false,
        summary: `表达式无效：${result.message}`,
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: result.message, retryable: false },
      };
    }
    const baseView = toBaseString(result.value, base);
    const summary =
      base === 10 || baseView === null
        ? `${expression} = ${result.value}`
        : `${expression} = ${result.value}（${base} 进制：${baseView}）`;
    return {
      ok: true,
      summary,
      data: { expression, base, decimal: result.value, baseView },
    };
  },
};

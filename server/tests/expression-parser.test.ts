// expression-parser 单测 —— 递归下降求值器（calc.evaluate 的引擎）
// 覆盖：四则/幂右结合/函数库/任意进制/错误枚举/守卫（除零、项数、非有限）

import { describe, expect, it } from 'vitest';
import { evaluateExpression, toBaseString } from '../src/tools/builtin/expression-parser.js';

function value(expression: string, base?: number): number {
  const result = evaluateExpression(expression, base);
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${result.message}`);
  return result.value;
}

function failure(expression: string, base?: number): string {
  const result = evaluateExpression(expression, base);
  if (result.ok) throw new Error(`expected failure, got ${result.value}`);
  return result.error;
}

describe('expression-parser', () => {
  it('四则运算与优先级', () => {
    expect(value('1+2*3')).toBe(7);
    expect(value('(1+2)*3')).toBe(9);
    expect(value('10-4-3')).toBe(3); // 左结合
    expect(value('100/5/4')).toBe(5);
    expect(value('7%3')).toBe(1);
  });

  it('幂运算右结合', () => {
    expect(value('2^3^2')).toBe(512); // 2^(3^2)，非 (2^3)^2
    expect(value('2^10')).toBe(1024);
  });

  it('一元正负号', () => {
    expect(value('-5')).toBe(-5);
    expect(value('--5')).toBe(5);
    expect(value('3*-2')).toBe(-6);
    expect(value('-(2+3)')).toBe(-5);
  });

  it('函数库与常量', () => {
    expect(value('sqrt(16)')).toBe(4);
    expect(value('abs(-3.5)')).toBe(3.5);
    expect(value('min(3,1,2)')).toBe(1);
    expect(value('max(3,1,2)')).toBe(3);
    expect(value('round(2.345, 1)')).toBe(2.3);
    expect(value('floor(2.9)')).toBe(2);
    expect(value('ceil(2.1)')).toBe(3);
    expect(value('pow(2,8)')).toBe(256);
    expect(value('log(e)')).toBeCloseTo(1, 12);
    expect(value('log2(8)')).toBe(3);
    expect(value('log10(1000)')).toBe(3);
    expect(value('hypot(3,4)')).toBe(5);
    expect(value('pi')).toBeCloseTo(Math.PI, 12);
    expect(value('tau')).toBeCloseTo(Math.PI * 2, 12);
  });

  it('任意进制字面量与小数', () => {
    expect(value('1010', 2)).toBe(10);
    expect(value('ff', 16)).toBe(255);
    expect(value('z', 36)).toBe(35);
    expect(value('10.1', 2)).toBe(2.5);
  });

  it('错误枚举', () => {
    expect(failure('')).toBe('EMPTY_EXPRESSION');
    expect(failure('1+')).toBe('UNEXPECTED_END');
    expect(failure('1@2')).toBe('UNEXPECTED_CHAR');
    expect(failure('foo(1)')).toBe('UNKNOWN_FUNCTION');
    expect(failure('sqrt(1,2)')).toBe('UNKNOWN_FUNCTION'); // 参数个数不符
    expect(failure('1/0')).toBe('DIVISION_BY_ZERO');
    expect(failure('1%0')).toBe('DIVISION_BY_ZERO');
    expect(failure('2^999999')).toBe('RESULT_NOT_FINITE');
    expect(failure('1+1', 1)).toBe('INVALID_NUMBER'); // 进制下限
    expect(failure('1+1', 37)).toBe('INVALID_NUMBER'); // 进制上限
    expect(failure('0x', 10)).toBe('INVALID_NUMBER');
  });

  it('守卫：表达式项数上限', () => {
    expect(failure('1+'.repeat(6000) + '1')).toBe('TOO_MANY_TERMS');
  });

  it('toBaseString 展示转换', () => {
    expect(toBaseString(255, 16)).toBe('ff');
    expect(toBaseString(10, 2)).toBe('1010');
    expect(toBaseString(-7, 2)).toBe('-111');
    expect(toBaseString(3.5, 2)).toBeNull();
    expect(toBaseString(8, 1)).toBeNull();
  });

  it('空白容忍', () => {
    expect(value('  1  +   2  ')).toBe(3);
    expect(value('sqrt ( 16 )')).toBe(4);
  });
});

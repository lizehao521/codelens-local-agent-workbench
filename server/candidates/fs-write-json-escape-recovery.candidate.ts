import { describe, expect, it } from 'vitest';
import { repairJson } from '../src/utils/json-repair.js';

describe('json-repair: 自动恢复常见 JSON 转义/格式错误', () => {
  describe('可恢复的无歧义错误', () => {
    it('单引号字符串 -> 双引号', () => {
      const input = "{'key': 'value'}";
      const result = repairJson(input);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ key: 'value' });
      expect(result.repaired).toBe(true);
    });

    it('尾随逗号', () => {
      const input = '{"a": 1,}';
      const result = repairJson(input);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ a: 1 });
      expect(result.repaired).toBe(true);
    });

    it('缺少闭合大括号', () => {
      const input = '{"a": 1';
      const result = repairJson(input);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ a: 1 });
      expect(result.repaired).toBe(true);
    });

    it('缺少闭合方括号', () => {
      const input = '[1, 2';
      const result = repairJson(input);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual([1, 2]);
      expect(result.repaired).toBe(true);
    });

    it('字符串中未转义的换行符', () => {
      const input = '{"text": "line1\nline2"}';
      const result = repairJson(input);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ text: 'line1\nline2' });
      expect(result.repaired).toBe(true);
    });

    it('字符串中未转义的引号', () => {
      const input = '{"text": "he said \"hello\""}';
      const result = repairJson(input);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ text: 'he said "hello"' });
      expect(result.repaired).toBe(true);
    });

    it('混合多种可恢复错误', () => {
      const input = "{'a': 1, 'b': 'text\nwith\"quotes',}";
      const result = repairJson(input);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ a: 1, b: 'text\nwith"quotes' });
      expect(result.repaired).toBe(true);
    });
  });

  describe('不可恢复/有歧义的错误 - 必须拒绝自动修复', () => {
    it('缺少键名', () => {
      const input = '{: "value"}';
      const result = repairJson(input);
      expect(result.ok).toBe(false);
      expect(result.repaired).toBe(false);
    });

    it('缺少冒号分隔符', () => {
      const input = '{"key" "value"}';
      const result = repairJson(input);
      expect(result.ok).toBe(false);
      expect(result.repaired).toBe(false);
    });

    it('多余的闭合括号', () => {
      const input = '{"a": 1}}';
      const result = repairJson(input);
      expect(result.ok).toBe(false);
      expect(result.repaired).toBe(false);
    });

    it('严重截断导致结构不确定', () => {
      const input = '{"a":';
      const result = repairJson(input);
      expect(result.ok).toBe(false);
      expect(result.repaired).toBe(false);
    });

    it('非对象/数组顶层结构', () => {
      const input = '"just a string"';
      const result = repairJson(input);
      expect(result.ok).toBe(false);
      expect(result.repaired).toBe(false);
    });
  });

  describe('已合法 JSON - 无需修复', () => {
    it('标准 JSON 直接通过', () => {
      const input = '{"a": 1, "b": "hello"}';
      const result = repairJson(input);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ a: 1, b: 'hello' });
      expect(result.repaired).toBe(false);
    });

    it('空对象', () => {
      const input = '{}';
      const result = repairJson(input);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({});
      expect(result.repaired).toBe(false);
    });

    it('空数组', () => {
      const input = '[]';
      const result = repairJson(input);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual([]);
      expect(result.repaired).toBe(false);
    });
  });

  describe('边界条件', () => {
    it('空字符串', () => {
      const input = '';
      const result = repairJson(input);
      expect(result.ok).toBe(false);
      expect(result.repaired).toBe(false);
    });

    it('仅空白字符', () => {
      const input = '   \n\t  ';
      const result = repairJson(input);
      expect(result.ok).toBe(false);
      expect(result.repaired).toBe(false);
    });

    it('null 值', () => {
      const input = 'null';
      const result = repairJson(input);
      expect(result.ok).toBe(false);
      expect(result.repaired).toBe(false);
    });
  });
});
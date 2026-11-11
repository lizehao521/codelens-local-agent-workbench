/**
 * krsi 报告「逐指标对比行」解析的回归测试。
 *
 * 为什么值得单独钉死：报告文案是字节级契约。main.go 输出全角冒号与全角括号，
 * 解析器若只认半角，不会报错、不会崩 —— 只会静默地一条都抓不到（metrics_json 恒 null），
 * 6 代 per-metric 明细全空却无人察觉。这类「沉默逻辑错误」只能靠断言守住。
 */

import { describe, expect, it } from 'vitest';
import { extractMetrics } from '../src/services/rsi/rsi-bridge.service.js';

/** 与 main.go:571-594 的真实输出逐字一致（含全角冒号、全角括号、护栏尾巴）。 */
const REAL_REPORT = [
  '两代改进对账 · krsi',
  '生产者 agent：第 1 代 → 第 2 代',
  '判据目录：声明 6 条 [R1 R2 R3 R4 R5 R6] ／ 实现 6 条 [R1 R2 R3 R4 R5 R6]',
  '读数：上一代 6 条；这一代 6 条',
  '指标：比到 2 个（目标 1 个 / 护栏 1 个），目标严格变好 1 个',
  '  · task.test_pass_rate：0.581 → 0.625（变好=true）',
  '  · tool.success_rate：0.9 → 0.9（变好=true）（护栏：不得变差）',
  '判定：improved',
  '理由：（无 —— 全部指标严格变好）',
].join('\n');

describe('extractMetrics 报告解析', () => {
  it('真实报告（全角冒号 + 护栏尾巴）必须解析出全部指标行', () => {
    expect(extractMetrics(REAL_REPORT)).toEqual([
      { metric: 'task.test_pass_rate', before: 0.581, after: 0.625, better: true },
      { metric: 'tool.success_rate', before: 0.9, after: 0.9, better: true },
    ]);
  });

  it('历史报告的半角写法同样要能解析', () => {
    expect(extractMetrics('  · tool.success_rate: 0.8 → 0.9（变好=true）')).toEqual([
      { metric: 'tool.success_rate', before: 0.8, after: 0.9, better: true },
    ]);
  });

  it('变好=false 要如实记为 false', () => {
    expect(extractMetrics('  · budget.efficiency：0.9 → 0.7（变好=false）')).toEqual([
      { metric: 'budget.efficiency', before: 0.9, after: 0.7, better: false },
    ]);
  });

  it('非指标行一律忽略，没有命中时返回 undefined', () => {
    expect(extractMetrics('判定：improved\n退出码：0（0=算数 1=不算数 2=拒收 3=核不了）')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { visibleTriggers } from '../src/lib/run-report-view';

describe('历史报告展示过滤', () => {
  it('隐藏旧预算标签，保留真实风险项', () => {
    expect(visibleTriggers(['文件改动', '成本超阈值', '预算耗尽', '预算自适应', '审批'])).toEqual([
      '文件改动',
      '审批',
    ]);
  });

  it('全部是旧预算标签时返回空列表', () => {
    expect(visibleTriggers(['成本超阈值', '预算耗尽', '预算自适应'])).toEqual([]);
  });
});

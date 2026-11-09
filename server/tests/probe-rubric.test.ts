/**
 * 探针评分表测试 —— 目标指标必须对「答对几项」敏感，而不是对篇幅敏感。
 */
import { describe, it, expect } from 'vitest';
import { scoreRubric } from '../src/services/judge/probe-rubric.js';

const GOAL = `请通读 notes/强化Agent.txt，然后逐条回答下面 5 个问题（每条一句话，序号对应）：
1) 四条铁律的编号与名称分别是什么；
2) 判据塔分哪几层，各层回答什么问题；
3) 工具生命周期的 6 个步骤分别是什么；
4) 「沉淀三问」是哪三问；
5) 饱和之后应该扩什么，不许做什么。`;

const FULL = `1) 四条铁律：C1 中心性、C2 闭环、C3 自证、C4 不外推。
2) 判据塔分 L0 规则判、L1 金丝雀、L2 语义深判、L3 红队四层。
3) 工具生命周期 6 步：触发、生成/强化、进沙箱、使用、回收、回归核心。
4) 沉淀三问：它解决了哪一类问题；这个解法能不能变成 π 的修改；下次能不能不造工具就解决。
5) 饱和之后应该扩任务空间、加新家族，不许改判据让它继续绿。`;

describe('scoreRubric', () => {
  it('不命中 trigger → applicable=false（退回通用覆盖度口径）', () => {
    const r = scoreRubric('把报告导出成 CSV 文件', '已完成。');
    expect(r.applicable).toBe(false);
    expect(r.score).toBe(0);
  });

  it('满分回答 → 1.0', () => {
    const r = scoreRubric(GOAL, FULL);
    expect(r.applicable).toBe(true);
    expect(r.hits).toBe(5);
    expect(r.score).toBe(1);
    expect(r.missing).toEqual([]);
  });

  it('答漏一项 → 0.8，并点名漏了哪一项', () => {
    const partial = FULL.replace(/4\)[^\n]*\n/, '');
    const r = scoreRubric(GOAL, partial);
    expect(r.score).toBe(0.8);
    expect(r.missing).toEqual([{ id: 4, label: '沉淀三问' }]);
  });

  it('浅答（只复述题面）→ 低分，说明指标能区分"读过"和"没读过"', () => {
    const shallow = `1) 四条铁律很重要。2) 判据塔很关键。3) 工具生命周期有 6 步。4) 沉淀三问要回答。5) 饱和后就该扩。`;
    expect(scoreRubric(GOAL, shallow).score).toBeLessThan(0.6);
  });

  it('空回答 → 0，且五项全列为漏答', () => {
    const r = scoreRubric(GOAL, '');
    expect(r.score).toBe(0);
    expect(r.missing.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('分数只取决于答对项数，与篇幅无关（同一答案重复十遍不加分）', () => {
    const padded = Array(10).fill(FULL).join('\n');
    expect(scoreRubric(GOAL, FULL).score).toBe(scoreRubric(GOAL, padded).score);
  });
});

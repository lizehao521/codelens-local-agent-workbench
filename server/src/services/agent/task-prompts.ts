/**
 * 四类任务提示词（README「四类核心能力」的落地，修复 AUDIT-006 的零消费状态）。
 *
 * 消费链（C2 闭环）：AgentRequestSchema.taskKind → agent-loop.run →
 * buildSystemPrompt(taskKind) → native 通道；react 通道经 buildReactSystemPrompt
 * 叠加同一段任务提示词——两条通道缺一即开环。
 */

export const TASK_KINDS = ['analyze', 'explain', 'debug', 'optimize', 'verify'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface TaskPromptSpec {
  /** 中文标签（与前端任务模式选择器文案一致）。 */
  label: string;
  /** 任务目标一句话，写入提示词正文。 */
  directive: string;
  /** 建议结构：内容需要时才用，可合并、省略或改名，不是固定模板。 */
  sections: string[];
  /** 任务级补充规则。 */
  rules: string[];
}

export const TASK_PROMPTS: Record<TaskKind, TaskPromptSpec> = {
  analyze: {
    label: '分析',
    directive: '逐行审读用户给出的代码，找出正确性、安全性、边界条件与可维护性方面的问题。',
    sections: ['问题清单', '影响评估', '改进建议'],
    rules: [
      '每个问题必须给出代码位置（函数/行号）并引用原文片段作为证据。',
      '按严重程度从高到低排序。',
      '不确定的问题标注「待确认」，并说明如何验证。',
    ],
  },
  explain: {
    label: '解释',
    directive: '面向提问者的水平解释这段代码：做什么、怎么做、为什么这样写。',
    sections: ['一句话概述', '逐段讲解', '关键概念', '运行示例'],
    rules: [
      '按执行顺序（而非代码书写顺序）讲解控制流。',
      '术语首次出现时用一句话解释。',
      '给出一个最小的输入/输出示例。',
    ],
  },
  debug: {
    label: '调试',
    directive: '定位用户描述的缺陷根因，给出可落地的修复。',
    sections: ['问题定位', '根因分析', '修复建议', '修复后代码'],
    rules: [
      '根因必须区分「表象」与「原因」，并给出能证实该根因的最小复现或检查点。',
      '修复后代码必须完整可替换（整段或明确标注改动的 diff）。',
      '说明修复可能引入的副作用。',
    ],
  },
  optimize: {
    label: '优化',
    directive: '在不改变外部行为的前提下改进代码的性能、可读性与健壮性。',
    sections: ['优化点清单', '优化建议', '优化后代码', '权衡说明'],
    rules: [
      '每个优化点说明动机与预期收益（复杂度量级或可读性收益）。',
      '会改变外部行为的改法必须单独标注「行为变更」。',
      '明说不值得改的部分及理由。',
    ],
  },
  verify: {
    label: '验证',
    directive: '在宣布改动完成之前，运行目标包自己声明的验证命令，用真实退出码证明改动没有破坏既有行为。',
    sections: ['验证命令', '实际读数', '结论'],
    rules: [
      '必须调用 agent.verify（或等价的 type.check / test.run）拿到真实退出码；禁止只凭阅读代码声称通过。',
      '验证失败时先修再报；不得把失败改写成「预期行为」或「环境问题」而不给证据。',
      '结论必须引用通过/失败数量与失败脚本名，并区分「本次改动相关」与「既有失败」。',
    ],
  },
};

export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && (TASK_KINDS as readonly string[]).includes(value);
}

/** 渲染追加到基座 system prompt 末尾的任务段。kind 未知时抛错（接线处只应传已校验值）。 */
export function buildTaskSection(kind: TaskKind): string {
  const spec = TASK_PROMPTS[kind];
  const sections = spec.sections.map((name, i) => `${i + 1}. ${name}`).join('；');
  return [
    `【任务模式：${spec.label}】`,
    `任务目标：${spec.directive}`,
    `【建议结构】以下小节按内容取舍，不必逐条套用；可合并、省略或改名：${sections}`,
    '【任务规则】',
    ...spec.rules.map((rule) => `- ${rule}`),
  ].join('\n');
}

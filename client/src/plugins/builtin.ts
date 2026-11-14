/** 内置 UI 插件：安装即用，作为插件宿主的示例。 */
import type { UiPlugin } from './types';

export const BUILTIN_PLUGINS: UiPlugin[] = [
  {
    id: 'dev-toolbox',
    name: '开发工具箱',
    version: '1.0.0',
    description: '把常用的开发检查动作变成一键草稿，确认后再交给 Agent 执行。',
    builtin: true,
    panels: [
      {
        id: 'checks',
        title: '提交前检查',
        description: '点击只填入输入框，不会自动发送。',
        items: [
          { label: '检查测试覆盖', prompt: '检查本次改动是否覆盖了相关测试，并列出缺口。' },
          { label: '列出未完成项', prompt: '列出当前任务未完成的部分、风险和回滚步骤。' },
          { label: '生成验证计划', prompt: '为当前改动生成一份可执行的验证计划，先列步骤再执行。' },
        ],
      },
      {
        id: 'commands',
        title: '常用指令',
        items: [
          { label: '总结目录结构', prompt: '读取当前目录结构并用短段落总结。' },
          { label: '跑测试并归因', prompt: '运行相关测试；若有失败，按环境问题或逻辑回归分类并给出修复建议。' },
        ],
      },
    ],
  },
  {
    id: 'meeting-notes',
    name: '会议纪要',
    version: '1.0.0',
    description: '把讨论整理成结论、待办和负责人，适合会后直接跟进。',
    builtin: true,
    panels: [
      {
        id: 'notes',
        title: '纪要整理',
        items: [
          { label: '整理结论', prompt: '把下面的讨论整理成结论、待办和负责人；没有负责人的待办单独标出。' },
          { label: '提取风险', prompt: '从下面的讨论中提取风险项，按影响面排序并给出缓解动作。' },
        ],
      },
    ],
  },
];

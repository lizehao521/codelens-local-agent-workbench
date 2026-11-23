/**
 * 内置策略技能（seed 数据）—— 把「过往经验里的高频失败模式」沉淀成可检索技能。
 *
 * 设计约束（与 skill-library.service.ts 的三条硬约束一致）：
 *  1. 只复用既有的 SkillCreateInput 形状，不新建匹配引擎、不新建仓储；
 *  2. 内容不含任何凭证形态（写入时仍会过密钥扫描，这里只是不主动引入）；
 *  3. 幂等：接线方用「已存在同名则跳过」的方式写入，重复启动不会重复种子。
 *
 * 这些技能描述的是「做任务时的策略提醒」，由 SkillLibraryService.match 检索命中，
 * 与 π 的 lessons（注入 system prompt）互补：lessons 是注入的、技能是被检索的。
 */

import type { SkillCreateInput } from './skill-library.service.js';

export const BUILTIN_STRATEGY_SKILLS: SkillCreateInput[] = [
  {
    name: 'converge-early',
    description: '任务容易未收敛就结束（迭代或预算耗尽、被中止）。先确认关键信息再动手，尽早收敛到结果，不要无限读码。',
    tags: ['收敛', '预算', '迭代', 'converge', 'budget'],
    steps: [
      '动手前列出本次任务必须确认的关键信息清单；',
      '每完成一步立即验证（tsc/测试/读数），有错立刻回滚该文件重来；',
      '接近预算上限时停止探索，基于已有证据收尾并明确列出未完成项。',
    ],
    matchScore: 0.9,
  },
  {
    name: 'verify-each-step',
    description: '局部改动漂亮但接线拆坏核心、不验证是高频失败模式。每改一个文件立即跑类型检查与相关测试，带着错不要往下写。',
    tags: ['验证', 'tsc', '测试', '回滚', 'verify', 'typecheck'],
    steps: [
      '每改完一个文件立刻跑 tsc --noEmit；',
      '出现任何 TS 错误立即回滚该文件，不要带着错继续改下一个文件；',
      '收尾前跑全量 type_check 与相关 vitest，贴真实退出码。',
    ],
    matchScore: 0.9,
  },
  {
    name: 'avoid-retry-storm',
    description: '同一工具/同一类失败被反复重试会触发熔断。失败后先换策略或换工具，不要重复同一个调用。',
    tags: ['熔断', '重试', '换策略', 'circuit', 'retry'],
    steps: [
      '同一调用连续失败两次即停止重试；',
      '先分析错误类型（参数错/找不到/被拒），再决定换参数、换工具还是换路径；',
      '重试前确认失败原因已被消除，而不是盲目再来一次。',
    ],
    matchScore: 0.85,
  },
  {
    name: 'respect-permission-boundary',
    description: '审批拒绝率偏高说明操作意图与权限边界不符。涉及文件写入或外部写操作时先说明意图，或改用影响范围更小的参数/工具。',
    tags: ['权限', '审批', '沙箱', '写操作', 'permission'],
    steps: [
      '写操作前确认路径在沙箱/白名单内，命令在白名单内；',
      '高危操作（覆盖/删除/清空）先向用户说明在等什么确认；',
      '被拒后改用只读替代方案（读文件、列目录、web 检索）获取所需信息。',
    ],
    matchScore: 0.85,
  },
  {
    name: 'read-enough-once',
    description: 'token 消耗接近或超过预算多因冗余读取与重复调用。一次取够所需信息，不要反复读同一文件/同一工具结果。',
    tags: ['token', '预算', '冗余读取', 'efficiency'],
    steps: [
      '读文件时一次指定 lineStart/lineEnd/keyword/maxBytes 取到所需片段；',
      '不要为了「再确认」重跑同一个只读工具；',
      '长输出先读摘要与位置，不要整段倾倒后再决定。',
    ],
    matchScore: 0.8,
  },
];

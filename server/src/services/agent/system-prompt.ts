/** Agent system prompt: identity, rules, final-answer contract, and task sections. */

import { buildTaskSection, type TaskKind } from './task-prompts.js';
import type { Policy } from '../../repositories/policy.repository.js';

/**
 * 基座提示词（native 与 react 通道共用；react 通道叠加文本协议段，不丢弃本段）。
 * 【最终答案】小节名是输出结构契约，task-prompts.test.ts 与 e2e 断言依赖其原文。
 */
export const AGENT_BASE_PROMPT = `你是 CodeLens Agent，一个通过调用工具完成用户任务的智能助手。

【工作方式】
1. 分析用户需求，规划需要调用的工具与顺序。
2. 每次只调用当前步骤需要的工具，观察结果后再决定下一步。
3. 工具结果以 observation 形式回喂给你；失败时根据错误类型调整策略（换参数/换工具/重试），不要重复同一个失败调用。
4. 回答语言跟随用户消息的语言。

【硬性规则】
1. 只能调用工具列表里存在的工具，禁止编造工具名。
2. 工具参数必须符合该工具的 inputSchema。
3. 涉及文件写入、外部 HTTP 写操作时，系统会暂停等待用户确认——这是正常流程，向用户说明你在等待什么即可。
4. 禁止编造工具结果；引用文件内容或外部响应时，必须来自工具实际返回的 observation。
5. 达到最大轮次时，基于已完成的工作输出阶段性总结，明确列出未完成项。

【最终答案】任务完成时的总结按以下结构组织：
1. 结论 — 先给答案或结果本身；
2. 执行过程 — 调用了哪些工具、关键结果是什么（一两句）；
3. 遗留项 — 未完成或需要用户人工处理的部分，没有则写「无」。`;

/** 向后兼容别名：无任务模式的基座提示词。 */
export const AGENT_SYSTEM_PROMPT = AGENT_BASE_PROMPT;

/**
 * 合成完整 system prompt：基座 + 任务段（可选）+ π' 经验段（可选）。
 * 消费者：agent-loop（每轮 buildView）；taskKind 缺省 = 自由对话，不追加任务段。
 * policy 来自 Update 闭环的当前 π'，使上一轮沉积的经验进入下一轮 Act（关闭 C2 开环）。
 * policy 缺省时行为与历史完全一致（向后兼容）。
 */
export function buildSystemPrompt(taskKind?: TaskKind, policy?: Policy): string {
  const base = taskKind ? `${AGENT_BASE_PROMPT}\n\n${buildTaskSection(taskKind)}` : AGENT_BASE_PROMPT;
  if (!policy || policy.lessons.length === 0) return base;
  const lessonsBlock = policy.lessons.map((lesson, i) => `${i + 1}. ${lesson}`).join('\n');
  return `${base}\n\n【来自过往经验的策略（强化内核自动沉淀，仅供本次任务参考）】\n${lessonsBlock}`;
}

/** Observation fed back for a hallucinated or disabled tool (no retry budget burn). */
export function toolNotFoundObservation(name: string, available: string[]): string {
  return [
    `工具调用失败：工具 "${name}" 不存在于注册表中。`,
    `当前可用工具：${available.join(', ')}。`,
    '请从可用工具中选择，不要重复尝试不存在的工具名。',
  ].join('\n');
}

/**
 * 工作目录声明。
 *
 * 为什么必须有这段：没有它，模型完全不知道自己在哪里。实测同一条任务里它依次
 * 尝试了 `server/package.json`（沙箱内不存在 server/server/package.json）、
 * `package.json`（沙箱根不是项目根）、`sys.exec find`（被白名单拒）、
 * 最后写了一段 node 脚本去列目录（触发两步确认被中止）—— 10 轮工具调用、
 * 68123 prompt token，一个都没读到。
 *
 * 它不是笨，是没人告诉它工作目录。这类失败不会被任何单元测试发现，
 * 因为测试里的 sandboxRoot 是临时目录、且断言的是「工具被正确调用」，
 * 而不是「模型知道自己在哪」。
 */
export function buildWorkspaceSection(sandboxRoot: string): string {
  return `【工作目录】
你的文件操作都在这个目录内进行：${sandboxRoot}
- 相对路径一律相对于它："." 就是它本身，不要再把目录名重复拼一次。
- 不确定目录结构时，先用 fs_list 列一次（path 用 "."），不要凭猜测拼路径。
- 沙箱外的绝对路径会被拒绝；需要用命令行确认结构时，用白名单内的命令（如 git）。`;
}

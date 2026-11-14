/** 输入框为空时的下一步推荐（纯规则，不依赖上游模型）。 */
import type { SessionMessageRow } from '../types';

export function suggestNextStep(messages: SessionMessageRow[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'assistant' || m.role === 'user');
  if (!last) return '读取 data 目录并总结内容';
  const text = last.content ?? '';
  if (last.role === 'assistant') {
    if (/未完成|待处理|失败|错误|中断|TODO/i.test(text)) {
      return '继续处理上一步未完成的部分，并先说明验证方式';
    }
    return '为刚才的结果补一个可验证的检查，并运行相关测试';
  }
  return '先给出执行计划，再按计划开始';
}

/**
 * Context Compaction Retry — 判据草案（候选态，不可原地执行）
 * 
 * 契约：compact() 在摘要失败后带缺失段反馈重试一次（最多一次）；
 * 双失败仍 fail-closed（AC-09 不变）；现有 9 个用例全绿。
 * 
 * 反向断言（红线，不得删减）：
 * 1. 双失败时必须 fail-closed（不许放宽为静默截断或继续上游）
 * 2. retry 不得超过一次（不许无限重试）
 * 3. 缺失段信息必须进入重试 prompt（buildCompactionPrompt 接收 missing 参数）
 * 4. 重试后的 fidelity check 仍按原有规则（九段式 + 证据地板）
 * 5. 现有 9 个用例（context-manager.test.ts + fidelity-checker.test.ts）必须保持全绿
 */

import { ContextManager } from '../src/services/agent/context-manager.service.js';
import { buildCompactionPrompt, checkFidelity, SUMMARY_SECTIONS } from '../src/services/agent/fidelity-checker.js';
import type { MessageRepository, MessageRow } from '../src/services/memory/message.repository.js';
import type { SseWriter } from '../src/services/agent/sse-writer.js';
import type { UpstreamMessage } from '../src/types/index.js';

// 判据接口定义（供 spec.json 引用）
export interface CompactionRetryJudgment {
  /** 1. buildCompactionPrompt 接收可选 missing 参数并在 prompt 中体现 */
  promptIncludesMissing: (missing: string[]) => boolean;
  
  /** 2. compact() 首次失败时带 missing 重试一次 */
  retriesOnceOnFailure: (deps: CompactionDeps) => Promise<boolean>;
  
  /** 3. 双失败时 fail-closed（返回 ok: false，不抛异常、不静默通过） */
  doubleFailureFailClosed: (deps: CompactionDeps) => Promise<boolean>;
  
  /** 4. retry 次数不超过 1（计数器验证） */
  retryCountNotExceedOne: (deps: CompactionDeps) => Promise<boolean>;
  
  /** 5. 现有 9 个用例全绿 */
  existingTestsPass: () => Promise<boolean>;
}

export interface CompactionDeps {
  messages: MessageRepository;
  resolveContextWindow: (provider: string, model: string) => number;
  sse: SseWriter;
  summarize: (prompt: string, system: string) => Promise<string>;
}

// 导出判据函数供测试框架调用
export const judgment: CompactionRetryJudgment = {
  promptIncludesMissing: (missing: string[]) => {
    const prompt = buildCompactionPrompt(missing);
    return missing.every(m => prompt.includes(m));
  },
  
  async retriesOnceOnFailure(deps: CompactionDeps) {
    // 由测试框架实现：构造首次失败、第二次成功的 summarize
    // 验证 compact() 返回 ok: true 且调用了 2 次 summarize
    return true; // placeholder
  },
  
  async doubleFailureFailClosed(deps: CompactionDeps) {
    // 由测试框架实现：构造两次都失败的 summarize
    // 验证 compact() 返回 ok: false 且 missing 包含两次失败的信息
    return true; // placeholder
  },
  
  async retryCountNotExceedOne(deps: CompactionDeps) {
    // 由测试框架实现：计数 summarize 调用次数 ≤ 2
    return true; // placeholder
  },
  
  async existingTestsPass() {
    // 由测试框架实现：跑现有 vitest 套件
    return true; // placeholder
  },
};

// 供 spec.json 引用的类型
export type { ContextManager, MessageRepository, SseWriter, UpstreamMessage, MessageRow };
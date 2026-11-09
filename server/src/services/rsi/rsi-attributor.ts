/**
 * RSI Attributor — krsi 判 not_improved / refused 时的 LLM 归因器。
 *
 * 设计原则：
 *   - 独立模块，不侵入 UpdateService 的 CRITERION_LESSON 规则路径
 *   - 用 OpenAICompatibleAdapter 直发请求（跟 deep-assessor 同底层）
 *   - 归因直接 INSERT INTO policy_injections（跟 applyFromJudge 同表）
 *   - 失败 catch 住返回 null，绝不拖主流程下水
 *
 * 产出：一条中文经验（1-2 句、具体、可行动），落 policy_injections 表。
 * 这条经验下一轮 run 会被 getInjectableView() 自动喂进 π。
 */

import { OpenAICompatibleAdapter } from '../../providers/openai-compatible.adapter.js';
import type { CriterionVerdict } from '../judge/types.js';
import type { RsiBridgeResult } from './rsi-bridge.service.js';

export interface AttributorDeps {
  db: {
    run(sql: string, params?: unknown): unknown;
    exec(sql: string): void;
  };
  /** session_id — 归因经验落同一会话 */
  sessionId: string;
  /** 本轮 generation — 归因锚点 */
  generation: number;
  /** 本轮 Agent verdicts（CriterionVerdict[]） */
  runVerdicts: CriterionVerdict[];
  /** krsi bridge result —— 归因的主输入 */
  rsiResult: RsiBridgeResult;
  /** LLM 凭证 */
  apiKey: string;
  baseUrl: string;
  model: string;
  provider?: string;
  /** 单次调用超时 ms。默认 180s —— 中转网关排队时归因请求实测可等 100s+ */
  timeoutMs?: number;
}

/**
 * 单次归因超时。默认 180s。
 *
 * 为什么不是 30s：中转网关在排队时，一次 512 token 的归因请求实测也会等 100s+。
 * 超时被 catch 后 outcome.wroteRow=false —— 归因看起来"跑过了"，实际一条经验都没落，
 * 闭环 r → Update 静默断开。宁可多等，也不要让归因被超时静默吞掉。
 */
const DEFAULT_TIMEOUT_MS = 180_000;

export interface AttributorOutcome {
  /** 归因经验（可能为空——LLM 返回 LESSON 内容就是这里） */
  lesson: string | null;
  /** 是否落库成功 */
  wroteRow: boolean;
  /** LLM 响应元数据（供审计） */
  model: string;
  latencyMs: number;
  tokens: { prompt: number; completion: number };
  /** 失败原因（attributor 自己 catch 后返回） */
  failure?: string;
}

export async function attributeDegradation(deps: AttributorDeps): Promise<AttributorOutcome> {
  const {
    db, sessionId, generation, runVerdicts, rsiResult,
    apiKey, baseUrl, model, provider,
  } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  const outcome: AttributorOutcome = {
    lesson: null,
    wroteRow: false,
    model,
    latencyMs: 0,
    tokens: { prompt: 0, completion: 0 },
  };

  // ── 只对 not_improved / refused 做归因 ──────────────────────────────────
  if (rsiResult.state !== 'not_improved' && rsiResult.state !== 'refused') {
    // improved / skipped / undecidable / error 都不需要归因
    outcome.latencyMs = Date.now() - startedAt;
    return outcome;
  }
  if (!apiKey || !baseUrl) {
    outcome.failure = 'not_configured';
    outcome.latencyMs = Date.now() - startedAt;
    return outcome;
  }

  // ── 构造归因 prompt ─────────────────────────────────────────────────────
  const prompt = buildAttributionPrompt({
    state: rsiResult.state,
    reasons: rsiResult.reasons,
    metrics: rsiResult.metrics,
    verdicts: runVerdicts,
    generation,
  });

  // ── 调 LLM ─────────────────────────────────────────────────────────────
  let content = '';
  let tokens = { prompt: 0, completion: 0 };
  try {
    const adapter = new OpenAICompatibleAdapter({ timeoutMs });
    const res = await adapter.chat({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2, // 归因要一点发散（找没见过的根因），但也别太飘
      // 1024 而不是 512：512 会让中文经验在句中截断（实测 "…只覆盖了顺手能写的词项、"），
      // 半句话入 π 后无法执行，等于往策略里塞噪声。
      maxTokens: 1024,
      baseUrl,
      apiKey,
      stream: false,
    });
    content = res.content ?? '';
    tokens = {
      prompt: res.usage?.promptTokens ?? 0,
      completion: res.usage?.completionTokens ?? 0,
    };
  } catch (err) {
    outcome.failure = err instanceof Error ? err.message : String(err);
    outcome.latencyMs = Date.now() - startedAt;
    outcome.tokens = tokens;
    return outcome;
  }

  // ── 从 LLM 输出里抽 LESSON ────────────────────────────────────────────
  const lesson = extractLesson(content);
  // 截断的经验不能入 π：半句话（以逗号/顿号/破折号结尾，或没有句末标点）
  // 下一轮既读不懂也不可执行，只会稀释 prompt。宁可这代不学，也不学半句。
  const complete = isCompleteLesson(lesson);
  outcome.lesson = complete ? lesson : null;
  if (!complete) outcome.failure = 'incomplete_lesson（输出被截断）';
  outcome.tokens = tokens;

  // ── 落库：policy_injections ────────────────────────────────────────────
  // columns: id, session_id, policy_version, lesson, created_at
  if (outcome.lesson) {
    try {
      db.run(
        `INSERT INTO policy_injections
           (session_id, policy_version, lesson, created_at)
         VALUES (?, ?, ?, ?)`,
        [
          sessionId,
          generation,
          outcome.lesson,
          Date.now(),
        ],
      );
      outcome.wroteRow = true;
    } catch (err) {
      outcome.failure = `db: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  outcome.latencyMs = Date.now() - startedAt;
  return outcome;
}

// ── Prompt 构造 ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是 RSI 自回归归因器。当 Agent 跨代对比后 krsi 判 not_improved 或 refused，
你要基于 krsi 的报告和 Agent 本轮 verdicts，写一段**具体、可行动**的中文经验，帮助 Agent 下一轮做得更好。

规则：
1. 只写 1-2 句，不要长段落
2. 要具体：点名哪个指标、哪个动作、什么方向
3. 可行动：下次遇到类似情况应该怎么做
4. 绝对不要加寒暄或解释，直接输出 LESSON: <内容>`;

function buildAttributionPrompt(args: {
  state: string;
  reasons: string[];
  metrics?: RsiBridgeResult['metrics'];
  verdicts: CriterionVerdict[];
  generation: number;
}): string {
  const { state, reasons, metrics, verdicts, generation } = args;
  const metricLines = (metrics ?? []).map(
    (m) => `  · ${m.metric}: ${m.before} → ${m.after}（变好=${m.better}）`,
  ).join('\n');
  const reasonStr = reasons.length > 0 ? reasons.map((r) => `  · ${r}`).join('\n') : '（无）';
  const verdictLines = verdicts
    .filter((v) => v.status !== 'unexec')
    .map((v) => `  [${v.layer}] ${v.criterion} ${v.status}${v.score !== undefined ? ` score=${v.score}` : ''}${v.detail ? ` — ${v.detail}` : ''}`)
    .join('\n');

  return `## RSI 跨代对账结果

- generation: g${generation - 1} → g${generation}
- verdict: ${state}
- krsi reasons:
${reasonStr}

${metrics && metrics.length > 0 ? `## per-metric 对比\n${metricLines}\n` : ''}
## Agent 本轮 verdicts（剔除 unexec）
${verdictLines || '  （无有效 verdict）'}

## 任务

写一段 1-2 句中文经验，具体、可行动。只输出 \`LESSON: <内容>\`，不要别的。`;
}

/**
 * 经验是否完整（有句末标点）。
 *
 * 截断判定是必须的：上游 maxTokens 触顶时输出会在句中停止，
 * 半句话写进 π 后无法执行 —— 那不是在学，是往策略里塞噪声。
 * null（没抽出东西）不算"被截断"，由调用方按"无输出"处理。
 */
export function isCompleteLesson(lesson: string | null): boolean {
  if (lesson === null) return true;
  return /[。！？!?.]$/.test(lesson.trim());
}

/** 从 LLM 输出里抽 LESSON 内容。格式容忍：LESSON: xxx / 经验：xxx / xxx（无前缀） */
export function extractLesson(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  // LESSON: xxx
  const lessonM = trimmed.match(/LESSON\s*[:：]\s*(.+)/i);
  if (lessonM) return lessonM[1]!.trim();
  // 经验：xxx
  const emM = trimmed.match(/经验\s*[:：]\s*(.+)/);
  if (emM) return emM[1]!.trim();
  // 兜底：取第一行非空非 markdown 行
  const firstLine = trimmed.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith('-'));
  return firstLine ?? null;
}

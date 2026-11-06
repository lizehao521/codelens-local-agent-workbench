/**
 * Token estimator (architecture 7.4): rough but stable estimates for the context
 * occupancy bar (AC-11) and the 75% compression trigger (AC-09). Latin text
 * averages ~4 chars/token; CJK is closer to 1 token per character.
 */

const LATIN_CHARS_PER_TOKEN = 4;
/**
 * CJK averages ~1 token per character on modern tokenizers (often more for
 * rare hanzi). The previous 1.5 chars/token under-estimated Chinese occupancy
 * by a third to a half, which systematically under-fired the 75% compaction
 * trigger (P1-3c): over-window transcripts then surfaced as an opaque upstream
 * 400 instead of a compaction. Erring high is the safe direction here.
 */
const CJK_CHARS_PER_TOKEN = 1;

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1;
    else if (code >= 0xac00 && code <= 0xd7ff) cjk += 1;
    else if (code >= 0xf900 && code <= 0xfaff) cjk += 1;
    else if (code >= 0xff00 && code <= 0xffef) cjk += 1;
  }
  const latin = text.length - cjk;
  return Math.ceil(latin / LATIN_CHARS_PER_TOKEN + cjk / CJK_CHARS_PER_TOKEN);
}

/** Estimates the prompt tokens of a message list (role + content + tool calls). */
export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string; tool_calls?: unknown }>,
  /**
   * Provider tool schemas shipped with the request (P1-3c). Native function
   * calling sends them on every turn — often thousands of tokens — so excluding
   * them under-estimated the real prompt size and the occupancy ratio.
   */
  tools?: unknown,
): number {
  let total = 0;
  for (const message of messages) {
    total += 4; // per-message framing overhead
    total += estimateTextTokens(message.content);
    if (message.tool_calls) total += estimateTextTokens(JSON.stringify(message.tool_calls));
  }
  if (tools !== undefined) {
    // native 传 schema 对象（JSON 序列化）；ReAct 传已渲染的目录文本（字符串，避免二次包裹）。
    total += typeof tools === 'string' ? estimateTextTokens(tools) : estimateTextTokens(JSON.stringify(tools));
  }
  return total;
}

/** Occupancy ratio against the context window, clamped to [0, 2]. */
export function occupancyRatio(estimatedTokens: number, contextWindow: number): number {
  if (contextWindow <= 0) return 0;
  return Math.min(2, estimatedTokens / contextWindow);
}

/**
 * P2-5: the newest actually-billed prompt size among the rows. The char
 * heuristic above is a guess; the provider's own usage counter is ground truth
 * for the turns already served. Used as a calibration FLOOR (never estimate
 * below the last real bill) — it also absorbs the tool schemas and system
 * prompt that the heuristic can misjudge. Older rows' usage is ignored: their
 * prompts were smaller, and after a compaction they describe a view that no
 * longer exists (which would only over-estimate).
 */
export function latestPromptUsage(rows: Array<{ usage_json?: string | null }>): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const raw = rows[i]?.usage_json;
    if (!raw) continue;
    try {
      const usage = JSON.parse(raw) as { promptTokens?: unknown };
      if (typeof usage.promptTokens === 'number' && usage.promptTokens > 0) return usage.promptTokens;
    } catch {
      /* malformed usage row: keep scanning */
    }
  }
  return 0;
}

/**
 * 一条 assistant 消息对上下文的体积贡献：正文 + 推理 + 工具调用。
 *
 * 三者都会随历史被每一轮重发、都要付费，只算正文会让账本严重偏低。实测
 * 一条工具调用轮正文为空（只记 0–1 token），而同一条的 `reasoning_content`
 * 有 2149 字符、`tool_calls_json` 还要带完整参数 —— 这一轮的真实体积被
 * 记成了几乎为零，`sessions.total_tokens` 于是长期虚低（C2 开环的一种：
 * 字段在记账，但记的不是它该记的东西）。
 *
 * 为什么不直接用 `usage_json`（上游账单）：那是**计费口径**（含重复计费的
 * 累计 prompt），而这里要的是**体积口径**（这条消息给上下文加了多少）。
 * 两者用途不同，都留着，不能互相冒充。
 */
export function estimateAssistantTokens(
  text: string,
  reasoning?: string | null,
  toolCallsJson?: string | null,
): number {
  return (
    estimateTextTokens(text) +
    estimateTextTokens(reasoning ?? '') +
    estimateTextTokens(toolCallsJson ?? '')
  );
}

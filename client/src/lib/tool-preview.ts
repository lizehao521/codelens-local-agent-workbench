// 工具结果预览 —— 行边界回退（60% 下限）+ 落盘判定 + 体积格式化
// 行边界回退是最容易写错的一段：单行超长 minified JSON 若强制回退到行边界会得到空串。

/** 单行超长时允许回退到行边界的最低比例（低于此比例宁可硬切在字符中间） */
export const LINE_BOUNDARY_FLOOR = 0.6;

/** 内联预览字符上限 */
export const INLINE_PREVIEW_LIMIT = 500;

/** 落盘阈值：超过 2KB 服务端写 artifact_path，前端不内联完整内容 */
export const ARTIFACT_BYTE_THRESHOLD = 2048;

/** 展开区顶部「结果较大」提示的字符阈值 */
export const LARGE_RESULT_CHARS = 10_000;

/**
 * 按行边界回退的截断：先切到 limit，再回退到最后一个换行。
 * 回退下限 60% —— 单行 3000 字符的 minified JSON 的 lastIndexOf('\n') 为 -1，
 * 若不设下限会得到空串（用户看到「什么都没有」比「被截断」更糟糕）。
 */
export function inlinePreview(text: string, limit: number = INLINE_PREVIEW_LIMIT): string {
  if (!text) return '';
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastNl = cut.lastIndexOf('\n');
  return lastNl > limit * LINE_BOUNDARY_FLOOR ? cut.slice(0, lastNl) : cut;
}

/** 是否被截断（用于决定是否渲染「… 省略 N 字符」行） */
export function isTruncated(text: string, limit: number = INLINE_PREVIEW_LIMIT): boolean {
  return text.length > limit;
}

/** 省略提示行的数字：省略了多少字符 */
export function omittedChars(text: string, preview: string): number {
  return Math.max(0, text.length - preview.length);
}

/** 结果是否应落盘（bytes > 2048） */
export function shouldPersistArtifact(bytes: number | undefined): boolean {
  return typeof bytes === 'number' && bytes > ARTIFACT_BYTE_THRESHOLD;
}

/** 字节格式化：512 B / 2.0 KB / 1.4 MB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 粗略估算 token 数（字符 / 4，仅用于「结果较大」提示，不做计费） */
export function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** 结果形态判定：JSON 走 JsonBlock，其余走纯文本 pre（不智能折行） */
export function detectResultKind(text: string): 'json' | 'text' {
  const head = text.trimStart();
  if (!head) return 'text';
  return head.startsWith('{') || head.startsWith('[') ? 'json' : 'text';
}

// Base URL 归一化 —— 与服务端 registry.normalizeBaseUrl 保持一致（同源判定/拼接前清理必须同规则）
// 背景：用户常把完整 endpoint 当 Base URL 填（.../v1/chat/completions），adapter 会再拼一次导致路径翻倍。

const ENDPOINT_SUFFIX_RE = /\/+(?:chat\/completions|completions|responses|messages|embeddings|models)\/?$/i;

/** 去尾斜杠 + 循环剥离误填的 endpoint 后缀；空串返回空串。 */
export function normalizeBaseUrl(raw: string | undefined | null): string {
  if (!raw) return '';
  let url = raw.trim().replace(/\/+$/, '');
  if (!url) return '';
  for (let i = 0; i < 3; i += 1) {
    const next = url.replace(ENDPOINT_SUFFIX_RE, '').replace(/\/+$/, '');
    if (next === url) break;
    url = next;
  }
  return url;
}

/** 两个 Base URL 是否指向同一上游（忽略大小写与尾斜杠/endpoint 差异）。 */
export function isSameUpstream(a: string | undefined | null, b: string | undefined | null): boolean {
  const x = normalizeBaseUrl(a);
  const y = normalizeBaseUrl(b);
  if (!x || !y) return false;
  return x.toLowerCase() === y.toLowerCase();
}

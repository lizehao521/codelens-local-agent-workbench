/**
 * 历史锚链的「版本标记」迁移（纯函数，可离线跑、可单测）。
 *
 * 背景：v1 时代的 anchor 行没有 `hash_version`。校验侧把「缺失」解释为 v1，
 * 所以**不迁移也能验**；这个迁移只做一件事——给缺省行补一个显式的
 * `hash_version: 1`，让账本自身写清口径，而不是靠约定。
 *
 * 三条硬约束：
 *  1. 幂等：已有 `hash_version` 的行（1 或 2）一个字节都不动，重复跑 stamped=0；
 *  2. 不静默重写：函数只返回新文本，是否落盘由调用方显式 `--apply` 决定；
 *  3. 只标记版本，不重算 anchor_hash —— v1 的原像不包含 hash_version，
 *     补标记不会改变任何一行的可验性。
 */

export interface MigrateReport {
  /** anchor 行总数。 */
  anchors: number;
  /** 本次补写 `hash_version: 1` 的行数。 */
  stamped: number;
  /** 已经带 `hash_version` 的行数（不动）。 */
  alreadyVersioned: number;
  /** 非 anchor 行（krsi 的 metric 行等，原样保留）。 */
  nonAnchor: number;
  /** 无法解析的 JSON 行（原样保留，不猜测）。 */
  invalid: number;
  /** 迁移后的全文。未发生迁移时与输入逐字节一致。 */
  content: string;
}

/** 给缺 `hash_version` 的 anchor 行补显式 v1 标记；幂等。 */
export function stampMissingHashVersion(text: string): MigrateReport {
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  // 末尾换行会制造一个空串元素；保留它以便原样拼回
  if (endsWithNewline) lines.pop();

  let anchors = 0;
  let stamped = 0;
  let alreadyVersioned = 0;
  let nonAnchor = 0;
  let invalid = 0;

  const out = lines.map((raw) => {
    const line = raw.trim();
    if (!line) return raw;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid += 1;
      return raw;
    }
    if (parsed?.type !== 'anchor') {
      nonAnchor += 1;
      return raw;
    }
    anchors += 1;
    if (typeof parsed.hash_version === 'number') {
      alreadyVersioned += 1;
      return raw;
    }
    stamped += 1;
    return JSON.stringify({ ...parsed, hash_version: 1 });
  });

  const content = out.join('\n') + (endsWithNewline ? '\n' : '');
  return { anchors, stamped, alreadyVersioned, nonAnchor, invalid, content };
}

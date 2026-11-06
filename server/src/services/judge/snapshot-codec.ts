/**
 * 判决快照的存储编码（判据塔 v2）。
 *
 * 为什么需要：`context_json` 里塞的是**全量证据 + 语义原文**（一次最坏约 50KB）。
 * 千会话 × 百任务就是 GB 级 —— judge_runs 会变成第二个 tool_calls 表。
 * 语义原文又不能砍：一砍长回答任务的 L2 就永远 unexec，等于废掉语义层。
 * 所以压缩存储，而不是裁掉证据。
 *
 * 编码契约：
 *  - 写入：能压得动就存 `gz:` + base64(gzip(JSON))；**压不动就存明文**（自适应）；
 *  - 读取：有 `gz:` 前缀走解压，**没有前缀按明文 JSON 读**（旧行必须继续可读）；
 *  - 解析失败返回 null，绝不抛 —— 一条坏行不该让整个历史列表 500。
 *
 * 压缩率的真实预期（实测，同一算法不同数据）：
 *  - 典型 Agent 轨迹（工具状态/名称/阈值高度重复）：约 0.59 及以下；
 *  - 自然语言中文（有词语与句式冗余）：约 0.10–0.35；
 *  - **对抗性输入没有收益**：均匀随机汉字 gzip 0.72–0.78，再经 base64（+33%）
 *    后是原文的 0.96–1.04×（样本相关，会跨过 1）；随机 base64 高熵文本
 *    （JWT/二进制转储形态）实测 gzip 0.758、base64 后 **1.010×**，比不压还大。
 *    因此编码必须自适应：压不小就存原文，绝不为了"看起来压缩了"把行撑大。
 */

import { gzipSync, gunzipSync } from 'node:zlib';

/** 压缩前缀。改动它就等于让所有历史行失效，不要动。 */
export const GZ_PREFIX = 'gz:';

/**
 * 序列化 + 自适应压缩。
 *
 * 比较的是 **UTF-8 字节数**（库里的存储单位）而不是 JS 字符串长度：
 * 中文在 UTF-16 里算 1 个 char、在库里占 3 个字节，按 char 比会系统性低估原文。
 */
export function encodeSnapshot(snapshot: unknown): string {
  const json = JSON.stringify(snapshot);
  const packed = `${GZ_PREFIX}${gzipSync(Buffer.from(json, 'utf8')).toString('base64')}`;
  return Buffer.byteLength(packed, 'utf8') >= Buffer.byteLength(json, 'utf8') ? json : packed;
}

/**
 * 解码。无前缀 = 明文（旧行 / 不可压缩内容 / 手工夹具），必须继续可读；
 * 任何异常都退化为 null，由调用方按「无可复算快照」处理。
 */
export function decodeSnapshot(raw: string | null | undefined): unknown | null {
  if (!raw) return null;
  try {
    if (raw.startsWith(GZ_PREFIX)) {
      const json = gunzipSync(Buffer.from(raw.slice(GZ_PREFIX.length), 'base64')).toString('utf8');
      return JSON.parse(json) as unknown;
    }
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * parseQuery：解析 URL 查询串。
 *
 * 规范：
 *   1) 允许以 "?" 开头，先剥掉；
 *   2) 以 "&" 分段，空段跳过；
 *   3) 只在第一个 "=" 处切分；没有 "=" 的段视为「键存在、值为空串」；
 *   4) 键和值都做 decodeURIComponent；解码失败时保留原样，不要抛错；
 *   5) "+" 视为空格；
 *   6) 同一键重复出现时，后出现的覆盖先出现的。
 *
 * 当前实现不剥 "?"、不解码、不处理 "+"、缺 "=" 时值为 undefined —— 都是真实缺陷。
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
function parseQuery(input) {
  const out = {};
  for (const part of String(input).split('&')) {
    const [k, v] = part.split('=');
    out[k] = v;
  }
  return out;
}

module.exports = { parseQuery };

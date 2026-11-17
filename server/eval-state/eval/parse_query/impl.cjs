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
 * 修复：补齐上述全部规范。
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
function parseQuery(input) {
  let s = String(input == null ? '' : input);
  if (s.startsWith('?')) s = s.slice(1);

  const out = {};
  const decode = (str) => {
    // 先按规范把 "+" 视为空格，再解码；解码失败时保留当前字符串（不抛错）。
    const plus = String(str).replace(/\+/g, ' ');
    try {
      return decodeURIComponent(plus);
    } catch (_e) {
      return plus;
    }
  };

  for (const part of s.split('&')) {
    if (part === '') continue; // 空段跳过
    const eq = part.indexOf('=');
    let k, v;
    if (eq === -1) {
      k = part;
      v = '';
    } else {
      k = part.slice(0, eq);
      v = part.slice(eq + 1);
    }
    out[decode(k)] = decode(v); // 同键后覆盖先
  }
  return out;
}

module.exports = { parseQuery };

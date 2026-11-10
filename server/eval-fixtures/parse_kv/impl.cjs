/**
 * parseKV：解析 "k1=v1;k2=v2" 形式的键值串。
 *
 * 规范：
 *   1) 以 ";" 分段，空段跳过；
 *   2) 键和值都要去掉首尾空白；
 *   3) 没有 "=" 的段视为「键存在、值为空串」；
 *   4) 值里允许再出现 "="（只在第一个 "=" 处切分）；
 *   5) 同一键重复出现时，后出现的覆盖先出现的。
 *
 * 当前实现没做 trim、没跳过空段、没用第一个 "=" 切分 —— 都是真实缺陷。
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
function parseKV(input) {
  const out = {};
  for (const part of String(input).split(';')) {
    const [k, v] = part.split('=');
    out[k] = v;
  }
  return out;
}

module.exports = { parseKV };

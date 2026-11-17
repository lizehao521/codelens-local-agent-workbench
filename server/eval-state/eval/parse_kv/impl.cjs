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
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
function parseKV(input) {
  const out = {};
  const segs = String(input).split(';');
  for (const raw of segs) {
    const seg = raw.trim();
    if (seg === '') continue;
    const idx = seg.indexOf('=');
    if (idx === -1) {
      out[seg] = '';
      continue;
    }
    const k = seg.slice(0, idx).trim();
    const v = seg.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

module.exports = { parseKV };

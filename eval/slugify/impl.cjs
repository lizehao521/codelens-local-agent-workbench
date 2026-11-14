/**
 * slugify：把标题转成 slug。
 *
 * 规范：
 *   1) 全部转小写；
 *   2) 任何非字母数字的连续片段折叠成单个 "-"；
 *   3) 去掉首尾的 "-"。
 *
 * 当前实现只处理了空白字符，其余规范都没做到 —— 这是真实缺陷，不是注释错误。
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
function slugify(input) {
  return String(input).replace(/\s+/g, '-');
}

module.exports = { slugify };

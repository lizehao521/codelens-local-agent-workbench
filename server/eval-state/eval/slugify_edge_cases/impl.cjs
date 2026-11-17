function slugify(str) {
  if (typeof str !== 'string') throw new TypeError('slugify expects a string');
  return str
    .normalize('NFD')                 // 把重音字母拆成「基字母 + 组合音标」
    .replace(/[\u0300-\u036f]/g, '')  // 折叠重音：Café -> Cafe
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')      // 连续非字母数字合并成一个分隔符
    .replace(/^-+|-+$/g, '');         // 裁掉首尾多余分隔符
}
module.exports = { slugify };

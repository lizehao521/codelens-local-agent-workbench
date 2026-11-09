function slugify(str) {
  if (typeof str !== 'string') throw new TypeError('slugify expects a string');
  return str.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
module.exports = { slugify };
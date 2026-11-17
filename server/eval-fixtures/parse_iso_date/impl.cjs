module.exports = {
  parseIsoDate: function(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) throw new Error('Invalid date');
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12) throw new Error('Invalid date');
    const days = [31, y % 4 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (d < 1 || d > days[mo - 1]) throw new Error('Invalid date');
    return { year: y, month: mo, day: d };
  }
};
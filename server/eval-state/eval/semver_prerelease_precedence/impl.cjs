module.exports = { semverCompare };
function semverCompare(a, b) {
  const re = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
  const ma = a.match(re), mb = b.match(re);
  if (!ma || !mb) throw new Error('invalid version');
  for (let i = 1; i <= 3; i++) {
    if (ma[i].length > 1 && ma[i][0] === '0') throw new Error('invalid version');
    if (mb[i].length > 1 && mb[i][0] === '0') throw new Error('invalid version');
  }
  for (let i = 1; i <= 3; i++) {
    const na = parseInt(ma[i], 10), nb = parseInt(mb[i], 10);
    if (na !== nb) return na < nb ? -1 : 1;
  }
  const pa = ma[4], pb = mb[4];
  if (pa === undefined && pb === undefined) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  const ia = pa.split('.'), ib = pb.split('.');
  const len = Math.max(ia.length, ib.length);
  for (let i = 0; i < len; i++) {
    if (i >= ia.length) return -1;
    if (i >= ib.length) return 1;
    const xa = ia[i], xb = ib[i];
    const na = /^\d+$/.test(xa), nb = /^\d+$/.test(xb);
    if (na && nb) {
      const va = parseInt(xa, 10), vb = parseInt(xb, 10);
      if (va !== vb) return va < vb ? -1 : 1;
    } else if (na) {
      return -1;
    } else if (nb) {
      return 1;
    } else {
      if (xa !== xb) return xa < xb ? -1 : 1;
    }
  }
  return 0;
}
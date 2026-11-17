'use strict';

var LOOSE_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]*))?(?:\+(.*))?$/;

function parse(version) {
  var m = LOOSE_RE.exec(version);
  if (!m) {
    throw new Error('Invalid semantic version: ' + version);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : []
  };
}

function compareVersions(a, b) {
  var pa = parse(a);
  var pb = parse(b);

  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

  var x = pa.prerelease.join('.');
  var y = pb.prerelease.join('.');
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

module.exports = { compareVersions: compareVersions };
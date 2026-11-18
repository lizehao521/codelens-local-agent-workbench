function verifyCitation(claim, evidence) {
  if (!claim || !evidence) return { consistent: false, reason: 'no_evidence' };
  if (claim.path !== evidence.path) return { consistent: false, reason: 'path_mismatch' };
  return { consistent: true, reason: 'ok' };
}
module.exports = { verifyCitation: verifyCitation };
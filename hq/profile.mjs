// Enforcement-profile detection (plan §3.3; platform trust domains and
// profiles; R8). HQ reports the profile actually in force, with the reasons a
// stronger one is not, and never claims more than the host proves.
//
// managed-protected needs every one of these. None exists before §9 PR 16
// (Linux) and PR 29 (macOS), so this skeleton never reports it:
//   - HQ runs in its own OS account (D6: _agent-bot-hq / agent-bot-hq);
//   - each member runs under its own principal (D7, PR 16);
//   - the host passed the hostile-member qualification (T01–T03, T21).
// managed-cooperative: the device is managed (enrolled with the identity
// service) but containment is not enforced.
// standalone-unenforced: the owner chose standalone in HQ's config.

export const HQ_ACCOUNTS = Object.freeze({ darwin: '_agent-bot-hq', linux: 'agent-bot-hq' });

export function detectProfile({
  platform = process.platform,
  account,                     // the OS account HQ runs as
  memberPrincipals = false,    // per-member principals in place (PR 16 / PR 29)
  qualified = false,           // hostile-member suite passed on this host
  standalone = false,          // owner config: run standalone, unenforced
} = {}) {
  const reasons = [];
  const expected = HQ_ACCOUNTS[platform];
  if (!expected) reasons.push(`platform ${platform} has no HQ account defined yet`);
  else if (account !== expected) reasons.push(`HQ runs in the ${account ?? 'unknown'} account, not ${expected} (D6; agent-bot-machine has not provisioned it)`);
  if (!memberPrincipals) reasons.push('members share one account: no per-member principals (D7)');
  if (!qualified) reasons.push('the host has not passed the hostile-member qualification (T01–T03, T21)');
  if (standalone) return { profile: 'standalone-unenforced', reasons: ['the owner chose standalone in HQ config', ...reasons] };
  // Protected only when every condition holds; this skeleton has no way to
  // satisfy the last two, so it falls through to cooperative.
  if (reasons.length === 0) return { profile: 'managed-protected', reasons };
  return { profile: 'managed-cooperative', reasons };
}

const RANK = { 'standalone-unenforced': 0, 'managed-cooperative': 1, 'managed-protected': 2 };

// R8: a weaker profile than requested is granted only with a warning that
// says so (admission-result.cooperative fixture).
export function profileWarning(requested, inForce, reasons) {
  if (!requested || RANK[inForce] >= RANK[requested]) return undefined;
  const why = reasons.find((r) => r.startsWith('members share')) ?? reasons[0] ?? 'containment is not enforced on this host';
  return `profile: ${requested} requested; ${inForce} in force (${why})`.slice(0, 512);
}

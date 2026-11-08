// Contract version and capability negotiation (R7, T14).
//
// Each versioned protocol (hq, wire, task) supports N and N-1. A peer offers
// the versions it speaks; the highest common one wins. No common version for
// a required protocol is `unsupported_version`. A frame that requires a
// capability the receiver has not negotiated is `required_capability_missing`.
import { fail } from '../errors.mjs';

const CAPABILITY = /^[a-z0-9]+(-[a-z0-9]+)*-v[0-9]+$/;

// current: { hq: 1, wire: 1, task: 1 }. Returns { hq: [1], ... } with N-1 when it is >= 1.
export function supportWindow(current) {
  const out = {};
  for (const [contract, n] of Object.entries(current)) {
    if (!Number.isSafeInteger(n) || n < 1) throw new TypeError(`${contract}: current version must be an integer >= 1`);
    out[contract] = n > 1 ? [n, n - 1] : [n];
  }
  return out;
}

// offered: the peer's supported_versions ({ hq: [1], wire: [1], task?: [1] }).
// supported: our window from supportWindow(). required: contracts that must agree.
// Returns the negotiated version per contract the two share.
export function negotiateVersions(offered, supported, { required = ['hq', 'wire'] } = {}) {
  const negotiated = {};
  for (const [contract, ours] of Object.entries(supported)) {
    const theirs = offered?.[contract];
    if (theirs === undefined) {
      if (required.includes(contract)) fail('unsupported_version', `peer offers no ${contract} version`, { contract });
      continue;
    }
    if (!Array.isArray(theirs) || theirs.some((v) => !Number.isSafeInteger(v) || v < 1)) {
      fail('unsupported_version', `peer's ${contract} versions are not positive integers`, { contract });
    }
    const common = theirs.filter((v) => ours.includes(v));
    if (common.length === 0) {
      if (required.includes(contract)) fail('unsupported_version', `no common ${contract} version: peer [${theirs}], HQ [${ours}]`, { contract, offered: theirs, supported: ours });
      continue;
    }
    negotiated[contract] = Math.max(...common);
  }
  return negotiated;
}

// The capabilities both sides support, in the peer's order.
export function negotiateCapabilities(offered, supported) {
  for (const c of [...offered, ...supported]) {
    if (!CAPABILITY.test(c)) throw new TypeError(`capability ${JSON.stringify(c)} is not a versioned token`);
  }
  return offered.filter((c) => supported.includes(c));
}

// Refuse a frame whose required capabilities were not all negotiated.
export function checkRequiredCapabilities(required = [], negotiated = []) {
  const missing = required.filter((c) => !negotiated.includes(c));
  if (missing.length) fail('required_capability_missing', `not negotiated: ${missing.join(', ')}`, { missing });
}

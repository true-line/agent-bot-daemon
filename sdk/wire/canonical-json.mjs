// RFC 8785 JSON Canonicalization Scheme (JCS).
//
// Signed structures and digests use these bytes (0.4 §6). Every
// implementation must reproduce the soul-contracts canonicalization vectors
// (fixtures/canonicalization/jcs.json) and each positive fixture's
// canonical_sha256; tests/sdk-wire.test.mjs checks both.
//
// JCS serializes primitives exactly as ECMAScript's JSON.stringify does
// (RFC 8785 §3.2.2), so only object key order needs work: keys sort by their
// UTF-16 code units, which is JavaScript's default string comparison.
import { createHash } from 'node:crypto';

export function canonicalize(value) {
  return serialize(value, new Set());
}

// JCS is defined over I-JSON (RFC 7493): a lone UTF-16 surrogate has no
// encoding, so it is refused here exactly as the strict parser refuses it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function string(s) {
  if (LONE_SURROGATE.test(s)) throw new TypeError('JCS has no encoding for a lone surrogate');
  return JSON.stringify(s);
}

function serialize(value, seen) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return string(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`JCS has no encoding for ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError(`JCS has no encoding for a ${typeof value}`);
  if (seen.has(value)) throw new TypeError('JCS cannot encode a cyclic structure');
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    // Every index, holes included: map() skips holes, so [ , ] and [] would collide.
    const items = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) throw new TypeError(`JCS has no encoding for a sparse array (hole at ${i})`);
      items.push(serialize(value[i], seen));
    }
    out = `[${items.join(',')}]`;
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('JCS encodes plain objects only');
    out = `{${Object.keys(value).sort().map((k) => `${string(k)}:${serialize(value[k], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return out;
}

export const canonicalBytes = (value) => Buffer.from(canonicalize(value), 'utf8');

// `sha256:<hex>` of the canonical bytes, the digest form every contract uses.
export const canonicalDigest = (value) => `sha256:${createHash('sha256').update(canonicalBytes(value)).digest('hex')}`;

import { createHash } from 'node:crypto';

/**
 * JCS-style canonicalization (RFC 8785) for the values these records carry:
 * recursively sort object keys by UTF-16 code units (Array.prototype.sort's
 * default), preserve array order, and emit compact UTF-8 JSON with
 * ECMAScript number serialization. Valid for values without -0, non-finite
 * numbers, or lone surrogates; the full conformance profile is a follow-up
 * (contracts/README.md).
 */
export function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

export function canonicalize(value) {
  return JSON.stringify(sortDeep(value));
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

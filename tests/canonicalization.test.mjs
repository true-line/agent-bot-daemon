import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalize, sha256Hex } from './support/canonical.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const vectors = JSON.parse(readFileSync(join(ROOT, 'contracts/fixtures/canonicalization-v1.json'), 'utf8')).vectors;

test('canonicalization vectors: canonical form and digest pin', () => {
  for (const vector of vectors) {
    assert.equal(canonicalize(vector.input), vector.canonical, `${vector.id}: canonical bytes`);
    assert.equal(sha256Hex(vector.canonical), vector.canonical_sha256, `${vector.id}: digest pin`);
  }
});

test('anchor: object keys sort lexicographically, arrays keep order', () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalize({ z: { y: 2, x: 1 }, a: [3, 1, 2] }), '{"a":[3,1,2],"z":{"x":1,"y":2}}');
  assert.equal(canonicalize({}), '{}');
});

test('anchor: numbers use ECMAScript serialization (RFC 8785 §3.2.2.3)', () => {
  assert.equal(
    canonicalize({ numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27] }),
    '{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}'
  );
});

test('anchor: strings emit minimal escapes and pass UTF-8 through', () => {
  assert.equal(canonicalize({ a: 'line\nbreak' }), '{"a":"line\\nbreak"}');
  assert.equal(canonicalize({ é: 'Euro Sign' }), '{"é":"Euro Sign"}');
});

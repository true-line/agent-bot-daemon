// The soul-contracts pin (D5, §9 PR 7): digest framing, pin shape, and the
// refusals — a changed digest, a moved tag, a backwards pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize, compareSemver, manifestDigest, readPin, repin, verify, PIN_PATH } from '../scripts/soul-contracts.mjs';

const entry = (path, text, mode = '100644') => ({ path, mode, bytes: Buffer.from(text) });

test('canonicalize sorts keys by UTF-16 code units (RFC 8785)', () => {
  assert.equal(canonicalize({ b: 1, a: { d: 'x', c: 2 } }), '{"a":{"c":2,"d":"x"},"b":1}');
  // U+1F600 is a surrogate pair (D83D …) and sorts before U+FB33 in UTF-16, unlike code-point order.
  assert.equal(canonicalize({ 'דּ': 1, '\u{1F600}': 2 }), '{"\u{1F600}":2,"דּ":1}');
  assert.throws(() => canonicalize({ a: 1.5 }), TypeError);
  assert.throws(() => canonicalize({ a: [1] }), TypeError);
});

test('manifest digest vector (cross-checked against an independent Python computation)', () => {
  const got = manifestDigest([entry('b/x.json', '{}\n'), entry('a.txt', 'hi', '100755')]);
  assert.equal(got.digest, 'sha256:5ced25d8ea0ac112750cfb4207371dbac882ad10505710c89c7f50f1e30e03ca');
  assert.equal(got.files, 2);
  // Order of discovery does not matter; content, size and mode do.
  assert.equal(manifestDigest([entry('a.txt', 'hi', '100755'), entry('b/x.json', '{}\n')]).digest, got.digest);
  assert.notEqual(manifestDigest([entry('b/x.json', '{}\n'), entry('a.txt', 'hi')]).digest, got.digest);
  assert.notEqual(manifestDigest([entry('b/x.json', '{} \n'), entry('a.txt', 'hi', '100755')]).digest, got.digest);
});

test('manifest refuses non-regular files and non-canonical paths', () => {
  assert.throws(() => manifestDigest([entry('link', 'target', '120000')]), /unsupported mode/);
  for (const p of ['../x', 'a/../b', 'a//b', './a', '/abs', 'a/']) {
    assert.throws(() => manifestDigest([entry(p, '')]), /canonical relative path/, p);
  }
  assert.throws(() => manifestDigest([entry('a', '1'), entry('a', '2')]), /duplicate/);
});

test('the committed pin is well formed', () => {
  const pin = readPin();
  assert.equal(pin.repository, 'https://github.com/true-line/soul-contracts.git');
  assert.deepEqual(pin.paths, ['errors', 'fixtures', 'schemas']);
});

test('semver comparison and the no-backwards rule', async () => {
  assert.equal(compareSemver('v0.4.0', 'v0.3.9'), 1);
  assert.equal(compareSemver('v0.10.0', 'v0.9.0'), 1);
  assert.equal(compareSemver('v1.0.0', 'v1.0.0'), 0);
  assert.throws(() => compareSemver('v1.0', 'v1.0.0'), /vMAJOR/);
  // Refused before anything is fetched.
  assert.throws(() => repin('v0.3.0', { ...readPin(), tag: 'v0.4.0' }), /never move backwards/);
});

test('the pinned release verifies, and the digested copy is what tests load', () => {
  const pin = readPin();
  const { dir, digest, files } = verify(pin);
  assert.equal(digest, pin.digest);
  assert.equal(files, pin.files);
  assert.ok(dir.endsWith(pin.commit));
  for (const f of ['schemas/hq/v1/hello.schema.json', 'fixtures/positive/hello.first-start.json', 'errors/registry.json', '.verified']) {
    assert.ok(existsSync(join(dir, f)), f);
  }
});

test('a changed digest or a moved tag is refused', () => {
  const pin = readPin();
  assert.throws(() => verify({ ...pin, digest: `sha256:${'0'.repeat(64)}` }), /does not match the pin/);
  assert.throws(() => verify({ ...pin, files: pin.files + 1 }), /does not match the pin/);
  assert.throws(() => verify({ ...pin, commit: 'e'.repeat(40) }), /moved tag/);
  assert.ok(PIN_PATH.endsWith('governance/soul-contracts.json'));
});

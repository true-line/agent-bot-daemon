// The SDK's wire helpers against the pinned soul-contracts fixtures (§4.6):
// JCS vectors and canonical digests, schema validation, strict parsing,
// version and capability negotiation, and the registry codes the SDK raises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verify } from '../scripts/soul-contracts.mjs';
import { canonicalize, canonicalDigest } from '../sdk/wire/canonical-json.mjs';
import { parseStrict } from '../sdk/wire/strict-json.mjs';
import { checkRequiredCapabilities, negotiateCapabilities, negotiateVersions, supportWindow } from '../sdk/wire/versions.mjs';
import { REGISTRY_CODES, HOST_CODES } from '../sdk/errors.mjs';
import { checkSchemaSupported, validate } from '../sdk/wire/schema.mjs';

const { dir } = verify();
const fx = (rel) => join(dir, 'fixtures', rel);
const load = (rel) => JSON.parse(readFileSync(fx(rel), 'utf8'));
const listing = (sub) => readdirSync(fx(sub)).filter((f) => f.endsWith('.json')).sort();
const positives = listing('positive').map((f) => [f, load(`positive/${f}`)]);
const negatives = listing('negative').map((f) => [f, load(`negative/${f}`)]);
const code = (c) => (e) => e.code === c;

test('JCS vectors: exact canonical text and digest', () => {
  const { vectors } = load('canonicalization/jcs.json');
  assert.ok(vectors.length >= 8);
  for (const v of vectors) {
    assert.equal(canonicalize(v.input), v.canonical, v.id);
    assert.equal(canonicalDigest(v.input), v.canonical_sha256, v.id);
  }
});

test('every positive fixture reproduces its canonical_sha256', () => {
  assert.ok(positives.length > 30);
  for (const [f, p] of positives) assert.equal(canonicalDigest(p.input), p.canonical_sha256, f);
});

test('hello.first-start canonical bytes and digest files match', () => {
  const p = load('positive/hello.first-start.json');
  assert.equal(canonicalize(p.input), readFileSync(fx('positive/hello.first-start.canonical.txt'), 'utf8'));
  assert.equal(canonicalDigest(p.input), readFileSync(fx('positive/hello.first-start.digest.txt'), 'utf8').trim());
});

test('every negative pins the exact bytes of its base positive', () => {
  for (const [f, n] of negatives) {
    const bytes = readFileSync(fx(n.base.fixture));
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, n.base.sha256, f);
  }
});

test('every fixture gets its expected schema verdict from the SDK validator', () => {
  const schemaFor = (rel) => JSON.parse(readFileSync(join(dir, 'schemas', rel), 'utf8'));
  let invalid = 0;
  for (const [f, x] of [...positives, ...negatives]) {
    if (x.expect.parse) continue;
    const errors = validate(schemaFor(x.schema), x.input);
    assert.equal(errors.length ? 'invalid' : 'valid', x.expect.schema, `${f}: ${JSON.stringify(errors)}`);
    if (errors.length) invalid++;
  }
  assert.ok(invalid >= 20, 'the schema-refusal negatives are exercised');
  // Every pinned schema uses only keywords the validator checks.
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.schema.json') ? [join(d, e.name)] : []));
  const schemas = walk(join(dir, 'schemas'));
  assert.ok(schemas.length >= 19);
  for (const f of schemas) checkSchemaSupported(JSON.parse(readFileSync(f, 'utf8')), f);
});

test('the validator fails closed on keywords it does not check, and checks what it claims', () => {
  for (const kw of [{ $ref: '#/x' }, { oneOf: [] }, { anyOf: [] }, { patternProperties: {} }, { format: 'uri' }]) {
    assert.throws(() => validate(kw, {}), TypeError, JSON.stringify(kw));
  }
  assert.throws(() => validate({ properties: { a: { not: {} } } }, {}), /keyword not/);
  const ts = { type: 'string', format: 'date-time' };
  assert.deepEqual(validate(ts, '2026-11-07T10:00:00Z'), []);
  assert.deepEqual(validate(ts, '2026-11-07T10:00:00.123+05:30'), []);
  for (const bad of ['2026-02-30T00:00:00Z', '2026-11-07 10:00:00Z', '2026-11-07T24:00:00Z', '2026-11-07T10:00:00']) assert.equal(validate(ts, bad).length, 1, bad);
  assert.deepEqual(validate({ type: 'string', maxLength: 1 }, '\u{1F600}'), [], 'length counts code points');
  assert.equal(validate({ type: 'integer' }, 1.5).length, 1);
  assert.deepEqual(validate({ type: 'number' }, 2), []);
  assert.equal(validate({ type: 'array', uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }]).length, 1);
  assert.equal(validate({ type: 'object', additionalProperties: false, properties: { a: true } }, { a: 1, b: 2 })[0].message, 'unknown field b');
  const cond = { if: { properties: { kind: { const: 'x' } }, required: ['kind'] }, then: { required: ['y'] } };
  assert.equal(validate(cond, { kind: 'x' }).length, 1);
  assert.deepEqual(validate(cond, { kind: 'z' }), []);
  assert.equal(validate({ type: 'array', contains: { const: 1 }, minContains: 2 }, [1, 2]).length, 1);
});

test('the strict parser refuses every parse-refusal fixture and accepts every fixture file', () => {
  const refusals = negatives.filter(([, n]) => n.expect.parse === 'invalid');
  assert.ok(refusals.length >= 1);
  for (const [f, n] of refusals) assert.throws(() => parseStrict(n.input_raw), code('host.invalid_json'), f);
  for (const sub of ['positive', 'negative']) {
    for (const f of listing(sub)) {
      const text = readFileSync(fx(`${sub}/${f}`), 'utf8');
      assert.deepEqual(parseStrict(text), JSON.parse(text), f);
    }
  }
});

test('strict parsing: duplicates, constants, BOM, surrogates, trailing text, depth', () => {
  assert.throws(() => parseStrict('{"a":{"b":1,"b":2}}'), code('host.invalid_json'));
  assert.throws(() => parseStrict('{"a":1,"\\u0061":2}'), code('host.invalid_json'), 'escaped duplicate');
  for (const bad of ['NaN', '{"a":Infinity}', '﻿{}', '"\\ud800"', '{} x', '[1,]', "{'a':1}", '01', '']) {
    assert.throws(() => parseStrict(bad), code('host.invalid_json'), JSON.stringify(bad));
  }
  assert.throws(() => parseStrict('['.repeat(65) + ']'.repeat(65)), code('host.invalid_json'));
  assert.deepEqual(parseStrict('['.repeat(64) + ']'.repeat(64)).length, 1);
  const o = parseStrict('{"__proto__":{"polluted":true}}');
  assert.equal(Object.getPrototypeOf(o), Object.prototype);
  assert.deepEqual(Object.keys(o), ['__proto__']);
  assert.equal({}.polluted, undefined);
});

test('canonicalize refuses what JCS cannot encode and allows shared references', () => {
  assert.throws(() => canonicalize({ a: NaN }), TypeError);
  assert.throws(() => canonicalize({ a: 1n }), TypeError);
  assert.throws(() => canonicalize(new Date(0)), TypeError);
  const cyc = {}; cyc.self = cyc;
  assert.throws(() => canonicalize(cyc), /cyclic/);
  const shared = { x: 1 };
  assert.equal(canonicalize({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
});

test('version negotiation: N and N-1, highest common wins, fixtures refuse outside the window', () => {
  assert.deepEqual(supportWindow({ hq: 1, wire: 1, task: 2 }), { hq: [1], wire: [1], task: [2, 1] });
  const ours = supportWindow({ hq: 1, wire: 1 });
  for (const [f, p] of positives.filter(([f]) => f.startsWith('hello.'))) {
    assert.deepEqual(negotiateVersions(p.input.supported_versions, ours), { hq: 1, wire: 1 }, f);
  }
  const n = load('negative/hello.unsupported-version.json');
  assert.equal(n.expect.error, 'unsupported_version');
  assert.throws(() => negotiateVersions(n.input.supported_versions, ours), code('unsupported_version'));
  assert.deepEqual(negotiateVersions({ hq: [1, 2], wire: [2] }, supportWindow({ hq: 2, wire: 2 })), { hq: 2, wire: 2 });
  assert.throws(() => negotiateVersions({ hq: [1] }, ours), code('unsupported_version'), 'wire missing');
  assert.deepEqual(negotiateVersions({ hq: [1], wire: [1] }, supportWindow({ hq: 1, wire: 1, task: 1 })), { hq: 1, wire: 1 }, 'task is optional by default');
});

test('capabilities: unknown required capability is refused (T14)', () => {
  const n = load('negative/wire-frame.unknown-required-capability.json');
  assert.equal(n.expect.error, 'required_capability_missing');
  assert.throws(() => checkRequiredCapabilities(n.input.required_capabilities, n.context.negotiated_capabilities), code('required_capability_missing'));
  for (const [f, p] of positives.filter(([f]) => f.startsWith('wire-frame.'))) {
    checkRequiredCapabilities(p.input.required_capabilities, n.context.negotiated_capabilities);
    assert.ok(true, f);
  }
  assert.deepEqual(negotiateCapabilities(['sealed-inner-v1', 'time-travel-v9'], ['sealed-inner-v1']), ['sealed-inner-v1']);
  assert.throws(() => negotiateCapabilities(['Sealed'], []), TypeError);
});

test('every registry code the SDK raises is registered with the same retryable flag', () => {
  const registry = JSON.parse(readFileSync(join(dir, 'errors/registry.json'), 'utf8'));
  const byCode = new Map(registry.codes.map((c) => [c.code, c]));
  for (const [c, retryable] of Object.entries(REGISTRY_CODES)) {
    assert.ok(byCode.has(c), `${c} is not in the pinned registry`);
    assert.equal(byCode.get(c).retryable, retryable, c);
  }
  for (const c of HOST_CODES) {
    assert.match(c, /^host\.[a-z_]+$/);
    assert.ok(!byCode.has(c), `${c} collides with a registry code`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validate, assertKeywordsUsed } from './support/validator.mjs';
import { canonicalize, sha256Hex } from './support/canonical.mjs';
import { parseStrict } from './support/strict-json.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(ROOT, 'contracts');
const SCHEMA_DIRS = ['hq-v1', 'broker', 'records'];

const jsonFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// --- Schemas ---------------------------------------------------------------

const schemas = new Map();
for (const sub of SCHEMA_DIRS) {
  for (const file of jsonFiles(join(CONTRACTS, 'schemas', sub))) {
    const path = join(CONTRACTS, 'schemas', sub, file);
    const schema = readJson(path);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', `${file}: draft 2020-12`);
    assert.doesNotThrow(() => assertKeywordsUsed(schema), `${file}: only supported keywords`);
    const name = file.replace(/\.schema\.json$/, '');
    schemas.set(name, { sub, path, schema });
  }
}

test('the Appendix A record set is complete (18 schemas)', () => {
  const expected = [
    'hello', 'admission-result', 'equip', 'ready-lease', 'lifecycle-request',
    'approval-record', 'wire-frame', 'directive-query', 'grant-record',
    'task-record', 'task-commitment', 'typed-note', 'action-record',
    'credential-issuance-record', 'transfer-record', 'dream-grant-record',
    'eval-plan-record', 'candidate-revision-record',
  ].sort();
  assert.deepEqual([...schemas.keys()].sort(), expected);
});

// --- Fixtures --------------------------------------------------------------

const FIXTURES = join(CONTRACTS, 'fixtures');
const positivesFiles = jsonFiles(FIXTURES).filter((f) => /-v1\.json$/.test(f) && f !== 'canonicalization-v1.json');
const negativesFiles = jsonFiles(FIXTURES).filter((f) => /-v1-negatives\.json$/.test(f));

test('every record has exactly one positives file and one negatives companion', () => {
  const records = (files, suffix) => new Set(files.map((f) => f.replace(suffix, '')));
  const pos = records(positivesFiles, '-v1.json');
  const neg = records(negativesFiles, '-v1-negatives.json');
  const canon = new Set(['canonicalization']);
  assert.deepEqual([...pos].sort(), [...schemas.keys()].sort());
  assert.deepEqual([...neg].sort(), [...schemas.keys()].sort());
  assert.equal(jsonFiles(FIXTURES).filter((f) => !pos.has(f.replace('-v1.json', '')) && f !== 'canonicalization-v1.json' && !f.endsWith('-negatives.json')).length, 0, 'no stray fixture files');
  assert.ok(canon.has('canonicalization'));
});

for (const file of positivesFiles) {
  const path = join(FIXTURES, file);
  const fixture = readJson(path);

  test(`${file}: vectors validate against their schema`, () => {
    const schemaPath = resolve(FIXTURES, fixture.schema);
    const schema = readJson(schemaPath);
    assert.equal(fixture.record, file.replace(/-v1\.json$/, ''), 'record matches file name');
    assert.ok(schemaPath.startsWith(join(CONTRACTS, 'schemas')), 'schema path stays under contracts/schemas');
    assertKeywordsUsed(schema);
    assert.ok(fixture.vectors.length >= 1, 'at least one vector');
    const ids = new Set();
    for (const vector of fixture.vectors) {
      assert.ok(!ids.has(vector.id), `duplicate vector id ${vector.id}`);
      ids.add(vector.id);
      assert.equal(vector.expected, 'valid');
      const result = validate(vector.data, schema);
      assert.deepEqual(result, { ok: true }, `${vector.id}: ${JSON.stringify(result.ok ? [] : result.errors)}`);
    }
  });

  test(`${file}: canonical digests are pinned`, () => {
    for (const vector of fixture.vectors) {
      assert.equal(
        vector.canonical_sha256,
        sha256Hex(canonicalize(vector.data)),
        `${vector.id}: canonical_sha256 must equal the SHA-256 of the vector data in canonical form`
      );
    }
  });
}

for (const file of negativesFiles) {
  const path = join(FIXTURES, file);
  const neg = readJson(path);
  const record = file.replace(/-v1-negatives\.json$/, '');

  test(`${file}: companion pins the exact positives bytes`, () => {
    assert.equal(neg.companion, 'negatives');
    assert.equal(neg.base.file, `${record}-v1.json`);
    const positivesBytes = readFileSync(join(FIXTURES, neg.base.file));
    assert.equal(neg.base.sha256, createHashOf(positivesBytes), 'base.sha256 must pin the positives file bytes');
  });

  test(`${file}: every negative vector is refused as declared`, () => {
    const schema = readJson(schemas.get(record).path);
    if (neg.semantic_now !== undefined) {
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(neg.semantic_now), 'semantic_now is a date-time');
    }
    const ids = new Set();
    for (const vector of neg.vectors) {
      assert.ok(!ids.has(vector.id), `duplicate vector id ${vector.id}`);
      ids.add(vector.id);
      assert.equal(typeof vector.note, 'string', `${vector.id}: carries a note`);
      if (vector.refusal === 'schema') {
        const result = validate(vector.data, schema);
        assert.equal(result.ok, false, `${vector.id}: schema must refuse`);
        assert.ok(result.errors.length >= 1);
      } else if (vector.refusal === 'parse') {
        assert.doesNotThrow(() => JSON.parse(vector.data_raw), `${vector.id}: JSON.parse tolerates it`);
        assert.throws(() => parseStrict(vector.data_raw), SyntaxError, `${vector.id}: strict parsing refuses it`);
      } else if (vector.refusal === 'semantic') {
        const result = validate(vector.data, schema);
        assert.deepEqual(result, { ok: true }, `${vector.id}: schema accepts; the semantic rule refuses — ${JSON.stringify(result.ok ? [] : result.errors)}`);
        applySemanticRule(vector, neg);
      } else {
        assert.fail(`${vector.id}: unknown refusal class ${vector.refusal}`);
      }
    }
  });
}

function applySemanticRule(vector, neg) {
  switch (vector.rule) {
    case 'expiry-before-now': {
      const stamp = vector.data.expiry ?? vector.data.expires_at;
      assert.ok(stamp !== undefined, `${vector.id}: vector carries an expiry`);
      assert.ok(
        Date.parse(stamp) < Date.parse(neg.semantic_now),
        `${vector.id}: expiry precedes semantic_now`
      );
      break;
    }
    case 'capability-not-negotiated': {
      const negotiated = neg.negotiated_capabilities;
      assert.ok(Array.isArray(negotiated), 'negotiated_capabilities declared for this file');
      assert.ok(
        vector.data.required_capabilities.some((c) => !negotiated.includes(c)),
        `${vector.id}: at least one required capability is outside the negotiated set`
      );
      break;
    }
    default:
      assert.fail(`${vector.id}: unknown semantic rule ${vector.rule}`);
  }
}

function createHashOf(buffer) {
  // Kept local so this file reads top-to-bottom: SHA-256 over exact bytes.
  return sha256Hex(buffer.toString('utf8'));
}

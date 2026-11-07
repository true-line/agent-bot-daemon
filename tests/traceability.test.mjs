import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const traceability = readFileSync(join(ROOT, 'docs/traceability.md'), 'utf8');
const glossary = readFileSync(join(ROOT, 'docs/glossary.md'), 'utf8');
const contractsReadme = readFileSync(join(ROOT, 'contracts/README.md'), 'utf8');

const WHITEPAPER_SHA = '6e8b85af5aea5454314b7563fef83d50b5582f2b6bd9bd2a8a9bd64cdedd3030';

test('traceability matrix covers R1–R12', () => {
  for (let n = 1; n <= 12; n += 1) {
    assert.match(traceability, new RegExp(`^\\| R${n} \\|`, 'm'), `R${n} row`);
  }
});

test('traceability matrix covers T01–T30', () => {
  for (let n = 1; n <= 30; n += 1) {
    const id = String(n).padStart(2, '0');
    assert.match(traceability, new RegExp(`^\\| T${id} `, 'm'), `T${id} row`);
  }
});

test('the shared-semantics tests are recorded as not tied to one requirement', () => {
  assert.match(traceability, /T05, T06, T07, T08, T09, T17, T18, T23/);
});

test('traceability pins the governing whitepaper by SHA-256', () => {
  assert.ok(traceability.includes(WHITEPAPER_SHA), 'whitepaper pin present');
});

test('glossary defines the core vocabulary and the enumerations', () => {
  for (const term of [
    'Principal', 'Owner', 'Soul', 'Member', 'Lead', 'Specialist',
    'Installation', 'Installation epoch', 'Runtime', 'Session', 'Task',
    'Grant handle', 'Credential reference', 'Directive', 'Query', 'Approval',
    'Receipt', 'Primitive', 'Render', 'Dream run', 'Candidate revision',
    'Eval cell',
  ]) {
    assert.ok(glossary.includes(term), `glossary defines "${term}"`);
  }
  for (const value of ['managed-protected', 'managed-cooperative', 'standalone-unenforced', 'external-untrusted']) {
    assert.ok(glossary.includes(value), `glossary enumerates "${value}"`);
  }
});

test('contracts README pins the normative sources', () => {
  assert.ok(contractsReadme.includes(WHITEPAPER_SHA));
  assert.ok(contractsReadme.includes('10.5281/zenodo.23547566'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = 'governance/error-codes.json';
const registry = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8'));

// The 0.4 minimum error codes, in the order the whitepaper lists them
// (Appendix A, "Minimum error codes"). This pin is the stage-0 baseline:
// the registry may add codes, but this set may never shrink or reword.
const MINIMUM_CODES = [
  'unsupported_version',
  'required_capability_missing',
  'caller_mismatch',
  'stale_epoch',
  'lease_expired',
  'grant_revoked',
  'destination_denied',
  'budget_exhausted',
  'revision_conflict',
  'message_conflict',
  'mailbox_full',
  'frame_too_large',
  'message_expired',
  'quarantined',
  'definition_not_accepted',
  'evidence_missing',
  'approval_mismatch',
  'write_scope_conflict',
  'outcome_unknown',
  'eval_coverage_missing',
  'candidate_rejected',
  'render_failed',
  'source_chain_unapproved',
  'dream_limit_exceeded',
  'credential_unavailable',
  'device_revoked',
  'profile_insufficient',
];

const RAISED_BY = ['hq', 'broker', 'entry-point', 'soul-build', 'eval-gate', 'identity-service'];

test('registry structure: schema_version, contiguous numbering, well-formed codes', () => {
  assert.equal(registry.schema_version, 1);
  assert.equal(typeof registry.description, 'string');
  assert.ok(registry.source?.sha256?.match(/^[0-9a-f]{64}$/), 'source pin present');
  const seen = new Set();
  registry.codes.forEach((entry, index) => {
    assert.equal(entry.n, index + 1, 'numbering is contiguous and in order');
    assert.match(entry.code, /^[a-z][a-z0-9_]{0,63}$/, 'codes are snake_case');
    assert.ok(!seen.has(entry.code), 'codes are unique');
    seen.add(entry.code);
    assert.equal(typeof entry.retryable, 'boolean');
    assert.ok(Array.isArray(entry.raised_by) && entry.raised_by.length >= 1);
    for (const r of entry.raised_by) assert.ok(RAISED_BY.includes(r), `raised_by "${r}" is a known component`);
    assert.ok(typeof entry.summary === 'string' && entry.summary.length >= 1 && entry.summary.length <= 200);
    assert.ok(/^\d+\.\d+$/.test(entry.registered), 'registered names the source draft');
  });
});

test('registry carries the 0.4 minimum set exactly, in order', () => {
  assert.deepEqual(registry.codes.map((c) => c.code), MINIMUM_CODES);
});

test('add-only ratchet: no code is removed, renamed, or renumbered relative to the base branch', () => {
  const baseRef = process.env.BASE_REF ?? 'origin/main';
  let baseSha;
  try {
    baseSha = execSync(`git merge-base ${JSON.stringify(baseRef)} HEAD`, { cwd: ROOT }).toString().trim();
  } catch {
    return; // no base ref available (fresh clone without origin) — structure checks above still ran
  }
  let baseText;
  try {
    baseText = execSync(`git show ${JSON.stringify(`${baseSha}:${REGISTRY_PATH}`)}`, { cwd: ROOT, maxBuffer: 1024 * 1024 }).toString();
  } catch {
    return; // registry did not exist at the base — every code is new
  }
  const baseCodes = JSON.parse(baseText).codes;
  const current = new Map(registry.codes.map((c) => [c.code, c]));
  for (const old of baseCodes) {
    const now = current.get(old.code);
    assert.ok(now, `code "${old.code}" must not be removed`);
    assert.equal(now.n, old.n, `code "${old.code}" must not be renumbered`);
  }
});

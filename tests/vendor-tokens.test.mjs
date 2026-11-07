import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// R10: no contract names a model, provider, or harness vendor. Vendor names
// appear only in configuration, adapter manifests, and evaluation records.
// The denylist is a tripwire for the automated gate; the manual schema
// review (PR done-when) remains the authority for anything it misses.
const DENYLIST = [
  'claude', 'codex', 'anthropic', 'openai', 'gpt-', 'gemini', 'google',
  'opencode', 'copilot', 'cursor', 'bedrock', 'mistral', 'llama', 'qwen',
  'glm', 'deepseek', 'grok', 'meta.ai', 'huggingface',
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const CONTRACT_FILES = [
  ...walk(join(ROOT, 'contracts')),
  join(ROOT, 'governance/error-codes.json'),
  join(ROOT, 'docs/glossary.md'),
  join(ROOT, 'docs/traceability.md'),
];

test('no vendor token appears in any contract artifact (R10)', () => {
  const offenders = [];
  for (const path of CONTRACT_FILES) {
    const text = readFileSync(path, 'utf8').toLowerCase();
    for (const token of DENYLIST) {
      if (text.includes(token)) offenders.push(`${path}: ${token}`);
    }
  }
  assert.deepEqual(offenders, []);
});

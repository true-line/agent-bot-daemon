// HQ has no npm dependencies (§3.4 rule 5): hq/ imports node: built-ins, the
// SDK and its own modules. Only the command line (main.mjs) reaches into
// scripts/, to load the pinned soul-contracts schemas, and only the plugin
// loader (plugins.mjs) imports dynamically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HQ = join(ROOT, 'hq');

test('hq/ imports only node: built-ins, sdk/ and its own modules', () => {
  const mods = readdirSync(HQ).filter((f) => f.endsWith('.mjs'));
  assert.ok(mods.length >= 7);
  for (const f of mods) {
    const src = readFileSync(join(HQ, f), 'utf8');
    for (const [, spec] of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      if (spec.startsWith('node:')) continue;
      const target = resolve(HQ, spec);
      const allowed = [HQ + '/', join(ROOT, 'sdk') + '/', ...(f === 'main.mjs' ? [join(ROOT, 'scripts') + '/'] : [])];
      assert.ok(allowed.some((a) => target.startsWith(a)), `hq/${f} imports ${relative(ROOT, target)}`);
    }
    // Only the plugin loader imports dynamically, after its digest checks.
    if (f !== 'plugins.mjs') assert.doesNotMatch(src, /\bimport\s*\(/, `hq/${f} uses a dynamic import`);
  }
});

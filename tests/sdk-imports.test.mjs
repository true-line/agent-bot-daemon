// The SDK has zero dependencies (§3.4 rule 5): its modules import only
// node: built-ins and each other. It imports nothing from scripts/, tests/
// or any other package, so a plugin repository can vendor it as is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK = resolve(dirname(fileURLToPath(import.meta.url)), '../sdk');
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

test('the SDK imports only node: built-ins and its own modules', async () => {
  const mods = files(SDK).filter((f) => f.endsWith('.mjs'));
  assert.ok(mods.length >= 10);
  for (const f of mods) {
    const src = readFileSync(f, 'utf8');
    for (const [, spec] of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${relative(SDK, f)} imports ${spec}`);
      assert.ok(resolve(dirname(f), spec).startsWith(SDK + '/'), `${relative(SDK, f)} reaches outside sdk/: ${spec}`);
    }
    assert.doesNotMatch(src, /\bimport\s*\(/, `${relative(SDK, f)} uses a dynamic import`);
  }
  const index = await import(join(SDK, 'index.mjs'));
  for (const name of ['definePlugin', 'createHost', 'createTestHost', 'checkPlugin', 'canonicalDigest', 'parseStrict', 'negotiateVersions']) {
    assert.equal(typeof index[name], 'function', name);
  }
  const pkg = JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@agent-bot/sdk');
  assert.equal(pkg.dependencies, undefined);
});

// Installed plugins (hq/plugins.mjs, plan §4.5): HQ runs no plugin code until
// the tree's digest matches its pin in governance/plugins.json, the static
// fields resolve, and the code matches plugin.json. --dev-plugins skips the
// pin and is always reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { manifestDigest } from '../scripts/soul-contracts.mjs';
import { loadPlugins, readPins, treeDigest, PINS_FORMAT } from '../hq/plugins.mjs';
import { startHQ } from './hq-harness.mjs';

const SDK = pathToFileURL(join(import.meta.dirname, '../sdk/plugin.mjs')).href;
const ran = () => globalThis.__hqPluginsRan ?? [];
let seq = 0;

// Each test gets fresh plugin names, so the module cache never hides a load.
const fresh = (base) => `${base}-${process.pid}-${++seq}`;

function writePlugin(root, { name, version = '1.0.0', requires = {}, json, code } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const manifest = json ?? { name, version, hostApi: 1, requires, optional: {}, services: [], identityServiceRoutes: [] };
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'plugin.mjs'), code ?? [
    `import { definePlugin } from ${JSON.stringify(SDK)};`,
    `globalThis.__hqPluginsRan = [...(globalThis.__hqPluginsRan ?? []), ${JSON.stringify(name)}];`,
    `export default definePlugin({ name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, hostApi: 1, requires: ${JSON.stringify(requires)}, async init() {} });`,
    '',
  ].join('\n'));
  return dir;
}

const pin = (dir, name, version = '1.0.0') => ({ name, version, sha256: treeDigest(join(dir, name)) });
const pinsOf = (...plugins) => ({ format: PINS_FORMAT, algorithm: 'sha256-manifest-v1', plugins });
const tempDir = () => mkdtempSync(join(tmpdir(), 'hq-plugins-'));
const byName = (report, name) => report.find((r) => r.name === name);

test('the tree digest uses the soul-contracts sha256-manifest-v1 framing', () => {
  const root = tempDir();
  try {
    const dir = writePlugin(root, { name: fresh('framing') });
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib/run.sh'), '#!/bin/sh\n');
    chmodSync(join(dir, 'lib/run.sh'), 0o755);
    const entries = ['lib/run.sh', 'plugin.json', 'plugin.mjs'].map((path) => ({ path, mode: path.endsWith('.sh') ? '100755' : '100644', bytes: readFileSync(join(dir, path)) }));
    assert.equal(treeDigest(dir), manifestDigest(entries).digest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a pinned plugin loads; an unpinned or altered one is refused without running its code', async () => {
  const root = tempDir();
  const [good, unpinned, altered, wrongVersion] = ['good', 'unpinned', 'altered', 'version'].map(fresh);
  try {
    for (const name of [good, unpinned, altered, wrongVersion]) writePlugin(root, { name });
    const pins = pinsOf(pin(root, good), pin(root, altered), { ...pin(root, wrongVersion), version: '1.0.1' });
    writeFileSync(join(root, altered, 'plugin.mjs'), readFileSync(join(root, altered, 'plugin.mjs'), 'utf8') + '// changed after pinning\n');

    const { loaded, report } = await loadPlugins({ dir: root, pins });
    assert.deepEqual(loaded.map((l) => l.plugin.name), [good]);
    assert.equal(byName(report, good).state, 'loaded');
    assert.match(byName(report, unpinned).reason, /not pinned/);
    assert.match(byName(report, altered).reason, /does not match the pin/);
    assert.match(byName(report, wrongVersion).reason, /pinned at 1.0.1, installed 1.0.0/);
    assert.ok(ran().includes(good));
    for (const name of [unpinned, altered, wrongVersion]) assert.ok(!ran().includes(name), `${name} ran`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('plugin.json is checked before the digest: directory name, static fields only, valid manifest', async () => {
  const root = tempDir();
  const [renamed, extra, bad] = ['renamed', 'extra', 'bad'].map(fresh);
  try {
    writePlugin(root, { name: renamed, json: { name: 'someone-else', version: '1.0.0', hostApi: 1 } });
    writePlugin(root, { name: extra, json: { name: extra, version: '1.0.0', hostApi: 1, init: 'x' } });
    writePlugin(root, { name: bad, json: { name: bad, version: 'one', hostApi: 1 } });
    const { loaded, report } = await loadPlugins({ dir: root, dev: true });
    assert.equal(loaded.length, 0);
    assert.match(byName(report, renamed).reason, /directory is/);
    assert.match(byName(report, extra).reason, /non-static field init/);
    assert.match(byName(report, bad).reason, /MAJOR.MINOR.PATCH/);
    for (const name of [renamed, extra, bad]) assert.ok(!ran().includes(name));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a symlink in the tree is refused, so the digested tree is the tree that runs', async () => {
  const root = tempDir();
  const name = fresh('linked');
  try {
    writePlugin(root, { name });
    symlinkSync('/etc/hosts', join(root, name, 'hosts'));
    const { loaded, report } = await loadPlugins({ dir: root, dev: true });
    assert.equal(loaded.length, 0);
    assert.match(byName(report, name).reason, /not a regular file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a plugin needing a refused, missing or cyclic dependency is refused from its static fields', async () => {
  const root = tempDir();
  const [base, dependent, orphan, a, b, onBuiltIn] = ['base', 'dependent', 'orphan', 'cycle-a', 'cycle-b', 'on-builtin'].map(fresh);
  try {
    writePlugin(root, { name: base });
    writePlugin(root, { name: dependent, requires: { [base]: '^1.0.0' } });
    writePlugin(root, { name: orphan, requires: { 'not-installed': '^1.0.0' } });
    writePlugin(root, { name: a, requires: { [b]: '^1.0.0' } });
    writePlugin(root, { name: b, requires: { [a]: '^1.0.0' } });
    writePlugin(root, { name: onBuiltIn, requires: { 'hq-admission': '^0.1.0' } });
    // base is unpinned, so dependent must fall with it.
    const pins = pinsOf(...[dependent, orphan, a, b, onBuiltIn].map((n) => pin(root, n)));
    const { loaded, report } = await loadPlugins({ dir: root, pins, available: { 'hq-admission': '0.1.0' } });
    assert.deepEqual(loaded.map((l) => l.plugin.name), [onBuiltIn]);
    assert.match(byName(report, dependent).reason, new RegExp(`requires ${base}`));
    assert.match(byName(report, orphan).reason, /requires not-installed/);
    assert.match(byName(report, a).reason, /dependency cycle/);
    assert.match(byName(report, b).reason, /dependency cycle/);
    for (const name of [dependent, orphan, a, b]) assert.ok(!ran().includes(name));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('code whose definePlugin fields differ from plugin.json is refused', async () => {
  const root = tempDir();
  const name = fresh('liar');
  try {
    writePlugin(root, { name, code: `import { definePlugin } from ${JSON.stringify(SDK)};\nexport default definePlugin({ name: ${JSON.stringify(name)}, version: '1.0.0', hostApi: 1, services: ['credentials'], async init() {} });\n` });
    const { loaded, report } = await loadPlugins({ dir: root, pins: pinsOf(pin(root, name)) });
    assert.equal(loaded.length, 0);
    assert.match(byName(report, name).reason, /differ from plugin.json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the pins file is strict', () => {
  const root = tempDir();
  try {
    const path = join(root, 'plugins.json');
    const write = (v) => writeFileSync(path, JSON.stringify(v));
    write(pinsOf());
    assert.deepEqual(readPins(path).plugins, []);
    write({ ...pinsOf(), format: 'other' });
    assert.throws(() => readPins(path), /format/);
    write({ ...pinsOf(), algorithm: 'sha1' });
    assert.throws(() => readPins(path), /algorithm/);
    write(pinsOf({ name: 'x', version: '1.0.0', sha256: 'abc' }));
    assert.throws(() => readPins(path), /each pin/);
    const p = { name: 'x', version: '1.0.0', sha256: `sha256:${'0'.repeat(64)}` };
    write(pinsOf(p, p));
    assert.throws(() => readPins(path), /pinned twice/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the repository pins file is valid', () => {
  readPins(join(import.meta.dirname, '../governance/plugins.json'));
});

test('HQ runs pinned plugins, receipts refusals, keeps core names, and reports dev plugins', async () => {
  const root = tempDir();
  const dev = tempDir();
  const [pinned, unpinned, devOnly] = ['pinned', 'unpinned', 'dev'].map(fresh);
  try {
    writePlugin(root, { name: pinned });
    writePlugin(root, { name: unpinned });
    writePlugin(root, { name: 'hq-admission', version: '0.1.0' });
    writePlugin(dev, { name: devOnly, requires: { [pinned]: '^1.0.0' } });
    writePlugin(dev, { name: pinned });
    const pins = pinsOf(pin(root, pinned), pin(root, 'hq-admission', '0.1.0'));
    const t = await startHQ({ pluginsDir: root, pins, devPlugins: dev });
    try {
      const s = (await (await t.owner()).request('status')).result;
      const state = (n) => s.plugins.find((p) => p.name === n)?.state;
      assert.equal(state(pinned), 'running');
      assert.equal(state(devOnly), 'running');
      assert.equal(state(unpinned), undefined);
      assert.equal(s.hq.devPlugins, dev);
      const load = (n, d = false) => s.hq.pluginLoad.find((r) => r.name === n && !!r.dev === d);
      assert.equal(load(devOnly, true).state, 'loaded');
      assert.match(load(pinned, true).reason, /name .* is taken/);
      assert.match(load('hq-admission').reason, /name hq-admission is taken/);
      assert.match(load(unpinned).reason, /not pinned/);
      const refused = t.hq.core.receipts.filter((r) => r.kind === 'hq.plugin.refused').map((r) => r.name).sort();
      assert.deepEqual(refused, ['hq-admission', pinned, unpinned].sort());
    } finally { await t.done(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dev, { recursive: true, force: true });
  }
});

test('an unreadable plugin directory stops HQ from starting', async () => {
  const home = tempDir();
  try {
    await assert.rejects(startHQ({ home, pluginsDir: join(home, 'missing') }), /cannot read plugin directory/);
    assert.ok(!readdirSync(home).some((f) => f.endsWith('.sock')), 'no socket left behind');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

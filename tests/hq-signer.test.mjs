// The HQ signer (plan §9 PR 15, first slice; hq/signer.mjs): one pinned
// P-256 key behind a software or a helper backend, real signatures on
// approval records, and an honest key_storage in status and the profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideApproval } from '../sdk/services.mjs';
import { validateConfig } from '../hq/hq.mjs';
import { backendFromConfig, createSigner, helperKeyBackend, helperRunner, jwkThumbprint, publicJwk, softwareKeyBackend, SIGNER_PROTOCOL } from '../hq/signer.mjs';
import { startHQ, tempHome } from './hq-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, 'signer-helper-fixture.mjs');
const MAIN = join(HERE, '../hq/main.mjs');
const enrollment = { source: 'test', deviceStatus: async () => 'enrolled', enroll: () => ({}) };
const outside = () => join(mkdtempSync(join(tmpdir(), 'hq-hw-')), 'chip.pem'); // the fake chip, outside HQ's home
const helperCommand = (keyfile) => [process.execPath, HELPER, keyfile];
const helper = (keyfile, mode) => helperKeyBackend({ command: helperCommand(keyfile), run: helperRunner({ env: { ...process.env, ...(mode ? { FAKE_SIGNER_MODE: mode } : {}) } }) });
const software = (home) => softwareKeyBackend({ dir: join(home, 'signer') });
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

test('software backend: the first use makes a private key file and a pin, and signatures verify against the pinned key only', async () => {
  const home = tempHome();
  try {
    const signer = createSigner({ home, backend: software(home), enrollment });
    assert.equal(await signer.deviceStatus(), 'enrolled');
    const key = join(home, 'signer/device-key.pem');
    assert.equal(statSync(key).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, 'signer')).mode & 0o777, 0o700);
    const pin = JSON.parse(readFileSync(join(home, 'signer/pin.json'), 'utf8'));
    assert.deepEqual([pin.key_storage, pin.backend, pin.generation], ['software', 'software', 1]);
    assert.equal(pin.thumbprint, jwkThumbprint(pin.jwk));
    assert.equal('d' in pin.jwk, false, 'the pin holds the public key only');

    const sig = signer.sign(Buffer.from('approve this'));
    assert.match(sig, new RegExp(`^hq-sig-v1\\.${pin.thumbprint}\\.[A-Za-z0-9_-]{86}$`));
    assert.equal(signer.verify(Buffer.from('approve this'), sig), true);
    assert.equal(signer.verify(Buffer.from('approve that'), sig), false);
    assert.equal(signer.verify(Buffer.from('approve this'), sig.replace('hq-sig-v1', 'hq-sig-v2')), false);
    assert.equal(signer.verify(Buffer.from('approve this'), 'fake-sig-v0:00'), false);
    assert.deepEqual(signer.report(), { available: true, backend: 'software', key_storage: 'software', alg: 'ES256', thumbprint: pin.thumbprint, generation: 1, key_files: 1 });

    // The same key after a restart.
    const again = createSigner({ home, backend: software(home), enrollment });
    assert.equal(again.verify(Buffer.from('approve this'), sig), true);
    assert.equal(again.report().thumbprint, pin.thumbprint);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('signJws makes a compact ES256 JWS that an outside verifier accepts with the public key', () => {
  const home = tempHome();
  try {
    const signer = createSigner({ home, backend: software(home), enrollment });
    const jws = signer.signJws({ typ: 'JWT' }, { iss: 'device', aud: 'https://agents.example' });
    const [h, p, s] = jws.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url'));
    assert.deepEqual(header, { typ: 'JWT', alg: 'ES256', kid: signer.report().thumbprint });
    assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iss: 'device', aud: 'https://agents.example' });
    const key = createPublicKey({ key: signer.publicJwk(), format: 'jwk' });
    assert.equal(cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a key that is gone, swapped or readable by others is an unavailable signer', async () => {
  const home = tempHome();
  try {
    createSigner({ home, backend: software(home), enrollment }).report();
    const key = join(home, 'signer/device-key.pem');
    const original = readFileSync(key, 'utf8');

    chmodSync(key, 0o644);
    await assert.rejects(createSigner({ home, backend: software(home), enrollment }).deviceStatus(), /must be 0600/);
    chmodSync(key, 0o600);

    // Another key in its place: the pin does not move with it.
    const other = tempHome();
    createSigner({ home: other, backend: software(other), enrollment }).report();
    writeFileSync(key, readFileSync(join(other, 'signer/device-key.pem')), { mode: 0o600 });
    rmSync(other, { recursive: true, force: true });
    const swapped = createSigner({ home, backend: software(home), enrollment });
    await assert.rejects(swapped.deviceStatus(), /different key from the pinned one/);
    assert.equal(swapped.report().available, false);
    assert.throws(() => swapped.sign(Buffer.from('x')), /different key/);

    rmSync(key);
    await assert.rejects(createSigner({ home, backend: software(home), enrollment }).deviceStatus(), /gone from its backend/);

    writeFileSync(key, original, { mode: 0o600 });
    assert.equal(await createSigner({ home, backend: software(home), enrollment }).deviceStatus(), 'enrolled');

    writeFileSync(join(home, 'signer/pin.json'), '{"thumbprint":"x"}', { mode: 0o600 });
    await assert.rejects(createSigner({ home, backend: software(home), enrollment }).deviceStatus(), /not a signer pin/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('re-keying is explicit: a fresh key, a new generation, and the old key\'s signatures stop verifying', () => {
  const home = tempHome();
  try {
    const signer = createSigner({ home, backend: software(home), enrollment });
    const before = signer.report();
    const old = signer.sign(Buffer.from('record'));
    assert.throws(() => signer.createKey(), /re-enrollment/);
    const made = signer.createKey({ replace: true });
    assert.equal(made.generation, 2);
    assert.notEqual(made.thumbprint, before.thumbprint);
    assert.equal(signer.verify(Buffer.from('record'), old), false);
    assert.equal(signer.verify(Buffer.from('record'), signer.sign(Buffer.from('record'))), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('helper backend: key_storage is hardware and HQ\'s state directory holds no key file', async () => {
  const home = tempHome();
  const chip = outside();
  try {
    const signer = createSigner({ home, backend: helper(chip), enrollment });
    assert.equal(await signer.deviceStatus(), 'enrolled');
    const report = signer.report();
    assert.deepEqual([report.backend, report.key_storage, report.key_files, report.generation], ['helper', 'hardware', 0, 1]);
    const sig = signer.sign(Buffer.from('approve this'));
    assert.equal(signer.verify(Buffer.from('approve this'), sig), true);
    assert.deepEqual(walk(home).map((f) => f.slice(home.length + 1)), ['signer/pin.json']);
    assert.doesNotMatch(readFileSync(join(home, 'signer/pin.json'), 'utf8'), /PRIVATE KEY|"d"/);

    // A helper that already holds a key is adopted, not re-keyed.
    const home2 = tempHome();
    try {
      assert.equal(createSigner({ home: home2, backend: helper(chip), enrollment }).report().thumbprint, report.thumbprint);
    } finally { rmSync(home2, { recursive: true, force: true }); }
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(dirname(chip), { recursive: true, force: true }); }
});

test('a helper that misbehaves is refused: wrong protocol, a software claim, a private key, a foreign signature, a failure', () => {
  const chip = outside();
  const home = tempHome();
  try {
    createSigner({ home, backend: helper(chip), enrollment }).report(); // a good key first
    const cases = [['protocol', /speaks agent-bot-hq-signer\/9/], ['software', /key_storage=software/], ['private', /returned a private key/], ['exit', /failed on status \(exit 3/], ['garbage', /not JSON/]];
    for (const [mode, why] of cases) {
      const r = createSigner({ home, backend: helper(chip, mode), enrollment }).report();
      assert.equal(r.available, false, mode);
      assert.match(r.reason, why, mode);
    }
    const foreign = createSigner({ home, backend: helper(chip, 'wrong-key'), enrollment });
    assert.equal(foreign.report().available, true);
    assert.throws(() => foreign.sign(Buffer.from('x')), /pinned key does not verify/);
    assert.throws(() => createSigner({ home, backend: helper(chip), enrollment }).sign(Buffer.alloc(40_000)), /at most 32768 bytes/);
    assert.throws(() => helperKeyBackend({ command: [] }), /helper command/);
    assert.throws(() => publicJwk({ kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' }), /no valid x/);
    assert.equal(SIGNER_PROTOCOL, 'agent-bot-hq-signer/1');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(dirname(chip), { recursive: true, force: true }); }
});

test('signer config: software by default, a helper by absolute path, nothing else', () => {
  assert.equal(backendFromConfig(undefined, { home: '/h' }).kind, 'software');
  assert.equal(backendFromConfig({ backend: 'helper', command: ['/usr/local/bin/hq-signer'] }, { home: '/h' }).kind, 'helper');
  assert.doesNotThrow(() => validateConfig({ signer: { backend: 'helper', command: ['/usr/local/bin/hq-signer', '--slot', '1'] } }));
  assert.doesNotThrow(() => validateConfig({ signer: { backend: 'software' } }));
  assert.throws(() => validateConfig({ signer: { backend: 'helper' } }), /signer\.command/);
  assert.throws(() => validateConfig({ signer: { backend: 'helper', command: ['hq-signer'] } }), /absolute path/);
  assert.throws(() => validateConfig({ signer: { backend: 'software', command: ['/x'] } }), /only for the helper/);
  assert.throws(() => validateConfig({ signer: { backend: 'cloud' } }), /software or helper/);
  assert.throws(() => validateConfig({ signer: { key: 'x' } }), /unknown key signer\.key/);
});

test('HQ: status names the signer and its custody, a software key is a stated reason protected is out of reach, and approvals carry a real signature', async () => {
  const t = await startHQ();
  try {
    const owner = await t.owner();
    const s = (await owner.request('status')).result;
    assert.equal(s.mode, 'running');
    assert.deepEqual([s.hq.signer.available, s.hq.signer.backend, s.hq.signer.key_storage, s.hq.signer.generation], [true, 'software', 'software', 1]);
    assert.match(s.hq.profileReasons.join('\n'), /key_storage=software/);
    assert.equal(JSON.stringify(s).includes('PRIVATE KEY'), false);

    t.hq.core.approvals.set('appr_test', { id: 'appr_test', plugin: 'p', digest: `sha256:${'0'.repeat(64)}`, state: 'pending' });
    const decided = decideApproval(t.hq.core, 'appr_test', 'approved');
    assert.match(decided.signature, /^hq-sig-v1\./);
    assert.equal(t.hq.core.signer.verify(Buffer.from(`appr_test\n${decided.digest}\napproved`), decided.signature), true);
    assert.equal(t.hq.core.signer.verify(Buffer.from(`appr_test\n${decided.digest}\ndenied`), decided.signature), false);
  } finally { await t.done(); }
});

test('HQ on a helper: hardware custody in status, no key file in the state directory, and the software reason is gone', async () => {
  const chip = outside();
  const t = await startHQ({ config: { signer: { backend: 'helper', command: helperCommand(chip) } } });
  try {
    const s = (await (await t.owner()).request('status')).result;
    assert.deepEqual([s.hq.signer.backend, s.hq.signer.key_storage, s.hq.signer.key_files], ['helper', 'hardware', 0]);
    assert.doesNotMatch(s.hq.profileReasons.join('\n'), /key_storage|hardware key/);
    assert.equal(s.profile, 'managed-cooperative', 'the other conditions still hold the host at cooperative');
    assert.deepEqual(walk(t.home).filter((f) => /\.pem$/.test(f)), []);
  } finally { await t.done(); rmSync(dirname(chip), { recursive: true, force: true }); }
});

test('HQ with an unavailable signer starts in safe mode and says why', async () => {
  const home = tempHome();
  const first = await startHQ({ home });
  await first.done({ keep: true });
  rmSync(join(home, 'signer/device-key.pem'));
  const t = await startHQ({ home });
  try {
    assert.equal(t.status.mode, 'safe');
    assert.match(t.status.reason, /signer unavailable: the pinned signer key is gone/);
    assert.equal(t.status.hq.signer.available, false);
  } finally { await t.done(); }
});

test('signer rekey: moves custody to the helper, removes the key file, and is refused while HQ runs', async () => {
  const home = tempHome();
  const chip = outside();
  const cli = (...args) => spawnSync(process.execPath, [MAIN, ...args, '--home', home, '--json'], { encoding: 'utf8' });
  try {
    const first = await startHQ({ home, config: {} });
    const before = first.status.hq.signer;
    // Asynchronous: this process is also the HQ the command talks to.
    const live = await new Promise((resolve) => {
      execFile(process.execPath, [MAIN, 'signer', 'rekey', '--home', home], { encoding: 'utf8', timeout: 20_000 }, (err, stdout, stderr) => resolve({ status: err ? (err.code ?? -1) : 0, stderr }));
    });
    assert.notEqual(live.status, 0);
    assert.match(live.stderr, /HQ is running/);
    await first.done({ keep: true });
    assert.equal(existsSync(join(home, 'signer/device-key.pem')), true);

    // The owner points HQ at the helper. Without a rekey the pin still names the old custody.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ signer: { backend: 'helper', command: helperCommand(chip) } }), { mode: 0o600 });
    const stale = createSigner({ home, backend: backendFromConfig({ backend: 'helper', command: helperCommand(chip) }, { home }), enrollment });
    assert.match(stale.report().reason, /changing custody is a re-enrollment/);

    const out = JSON.parse(execFileSync(process.execPath, [MAIN, 'signer', 'rekey', '--home', home, '--json'], { encoding: 'utf8' }));
    assert.deepEqual([out.key_storage, out.generation, out.software_key_removed], ['hardware', 2, true]);
    assert.notEqual(out.thumbprint, before.thumbprint);
    assert.equal(existsSync(join(home, 'signer/device-key.pem')), false);
    assert.equal(cli('signer', 'nope').status, 1);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(dirname(chip), { recursive: true, force: true }); }
});

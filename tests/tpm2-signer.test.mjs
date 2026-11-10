// The TPM 2.0 signer helper (plan §9 row 15b; helpers/tpm2-signer.mjs),
// run against a software TPM (swtpm) with tpm2-tools. A software TPM proves
// the helper and the tpm2-tools calls, not hardware custody: qualification
// on a real TPM is separate and is what changes the feature flag's default.
//
// The tests skip where swtpm or tpm2-tools is missing. CI sets
// HQ_REQUIRE_TPM=1, which turns that skip into a failure.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSigner, helperKeyBackend, helperRunner } from '../hq/signer.mjs';
import { startHQ, tempHome } from './hq-harness.mjs';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), '../helpers/tpm2-signer.mjs');
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
const available = process.platform === 'linux' && has('swtpm') && has('tpm2_sign') && has('tpm2_createprimary');
const required = process.env.HQ_REQUIRE_TPM === '1';
const skip = available ? false : 'swtpm and tpm2-tools are not installed';
const PORT = 23210 + (process.pid % 500) * 2;
const env = { ...process.env, TPM2TOOLS_TCTI: `swtpm:host=127.0.0.1,port=${PORT}` };
const enrollment = { source: 'test', deviceStatus: async () => 'enrolled', enroll: () => ({}) };
const command = (handle) => [process.execPath, HELPER, ...(handle ? ['--handle', handle] : [])];
const backend = (handle) => helperKeyBackend({ command: command(handle), run: helperRunner({ env }) });
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

let swtpm;
let state;

const listening = (port) => new Promise((resolve) => {
  const s = createConnection({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

before(async () => {
  if (!available) return;
  state = mkdtempSync(join(tmpdir(), 'hq-swtpm-'));
  swtpm = spawn('swtpm', ['socket', '--tpm2', '--tpmstate', `dir=${state}`, '--server', `type=tcp,port=${PORT}`, '--ctrl', `type=tcp,port=${PORT + 1}`, '--flags', 'not-need-init,startup-clear'], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !(await listening(PORT + 1)); i++) await new Promise((r) => setTimeout(r, 50));
});

after(() => {
  swtpm?.kill('SIGTERM');
  if (state) rmSync(state, { recursive: true, force: true });
});

test('CI has a software TPM to test against', { skip: !required }, () => {
  assert.equal(available, true, 'HQ_REQUIRE_TPM=1 but swtpm or tpm2-tools is missing (or this is not Linux)');
});

// When a helper call fails, say what tpm2-tools said: HQ itself ignores stderr.
function explain(handle, op, input = '{}') {
  const r = spawnSync(process.execPath, [HELPER, '--handle', handle, op], { input, env, encoding: 'utf8' });
  return `${op} exit ${r.status}: ${r.stderr.trim() || r.stdout.trim()}`;
}

test('TPM helper: creates a key in the TPM, signs with it, and HQ holds no key file', { skip }, async () => {
  const home = tempHome();
  try {
    const probe = spawnSync(process.execPath, [HELPER, '--handle', '0x8101002f', 'create'], { input: '{}', env, encoding: 'utf8' });
    assert.equal(probe.status, 0, `create exit ${probe.status}: ${probe.stderr}`);
    assert.match(explain('0x8101002f', 'create'), /already exists/);
    const signer = createSigner({ home, backend: backend(), enrollment });
    assert.equal(await signer.deviceStatus(), 'enrolled');
    const report = signer.report();
    assert.deepEqual([report.available, report.backend, report.key_storage, report.key_files, report.generation], [true, 'helper', 'hardware', 0, 1]);
    const sig = signer.sign(Buffer.from('approve this'));
    assert.equal(signer.verify(Buffer.from('approve this'), sig), true, 'the TPM signature verifies against the pinned public key');
    assert.equal(signer.verify(Buffer.from('approve that'), sig), false);
    assert.equal(signer.signJws({ typ: 'JWT' }, { iss: 'device' }).split('.').length, 3);
    assert.deepEqual(walk(home).map((f) => f.slice(home.length + 1)), ['signer/pin.json']);

    // The key survives a new HQ process: the pin still matches what the TPM holds.
    assert.equal(createSigner({ home, backend: backend(), enrollment }).report().thumbprint, report.thumbprint);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('TPM helper: re-keying evicts the old key and makes a new one; create without replace is refused', { skip }, () => {
  const home = tempHome();
  const handle = '0x81010021';
  try {
    const signer = createSigner({ home, backend: backend(handle), enrollment });
    const first = signer.report();
    const old = signer.sign(Buffer.from('record'));
    const refused = spawnSync(process.execPath, [HELPER, '--handle', handle, 'create'], { input: '{}', env, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /already exists/);
    const made = signer.createKey({ replace: true });
    assert.equal(made.generation, 2);
    assert.notEqual(made.thumbprint, first.thumbprint);
    assert.equal(signer.verify(Buffer.from('record'), old), false);
    assert.equal(signer.verify(Buffer.from('record'), signer.sign(Buffer.from('record'))), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('TPM helper: bad input and a missing key fail without output HQ could mistake for an answer', { skip }, () => {
  const run = (args, input = '{}') => spawnSync(process.execPath, [HELPER, ...args], { input, env, encoding: 'utf8' });
  const empty = run(['--handle', '0x81010022', 'status']);
  assert.deepEqual(JSON.parse(empty.stdout), { protocol: 'agent-bot-hq-signer/1', key_storage: 'hardware', present: false });
  for (const r of [run(['--handle', '0x81010022', 'sign'], '{"message":"aGk"}'), run(['--handle', '0x01000000', 'status']), run(['sign'], '{"message":"not base64!"}'), run(['sign'], '{}'), run(['nope'])]) {
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^tpm2-signer: /);
  }
});

test('HQ runs on the TPM helper when the hardwareSigner feature is on', { skip }, async () => {
  const saved = process.env.TPM2TOOLS_TCTI;
  process.env.TPM2TOOLS_TCTI = env.TPM2TOOLS_TCTI; // HQ's default helper runner inherits the environment
  const t = await startHQ({ config: { features: { hardwareSigner: true }, signer: { backend: 'helper', command: command('0x81010023') } } });
  try {
    const s = (await (await t.owner()).request('status')).result;
    assert.equal(s.mode, 'running');
    assert.deepEqual([s.hq.signer.available, s.hq.signer.key_storage, s.hq.signer.key_files], [true, 'hardware', 0]);
    assert.deepEqual(walk(t.home).filter((f) => /\.pem$/.test(f)), []);
  } finally {
    await t.done();
    if (saved === undefined) delete process.env.TPM2TOOLS_TCTI; else process.env.TPM2TOOLS_TCTI = saved;
  }
});

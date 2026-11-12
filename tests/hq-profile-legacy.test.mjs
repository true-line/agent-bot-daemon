// Profile reporting (hq/profile.mjs, R8) and the strangler bridge to the
// existing daemon (hq/legacy.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProfile, profileWarning } from '../hq/profile.mjs';
import { deviceStateFrom, execRunner, legacyDaemon, legacySigner } from '../hq/legacy.mjs';
import { fakeLegacy } from './hq-harness.mjs';

test('HQ in the owner account reports managed-cooperative and every reason protected is out of reach', () => {
  const p = detectProfile({ platform: 'darwin', account: 'user' });
  assert.equal(p.profile, 'managed-cooperative');
  assert.equal(p.reasons.length, 4);
  assert.match(p.reasons[0], /user account, not _agent-bot-hq \(D6/);
  assert.match(p.reasons[1], /share one account: no OS account per harness credential \(D7\)$/);
  assert.match(p.reasons[2], /T01–T03, T21/);
  assert.match(p.reasons[3], /not known to be a hardware key/);
  assert.match(detectProfile({ platform: 'darwin', account: 'user', keyStorage: 'software' }).reasons[3], /key_storage=software/);
  assert.equal(detectProfile({ platform: 'darwin', account: 'user', keyStorage: 'hardware' }).reasons.length, 3);
});

test('even in its own account, HQ without harness accounts and qualification is not protected', () => {
  for (const [platform, account] of [['darwin', '_agent-bot-hq'], ['linux', 'agent-bot-hq']]) {
    const p = detectProfile({ platform, account, keyStorage: 'hardware' });
    assert.equal(p.profile, 'managed-cooperative', platform);
    assert.equal(p.reasons.length, 2);
  }
  // Everything else in place, a key file still keeps the host out of protected.
  const all = { platform: 'linux', account: 'agent-bot-hq', harnessAccounts: true, qualified: true };
  assert.equal(detectProfile({ ...all, keyStorage: 'hardware' }).profile, 'managed-protected');
  assert.equal(detectProfile({ ...all, keyStorage: 'software' }).profile, 'managed-cooperative');
  assert.equal(detectProfile(all).profile, 'managed-cooperative');
  assert.equal(detectProfile({ platform: 'linux', account: 'agent-bot-hq', harnessAccounts: true }).profile, 'managed-cooperative');
  assert.match(detectProfile({ platform: 'win32', account: 'x' }).reasons[0], /no HQ account defined/);
});

test('harness accounts (row 16b): a stated gap is the reason, and in place they drop the reason but not the label', () => {
  const base = { platform: 'linux', account: 'user', keyStorage: 'software' };
  const gap = 'agents whose harness has no account of its own: agent_x/m_spec (adapter x) (D7)';
  const p = detectProfile({ ...base, harnessAccounts: gap });
  assert.equal(p.profile, 'managed-cooperative');
  assert.equal(p.reasons[1], gap);
  assert.match(profileWarning('managed-protected', p.profile, p.reasons), /\(agents whose harness has no account of its own/);
  const none = detectProfile({ ...base, harnessAccounts: true });
  assert.equal(none.profile, 'managed-cooperative');
  assert.equal(none.reasons.length, 3);
  assert.ok(!none.reasons.some((r) => r.endsWith('(D7)')));
  assert.match(detectProfile({ ...base, harnessAccounts: '' }).reasons[1], /share one account/);
});

test('standalone is reported when the owner chose it', () => {
  const p = detectProfile({ platform: 'darwin', account: 'user', standalone: true });
  assert.equal(p.profile, 'standalone-unenforced');
  assert.match(p.reasons[0], /owner chose standalone/);
});

test('a weaker profile than requested carries a warning; an equal or stronger one does not', () => {
  const { reasons } = detectProfile({ platform: 'darwin', account: 'user' });
  assert.match(profileWarning('managed-protected', 'managed-cooperative', reasons), /^profile: managed-protected requested; managed-cooperative in force \(agents of every harness share one account/);
  assert.equal(profileWarning('managed-cooperative', 'managed-cooperative', reasons), undefined);
  assert.equal(profileWarning('standalone-unenforced', 'managed-cooperative', reasons), undefined);
  assert.equal(profileWarning(undefined, 'managed-cooperative', reasons), undefined);
});

test('device state from the legacy enrollment: enrolled, unenrolled, revoked, or nothing', () => {
  assert.equal(deviceStateFrom({ enrolled: true }), 'enrolled');
  assert.equal(deviceStateFrom({ enrolled: false }), 'unenrolled');
  assert.equal(deviceStateFrom({ enrolled: true, remote: { revoked: true } }), 'revoked');
  assert.equal(deviceStateFrom({ enrolled: true, remote: { status: 'revoked' } }), 'revoked');
  assert.equal(deviceStateFrom({ error: 'invalid_grant' }), 'revoked');
  assert.equal(deviceStateFrom({}), undefined);
  assert.equal(deviceStateFrom([]), undefined);
  assert.equal(deviceStateFrom(null), undefined);
});

test('the legacy signer reports device state and throws when it cannot read one; it never signs', async () => {
  const l = fakeLegacy({ device: 'enrolled' });
  const signer = legacySigner({ run: l.run });
  assert.equal(await signer.deviceStatus(), 'enrolled');
  l.state.device = 'broken';
  await assert.rejects(signer.deviceStatus(), /gave no device state/);
  assert.throws(() => signer.sign(Buffer.from('x')), /legacy enrollment signs nothing/);
  assert.equal(signer.verify(), false);
  assert.throws(() => signer.enroll(), (e) => e.code === 'host.invalid_request');
});

test('the legacy daemon is probed, reported without its Soul list, and never started unless supervised', async () => {
  const l = fakeLegacy({ daemon: 'stopped' });
  const watch = legacyDaemon({ run: l.run, clock: { now: () => 1 } });
  assert.deepEqual(await watch.tick(), { state: 'stopped', checkedAt: 1, version: '0.15.17', pid: 4242 });
  assert.ok(!l.state.calls.some((c) => c.includes('daemon start')));
  assert.equal(JSON.stringify(watch.report()).includes('soulDir'), false);

  const supervised = legacyDaemon({ run: l.run, supervise: true, clock: { now: () => 2 } });
  const after = await supervised.tick();
  assert.equal(after.state, 'running');
  assert.equal(after.startAttempted, true);
  assert.equal(supervised.report().starts, 1);
  await supervised.tick();
  assert.equal(supervised.report().starts, 1, 'a running daemon is left alone');

  l.state.daemon = 'garbled';
  const unknown = await supervised.tick();
  assert.equal(unknown.state, 'unknown');
  assert.equal(supervised.report().starts, 1, 'unknown is never treated as stopped');
});

test('the default runner executes without a shell and reports exit codes', async () => {
  const run = execRunner();
  const ok = await run([process.execPath, '-e', 'console.log(JSON.stringify({ running: true }))']);
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(ok.stdout), { running: true });
  const bad = await run([process.execPath, '-e', 'process.exit(3)']);
  assert.equal(bad.code, 3);
  const missing = await run(['/nonexistent/agent-bot-hq-test']);
  assert.notEqual(missing.code, 0);
  assert.ok(missing.error);
});

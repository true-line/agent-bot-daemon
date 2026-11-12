// Harness accounts and their broker endpoints (plan §9 row 16a; T01; D7 as
// amended by platform PDR-0053: one OS account per harness credential).
//
// These tests run everywhere: the caller's account is the endpoint a
// connection arrives on, so two endpoint directories stand in for two
// accounts and an injected resolver gives them different uids. What they
// cannot show is the kernel refusing another account at connect; that is
// tests/hq-harness-accounts-real.test.mjs, on real accounts in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, renameSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { bindProof } from '../hq/admission.mjs';
import { validateConfig } from '../hq/hq.mjs';
import { planHarnessEndpoints, resolveAccount, validateHarnessesConfig } from '../hq/harness-accounts.mjs';
import { referenceBroker } from './broker-fixture.mjs';
import { DIGEST, fakeSudo, HARNESS_UIDS as UIDS, harnessLayout as layout, hello, helloOn, SOUL, startHQ } from './hq-harness.mjs';

const A = 'hqm_a';
const B = 'hqm_b';
const hqUid = process.getuid();

// The lead runs on adapter-a, the specialist on adapter-b (helloOn).
const harnessesConfig = (dir, accounts = { 'adapter-a': A, 'adapter-b': B }) => ({ dir, accounts });

async function setup({ home, dir, resolve, lstat, accounts, roles = ['adapter-a', 'adapter-b'] } = {}) {
  const made = dir ? undefined : layout();
  const t = await startHQ({
    ...(home ? { home } : {}),
    platform: 'linux',
    accounts: resolve ?? made.resolve,
    harnessLstat: lstat ?? made.lstat,
    launch: { spawn: fakeSudo().spawn },
    config: { acceptedDefinitions: { [SOUL]: [DIGEST] }, harnesses: harnessesConfig(dir ?? made.dir, accounts) },
    plugins: [referenceBroker()],
  });
  const endpoint = (account) => t.status.hq.sockets.harnesses.find((m) => m.account === account).path;
  const on = (account) => t.member(account ? endpoint(account) : undefined);
  // The whole bind: HQ's challenge, then the proof keyed with `key`.
  const bind = async (conn, runtimeId, key) => {
    const challenge = await conn.request('bind.challenge', { runtime_id: runtimeId });
    assert.equal(challenge.ok, true, JSON.stringify(challenge));
    return conn.request('bind', { runtime_id: runtimeId, proof: bindProof(key, challenge.result.nonce, runtimeId) });
  };
  const admit = async () => {
    const entry = await t.entry();
    const r = (await entry.request('Hello', helloOn(...roles))).result;
    const rt = (role) => r.admitted_runtimes.find((a) => a.role === role);
    return { lead: rt('lead'), spec: rt('specialist') };
  };
  const receipts = (kind) => t.hq.core.receipts.filter((r) => r.kind === kind);
  return { ...t, made, endpoint, on, bind, admit, receipts, cleanup: async (opts) => { await t.done(opts); if (!opts?.keep) made?.remove(); } };
}
const refused = (res, code = 'caller_mismatch') => {
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.refusal?.error ?? res.host_refusal?.code, code, JSON.stringify(res));
};

test('harnesses config: adapter IDs to accounts, shared accounts allowed, the old members key refused, nothing off Linux', () => {
  const ok = { accounts: { 'adapter-a': A, 'adapter-b': B, 'adapter-c': A } };
  assert.equal(validateHarnessesConfig(ok), ok);
  assert.doesNotThrow(() => validateConfig({ harnesses: { dir: '/run/x', ...ok } }));
  for (const [bad, why] of [
    [null, /harnesses is an object/],
    [{ accounts: ok.accounts, extra: 1 }, /unknown key harnesses.extra/],
    [{ dir: 'relative', ...ok }, /absolute path/],
    [{}, /maps adapter IDs to accounts/],
    [{ accounts: [] }, /maps adapter IDs to accounts/],
    [{ accounts: { 'bad id!': A } }, /not an adapter ID/],
    [{ accounts: { [`a${'x'.repeat(128)}`]: A } }, /not an adapter ID/],
    [{ accounts: { 'adapter-a': 'Root User' } }, /not an account name/],
    [{ accounts: { 'adapter-a': 7 } }, /not an account name/],
  ]) assert.throws(() => validateHarnessesConfig(bad), why);
  // The 16a shape, keyed by Soul and member, is gone; the refusal names its replacement.
  assert.throws(() => validateConfig({ members: { accounts: { [SOUL]: { m_lead: A } } } }), /unknown key members; .*harnesses: \{ dir\?, accounts: \{ <adapter_id>: <account> \} \}/);
  const l = layout();
  try {
    assert.throws(() => planHarnessEndpoints(harnessesConfig(l.dir), { hqUid, platform: 'darwin', resolve: l.resolve, lstat: l.lstat }), /needs the Linux protected profile/);
  } finally { l.remove(); }
});

test('the endpoint layout is verified, never repaired', () => {
  const l = layout();
  const plan = (over = {}, cfg = harnessesConfig(l.dir)) => planHarnessEndpoints(cfg, { hqUid, platform: 'linux', resolve: l.resolve, lstat: l.lstat, ...over });
  try {
    const planned = plan();
    assert.deepEqual(planned.endpoints.map((e) => [e.account, e.uid, e.path, e.home, e.adapters]), [[A, UIDS[A], join(l.dir, A, 'broker.sock'), l.homes[A], ['adapter-a']], [B, UIDS[B], join(l.dir, B, 'broker.sock'), l.homes[B], ['adapter-b']]]);
    assert.equal(planned.accountOf('adapter-a').account, A);
    assert.equal(planned.accountOf('adapter-other'), undefined);
    assert.equal(planned.accountOf('constructor'), undefined, 'only the config\'s own keys');
    // Two adapters on one account: one endpoint, resolved once.
    const resolved = [];
    const shared = plan({ resolve: (n) => { resolved.push(n); return l.resolve(n); } }, harnessesConfig(l.dir, { 'adapter-a': A, 'adapter-c': A, 'adapter-b': B }));
    assert.deepEqual(shared.endpoints.map((e) => [e.account, e.adapters]), [[A, ['adapter-a', 'adapter-c']], [B, ['adapter-b']]]);
    assert.deepEqual(resolved, [A, B]);
    assert.equal(shared.accountOf('adapter-c'), shared.accountOf('adapter-a'));

    const as = (name, info) => (n) => (n === name ? { ...l.resolve(n), ...info } : l.resolve(n));
    assert.throws(() => plan({ resolve: as(A, { uid: 0 }) }), /is root/);
    assert.throws(() => plan({ resolve: as(A, { uid: hqUid }) }), /HQ's own account/);
    assert.throws(() => plan({ resolve: as(B, { uid: UIDS[A] }) }), /share uid/);
    assert.throws(() => plan({ resolve: as(A, { groupMembers: ['mallory'] }) }), /must be a private group/);
    assert.throws(() => plan({ resolve: as(A, { gid: l.gids[A] + 1 }) }), /has group/);
    assert.throws(() => plan({ hqUid: hqUid + 1 }), /owned by uid/);
    assert.throws(() => plan({}, harnessesConfig(l.dir, { 'adapter-a': A, 'adapter-b': 'hqm_missing' })), /does not exist on this host/);
    assert.throws(() => plan({}, harnessesConfig(join(l.dir, 'nowhere'))), /does not exist; the provisioner creates it/);

    chmodSync(join(l.dir, A), 0o750);
    assert.throws(() => plan(), /must be 2750/);
    chmodSync(join(l.dir, A), 0o2770);
    assert.throws(() => plan(), /must be 2750/);
    chmodSync(join(l.dir, A), 0o2750);
    chmodSync(l.dir, 0o775);
    assert.throws(() => plan(), /writable by group or others/);
    chmodSync(l.dir, 0o750);
    assert.throws(() => plan(), /traverse/);
  } finally { l.remove(); }
});

test('a harness account\'s home is verified, never repaired: a real directory, the account\'s, 0700 (row 16b)', () => {
  const l = layout();
  const plan = (over = {}) => planHarnessEndpoints(harnessesConfig(l.dir), { hqUid, platform: 'linux', resolve: l.resolve, lstat: l.lstat, ...over });
  const as = (name, info) => (n) => (n === name ? { ...l.resolve(n), ...info } : l.resolve(n));
  try {
    assert.doesNotThrow(() => plan());
    assert.throws(() => plan({ resolve: as(A, { home: '' }) }), /no home directory of its own/);
    assert.throws(() => plan({ resolve: as(A, { home: 'relative/home' }) }), /no home directory of its own/);
    assert.throws(() => plan({ resolve: as(A, { home: '/' }) }), /no home directory of its own/);
    assert.throws(() => plan({ resolve: as(A, { home: join(l.homes[A], 'missing') }) }), /does not exist; the provisioner creates it/);
    // Owned by someone else: HQ's account, or the other harness account.
    l.owners[A] = hqUid;
    assert.throws(() => plan(), /is owned by uid/);
    l.owners[A] = UIDS[B];
    assert.throws(() => plan(), /is owned by uid/);
    l.owners[A] = UIDS[A];
    // Exactly 0700: any group or other bit, less than the owner's full
    // access, or a sticky bit is refused, and the message names the mode.
    for (const mode of [0o000, 0o400, 0o500, 0o600, 0o750, 0o705, 0o701, 0o710, 0o770, 0o1700]) {
      chmodSync(l.homes[A], mode);
      const found = mode.toString(8).padStart(4, '0');
      assert.throws(() => plan(), new RegExp(`has mode ${found}; .*must be 0700`), found);
    }
    // setuid and setgid on a directory, which an unprivileged chmod may not
    // keep, through lstat.
    chmodSync(l.homes[A], 0o700);
    for (const bits of [0o4000, 0o2000]) {
      const lstat = (path) => { const st = l.lstat(path); return path === l.homes[A] ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mode: st.mode | bits }) : st; };
      assert.throws(() => plan({ lstat }), new RegExp(`has mode ${(0o700 | bits).toString(8)}; .*must be 0700`), bits.toString(8));
    }
    assert.equal((statSync(l.homes[A]).mode & 0o7777), 0o700);
    assert.doesNotThrow(() => plan(), '0700 is accepted');
    // A symlink to a good directory is still refused.
    renameSync(l.homes[A], `${l.homes[A]}.real`);
    symlinkSync(`${l.homes[A]}.real`, l.homes[A]);
    assert.throws(() => plan(), /is not a directory/);
  } finally { l.remove(); }
});

test('an account is read from the host through getent', () => {
  const run = (file, args) => {
    assert.equal(file, 'getent');
    if (args[0] === 'passwd' && args[1] === A) return `${A}:x:1201:1301::/home/${A}:/usr/sbin/nologin\n`;
    if (args[0] === 'passwd' && args[1] === 'short_entry') return 'short_entry:x:1202:1302\n';
    if (args[0] === 'group' && args[1] === '1301') return `${A}:x:1301:${A},guest\n`;
    throw new Error('exit 2');
  };
  assert.deepEqual(resolveAccount(A, { run }), { uid: 1201, gid: 1301, groupMembers: [A, 'guest'], home: `/home/${A}` });
  assert.throws(() => resolveAccount('short_entry', { run }), /unreadable passwd entry/);
  assert.throws(() => resolveAccount('nobody_here', { run }), /does not exist on this host/);
});

test('HQ opens one 0660 endpoint per harness account and names them in status', async () => {
  const t = await setup();
  try {
    assert.deepEqual(t.status.hq.sockets.harnesses.map((m) => [m.account, m.adapters]), [[A, ['adapter-a']], [B, ['adapter-b']]]);
    for (const account of [A, B]) assert.equal(statSync(t.endpoint(account)).mode & 0o777, 0o660);
    // The shared socket is still there, still 0600.
    assert.equal(statSync(t.hq.paths.broker).mode & 0o777, 0o600);
  } finally { await t.cleanup(); }
});

test('an agent binds from its harness account\'s endpoint with a keyed proof, and the binding is never sent', async () => {
  const t = await setup();
  try {
    const { lead } = await t.admit();
    const conn = await t.on(A);
    const res = await t.bind(conn, lead.runtime_id, lead.channel_binding);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.member_id, 'm_lead');
    const [receipt] = t.receipts('hq.bind');
    assert.equal(receipt.caller_account, A);
    assert.equal(receipt.proof, 'hmac-sha256');
    assert.ok(!JSON.stringify(t.hq.core.receipts).includes(lead.channel_binding), 'no receipt carries the binding');
    // The bound connection then works as before.
    assert.equal((await conn.request('task.directives', {})).ok, true);
  } finally { await t.cleanup(); }
});

test('T01: a binding copied to another harness account is refused, whatever it presents', async () => {
  const t = await setup();
  try {
    const { lead, spec } = await t.admit();
    // Account B holds A's runtime ID and A's channel binding.
    refused(await t.bind(await t.on(B), lead.runtime_id, lead.channel_binding));
    // The shared socket does not speak for an account-bound runtime, in either form.
    refused(await t.bind(await t.on(), lead.runtime_id, lead.channel_binding));
    refused(await (await t.on()).request('bind', { runtime_id: lead.runtime_id, channel_binding: lead.channel_binding }));
    // Nor does the right endpoint with the binding sent in the clear, or with the wrong key.
    refused(await (await t.on(A)).request('bind', { runtime_id: lead.runtime_id, channel_binding: lead.channel_binding }));
    refused(await t.bind(await t.on(A), lead.runtime_id, spec.channel_binding));
    // B is still B: its own runtime binds from its own endpoint.
    assert.equal((await t.bind(await t.on(B), spec.runtime_id, spec.channel_binding)).ok, true);
    // Every refusal reads the same, and none names the account it should have been.
    const refusals = t.receipts('hq.bind.refused');
    assert.equal(refusals.length, 5);
    assert.deepEqual([...new Set(refusals.map((r) => r.code))], ['caller_mismatch']);
    assert.deepEqual(refusals.map((r) => r.caller_account), [B, undefined, undefined, A, A]);
  } finally { await t.cleanup(); }
});

test('a challenge is for one connection, one runtime, one use, and sixty seconds', async () => {
  const t = await setup();
  try {
    const { lead, spec } = await t.admit();
    const proofFor = async (conn, runtimeId, key) => bindProof(key, (await conn.request('bind.challenge', { runtime_id: runtimeId })).result.nonce, runtimeId);

    // A proof with no challenge on this connection.
    const one = await t.on(A);
    const other = await t.on(A);
    const proof = await proofFor(one, lead.runtime_id, lead.channel_binding);
    refused(await other.request('bind', { runtime_id: lead.runtime_id, proof }));
    // A wrong answer spends the challenge: the right proof for it no longer binds.
    refused(await one.request('bind', { runtime_id: lead.runtime_id, proof: 'f'.repeat(64) }));
    refused(await one.request('bind', { runtime_id: lead.runtime_id, proof }));
    // A challenge asked for another runtime.
    const mixed = await t.on(A);
    const nonce = (await mixed.request('bind.challenge', { runtime_id: spec.runtime_id })).result.nonce;
    refused(await mixed.request('bind', { runtime_id: lead.runtime_id, proof: bindProof(lead.channel_binding, nonce, lead.runtime_id) }));
    // An expired challenge.
    const slow = await t.on(A);
    const late = await proofFor(slow, lead.runtime_id, lead.channel_binding);
    t.clock.advance(60_000);
    refused(await slow.request('bind', { runtime_id: lead.runtime_id, proof: late }));
    // An unknown runtime gets a challenge like any other, and the same refusal.
    const probe = await t.on(A);
    const ghost = await probe.request('bind.challenge', { runtime_id: 'rt_doesnotexist' });
    assert.equal(ghost.ok, true);
    refused(await probe.request('bind', { runtime_id: 'rt_doesnotexist', proof: bindProof('x'.repeat(24), ghost.result.nonce, 'rt_doesnotexist') }));
    // Malformed frames are invalid requests, not mismatches.
    refused(await probe.request('bind', { runtime_id: lead.runtime_id, proof: 'short' }), 'host.invalid_request');
    refused(await probe.request('bind', { runtime_id: lead.runtime_id }), 'host.invalid_request');
    refused(await probe.request('bind.challenge', { runtime_id: lead.runtime_id, extra: 1 }), 'host.invalid_request');
  } finally { await t.cleanup(); }
});

test('T01 after a restart: the account a runtime was admitted for is in the store', async () => {
  const first = await setup();
  const { lead, spec } = await first.admit();
  const { home } = first;
  const { dir, resolve, lstat } = first.made;
  await first.cleanup({ keep: true });
  const again = await setup({ home, dir, resolve, lstat });
  try {
    refused(await again.bind(await again.on(B), lead.runtime_id, lead.channel_binding));
    refused(await (await again.on()).request('bind', { runtime_id: lead.runtime_id, channel_binding: lead.channel_binding }));
    assert.equal((await again.bind(await again.on(A), lead.runtime_id, lead.channel_binding)).ok, true);
    assert.equal((await again.bind(await again.on(B), spec.runtime_id, spec.channel_binding)).ok, true);
  } finally {
    await again.done();
    first.made.remove();
  }
});

test('an agent whose harness has no account keeps the shared socket; an account endpoint never speaks for it', async () => {
  const t = await setup({ accounts: { 'adapter-a': A } });
  try {
    const { lead, spec } = await t.admit();
    assert.deepEqual(t.status.hq.sockets.harnesses.map((m) => m.account), [A]);
    // The specialist's harness has no account: cooperative, as before, in either form.
    assert.equal((await (await t.on()).request('bind', { runtime_id: spec.runtime_id, channel_binding: spec.channel_binding })).ok, true);
    assert.equal((await t.bind(await t.on(), spec.runtime_id, spec.channel_binding)).ok, true);
    // But not through a harness account's endpoint.
    refused(await t.bind(await t.on(A), spec.runtime_id, spec.channel_binding));
    assert.equal((await t.bind(await t.on(A), lead.runtime_id, lead.channel_binding)).ok, true);
  } finally { await t.cleanup(); }
});

test('two adapters on one account share its endpoint, and both agents bind there; only the keyed proof tells them apart', async () => {
  const t = await setup({ accounts: { 'adapter-a': A, 'adapter-c': A } , roles: ['adapter-a', 'adapter-c'] });
  try {
    assert.deepEqual(t.status.hq.sockets.harnesses.map((m) => [m.account, m.adapters]), [[A, ['adapter-a', 'adapter-c']]]);
    const { lead, spec } = await t.admit();
    const [rl, rs] = [lead, spec].map((r) => t.hq.core.tables.get('hq-admission\0runtimes').get(r.runtime_id));
    assert.deepEqual([rl.harness_account, rl.adapter_id, rs.harness_account, rs.adapter_id], [A, 'adapter-a', A, 'adapter-c']);
    assert.equal((await t.bind(await t.on(A), lead.runtime_id, lead.channel_binding)).ok, true);
    assert.equal((await t.bind(await t.on(A), spec.runtime_id, spec.channel_binding)).ok, true);
    // Same account, the other agent's key: refused.
    refused(await t.bind(await t.on(A), lead.runtime_id, spec.channel_binding));
    // Neither binds from the shared socket.
    refused(await t.bind(await t.on(), spec.runtime_id, spec.channel_binding));
    assert.deepEqual(t.receipts('hq.bind').map((r) => [r.member_id, r.caller_account]), [['m_lead', A], ['m_spec', A]]);
  } finally { await t.cleanup(); }
});

test('the fixture\'s Hello, both roles on one adapter, binds both runtimes to that adapter\'s account', async () => {
  const t = await setup({ accounts: { 'fake-adapter': A } });
  try {
    const entry = await t.entry();
    const r = (await entry.request('Hello', hello())).result;
    for (const a of r.admitted_runtimes) {
      assert.ok(!('adapter_id' in a), 'the admission result keeps its shape');
      assert.equal(t.hq.core.tables.get('hq-admission\0runtimes').get(a.runtime_id).harness_uid, UIDS[A]);
      assert.equal((await t.bind(await t.on(A), a.runtime_id, a.channel_binding)).ok, true);
    }
  } finally { await t.cleanup(); }
});

test('HQ refuses to start on a layout that is not the provisioner\'s', async () => {
  const l = layout();
  try {
    const start = (over = {}) => startHQ({ platform: 'linux', accounts: l.resolve, harnessLstat: l.lstat, launch: { spawn: fakeSudo().spawn }, config: { acceptedDefinitions: { [SOUL]: [DIGEST] }, harnesses: harnessesConfig(l.dir) }, plugins: [referenceBroker()], ...over });
    chmodSync(join(l.dir, B), 0o2755);
    await assert.rejects(start(), /must be 2750/);
    chmodSync(join(l.dir, B), 0o2750);
    // A home others can read refuses the start too, as a bad endpoint does.
    chmodSync(l.homes[B], 0o755);
    await assert.rejects(start(), /must be 0700/);
    chmodSync(l.homes[B], 0o700);
    await assert.rejects(start({ platform: 'darwin' }), /needs the Linux protected profile/);
  } finally { l.remove(); }
});

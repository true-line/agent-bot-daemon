// Member accounts and their broker endpoints (plan §9 row 16a; T01).
//
// These tests run everywhere: the caller's identity is the endpoint a
// connection arrives on, so two endpoint directories stand in for two
// accounts and an injected resolver gives them different uids. What they
// cannot show is the kernel refusing another account at connect; that is
// tests/hq-member-accounts.test.mjs, on real accounts in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindProof } from '../hq/admission.mjs';
import { validateConfig } from '../hq/hq.mjs';
import { planMemberEndpoints, resolveAccount, validateMembersConfig } from '../hq/members.mjs';
import { referenceBroker } from './broker-fixture.mjs';
import { DIGEST, hello, SOUL, startHQ } from './hq-harness.mjs';

const A = 'hqm_a';
const B = 'hqm_b';
const UIDS = { [A]: 61001, [B]: 61002 };
const hqUid = process.getuid();

// A members directory laid out as the provisioner would, with the group the
// file system gives this user's own directories.
function layout(accounts = [A, B]) {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  chmodSync(dir, 0o755);
  const gids = {};
  for (const account of accounts) {
    const home = join(dir, account);
    mkdirSync(home);
    chmodSync(home, 0o2750);
    gids[account] = statSync(home).gid;
  }
  const resolve = (name) => {
    if (!(name in UIDS)) throw new Error(`member account ${name} does not exist on this host`);
    return { uid: UIDS[name], gid: gids[name], groupMembers: [] };
  };
  return { dir, resolve, gids, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
const membersConfig = (dir, accounts = { m_lead: A, m_spec: B }) => ({ dir, accounts: { [SOUL]: accounts } });

async function setup({ home, dir, resolve, accounts } = {}) {
  const made = dir ? undefined : layout();
  const t = await startHQ({
    ...(home ? { home } : {}),
    platform: 'linux',
    accounts: resolve ?? made.resolve,
    config: { acceptedDefinitions: { [SOUL]: [DIGEST] }, members: membersConfig(dir ?? made.dir, accounts) },
    plugins: [referenceBroker()],
  });
  const endpoint = (account) => t.status.hq.sockets.members.find((m) => m.account === account).path;
  const on = (account) => t.member(account ? endpoint(account) : undefined);
  // The whole bind: HQ's challenge, then the proof keyed with `key`.
  const bind = async (conn, runtimeId, key) => {
    const challenge = await conn.request('bind.challenge', { runtime_id: runtimeId });
    assert.equal(challenge.ok, true, JSON.stringify(challenge));
    return conn.request('bind', { runtime_id: runtimeId, proof: bindProof(key, challenge.result.nonce, runtimeId) });
  };
  const admit = async () => {
    const entry = await t.entry();
    const r = (await entry.request('Hello', hello())).result;
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

test('members config: the shape, one account per member, and nothing off Linux', () => {
  const ok = { accounts: { [SOUL]: { m_lead: A, m_spec: B } } };
  assert.equal(validateMembersConfig(ok), ok);
  assert.doesNotThrow(() => validateConfig({ members: { dir: '/run/x', ...ok } }));
  for (const [bad, why] of [
    [null, /members is an object/],
    [{ accounts: ok.accounts, extra: 1 }, /unknown key members.extra/],
    [{ dir: 'relative', ...ok }, /absolute path/],
    [{}, /maps Soul IDs/],
    [{ accounts: { nope: {} } }, /not a Soul ID/],
    [{ accounts: { [SOUL]: { 'bad id!': A } } }, /not a member ID/],
    [{ accounts: { [SOUL]: { m_lead: 'Root User' } } }, /not an account name/],
    [{ accounts: { [SOUL]: { m_lead: A, m_spec: A } } }, /each member needs its own account/],
  ]) assert.throws(() => validateMembersConfig(bad), why);
  const l = layout();
  try {
    assert.throws(() => planMemberEndpoints(membersConfig(l.dir), { hqUid, platform: 'darwin', resolve: l.resolve }), /needs the Linux protected profile/);
  } finally { l.remove(); }
});

test('the endpoint layout is verified, never repaired', () => {
  const l = layout();
  const plan = (over = {}, cfg = membersConfig(l.dir)) => planMemberEndpoints(cfg, { hqUid, platform: 'linux', resolve: l.resolve, ...over });
  try {
    const planned = plan();
    assert.deepEqual(planned.endpoints.map((e) => [e.account, e.uid, e.path]), [[A, UIDS[A], join(l.dir, A, 'broker.sock')], [B, UIDS[B], join(l.dir, B, 'broker.sock')]]);
    assert.equal(planned.accountOf(SOUL, 'm_lead').account, A);
    assert.equal(planned.accountOf(SOUL, 'm_other'), undefined);

    const as = (name, info) => (n) => (n === name ? { ...l.resolve(n), ...info } : l.resolve(n));
    assert.throws(() => plan({ resolve: as(A, { uid: 0 }) }), /is root/);
    assert.throws(() => plan({ resolve: as(A, { uid: hqUid }) }), /HQ's own account/);
    assert.throws(() => plan({ resolve: as(B, { uid: UIDS[A] }) }), /share uid/);
    assert.throws(() => plan({ resolve: as(A, { groupMembers: ['mallory'] }) }), /must be a private group/);
    assert.throws(() => plan({ resolve: as(A, { gid: l.gids[A] + 1 }) }), /has group/);
    assert.throws(() => plan({ hqUid: hqUid + 1 }), /owned by uid/);
    assert.throws(() => plan({}, membersConfig(l.dir, { m_lead: A, m_spec: 'hqm_missing' })), /does not exist on this host/);
    assert.throws(() => plan({}, membersConfig(join(l.dir, 'nowhere'))), /does not exist; the provisioner creates it/);

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

test('an account is read from the host through getent', () => {
  const run = (file, args) => {
    assert.equal(file, 'getent');
    if (args[0] === 'passwd' && args[1] === A) return `${A}:x:1201:1301::/home/${A}:/usr/sbin/nologin\n`;
    if (args[0] === 'group' && args[1] === '1301') return `${A}:x:1301:${A},guest\n`;
    throw new Error('exit 2');
  };
  assert.deepEqual(resolveAccount(A, { run }), { uid: 1201, gid: 1301, groupMembers: [A, 'guest'] });
  assert.throws(() => resolveAccount('nobody_here', { run }), /does not exist on this host/);
});

test('HQ opens one 0660 endpoint per member account and names them in status', async () => {
  const t = await setup();
  try {
    assert.deepEqual(t.status.hq.sockets.members.map((m) => m.account), [A, B]);
    for (const account of [A, B]) assert.equal(statSync(t.endpoint(account)).mode & 0o777, 0o660);
    // The shared socket is still there, still 0600.
    assert.equal(statSync(t.hq.paths.broker).mode & 0o777, 0o600);
  } finally { await t.cleanup(); }
});

test('a member binds from its own endpoint with a keyed proof, and the binding is never sent', async () => {
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

test('T01: a binding copied to another member is refused, whatever it presents', async () => {
  const t = await setup();
  try {
    const { lead, spec } = await t.admit();
    // Member B holds A's runtime ID and A's channel binding.
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
  const { dir, resolve } = first.made;
  await first.cleanup({ keep: true });
  const again = await setup({ home, dir, resolve });
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

test('a member with no account keeps the shared socket; an account endpoint never speaks for it', async () => {
  const t = await setup({ accounts: { m_lead: A } });
  try {
    const { lead, spec } = await t.admit();
    assert.deepEqual(t.status.hq.sockets.members.map((m) => m.account), [A]);
    // The specialist has no account: cooperative, as before, in either form.
    assert.equal((await (await t.on()).request('bind', { runtime_id: spec.runtime_id, channel_binding: spec.channel_binding })).ok, true);
    assert.equal((await t.bind(await t.on(), spec.runtime_id, spec.channel_binding)).ok, true);
    // But not through another member's endpoint.
    refused(await t.bind(await t.on(A), spec.runtime_id, spec.channel_binding));
    assert.equal((await t.bind(await t.on(A), lead.runtime_id, lead.channel_binding)).ok, true);
  } finally { await t.cleanup(); }
});

test('HQ refuses to start on a layout that is not the provisioner\'s', async () => {
  const l = layout();
  try {
    chmodSync(join(l.dir, B), 0o2755);
    await assert.rejects(startHQ({ platform: 'linux', accounts: l.resolve, config: { acceptedDefinitions: { [SOUL]: [DIGEST] }, members: membersConfig(l.dir) }, plugins: [referenceBroker()] }), /must be 2750/);
    await assert.rejects(startHQ({ platform: 'darwin', accounts: l.resolve, config: { acceptedDefinitions: { [SOUL]: [DIGEST] }, members: membersConfig(l.dir) } }), /needs the Linux protected profile/);
  } finally { l.remove(); }
});

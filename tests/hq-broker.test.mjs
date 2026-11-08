// The member broker socket (plan §4.9; §9 row 13b, daemon side): HQ core
// opens broker.sock, one plugin serves it, a member binds its connection
// with its channel binding, and the task service authorizes a delivered
// commit by the bound runtime. T05 over the socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { definePlugin } from '../sdk/plugin.mjs';
import { createTestHost } from '../sdk/test-host.mjs';
import { referenceBroker } from './broker-fixture.mjs';
import { hello, SOUL, startHQ } from './hq-harness.mjs';

const code = (c) => (e) => { assert.equal(e.code, c, e.message); return true; };
const stateOf = (host, name) => host.status().plugins.find((p) => p.name === name);
const plugin = (name, init, extra = {}) => definePlugin({ name, version: '1.0.0', hostApi: 1, init, ...extra });

// The host side, on the SDK test host.
test('one plugin serves the broker; a second is refused, and serving closes after init', async () => {
  let late;
  const host = createTestHost({ plugins: [
    plugin('first', async (ctx) => { late = ctx; ctx.broker.serve({ accept: () => 'first' }); }),
    plugin('second', async (ctx) => { ctx.broker.serve({ accept: () => 'second' }); }, { requires: { first: '^1.0.0' } }),
  ] });
  await host.start();
  assert.match(stateOf(host, 'second').reason, /host.duplicate_registration: broker server broker is already registered by first/);
  assert.deepEqual(host.registrations().servers, [{ key: 'broker', plugin: 'first' }]);
  assert.equal(await host.brokerAccept('bind', {}, { connection: 'bc_1' }), 'first');
  assert.throws(() => late.broker.serve({ accept() {} }), code('host.registration_closed'));
  assert.throws(() => late.broker.serve({}), code('host.invalid_request'));
});

test('with no broker plugin running, every frame is refused', async () => {
  const none = createTestHost({ plugins: [] });
  await none.start();
  await assert.rejects(none.brokerAccept('bind', {}, { connection: 'bc_1' }), code('host.no_broker'));

  const broken = createTestHost({ plugins: [plugin('broker', async (ctx) => { ctx.broker.serve({ accept() {} }); }, { start: async () => { throw new Error('no'); } })] });
  await broken.start();
  await assert.rejects(broken.brokerAccept('bind', {}, { connection: 'bc_1' }), code('host.no_broker'));

  const stopped = createTestHost({ plugins: [plugin('broker', async (ctx) => { ctx.broker.serve({ accept() {} }); })] });
  await stopped.start();
  await assert.rejects(stopped.brokerAccept('Bad Kind', {}, { connection: 'bc_1' }), code('host.invalid_request'));
  await stopped.stop();
  await assert.rejects(stopped.brokerAccept('bind', {}, { connection: 'bc_1' }), code('host.not_running'));
});

test('only the serving plugin delivers, only to a registered kind, and the consumer sees the runtime alone', async () => {
  const seen = [];
  let broker;
  let other;
  const host = createTestHost({ plugins: [
    plugin('broker', async (ctx) => { broker = ctx; ctx.broker.serve({ accept() {} }); }),
    plugin('consumer', async (ctx) => {
      other = ctx;
      ctx.broker.registerKind({ kind: 'notes.take', consume: (message, meta) => { message.mutated = true; seen.push({ message, meta, frozen: Object.isFrozen(meta) }); return 'taken'; } });
    }),
  ] });
  await host.start();
  const sent = { n: 1 };
  assert.equal(await broker.broker.deliver('notes.take', sent, { runtime_id: 'rt_1' }), 'taken');
  assert.deepEqual(sent, { n: 1 }, 'the consumer got a copy');
  assert.deepEqual(seen, [{ message: { n: 1, mutated: true }, meta: { runtime_id: 'rt_1' }, frozen: true }]);
  await assert.rejects(broker.broker.deliver('notes.give', {}, { runtime_id: 'rt_1' }), code('host.unknown_kind'));
  await assert.rejects(broker.broker.deliver('notes.take', {}, {}), code('host.invalid_request'));
  await assert.rejects(other.broker.deliver('notes.take', {}, { runtime_id: 'rt_1' }), code('host.auth_mismatch'));
  await host.stop();
  await assert.rejects(broker.broker.deliver('notes.take', {}, { runtime_id: 'rt_1' }), code('host.context_revoked'));
});

test('a closed connection reaches the serving plugin, and its failure does not', async () => {
  const closed = [];
  const host = createTestHost({ plugins: [plugin('broker', async (ctx) => {
    ctx.broker.serve({ accept() {}, closed(c) { closed.push(c); if (c === 'bc_bad') throw new Error('plugin bug'); } });
  })] });
  await host.start();
  await host.brokerClosed('bc_1');
  await host.brokerClosed('bc_bad');
  assert.deepEqual(closed, ['bc_1', 'bc_bad']);
});

// The real HQ, over broker.sock.
async function setup() {
  const t = await startHQ({ plugins: [referenceBroker()] });
  const entry = await t.entry();
  const admitted = async (over = {}) => {
    const r = (await entry.request('Hello', hello(over))).result;
    const rt = (role) => ({ ...r.admitted_runtimes.find((a) => a.role === role), epoch: r.installation_epoch, generation: r.lease_generation });
    return { lead: rt('lead'), spec: rt('specialist') };
  };
  const { lead, spec } = await admitted();
  const tasks = t.hq.host.provided('hq-tasks');
  let n = 0;
  const offer = async () => {
    n += 1;
    const r = await tasks.offer({ operation_id: `offer_${n}`, objective: 'Repair the seeded issue.', done_criteria: 'Checks pass.', accountable_soul: SOUL, write_scope: ['workspace:scratch'] }, { from: { kind: 'owner' } });
    return r.task_id;
  };
  const record = async (taskId) => (await tasks.get(taskId)).task;
  const request = (rt, task, transition, over = {}) => {
    n += 1;
    return { contract: 'task/v1', request_id: `req_${n}`, task_id: task.task_id, expected_revision: task.revision, installation_epoch: rt.epoch, runtime_id: rt.runtime_id, lease_generation: rt.generation, operation_id: `op_${n}`, transition, ...over };
  };
  const bound = async (rt) => {
    const m = await t.member();
    const res = await m.request('bind', { runtime_id: rt.runtime_id, channel_binding: rt.channel_binding });
    assert.equal(res.ok, true, JSON.stringify(res));
    return m;
  };
  return { ...t, entry, admitted, lead, spec, tasks, offer, record, request, bound };
}

test('broker.sock is 0600 beside the other sockets, and status names it', async () => {
  const t = await startHQ();
  try {
    assert.equal(statSync(t.hq.paths.broker).mode & 0o777, 0o600);
    assert.equal(t.status.hq.sockets.broker, t.hq.paths.broker);
    // HQ alone serves no broker: the frame is refused, not dropped.
    const m = await t.member();
    assert.equal((await m.request('bind', { runtime_id: 'rt_x', channel_binding: 'cb_xxxxxxxxxxxxxxxx' })).host_refusal.code, 'host.no_broker');
    // Owner and entry-point operations are not broker kinds.
    assert.equal((await m.request('status')).host_refusal.code, 'host.no_broker');
  } finally { await t.done(); }
});

test('a member bound by its channel binding commits a task over the broker socket; a specialist proposes', async () => {
  const t = await setup();
  try {
    const lead = await t.bound(t.lead);
    const spec = await t.bound(t.spec);
    const taskId = await t.offer();
    for (const to of ['accepted', 'running']) {
      const res = await lead.request('task.commit', t.request(t.lead, await t.record(taskId), to));
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.result.outcome, 'committed');
    }
    const proposed = await spec.request('task.commit', t.request(t.spec, await t.record(taskId), 'completed', { result_ref: 'artifact_spec' }));
    assert.equal(proposed.result.outcome, 'proposal');
    assert.equal((await t.record(taskId)).status, 'running');
    const done = await lead.request('task.commit', t.request(t.lead, await t.record(taskId), 'completed', { result_ref: 'artifact_final' }));
    assert.equal(done.result.status, 'completed');
    const task = await t.record(taskId);
    assert.equal(task.status, 'completed');
    assert.equal(task.revision, 3);

    // Receipts name the bound runtime as the caller and never the binding.
    const commits = t.hq.core.receipts.filter((r) => r.kind === 'task.commit');
    assert.ok(commits.every((r) => r.caller === `runtime:${r.runtime_id}`));
    assert.deepEqual(t.hq.core.receipts.filter((r) => r.kind === 'hq.bind').map((r) => r.member_id), ['m_lead', 'm_spec']);
    for (const rt of [t.lead, t.spec]) assert.equal(JSON.stringify(t.hq.core.receipts).includes(rt.channel_binding), false);
  } finally { await t.done(); }
});

test('a frame before bind, a wrong binding, a second bind, and a request for another runtime are refused', async () => {
  const t = await setup();
  try {
    const taskId = await t.offer();
    const m = await t.member();
    assert.equal((await m.request('task.commit', t.request(t.lead, await t.record(taskId), 'accepted'))).refusal.error, 'caller_mismatch');
    // The spec's binding does not open the lead's runtime, and an unknown
    // runtime gets the same answer as a wrong binding.
    assert.equal((await m.request('bind', { runtime_id: t.lead.runtime_id, channel_binding: t.spec.channel_binding })).refusal.error, 'caller_mismatch');
    assert.equal((await m.request('bind', { runtime_id: 'rt_unknown', channel_binding: t.spec.channel_binding })).refusal.error, 'caller_mismatch');
    assert.equal((await m.request('bind', { runtime_id: t.lead.runtime_id })).host_refusal.code, 'host.invalid_request');
    assert.equal((await m.request('bind', { runtime_id: t.lead.runtime_id, channel_binding: t.lead.channel_binding, extra: 1 })).host_refusal.code, 'host.invalid_request');

    // Bound as the specialist, it cannot speak for the lead.
    assert.equal((await m.request('bind', { runtime_id: t.spec.runtime_id, channel_binding: t.spec.channel_binding })).ok, true);
    assert.equal((await m.request('bind', { runtime_id: t.lead.runtime_id, channel_binding: t.lead.channel_binding })).host_refusal.code, 'host.invalid_request');
    const forged = await m.request('task.commit', t.request(t.lead, await t.record(taskId), 'accepted'));
    assert.equal(forged.refusal.error, 'caller_mismatch');
    assert.equal((await t.record(taskId)).status, 'offered');

    // A member cannot offer a task: an offer's source is the owner, HQ or a peer.
    const offered = await m.request('task.offer', { operation_id: 'offer_m', objective: 'x', done_criteria: 'y', accountable_soul: SOUL, write_scope: ['workspace:scratch'] });
    assert.equal(offered.host_refusal.code, 'host.invalid_request');
    assert.equal((await m.request('notes.take', {})).host_refusal.code, 'host.unknown_kind');

    const refused = t.hq.core.receipts.filter((r) => r.kind === 'hq.bind.refused').map((r) => r.code);
    assert.deepEqual(refused, ['caller_mismatch', 'caller_mismatch', 'host.invalid_request', 'host.invalid_request']);
  } finally { await t.done(); }
});

test('a superseded or expired runtime is refused, at bind and on a connection already bound', async () => {
  const t = await setup();
  try {
    const taskId = await t.offer();
    const lead = await t.bound(t.lead);
    // A newer admission supersedes every runtime of the Soul.
    const fresh = await t.admitted({ request_id: 'req_0002' });
    assert.equal((await lead.request('task.commit', t.request(t.lead, await t.record(taskId), 'accepted'))).refusal.error, 'lease_expired');
    const again = await t.member();
    assert.equal((await again.request('bind', { runtime_id: t.lead.runtime_id, channel_binding: t.lead.channel_binding })).refusal.error, 'lease_expired');
    assert.equal((await t.record(taskId)).status, 'offered');

    // The new runtime binds and commits; then its lease lapses.
    const now = await t.bound(fresh.lead);
    assert.equal((await now.request('task.commit', t.request(fresh.lead, await t.record(taskId), 'accepted'))).result.outcome, 'committed');
    t.clock.advance(60_001);
    assert.equal((await now.request('task.commit', t.request(fresh.lead, await t.record(taskId), 'running'))).refusal.error, 'lease_expired');
    const late = await t.member();
    assert.equal((await late.request('bind', { runtime_id: fresh.lead.runtime_id, channel_binding: fresh.lead.channel_binding })).refusal.error, 'lease_expired');
  } finally { await t.done(); }
});

test('T05 over the socket: one commit delivered repeatedly, on one connection or two, commits once with a stable receipt', async () => {
  const t = await setup();
  try {
    const taskId = await t.offer();
    const first = await t.bound(t.lead);
    const second = await t.bound(t.lead);
    const req = t.request(t.lead, await t.record(taskId), 'accepted');
    const answers = [];
    for (const m of [first, first, second, first]) answers.push(await m.request('task.commit', req));
    assert.ok(answers.every((a) => a.ok), JSON.stringify(answers));
    assert.equal(new Set(answers.map((a) => JSON.stringify(a.result))).size, 1);
    const task = await t.record(taskId);
    assert.equal(task.revision, 1);
    assert.equal(t.hq.core.receipts.filter((r) => r.kind === 'task.commit' && r.operation_id === req.operation_id).length, 1);

    // The same operation with changed content is refused, not committed.
    const changed = await first.request('task.commit', { ...req, evidence_refs: ['check_x'] });
    assert.equal(changed.host_refusal.code, 'host.invalid_request');
    assert.equal((await t.record(taskId)).revision, 1);
  } finally { await t.done(); }
});

test('closing a connection drops its binding in the serving plugin', async () => {
  const t = await setup();
  try {
    const broker = t.hq.host.provided('test-broker');
    const m = await t.bound(t.lead);
    assert.equal(broker.boundConnections(), 1);
    await m.close();
    for (let i = 0; i < 50 && broker.boundConnections() > 0; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(broker.boundConnections(), 0);
  } finally { await t.done(); }
});

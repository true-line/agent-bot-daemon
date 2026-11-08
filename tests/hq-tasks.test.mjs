// The task service in HQ's store (hq/tasks.mjs; plan §9 PR 13): task/v1
// records, CAS, operation keys, proposals versus commitments, write-scope
// exclusion, and the stage 1 gate T04, T05 and T20 (0.4 §14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admissionPlugin } from '../hq/admission.mjs';
import { validateConfig } from '../hq/hq.mjs';
import { deadlineMs, overlapAllowed, scopeOverlap, tasksPlugin } from '../hq/tasks.mjs';
import { createTestHost } from '../sdk/test-host.mjs';
import { validate } from '../sdk/wire/schema.mjs';
import { DIGEST, fixture, hello, schemas, SOUL, startHQ } from './hq-harness.mjs';

const OTHER_SOUL = 'agent_11111111-2222-4333-8444-555555555555';
const PEER = 'agent_99999999-8888-4777-8666-555555555555';
const code = (c) => (e) => { assert.equal(e.code, c, e.message); return true; };

async function setup({ concurrentWriters = [] } = {}) {
  const host = createTestHost({
    plugins: [admissionPlugin({ schemas }), tasksPlugin({ schemas })],
    config: { 'hq-admission': { acceptedDefinitions: { [SOUL]: [DIGEST], [OTHER_SOUL]: [DIGEST] } }, 'hq-tasks': { concurrentWriters } },
  });
  await host.start();
  const admit = async (session = 'ep_a', over = {}) => {
    const r = await host.dispatch('Hello', { auth: 'entry-point', payload: hello(over), session });
    const rt = (role) => ({ ...r.admitted_runtimes.find((a) => a.role === role), epoch: r.installation_epoch, generation: r.lease_generation, session });
    return { lead: rt('lead'), spec: rt('specialist'), decision: r };
  };
  const { lead, spec } = await admit();
  const tasks = host.provided('hq-tasks');
  let n = 0;
  const request = (rt, task, transition, over = {}) => {
    n += 1;
    return {
      contract: 'task/v1', request_id: `req_${n}`, task_id: task.task_id ?? task, expected_revision: task.revision ?? 0,
      installation_epoch: rt.epoch, runtime_id: rt.runtime_id, lease_generation: rt.generation, operation_id: `op_${n}`, transition, ...over,
    };
  };
  const commit = (rt, task, transition, over) => tasks.commit(request(rt, task, transition, over), { session: rt.session });
  const record = async (taskId) => (await tasks.get(taskId)).task;
  const offer = async (over = {}, from = { kind: 'owner' }) => {
    n += 1;
    const r = await tasks.offer({ operation_id: `offer_${n}`, objective: 'Repair the seeded issue.', done_criteria: 'Checks pass.', accountable_soul: SOUL, write_scope: ['workspace:scratch'], ...over }, { from });
    return record(r.task_id);
  };
  return { host, tasks, lead, spec, admit, request, commit, record, offer };
}

const valid = (task) => assert.deepEqual(validate(schemas['task-record'], task), [], JSON.stringify(task));

test('a task runs offered, accepted, running, completed; every record is a valid task/v1 record', async () => {
  const t = await setup();
  let task = await t.offer({ deadline: '2026-01-02T00:00:00Z', budget: 5 });
  valid(task);
  assert.equal(task.status, 'offered');
  assert.equal(task.revision, 0);
  assert.equal(task.requester, 'owner');
  for (const to of ['accepted', 'running', 'completed']) {
    const r = await t.commit(t.lead, task, to, to === 'completed' ? { result_ref: 'artifact_1', evidence_refs: ['check_1'] } : {});
    assert.equal(r.outcome, 'committed');
    assert.equal(r.status, to);
    task = await t.record(task.task_id);
    valid(task);
    assert.equal(task.status, to);
  }
  assert.equal(task.revision, 3);
  assert.equal(task.lease_generation, t.lead.generation);
  assert.deepEqual(task.evidence, ['artifact_1', 'check_1']);
  assert.deepEqual(t.host.receipts().filter((r) => r.kind === 'task.commit').map((r) => r.status), ['accepted', 'running', 'completed']);

  // The owner reads the store through hq/v1.
  const listed = await t.host.dispatch('tasks.list', { auth: 'owner' });
  assert.deepEqual(listed, [{ task_id: task.task_id, status: 'completed', revision: 3, accountable_soul: SOUL, deadline: '2026-01-02T00:00:00Z' }]);
  assert.deepEqual((await t.host.dispatch('tasks.get', { auth: 'owner', payload: { task_id: task.task_id } })).task, task);
  await assert.rejects(t.host.dispatch('tasks.get', { auth: 'entry-point', payload: { task_id: task.task_id } }), code('host.auth_mismatch'));
});

test('T20: a specialist\'s final answer is recorded as a proposal; only the lead\'s commitment finalizes', async () => {
  const t = await setup();
  let task = await t.offer();
  await t.commit(t.lead, task, 'accepted');
  await t.commit(t.lead, (task = await t.record(task.task_id)), 'running');
  task = await t.record(task.task_id);

  const proposed = await t.commit(t.spec, task, 'completed', { result_ref: 'artifact_spec' });
  assert.equal(proposed.outcome, 'proposal');
  assert.match(proposed.proposal_id, /^prop_/);
  const after = await t.record(task.task_id);
  assert.deepEqual(after, task, 'the task did not move');
  const { proposals } = await t.tasks.get(task.task_id);
  assert.deepEqual(proposals.map((p) => [p.member_id, p.role, p.transition, p.evidence]), [['m_spec', 'specialist', 'completed', ['artifact_spec']]]);

  // A specialist cannot cancel or fail the task either: everything it sends proposes.
  assert.equal((await t.commit(t.spec, task, 'canceled')).outcome, 'proposal');
  assert.equal((await t.record(task.task_id)).status, 'running');

  // The lead finalizes, citing the proposal's artifact as evidence.
  await t.commit(t.lead, task, 'completed', { result_ref: 'artifact_spec' });
  assert.equal((await t.record(task.task_id)).status, 'completed');

  // A late proposal on a finished task is retained and does not reopen it.
  const late = await t.commit(t.spec, await t.record(task.task_id), 'running');
  assert.equal(late.outcome, 'proposal');
  assert.equal((await t.record(task.task_id)).status, 'completed');
  assert.equal((await t.tasks.get(task.task_id)).proposals.length, 3);
});

test('T05: an identical request delivered repeatedly commits once and returns the stable prior receipt', async () => {
  const t = await setup();
  const task = await t.offer();
  const req = t.request(t.lead, task, 'accepted');
  const first = await t.tasks.commit(req, { session: t.lead.session });
  for (let i = 0; i < 3; i++) assert.deepEqual(await t.tasks.commit(structuredClone(req), { session: t.lead.session }), first);
  const after = await t.record(task.task_id);
  assert.equal(after.revision, 1);
  assert.equal(t.host.receipts().filter((r) => r.kind === 'task.commit').length, 1);

  // The repeat is answered even after the task moved on.
  await t.commit(t.lead, after, 'running');
  assert.deepEqual(await t.tasks.commit(structuredClone(req), { session: t.lead.session }), first);

  // The same operation ID with changed content is refused, and changes nothing.
  await assert.rejects(t.tasks.commit({ ...req, request_id: 'req_changed' }, { session: t.lead.session }), code('host.invalid_request'));
  assert.equal((await t.record(task.task_id)).revision, 2);

  // An offer's operation key works the same way.
  const input = { operation_id: 'offer_same', objective: 'x', done_criteria: 'y', accountable_soul: SOUL };
  const o1 = await t.tasks.offer(input, { from: { kind: 'owner' } });
  assert.deepEqual(await t.tasks.offer({ ...input }, { from: { kind: 'owner' } }), o1);
  await assert.rejects(t.tasks.offer({ ...input }, { from: { kind: 'peer', soul: PEER } }), code('caller_mismatch'));
  assert.equal((await t.tasks.list()).length, 2);
});

test('CAS: a stale expected revision is revision_conflict; a cancel and a completion race on the committed revision', async () => {
  const t = await setup();
  let task = await t.offer();
  await t.commit(t.lead, task, 'accepted');
  await assert.rejects(t.commit(t.lead, task, 'running'), code('revision_conflict'), 'expected revision 0, task at 1');
  task = await t.record(task.task_id);
  assert.equal(task.revision, 1);

  // Both race from revision 1: the owner's cancel commits first, so the completion loses.
  await t.tasks.cancel({ task_id: task.task_id, expected_revision: 1, operation_id: 'cancel_1' }, { from: { kind: 'owner' } });
  await assert.rejects(t.commit(t.lead, task, 'completed'), code('host.invalid_request'), 'the task is canceled');
  const other = await t.offer({ write_scope: ['workspace:other'] });
  await t.commit(t.lead, other, 'accepted');
  await t.commit(t.lead, await t.record(other.task_id), 'completed');
  await assert.rejects(t.tasks.cancel({ task_id: other.task_id, expected_revision: 1, operation_id: 'cancel_2' }, { from: { kind: 'owner' } }), code('host.invalid_request'));
  assert.equal((await t.record(other.task_id)).status, 'completed');
});

test('only the current lead of the task\'s Soul, at the current epoch and lease, commits', async () => {
  const t = await setup();
  const task = await t.offer();
  await assert.rejects(t.commit({ ...t.lead, epoch: t.lead.epoch + 1 }, task, 'accepted'), code('stale_epoch'));
  await assert.rejects(t.commit({ ...t.lead, generation: t.lead.generation + 1 }, task, 'accepted'), code('lease_expired'));
  await assert.rejects(t.commit({ ...t.lead, session: 'ep_other' }, task, 'accepted'), code('caller_mismatch'));
  await assert.rejects(t.tasks.commit(t.request(t.lead, task, 'accepted'), {}), code('caller_mismatch'));

  // Another Soul's lead cannot commit on this Soul's task.
  const other = await t.admit('ep_b', { request_id: 'req_other', soul_id: OTHER_SOUL, installation_id: 'inst_other' });
  await assert.rejects(t.commit(other.lead, task, 'accepted'), code('caller_mismatch'));

  // A new admission supersedes the old lead; it cannot finalize from its old session.
  const fresh = await t.admit('ep_a', { request_id: 'req_again' });
  await assert.rejects(t.commit(t.lead, task, 'accepted'), code('lease_expired'));
  await t.commit(fresh.lead, task, 'accepted');

  // An expired lease stops commits too.
  t.host.clock.advance(61_000);
  await assert.rejects(t.commit(fresh.lead, await t.record(task.task_id), 'running'), code('lease_expired'));
  assert.equal((await t.record(task.task_id)).revision, 1);
  assert.ok(t.host.receipts().some((r) => r.kind === 'task.commit.refused' && r.code === 'lease_expired'));
});

test('the lead cannot cancel or enter waiting itself, and resumes only from a reason it can clear', async () => {
  const t = await setup();
  let task = await t.offer();
  await t.commit(t.lead, task, 'accepted');
  await t.commit(t.lead, (task = await t.record(task.task_id)), 'running');
  task = await t.record(task.task_id);
  await assert.rejects(t.commit(t.lead, task, 'canceled'), code('host.invalid_request'));
  await assert.rejects(t.commit(t.lead, task, 'waiting'), code('host.invalid_request'));
  await assert.rejects(t.commit(t.lead, task, 'accepted'), code('host.invalid_request'), 'running cannot go back to accepted');

  await t.tasks.wait({ task_id: task.task_id, expected_revision: task.revision, operation_id: 'wait_1', reason: 'credential_unavailable' }, { from: { kind: 'hq' } });
  task = await t.record(task.task_id);
  valid(task);
  assert.equal(task.waiting_reason, 'credential_unavailable');
  await assert.rejects(t.commit(t.lead, task, 'running'), code('host.invalid_request'), 'HQ clears a credential wait');
  await assert.rejects(t.tasks.wait({ task_id: task.task_id, expected_revision: task.revision, operation_id: 'wait_2', reason: 'credential_unavailable' }, { from: { kind: 'peer', soul: PEER } }), code('host.invalid_request'));
  await assert.rejects(t.tasks.wait({ task_id: task.task_id, expected_revision: task.revision, operation_id: 'wait_3', reason: 'bored' }, { from: { kind: 'hq' } }), code('host.invalid_request'));

  const dep = await t.offer({ write_scope: ['workspace:dep'] });
  await t.commit(t.lead, dep, 'accepted');
  await t.commit(t.lead, await t.record(dep.task_id), 'running');
  const running = await t.record(dep.task_id);
  await t.tasks.wait({ task_id: dep.task_id, expected_revision: running.revision, operation_id: 'wait_dep', reason: 'dependency' }, { from: { kind: 'hq' } });
  await t.commit(t.lead, await t.record(dep.task_id), 'running');
  const resumed = await t.record(dep.task_id);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.waiting_reason, undefined);
  valid(resumed);
});

test('accepting a task whose write scope overlaps an active one is write_scope_conflict, unless the owner allowed concurrent writers', async () => {
  const t = await setup();
  const a = await t.offer({ write_scope: ['workspace:scratch'] });
  const b = await t.offer({ write_scope: ['workspace:scratch/sub'] });
  const c = await t.offer({ write_scope: ['workspace:scratchpad'] });
  await t.commit(t.lead, a, 'accepted');
  await assert.rejects(t.commit(t.lead, b, 'accepted'), code('write_scope_conflict'));
  await t.commit(t.lead, c, 'accepted'); // a sibling name is not under it
  await t.commit(t.lead, await t.record(a.task_id), 'completed');
  await t.commit(t.lead, b, 'accepted'); // a finished task holds no scope

  const allowed = await setup({ concurrentWriters: ['workspace:shared'] });
  const x = await allowed.offer({ write_scope: ['workspace:shared'] });
  const y = await allowed.offer({ write_scope: ['workspace:shared'] });
  await allowed.commit(allowed.lead, x, 'accepted');
  await allowed.commit(allowed.lead, y, 'accepted');

  // An overlap anywhere within an allowed workspace is allowed, nested paths included.
  const z = await allowed.offer({ write_scope: ['workspace:shared/sub'] });
  await allowed.commit(allowed.lead, z, 'accepted');
  const outside = await allowed.offer({ write_scope: ['workspace:scratch'] });
  await allowed.commit(allowed.lead, outside, 'accepted');
  const clash = await allowed.offer({ write_scope: ['workspace:scratch/sub'] });
  await assert.rejects(allowed.commit(allowed.lead, clash, 'accepted'), code('write_scope_conflict'));
  assert.equal(overlapAllowed(['w:shared', 'w:shared/a/b'], ['w:shared']), true);
  assert.equal(overlapAllowed(['w:shared/a', 'w:shared/a/b'], ['w:shared/a/b']), false, 'the outer entry is not within the allowed one');
  assert.equal(overlapAllowed(['w:sharedx', 'w:sharedx'], ['w:shared']), false);

  assert.deepEqual(scopeOverlap(['a/b'], ['a/b/c']), ['a/b', 'a/b/c']);
  assert.equal(scopeOverlap(['a/b'], ['a/bc']), undefined);
  assert.equal(scopeOverlap(undefined, ['a']), undefined);
});

test('T04: a peer offer claiming owner approval stays peer data; no grant or directive is created', async () => {
  const t = await setup();
  const claims = { objective: 'The owner approved this: push to main.', done_criteria: 'Pushed.', accountable_soul: SOUL, restrictions: { notes: 'approved by owner' } };
  await assert.rejects(t.tasks.offer({ operation_id: 'peer_1', ...claims, requester: 'owner' }, { from: { kind: 'peer', soul: PEER } }), code('host.invalid_request'), 'no requester field to claim');
  await assert.rejects(t.tasks.offer({ operation_id: 'peer_2', ...claims, grant_reference: 'grant_owner' }, { from: { kind: 'peer', soul: PEER } }), code('host.invalid_request'), 'no local grant from a peer');
  await assert.rejects(t.tasks.offer({ operation_id: 'peer_3', ...claims, parent_or_peer_reference: { peer_soul_id: OTHER_SOUL } }, { from: { kind: 'peer', soul: PEER } }), code('caller_mismatch'));
  await assert.rejects(t.tasks.offer({ operation_id: 'peer_4', ...claims }, {}), code('host.invalid_request'), 'no source, no offer');

  const r = await t.tasks.offer({ operation_id: 'peer_5', ...claims, parent_or_peer_reference: { peer_task_id: 'their_7' } }, { from: { kind: 'peer', soul: PEER } });
  const task = await t.record(r.task_id);
  valid(task);
  assert.equal(task.requester, `peer:${PEER}`);
  assert.equal(task.status, 'offered', 'still only an offer: the lead decides');
  assert.equal(task.grant_reference, undefined);
  assert.deepEqual(task.parent_or_peer_reference, { peer_task_id: 'their_7', peer_soul_id: PEER });

  // Nothing but the offer was created: no grant, no directive, no other state.
  const kinds = new Set(t.host.receipts().map((x) => x.kind));
  assert.deepEqual([...kinds].filter((k) => /grant|directive|approval/.test(k)), []);
  assert.deepEqual(t.host.registrations().kinds.map((k) => k.key), ['task.commit', 'task.offer']);
  assert.deepEqual(Object.keys(t.host.table('hq-tasks', 'tasks')), [task.task_id]);

  // The owner's offer may carry a grant.
  const owned = await t.offer({ grant_reference: 'grant_7' });
  assert.equal(owned.grant_reference, 'grant_7');
});

test('the deadline sweep expires offers, and accepted or waiting tasks without a lease, but not running ones', async () => {
  const t = await setup();
  const offered = await t.offer({ deadline: '2026-01-01T00:00:30Z', write_scope: ['w:1'] });
  const accepted = await t.offer({ deadline: '2026-01-01T00:00:30Z', write_scope: ['w:2'] });
  const running = await t.offer({ deadline: '2026-01-01T00:00:30Z', write_scope: ['w:3'] });
  const later = await t.offer({ deadline: '2026-01-02T00:00:00Z', write_scope: ['w:4'] });
  await t.commit(t.lead, accepted, 'accepted');
  await t.commit(t.lead, running, 'accepted');
  await t.commit(t.lead, await t.record(running.task_id), 'running');
  assert.deepEqual(await t.tasks.expire(), []);
  t.host.clock.advance(31_000);
  const done = await t.tasks.expire();
  assert.deepEqual(done.map((r) => r.task_id).sort(), [offered.task_id, accepted.task_id].sort());
  for (const x of [offered, accepted]) { const r = await t.record(x.task_id); valid(r); assert.equal(r.status, 'expired'); }
  assert.equal((await t.record(running.task_id)).status, 'running');
  assert.equal((await t.record(later.task_id)).status, 'offered');
  assert.deepEqual(await t.tasks.expire(), [], 'an expired task does not expire twice');
});

test('a waiting task expires only once no live lease holds it, and a leap-second deadline is a real instant', async () => {
  const t = await setup();
  let task = await t.offer({ deadline: '2026-01-01T00:00:30Z' });
  await t.commit(t.lead, task, 'accepted');
  await t.commit(t.lead, (task = await t.record(task.task_id)), 'running');
  task = await t.record(task.task_id);
  await t.tasks.wait({ task_id: task.task_id, expected_revision: task.revision, operation_id: 'wait_lease', reason: 'dependency' }, { from: { kind: 'hq' } });
  t.host.clock.advance(31_000);
  assert.deepEqual(await t.tasks.expire(), [], 'past its deadline, but the lead\'s lease still holds it');
  t.host.clock.advance(30_000); // the 60 s lease lapses
  assert.deepEqual((await t.tasks.expire()).map((r) => r.task_id), [task.task_id]);
  assert.equal((await t.record(task.task_id)).status, 'expired');

  assert.equal(deadlineMs('2026-12-31T23:59:60Z'), Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(deadlineMs('2026-12-31T23:59:60.5+00:00'), Date.parse('2027-01-01T00:00:00.5Z'));
  const leap = await t.offer({ deadline: '2026-01-01T23:59:60Z', write_scope: ['w:leap'] });
  assert.deepEqual(await t.tasks.expire(), [], 'not due yet');
  assert.equal((await t.record(leap.task_id)).status, 'offered');
});

test('every refusal is receipted, malformed requests included', async () => {
  const t = await setup();
  const task = await t.offer();
  await assert.rejects(t.tasks.commit({ ...t.request(t.lead, task, 'accepted'), transition: 'finish' }, { session: t.lead.session }), code('host.invalid_request'));
  await assert.rejects(t.tasks.commit(t.request(t.lead, task, 'accepted'), {}), code('caller_mismatch'));
  await assert.rejects(t.tasks.commit(null, { session: t.lead.session }), code('host.invalid_request'));
  await assert.rejects(t.tasks.offer({ operation_id: 'o_bad', objective: 'x' , extra: 1 }, { from: { kind: 'owner' } }), code('host.invalid_request'));
  await assert.rejects(t.tasks.offer({ operation_id: 'o_nobody', objective: 'x', done_criteria: 'y', accountable_soul: SOUL }, {}), code('host.invalid_request'));
  await assert.rejects(t.tasks.wait({ task_id: task.task_id, expected_revision: 0, operation_id: 'w_bad', reason: 'bored' }, { from: { kind: 'hq' } }), code('host.invalid_request'));
  await assert.rejects(t.tasks.cancel({ task_id: task.task_id, expected_revision: 0, operation_id: 'c_bad' }, { from: { kind: 'peer', soul: PEER } }), code('host.invalid_request'));
  const refused = t.host.receipts().filter((r) => r.kind.endsWith('.refused')).map((r) => [r.kind, r.code]);
  assert.deepEqual(refused, [
    ['task.commit.refused', 'host.invalid_request'], ['task.commit.refused', 'caller_mismatch'], ['task.commit.refused', 'host.invalid_request'],
    ['task.offer.refused', 'host.invalid_request'], ['task.offer.refused', 'host.invalid_request'],
    ['task.wait.refused', 'host.invalid_request'], ['task.cancel.refused', 'host.invalid_request'],
  ]);
});

test('commitment requests the contract refuses never reach the store', async () => {
  const t = await setup();
  const task = await t.offer();
  for (const name of ['task-commitment.illustrative-verb.json', 'task-commitment.missing-operation-id.json']) {
    const input = { ...fixture(`negative/${name}`).input, task_id: task.task_id, runtime_id: t.lead.runtime_id };
    await assert.rejects(t.tasks.commit(input, { session: t.lead.session }), code('host.invalid_request'), name);
  }
  assert.equal((await t.record(task.task_id)).revision, 0);
  await assert.rejects(t.tasks.offer({ operation_id: 'bad', objective: '', done_criteria: 'x', accountable_soul: SOUL }, { from: { kind: 'owner' } }), code('host.invalid_request'));
});

test('HQ runs the task service as a built-in plugin, and tasks persist in its store across a restart', async () => {
  const t = await startHQ();
  try {
    const tasks = t.hq.host.provided('hq-tasks');
    const r = await tasks.offer({ operation_id: 'durable_1', objective: 'x', done_criteria: 'y', accountable_soul: SOUL }, { from: { kind: 'owner' } });
    await t.hq.stop();
    await t.hq.start();
    const owner = await t.owner();
    const res = await owner.request('tasks.list', {});
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.result.map((x) => [x.task_id, x.status]), [[r.task_id, 'offered']]);

    // HQ's periodic pass runs the deadline sweep.
    const due = await t.hq.host.provided('hq-tasks').offer({ operation_id: 'durable_due', objective: 'x', done_criteria: 'y', accountable_soul: SOUL, deadline: '2026-11-01T00:00:00Z' }, { from: { kind: 'owner' } });
    assert.deepEqual((await t.hq.sweepTasks()).map((x) => x.task_id), [due.task_id]);
    assert.equal((await t.hq.host.provided('hq-tasks').get(due.task_id)).task.status, 'expired');
  } finally { await t.done(); }
});

test('the owner\'s config names concurrent writers as a list of workspaces', () => {
  assert.deepEqual(validateConfig({ concurrentWriters: ['workspace:shared'] }), { concurrentWriters: ['workspace:shared'] });
  for (const bad of ['workspace:shared', [''], [1], [{}]]) assert.throws(() => validateConfig({ concurrentWriters: bad }), /concurrentWriters/);
});

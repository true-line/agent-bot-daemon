// A member proposal is never a commitment (test gap #8; plan §9 PR 13; R3,
// T04 and T20 in 0.4 §14). hq-tasks.test.mjs shows one specialist proposing
// on a running task. This file closes the rest of the space: every member
// that is not the lead, in every task state HQ can reach today, sending
// every transition the task/v1 commitment contract names, on both paths a
// request arrives by. None of it moves a task, and nothing a member puts in
// a request, or does with an operation key, turns a proposal into a
// commitment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admissionPlugin } from '../hq/admission.mjs';
import { tasksPlugin } from '../hq/tasks.mjs';
import { createTestHost } from '../sdk/test-host.mjs';
import { referenceBroker } from './broker-fixture.mjs';
import { DIGEST, hello, schemas, SOUL, startHQ } from './hq-harness.mjs';

const code = (c) => (e) => { assert.equal(e.code, c, e.message); return true; };
const TRANSITIONS = schemas['task-commitment'].properties.transition.enum;
// Role names are free text in hq/v1; only the exact name `lead` commits.
const NOT_LEAD = ['specialist', 'reviewer', 'leader', 'lead-2'];
const roles = (names) => names.map((role) => ({ role, member_id: `m_${role}`, adapter_id: 'fake-adapter', adapter_version: '0.1.0' }));

async function setup() {
  const host = createTestHost({
    plugins: [admissionPlugin({ schemas }), tasksPlugin({ schemas })],
    config: { 'hq-admission': { acceptedDefinitions: { [SOUL]: [DIGEST] } }, 'hq-tasks': {} },
  });
  await host.start();
  const session = 'ep_a';
  const r = await host.dispatch('Hello', { auth: 'entry-point', payload: hello({ requested_roles: roles(['lead', ...NOT_LEAD]) }), session });
  const rt = (role) => ({ ...r.admitted_runtimes.find((a) => a.role === role), epoch: r.installation_epoch, generation: r.lease_generation, session });
  const tasks = host.provided('hq-tasks');
  let n = 0;
  const request = (who, task, transition, over = {}) => {
    n += 1;
    return {
      contract: 'task/v1', request_id: `req_${n}`, task_id: task.task_id, expected_revision: task.revision,
      installation_epoch: who.epoch, runtime_id: who.runtime_id, lease_generation: who.generation, operation_id: `op_${n}`, transition, ...over,
    };
  };
  const record = async (taskId) => (await tasks.get(taskId)).task;
  // The two ways a request reaches the service: the admission connection,
  // and a broker delivery with the runtime the member's connection bound.
  const via = { session: (who) => ({ session: who.session }), broker: (who) => ({ runtime_id: who.runtime_id }) };
  const lead = rt('lead');
  const leadCommits = async (task, to, over) => { await tasks.commit(request(lead, task, to, over), via.session(lead)); return record(task.task_id); };
  const hq = { from: { kind: 'hq' } };
  const owner = { from: { kind: 'owner' } };

  // A fresh task in `state`, reached the way HQ reaches it.
  const taskIn = async (state) => {
    n += 1;
    const deadline = state === 'expired' ? { deadline: new Date(host.clock.now() + 1_000).toISOString() } : {};
    const offered = await tasks.offer({ operation_id: `offer_${n}`, objective: 'Repair the seeded issue.', done_criteria: 'Checks pass.', accountable_soul: SOUL, write_scope: [`workspace:w${n}`], ...deadline }, owner);
    let task = await record(offered.task_id);
    if (state === 'offered') return task;
    if (state === 'canceled') { await tasks.cancel({ task_id: task.task_id, expected_revision: task.revision, operation_id: `cancel_${n}` }, owner); return record(task.task_id); }
    if (state === 'expired') { host.clock.advance(2_000); await tasks.expire(); return record(task.task_id); }
    task = await leadCommits(task, 'accepted');
    if (state === 'accepted') return task;
    if (state === 'failed') return leadCommits(task, 'failed');
    task = await leadCommits(task, 'running');
    if (state === 'running') return task;
    if (state === 'completed') return leadCommits(task, 'completed', { result_ref: 'artifact_lead' });
    assert.equal(state, 'waiting');
    await tasks.wait({ task_id: task.task_id, expected_revision: task.revision, operation_id: `wait_${n}`, reason: 'dependency' }, hq);
    return record(task.task_id);
  };
  return { host, tasks, rt, lead, request, record, via, taskIn, leadCommits };
}

// `reconciling` is entered by the action ledger (§9 PR 19) and cannot be
// reached yet; it joins this list with that PR.
const STATES = ['offered', 'accepted', 'running', 'waiting', 'completed', 'failed', 'canceled', 'expired'];

test('whatever a member that is not the lead sends, in any task state and on either path, is a proposal and the task does not move', async () => {
  const t = await setup();
  let attempts = 0;
  for (const state of STATES) {
    const task = await t.taskIn(state);
    assert.equal(task.status, state);
    for (const role of NOT_LEAD) {
      const who = t.rt(role);
      for (const path of ['session', 'broker']) {
        for (const transition of TRANSITIONS) {
          const where = `${role} sends ${transition} on a ${state} task over the ${path} path`;
          const receipt = await t.tasks.commit(t.request(who, task, transition, { result_ref: 'artifact_claimed', evidence_refs: ['check_claimed'] }), t.via[path](who));
          attempts += 1;
          assert.equal(receipt.outcome, 'proposal', where);
          assert.equal(receipt.by, who.member_id, where);
          assert.deepEqual([receipt.status, receipt.revision], [task.status, task.revision], where);
          assert.deepEqual(await t.record(task.task_id), task, `${where}: the task moved`);
        }
      }
    }
    // The claimed result and evidence stay on the proposals, never on the task.
    const { task: after, proposals } = await t.tasks.get(task.task_id);
    assert.deepEqual(after, task);
    assert.equal(JSON.stringify(after).includes('artifact_claimed'), false);
    assert.equal(proposals.length, NOT_LEAD.length * 2 * TRANSITIONS.length);
    assert.ok(proposals.every((p) => p.task_status === state && p.task_revision === task.revision && p.role !== 'lead'));
  }
  assert.equal(attempts, STATES.length * NOT_LEAD.length * 2 * TRANSITIONS.length);

  // Across the whole run: every committed transition is the lead's, the
  // owner's or HQ's, and every one of the members' requests is a proposal.
  const receipts = t.host.receipts();
  const committed = receipts.filter((r) => r.outcome === 'committed');
  assert.deepEqual([...new Set(committed.map((r) => r.by))].sort(), ['hq', 'm_lead', 'owner']);
  const theirs = receipts.filter((r) => NOT_LEAD.some((role) => r.by === `m_${role}`));
  assert.equal(theirs.length, attempts);
  assert.ok(theirs.every((r) => r.kind === 'task.commit' && r.outcome === 'proposal'));
});

test('a member cannot claim the lead\'s standing in a request', async () => {
  const t = await setup();
  const spec = t.rt('specialist');
  const task = await t.taskIn('running');

  // The contract has no field for who is asking: role, member and outcome
  // are HQ's to state, and a request that carries them is refused.
  for (const claim of [{ role: 'lead' }, { member_id: 'm_lead' }, { outcome: 'committed' }, { by: 'm_lead' }, { caller: `runtime:${t.lead.runtime_id}` }]) {
    for (const path of ['session', 'broker']) {
      await assert.rejects(t.tasks.commit(t.request(spec, task, 'completed', claim), t.via[path](spec)), code('host.invalid_request'), JSON.stringify(claim));
    }
  }
  // Bound as itself, it cannot name the lead's runtime, and it cannot name
  // its own with the lead's connection either.
  await assert.rejects(t.tasks.commit(t.request(t.lead, task, 'completed'), t.via.broker(spec)), code('caller_mismatch'));
  await assert.rejects(t.tasks.commit(t.request(spec, task, 'completed'), t.via.broker(t.lead)), code('caller_mismatch'));
  // Both paths at once is no caller at all.
  await assert.rejects(t.tasks.commit(t.request(spec, task, 'completed'), { session: spec.session, runtime_id: t.lead.runtime_id }), code('caller_mismatch'));
  assert.deepEqual(await t.record(task.task_id), task);
  assert.deepEqual((await t.tasks.get(task.task_id)).proposals, [], 'a refused request is not a proposal either');
});

test('an operation key never turns a proposal into a commitment, or a commitment into the member\'s', async () => {
  const t = await setup();
  const spec = t.rt('specialist');
  const task = await t.taskIn('running');

  // The specialist proposes completion over its bound connection.
  const proposal = t.request(spec, task, 'completed', { result_ref: 'artifact_spec' });
  const first = await t.tasks.commit(proposal, t.via.broker(spec));
  assert.equal(first.outcome, 'proposal');

  // The lead cannot reuse that operation: it belongs to the specialist.
  await assert.rejects(t.tasks.commit({ ...t.request(t.lead, task, 'completed'), operation_id: proposal.operation_id }, t.via.broker(t.lead)), code('caller_mismatch'));
  assert.deepEqual(await t.record(task.task_id), task);

  // The lead completes the task under its own operation.
  const leadRequest = t.request(t.lead, task, 'completed', { result_ref: 'artifact_spec' });
  const done = await t.tasks.commit(leadRequest, t.via.broker(t.lead));
  assert.equal(done.outcome, 'committed');
  const finished = await t.record(task.task_id);
  assert.equal(finished.status, 'completed');

  // Repeating the proposal now, when the task is where the proposal asked,
  // returns the stored proposal receipt: it did not become the commitment.
  assert.deepEqual(await t.tasks.commit(structuredClone(proposal), t.via.broker(spec)), first);
  // The specialist cannot replay the lead's request as its own, with the
  // lead's runtime or with its own under the lead's operation.
  await assert.rejects(t.tasks.commit(structuredClone(leadRequest), t.via.broker(spec)), code('caller_mismatch'));
  await assert.rejects(t.tasks.commit({ ...leadRequest, runtime_id: spec.runtime_id }, t.via.broker(spec)), code('caller_mismatch'));
  assert.deepEqual(await t.record(task.task_id), finished);
  assert.deepEqual(t.host.receipts().filter((r) => r.kind === 'task.commit' && r.task_id === task.task_id && r.outcome === 'committed').map((r) => [r.status, r.by]), [
    ['accepted', 'm_lead'], ['running', 'm_lead'], ['completed', 'm_lead'],
  ]);
});

test('over the broker socket and across a restart of HQ, a specialist\'s requests stay proposals', async () => {
  const t = await startHQ({ plugins: [referenceBroker()] });
  try {
    const admit = async (over = {}) => {
      const r = (await (await t.entry()).request('Hello', hello(over))).result;
      const rt = (role) => ({ ...r.admitted_runtimes.find((a) => a.role === role), epoch: r.installation_epoch, generation: r.lease_generation });
      return { lead: rt('lead'), spec: rt('specialist') };
    };
    const bound = async (who) => {
      const m = await t.member();
      assert.equal((await m.request('bind', { runtime_id: who.runtime_id, channel_binding: who.channel_binding })).ok, true);
      return m;
    };
    let n = 0;
    const request = (who, task, transition, over = {}) => {
      n += 1;
      return { contract: 'task/v1', request_id: `req_${n}`, task_id: task.task_id, expected_revision: task.revision, installation_epoch: who.epoch, runtime_id: who.runtime_id, lease_generation: who.generation, operation_id: `op_${n}`, transition, ...over };
    };
    const tasks = () => t.hq.host.provided('hq-tasks');
    const record = async (taskId) => (await tasks().get(taskId)).task;

    let { lead, spec } = await admit();
    const offered = await tasks().offer({ operation_id: 'offer_1', objective: 'Repair the seeded issue.', done_criteria: 'Checks pass.', accountable_soul: SOUL, write_scope: ['workspace:scratch'] }, { from: { kind: 'owner' } });
    let leadConn = await bound(lead);
    let specConn = await bound(spec);
    const everything = async (conn, who, task) => {
      for (const transition of TRANSITIONS) {
        const res = await conn.request('task.commit', request(who, task, transition, { result_ref: 'artifact_spec' }));
        assert.equal(res.ok, true, JSON.stringify(res));
        assert.equal(res.result.outcome, 'proposal', transition);
      }
      assert.deepEqual(await record(task.task_id), task);
    };

    let task = await record(offered.task_id);
    await everything(specConn, spec, task); // it cannot accept the owner's offer for the Soul
    for (const to of ['accepted', 'running']) {
      assert.equal((await leadConn.request('task.commit', request(lead, await record(task.task_id), to))).result.outcome, 'committed');
    }
    task = await record(task.task_id);
    await everything(specConn, spec, task);

    await t.hq.stop();
    await t.hq.start();
    // The task and the proposals are as they were: nothing was promoted.
    const stored = await tasks().get(task.task_id);
    assert.deepEqual(stored.task, task);
    assert.equal(stored.proposals.length, 2 * TRANSITIONS.length);

    ({ lead, spec } = await admit({ request_id: 'req_after_restart' }));
    specConn = await bound(spec);
    leadConn = await bound(lead);
    await everything(specConn, spec, task);
    const done = await leadConn.request('task.commit', request(lead, task, 'completed', { result_ref: 'artifact_spec' }));
    assert.equal(done.result.outcome, 'committed');
    task = await record(task.task_id);
    assert.equal(task.status, 'completed');
    await everything(specConn, spec, task); // a finished task stays finished

    const commits = t.hq.core.receipts.filter((r) => r.kind === 'task.commit');
    assert.deepEqual(commits.filter((r) => r.outcome === 'committed').map((r) => [r.status, r.by]), [['accepted', 'm_lead'], ['running', 'm_lead'], ['completed', 'm_lead']]);
    assert.ok(commits.filter((r) => r.by === 'm_spec').every((r) => r.outcome === 'proposal'));
  } finally { await t.done(); }
});

// The task service in HQ's store (plan §9 PR 13; 0.4 §7; soul-contracts
// schemas/task/v1). agent-bot-daemon is the `task-v1` provider (platform
// PDR-0024): authoritative task records live here, and agent-comms mirrors
// them unchanged through its codec.
//
// What it enforces:
// - Records. Every task record HQ writes validates against the pinned
//   task-record schema, and every commitment request against
//   task-commitment (fail closed, inbound and outbound).
// - Who commits. A member's request names its runtime; HQ looks the runtime
//   up through hq-admission inside admission's own transaction, so a Hello
//   that supersedes it cannot interleave. The caller is the connection, never
//   a payload field; the runtime must be live, of the task's accountable
//   Soul, at the current installation epoch and lease generation.
// - Proposals versus commitments (T20, R3). Only the current admitted lead
//   commits. Anything a specialist sends, a final answer included, is
//   recorded as a proposal and leaves the task unchanged; a proposal on a
//   finished task is retained as evidence and does not reopen it.
// - CAS. A commit carries the revision it expects; anything else is
//   `revision_conflict`. Completion and cancellation races are decided by
//   committed revision.
// - Operation keys (T05). An operation ID commits once. Repeating it with the
//   same content, from the same caller, returns the stored receipt; changed
//   content is refused.
// - Write-scope exclusion. Accepting a task whose write scope overlaps an
//   active task's is `write_scope_conflict`, unless the owner listed that
//   workspace in `concurrentWriters`.
// - Source authority (T04). An offer's requester is who sent it, never what
//   the payload claims. A peer offer stays peer data: it cannot carry a local
//   grant, and nothing here creates a grant or a directive.
//
// Not here yet: budgets reservation on accept (§9 PR 19), the action ledger
// and the `reconciling` state it drives (PR 19), owner-cleared waiting
// reasons (approvals, PR 21) and broker delivery of the `task.offer` and
// `task.commit` kinds (the broker, PR 16). The kinds are registered so the
// broker finds them; until then other HQ plugins reach the service through
// `ctx.deps['hq-tasks']`.
import { definePlugin } from '../sdk/plugin.mjs';
import { fail, HostError } from '../sdk/errors.mjs';
import { canonicalDigest } from '../sdk/wire/canonical-json.mjs';
import { validate } from '../sdk/wire/schema.mjs';

export const TASK_SCHEMA_NAMES = Object.freeze(['task-commitment', 'task-record']);
export const ACTIVE = Object.freeze(['accepted', 'running', 'waiting', 'reconciling']);
const TERMINAL = ['completed', 'failed', 'canceled', 'expired'];
const LEAD_ROLE = 'lead';

// What the current lead may commit, from each state (0.4 §7). `waiting` and
// `reconciling` are entered by HQ, which knows the reason; `canceled` is the
// owner's or HQ's; `expired` is the deadline sweep's.
const LEAD_TRANSITIONS = Object.freeze({
  offered: ['accepted'],
  accepted: ['running', 'completed', 'failed'],
  running: ['completed', 'failed'],
  waiting: ['running', 'completed', 'failed'],
  reconciling: ['completed', 'failed'],
});
// A lead can clear these itself by resuming; the others wait for the owner
// or HQ (owner input or pause, credentials, a reconciliation decision).
const LEAD_CLEARABLE = ['dependency', 'provider_availability'];
const HQ_WAIT_FROM = ['running', 'reconciling'];
const OFFER_FIELDS = new Set(['operation_id', 'objective', 'done_criteria', 'accountable_soul', 'write_scope', 'deadline', 'budget', 'restrictions', 'parent_or_peer_reference', 'grant_reference']);
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOUL_ID = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Two write scopes overlap when an entry of one equals, or is a path prefix
// of, an entry of the other. Returns the first overlapping pair.
export function scopeOverlap(a = [], b = []) {
  const under = (x, y) => x === y || y.startsWith(x.endsWith('/') ? x : `${x}/`);
  for (const x of a) for (const y of b) if (under(x, y) || under(y, x)) return [x, y];
  return undefined;
}

export function tasksPlugin({ schemas }) {
  for (const n of TASK_SCHEMA_NAMES) if (!schemas?.[n]) throw new TypeError(`the task service needs the pinned task/v1 ${n} schema`);

  const WAITING_REASONS = schemas['task-record'].properties?.waiting_reason?.enum ?? [];
  const check = (name, value, inbound) => {
    const errors = validate(schemas[name], value);
    if (!errors.length) return;
    const first = errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ');
    if (inbound) fail('host.invalid_request', `not a valid task/v1 ${name}: ${first}`, { errors: errors.slice(0, 10) });
    throw new Error(`HQ built an invalid task/v1 ${name} (${first}); refusing to write it`);
  };

  return definePlugin({
    name: 'hq-tasks',
    version: '0.1.0',
    hostApi: 1,
    requires: { 'hq-admission': '^0.1.0' },
    services: ['store', 'receipts', 'clock', 'random', 'config', 'log'],
    async init(ctx) {
      const { store, receipts, clock, random, config } = ctx.services;
      const admission = ctx.deps['hq-admission'];
      if (typeof admission?.withLiveRuntime !== 'function') throw new Error('hq-admission does not provide withLiveRuntime');
      const concurrent = () => config.get('concurrentWriters') ?? [];
      const id = (prefix) => `${prefix}_${random.hex(8)}`;
      const iso = (ms) => new Date(ms).toISOString();

      // An operation ID commits once. Inside the transaction that would
      // commit it: the stored receipt for an exact repeat, or a refusal.
      function repeated(tx, operationId, caller, digest) {
        const earlier = tx.get('operations', operationId);
        if (!earlier) return undefined;
        if (earlier.caller !== caller) fail('caller_mismatch', `operation ${operationId} belongs to another caller`);
        if (earlier.digest !== digest) fail('host.invalid_request', `operation ${operationId} was already used with different content`);
        return earlier.receipt;
      }

      // Commit one transition: CAS on the revision, the record checked
      // against the contract, the operation key and receipt stored with it.
      function transition(tx, task, { operationId, caller, digest, expectedRevision, to, patch = {}, by }) {
        if (expectedRevision !== task.revision) fail('revision_conflict', `task ${task.task_id} is at revision ${task.revision}, not ${expectedRevision}`, { revision: task.revision });
        const next = { ...task, ...patch, status: to, revision: task.revision + 1 };
        if (to !== 'waiting') delete next.waiting_reason;
        check('task-record', next, false);
        const receipt = { contract: 'task/v1', receipt_id: id('trc'), operation_id: operationId, task_id: task.task_id, outcome: 'committed', from: task.status, status: to, revision: next.revision, by, at: iso(clock.now()) };
        tx.put('tasks', task.task_id, next);
        tx.put('operations', operationId, { caller, digest, receipt });
        return receipt;
      }

      const taskOf = (tx, taskId) => {
        const task = tx.get('tasks', taskId);
        if (!task) fail('host.invalid_request', `unknown task ${taskId}`);
        return task;
      };

      // Receipt every decision, refusals included.
      async function receipted(kind, details, fn) {
        try {
          const out = await fn();
          if (out.fresh) await receipts.append({ kind, ...details, ...out.receipt });
          return out.receipt;
        } catch (e) {
          if (e instanceof HostError) await receipts.append({ kind: `${kind}.refused`, code: e.code, ...details }).catch(() => {});
          throw e;
        }
      }

      // An offer: from the owner, from HQ, or from a peer Soul. `from` is set
      // by the caller inside HQ from the authenticated source, never parsed
      // from the offer.
      async function offer(input, { from } = {}) {
        const requester = from?.kind === 'owner' ? 'owner' : from?.kind === 'hq' ? 'hq'
          : from?.kind === 'peer' && SOUL_ID.test(from.soul ?? '') ? `peer:${from.soul}` : undefined;
        if (!requester) fail('host.invalid_request', 'an offer needs its authenticated source: owner, hq, or a peer Soul');
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail('host.invalid_request', 'an offer is an object');
        for (const k of Object.keys(input)) if (!OFFER_FIELDS.has(k)) fail('host.invalid_request', `an offer has no field ${k}`, { field: k });
        if (typeof input.operation_id !== 'string' || !OPERATION_ID.test(input.operation_id)) fail('host.invalid_request', 'an offer needs an operation_id');
        const { operation_id: operationId, ...fields } = input;
        let reference = fields.parent_or_peer_reference;
        if (from.kind === 'peer') {
          // Peer data stays peer data (T04): no local grant, and the peer is
          // the one that sent it.
          if (fields.grant_reference !== undefined) fail('host.invalid_request', 'a peer offer cannot name a local grant');
          if (reference?.peer_soul_id !== undefined && reference.peer_soul_id !== from.soul) fail('caller_mismatch', `offer claims peer ${reference.peer_soul_id}, sent by ${from.soul}`);
          reference = { ...reference, peer_soul_id: from.soul };
        }
        const digest = canonicalDigest({ op: 'offer', input });
        return receipted('task.offer', { requester, operation_id: operationId }, () => store.tx((tx) => {
          const prior = repeated(tx, operationId, requester, digest);
          if (prior) return { receipt: prior, fresh: false };
          const task = { task_id: id('task'), ...fields, ...(reference ? { parent_or_peer_reference: reference } : {}), requester, revision: 0, status: 'offered' };
          check('task-record', task, true);
          const receipt = { contract: 'task/v1', receipt_id: id('trc'), operation_id: operationId, task_id: task.task_id, outcome: 'committed', status: 'offered', revision: 0, by: requester, at: iso(clock.now()) };
          tx.put('tasks', task.task_id, task);
          tx.put('operations', operationId, { caller: requester, digest, receipt });
          return { receipt, fresh: true };
        }));
      }

      // A member's task/v1 commitment request. `session` is the protected
      // connection it arrived on.
      async function commit(request, { session } = {}) {
        if (typeof session !== 'string' || !session) fail('caller_mismatch', 'no authenticated connection for this request');
        check('task-commitment', request, true);
        const digest = canonicalDigest({ op: 'commit', request });
        const details = { operation_id: request.operation_id, task_id: request.task_id, runtime_id: request.runtime_id, caller: session };
        return receipted('task.commit', details, () => admission.withLiveRuntime(request.runtime_id, session, (rt) => store.tx((tx) => {
          const prior = repeated(tx, request.operation_id, session, digest);
          if (prior) return { receipt: prior, fresh: false };
          if (request.installation_epoch !== rt.epoch) fail('stale_epoch', `runtime ${request.runtime_id} is at epoch ${rt.epoch}, not ${request.installation_epoch}`);
          if (request.lease_generation !== rt.lease_generation) fail('lease_expired', `runtime ${request.runtime_id} holds lease generation ${rt.lease_generation}, not ${request.lease_generation}`);
          const task = taskOf(tx, request.task_id);
          if (rt.soul_id !== task.accountable_soul) fail('caller_mismatch', `task ${task.task_id} belongs to ${task.accountable_soul}, not ${rt.soul_id}`);
          const evidence = [...(request.result_ref ? [request.result_ref] : []), ...(request.evidence_refs ?? [])];

          if (rt.role !== LEAD_ROLE) {
            // A specialist proposes (T20). The task does not move.
            const proposal = { proposal_id: id('prop'), task_id: task.task_id, operation_id: request.operation_id, member_id: rt.member_id, role: rt.role, runtime_id: request.runtime_id, transition: request.transition, evidence, task_revision: task.revision, task_status: task.status, at: iso(clock.now()) };
            const receipt = { contract: 'task/v1', receipt_id: id('trc'), operation_id: request.operation_id, task_id: task.task_id, outcome: 'proposal', proposal_id: proposal.proposal_id, status: task.status, revision: task.revision, by: rt.member_id, at: proposal.at };
            tx.put('proposals', proposal.proposal_id, proposal);
            tx.put('operations', request.operation_id, { caller: session, digest, receipt });
            return { receipt, fresh: true };
          }

          if (TERMINAL.includes(task.status)) fail('host.invalid_request', `task ${task.task_id} is ${task.status}`);
          const to = request.transition;
          if (to === 'canceled') fail('host.invalid_request', 'only the owner or HQ cancels a task');
          if (to === 'waiting' || to === 'reconciling') fail('host.invalid_request', `${to} is entered by HQ with its reason; task/v1 commitments carry none`);
          if (!(LEAD_TRANSITIONS[task.status] ?? []).includes(to)) fail('host.invalid_request', `task ${task.task_id} cannot go from ${task.status} to ${to}`);
          if (task.status === 'waiting' && to === 'running' && !LEAD_CLEARABLE.includes(task.waiting_reason)) {
            fail('host.invalid_request', `task ${task.task_id} waits on ${task.waiting_reason}, which the owner or HQ clears`);
          }
          if (to === 'accepted') {
            const allowed = new Set(concurrent());
            for (const [otherId, other] of tx.list('tasks')) {
              if (otherId === task.task_id || !ACTIVE.includes(other.status)) continue;
              const pair = scopeOverlap(task.write_scope, other.write_scope);
              if (pair && !(allowed.has(pair[0]) && allowed.has(pair[1]))) {
                fail('write_scope_conflict', `write scope ${pair[0]} overlaps ${pair[1]} of active task ${otherId}`, { task_id: otherId });
              }
            }
          }
          const patch = {
            ...(to === 'running' ? { lease_generation: rt.lease_generation } : {}),
            ...(evidence.length ? { evidence: [...(task.evidence ?? []), ...evidence] } : {}),
          };
          const receipt = transition(tx, task, { operationId: request.operation_id, caller: session, digest, expectedRevision: request.expected_revision, to, patch, by: rt.member_id });
          return { receipt, fresh: true };
        })));
      }

      // HQ or the owner: put an active task in waiting, with its reason.
      async function wait({ task_id: taskId, expected_revision: expectedRevision, operation_id: operationId, reason }, { from } = {}) {
        const by = ['owner', 'hq'].includes(from?.kind) ? from.kind : fail('host.invalid_request', 'waiting is set by the owner or HQ');
        if (!WAITING_REASONS.includes(reason)) fail('host.invalid_request', `waiting reason is one of ${WAITING_REASONS.join(', ')}`);
        if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) fail('host.invalid_request', 'waiting needs an operation_id');
        const digest = canonicalDigest({ op: 'wait', taskId, expectedRevision, reason });
        return receipted('task.wait', { operation_id: operationId, task_id: taskId, by }, () => store.tx((tx) => {
          const prior = repeated(tx, operationId, by, digest);
          if (prior) return { receipt: prior, fresh: false };
          const task = taskOf(tx, taskId);
          if (!HQ_WAIT_FROM.includes(task.status)) fail('host.invalid_request', `task ${taskId} cannot wait from ${task.status}`);
          return { receipt: transition(tx, task, { operationId, caller: by, digest, expectedRevision, to: 'waiting', patch: { waiting_reason: reason }, by }), fresh: true };
        }));
      }

      // The owner or HQ cancels; the revision check decides a race with a
      // completion.
      async function cancel({ task_id: taskId, expected_revision: expectedRevision, operation_id: operationId }, { from } = {}) {
        const by = ['owner', 'hq'].includes(from?.kind) ? from.kind : fail('host.invalid_request', 'only the owner or HQ cancels a task');
        if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) fail('host.invalid_request', 'a cancel needs an operation_id');
        const digest = canonicalDigest({ op: 'cancel', taskId, expectedRevision });
        return receipted('task.cancel', { operation_id: operationId, task_id: taskId, by }, () => store.tx((tx) => {
          const prior = repeated(tx, operationId, by, digest);
          if (prior) return { receipt: prior, fresh: false };
          const task = taskOf(tx, taskId);
          if (!ACTIVE.includes(task.status) && task.status !== 'offered') fail('host.invalid_request', `task ${taskId} is ${task.status}`);
          return { receipt: transition(tx, task, { operationId, caller: by, digest, expectedRevision, to: 'canceled', by }), fresh: true };
        }));
      }

      // The deadline sweep: an offer past its deadline, or an accepted or
      // waiting task past it with no lease, expires (0.4 §7).
      async function expire() {
        const now = clock.now();
        const done = await store.tx((tx) => {
          const out = [];
          for (const [, task] of tx.list('tasks')) {
            if (!task.deadline || Date.parse(task.deadline) > now) continue;
            if (!['offered', 'accepted', 'waiting'].includes(task.status)) continue;
            const operationId = `expire:${task.task_id}:${task.revision}`;
            out.push(transition(tx, task, { operationId, caller: 'hq', digest: canonicalDigest({ op: 'expire', task: task.task_id, revision: task.revision }), expectedRevision: task.revision, to: 'expired', by: 'hq' }));
          }
          return out;
        });
        for (const r of done) await receipts.append({ kind: 'task.expire', ...r });
        return done;
      }

      const get = (taskId) => store.tx((tx) => {
        const task = tx.get('tasks', taskId);
        if (!task) return null;
        return { task, proposals: tx.list('proposals').map(([, p]) => p).filter((p) => p.task_id === taskId) };
      });
      const list = () => store.tx((tx) => tx.list('tasks').map(([, t]) => ({ task_id: t.task_id, status: t.status, revision: t.revision, accountable_soul: t.accountable_soul, ...(t.waiting_reason ? { waiting_reason: t.waiting_reason } : {}), ...(t.deadline ? { deadline: t.deadline } : {}) })));

      ctx.hq.register({ op: 'tasks.list', auth: 'owner', handler: async () => list() });
      ctx.hq.register({
        op: 'tasks.get', auth: 'owner',
        handler: async (payload) => {
          if (!payload || typeof payload.task_id !== 'string' || Object.keys(payload).length !== 1) fail('host.invalid_request', 'tasks.get takes { task_id }');
          return (await get(payload.task_id)) ?? fail('host.invalid_request', `unknown task ${payload.task_id}`);
        },
      });
      ctx.broker.registerKind({ kind: 'task.commit', schema: schemas['task-commitment'], consume: (message, meta) => commit(message, meta) });
      ctx.broker.registerKind({ kind: 'task.offer', consume: (message, meta) => offer(message, meta) });

      return { provides: { offer, commit, wait, cancel, expire, get, list } };
    },
  });
}

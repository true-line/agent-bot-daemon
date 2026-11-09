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
//   that supersedes it cannot interleave. The caller is never a payload
//   field: it is the admission connection, or, for a message the broker
//   delivered (plan §4.9), the runtime the member's connection bound, which
//   the request must name. The runtime must be live, of the task's
//   accountable Soul, at the current installation epoch and lease generation.
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
// The broker delivers the `task.commit` kind with the bound runtime (§9 row
// 13b). It also finds `task.offer`, which a member cannot send: an offer's
// source is the owner, HQ or a peer Soul, and a member delivery carries none
// of those, so it is refused. Other HQ plugins reach the service through
// `ctx.deps['hq-tasks']`.
//
// How work reaches a Soul (§9 row 14 needs both ends):
// - The owner offers a task with `tasks.offer` on the control socket. The
//   requester is the socket's auth class, `owner`.
// - A bound member reads its Soul's waiting directives with the
//   `task.directives` kind, and one of its Soul's tasks with `task.get`.
//   A directive is a wire/v1 directive-or-query record for a task that is
//   still offered and whose requester is the owner or HQ. A peer's offer is
//   never a directive (T04). A member reads its own Soul's tasks only; a
//   task of another Soul and an unknown task get the same refusal.
//
// Not here yet: budgets reservation on accept (§9 PR 19), the action ledger
// and the `reconciling` state it drives (PR 19), and owner-cleared waiting
// reasons (approvals, PR 21).
import { definePlugin } from '../sdk/plugin.mjs';
import { fail, HostError } from '../sdk/errors.mjs';
import { canonicalDigest } from '../sdk/wire/canonical-json.mjs';
import { validate } from '../sdk/wire/schema.mjs';

export const TASK_SCHEMA_NAMES = Object.freeze(['task-commitment', 'task-record']);
// From wire/v1: the record a directive is delivered as.
export const TASK_WIRE_SCHEMA_NAMES = Object.freeze(['directive-or-query']);
const DIRECTIVE_ISSUERS = ['owner', 'hq'];
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

// `y` is `x` or below it, on a path boundary.
export const within = (x, y) => x === y || y.startsWith(x.endsWith('/') ? x : `${x}/`);

// Two write scopes overlap when an entry of one equals, or is a path prefix
// of, an entry of the other. Returns the first overlapping pair.
export function scopeOverlap(a = [], b = []) {
  for (const x of a) for (const y of b) if (within(x, y) || within(y, x)) return [x, y];
  return undefined;
}

// An overlap is allowed when both entries lie within one workspace the owner
// listed for concurrent writers.
export const overlapAllowed = ([x, y], allowed = []) => allowed.some((w) => within(w, x) && within(w, y));

// A deadline in milliseconds. RFC 3339 allows a leap second (:60), which
// Date.parse refuses; it is the instant after :59.
export function deadlineMs(deadline) {
  const ms = Date.parse(deadline);
  if (!Number.isNaN(ms)) return ms;
  const leap = /^(.*T\d{2}:\d{2}):60(\.\d+)?(.*)$/i.exec(deadline ?? '');
  return leap ? Date.parse(`${leap[1]}:59${leap[2] ?? ''}${leap[3]}`) + 1000 : Number.NaN;
}

export function tasksPlugin({ schemas }) {
  for (const n of TASK_SCHEMA_NAMES) if (!schemas?.[n]) throw new TypeError(`the task service needs the pinned task/v1 ${n} schema`);
  for (const n of TASK_WIRE_SCHEMA_NAMES) if (!schemas?.[n]) throw new TypeError(`the task service needs the pinned wire/v1 ${n} schema`);

  const WAITING_REASONS = schemas['task-record'].properties?.waiting_reason?.enum ?? [];
  const check = (name, value, inbound, contract = 'task/v1') => {
    const errors = validate(schemas[name], value);
    if (!errors.length) return;
    const first = errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ');
    if (inbound) fail('host.invalid_request', `not a valid ${contract} ${name}: ${first}`, { errors: errors.slice(0, 10) });
    throw new Error(`HQ built an invalid ${contract} ${name} (${first}); refusing to write it`);
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
      for (const f of ['withLiveRuntime', 'withLeases', 'withBoundRuntime']) if (typeof admission?.[f] !== 'function') throw new Error(`hq-admission does not provide ${f}`);
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
        const operationId = typeof input?.operation_id === 'string' ? input.operation_id : undefined;
        return receipted('task.offer', { requester: requester ?? 'unknown', ...(operationId ? { operation_id: operationId } : {}) }, () => {
          if (!requester) fail('host.invalid_request', 'an offer needs its authenticated source: owner, hq, or a peer Soul');
          if (!input || typeof input !== 'object' || Array.isArray(input)) fail('host.invalid_request', 'an offer is an object');
          for (const k of Object.keys(input)) if (!OFFER_FIELDS.has(k)) fail('host.invalid_request', `an offer has no field ${k}`, { field: k });
          if (!operationId || !OPERATION_ID.test(operationId)) fail('host.invalid_request', 'an offer needs an operation_id');
          const { operation_id: _op, ...fields } = input;
          let reference = fields.parent_or_peer_reference;
          if (from.kind === 'peer') {
            // Peer data stays peer data (T04): no local grant, and the peer is
            // the one that sent it.
            if (fields.grant_reference !== undefined) fail('host.invalid_request', 'a peer offer cannot name a local grant');
            if (reference?.peer_soul_id !== undefined && reference.peer_soul_id !== from.soul) fail('caller_mismatch', `offer claims peer ${reference.peer_soul_id}, sent by ${from.soul}`);
            reference = { ...reference, peer_soul_id: from.soul };
          }
          const digest = canonicalDigest({ op: 'offer', input });
          return store.tx((tx) => {
          const prior = repeated(tx, operationId, requester, digest);
          if (prior) return { receipt: prior, fresh: false };
          const task = { task_id: id('task'), ...fields, ...(reference ? { parent_or_peer_reference: reference } : {}), requester, revision: 0, status: 'offered' };
          check('task-record', task, true);
          const receipt = { contract: 'task/v1', receipt_id: id('trc'), operation_id: operationId, task_id: task.task_id, outcome: 'committed', status: 'offered', revision: 0, by: requester, at: iso(clock.now()) };
          tx.put('tasks', task.task_id, task);
          tx.put('operations', operationId, { caller: requester, digest, receipt });
          return { receipt, fresh: true };
          });
        });
      }

      // A member's task/v1 commitment request. Exactly one of: `session`, the
      // admission connection it arrived on, or `runtime_id`, the runtime the
      // broker bound the member's connection to (§4.9).
      async function commit(request, { session, runtime_id: bound } = {}) {
        const field = (k) => (typeof request?.[k] === 'string' ? { [k]: request[k] } : {});
        const viaSession = typeof session === 'string' && session !== '';
        const viaBroker = typeof bound === 'string' && bound !== '';
        const caller = viaSession && !viaBroker ? session : viaBroker && !viaSession ? `runtime:${bound}` : undefined;
        const details = { ...field('operation_id'), ...field('task_id'), ...field('runtime_id'), caller: caller ?? 'unknown' };
        return receipted('task.commit', details, () => {
          if (!caller) fail('caller_mismatch', 'no authenticated connection or bound runtime for this request');
          check('task-commitment', request, true);
          if (viaBroker && request.runtime_id !== bound) fail('caller_mismatch', `the connection is bound to runtime ${bound}, not ${request.runtime_id}`);
          const digest = canonicalDigest({ op: 'commit', request });
          const withRuntime = viaBroker ? (fn) => admission.withBoundRuntime(bound, fn) : (fn) => admission.withLiveRuntime(request.runtime_id, session, fn);
          return withRuntime((rt) => store.tx((tx) => {
          const prior = repeated(tx, request.operation_id, caller, digest);
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
            tx.put('operations', request.operation_id, { caller, digest, receipt });
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
            const allowed = concurrent();
            for (const [otherId, other] of tx.list('tasks')) {
              if (otherId === task.task_id || !ACTIVE.includes(other.status)) continue;
              const pair = scopeOverlap(task.write_scope, other.write_scope);
              if (pair && !overlapAllowed(pair, allowed)) {
                fail('write_scope_conflict', `write scope ${pair[0]} overlaps ${pair[1]} of active task ${otherId}`, { task_id: otherId });
              }
            }
          }
          const patch = {
            ...(to === 'running' ? { lease_generation: rt.lease_generation } : {}),
            ...(evidence.length ? { evidence: [...(task.evidence ?? []), ...evidence] } : {}),
          };
          const receipt = transition(tx, task, { operationId: request.operation_id, caller, digest, expectedRevision: request.expected_revision, to, patch, by: rt.member_id });
          return { receipt, fresh: true };
          }));
        });
      }

      // HQ or the owner: put an active task in waiting, with its reason.
      async function wait({ task_id: taskId, expected_revision: expectedRevision, operation_id: operationId, reason }, { from } = {}) {
        const by = ['owner', 'hq'].includes(from?.kind) ? from.kind : undefined;
        return receipted('task.wait', { operation_id: operationId, task_id: taskId, by: by ?? 'unknown' }, () => {
          if (!by) fail('host.invalid_request', 'waiting is set by the owner or HQ');
          if (!WAITING_REASONS.includes(reason)) fail('host.invalid_request', `waiting reason is one of ${WAITING_REASONS.join(', ')}`);
          if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) fail('host.invalid_request', 'waiting needs an operation_id');
          const digest = canonicalDigest({ op: 'wait', taskId, expectedRevision, reason });
          return store.tx((tx) => {
          const prior = repeated(tx, operationId, by, digest);
          if (prior) return { receipt: prior, fresh: false };
          const task = taskOf(tx, taskId);
          if (!HQ_WAIT_FROM.includes(task.status)) fail('host.invalid_request', `task ${taskId} cannot wait from ${task.status}`);
          return { receipt: transition(tx, task, { operationId, caller: by, digest, expectedRevision, to: 'waiting', patch: { waiting_reason: reason }, by }), fresh: true };
          });
        });
      }

      // The owner or HQ cancels; the revision check decides a race with a
      // completion.
      async function cancel({ task_id: taskId, expected_revision: expectedRevision, operation_id: operationId }, { from } = {}) {
        const by = ['owner', 'hq'].includes(from?.kind) ? from.kind : undefined;
        return receipted('task.cancel', { operation_id: operationId, task_id: taskId, by: by ?? 'unknown' }, () => {
          if (!by) fail('host.invalid_request', 'only the owner or HQ cancels a task');
          if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) fail('host.invalid_request', 'a cancel needs an operation_id');
          const digest = canonicalDigest({ op: 'cancel', taskId, expectedRevision });
          return store.tx((tx) => {
          const prior = repeated(tx, operationId, by, digest);
          if (prior) return { receipt: prior, fresh: false };
          const task = taskOf(tx, taskId);
          if (!ACTIVE.includes(task.status) && task.status !== 'offered') fail('host.invalid_request', `task ${taskId} is ${task.status}`);
          return { receipt: transition(tx, task, { operationId, caller: by, digest, expectedRevision, to: 'canceled', by }), fresh: true };
          });
        });
      }

      // The deadline sweep (0.4 §7): an offer past its deadline expires, and
      // so does an accepted or waiting task past it that no live lease holds.
      // A waiting task keeps the lease generation it last ran under; it is
      // held only while a runtime of its Soul at that generation is still
      // live, so a task whose worker lease lapsed can expire. The check runs
      // inside admission's transaction queue, as a commit's does.
      async function expire() {
        const now = clock.now();
        const done = await admission.withLeases((held) => store.tx((tx) => {
          const out = [];
          for (const [, task] of tx.list('tasks')) {
            if (!task.deadline || !(deadlineMs(task.deadline) <= now)) continue;
            if (!['offered', 'accepted', 'waiting'].includes(task.status)) continue;
            if (task.status !== 'offered' && task.lease_generation !== undefined && held(task.accountable_soul, task.lease_generation)) continue;
            const operationId = `expire:${task.task_id}:${task.revision}`;
            out.push(transition(tx, task, { operationId, caller: 'hq', digest: canonicalDigest({ op: 'expire', task: task.task_id, revision: task.revision }), expectedRevision: task.revision, to: 'expired', by: 'hq' }));
          }
          return out;
        }));
        for (const r of done) await receipts.append({ kind: 'task.expire', ...r });
        return done;
      }

      const get = (taskId) => store.tx((tx) => {
        const task = tx.get('tasks', taskId);
        if (!task) return null;
        return { task, proposals: tx.list('proposals').map(([, p]) => p).filter((p) => p.task_id === taskId) };
      });

      // A member's reads, by the runtime the broker bound. `fn(tx, runtime)`
      // runs in admission's queue, so the runtime is live while it reads.
      // Refusals are receipted; a read changes nothing, so it leaves no
      // receipt of its own.
      async function memberRead(kind, bound, details, fn) {
        try {
          if (typeof bound !== 'string' || bound === '') fail('caller_mismatch', 'no bound runtime for this request');
          return await admission.withBoundRuntime(bound, (rt) => store.tx((tx) => fn(tx, rt)));
        } catch (e) {
          if (e instanceof HostError) await receipts.append({ kind: `${kind}.refused`, code: e.code, ...details, caller: typeof bound === 'string' && bound ? `runtime:${bound}` : 'unknown' }).catch(() => {});
          throw e;
        }
      }
      const empty = (message) => message === undefined || message === null || (typeof message === 'object' && !Array.isArray(message) && Object.keys(message).length === 0);

      // The waiting directives of the bound runtime's Soul: its offered
      // tasks from the owner or HQ, oldest first. A directive with no
      // deadline is good for the reader's lease and is read again after it.
      const directives = (message, { runtime_id: bound } = {}) => memberRead('task.directives', bound, {}, (tx, rt) => {
        if (!empty(message)) fail('host.invalid_request', 'task.directives takes no fields');
        const out = [];
        for (const [, task] of tx.list('tasks')) {
          if (task.accountable_soul !== rt.soul_id || task.status !== 'offered' || !DIRECTIVE_ISSUERS.includes(task.requester)) continue;
          const directive = {
            message_id: `dir_${task.task_id}`,
            issuer: { principal: task.requester },
            recipient: rt.soul_id,
            kind: 'directive',
            task_or_decision_reference: { task_id: task.task_id },
            ...(task.grant_reference ? { policy_or_grant_reference: { grant_id: task.grant_reference } } : {}),
            expiry: task.deadline ?? iso(rt.lease_expires_at),
            payload: { task },
          };
          check('directive-or-query', directive, false, 'wire/v1');
          out.push(directive);
        }
        return { directives: out };
      });

      // One task of the bound runtime's Soul, with its proposals.
      const memberGet = (message, { runtime_id: bound } = {}) => {
        const taskId = typeof message?.task_id === 'string' ? message.task_id : undefined;
        return memberRead('task.get', bound, taskId && OPERATION_ID.test(taskId) ? { task_id: taskId } : {}, (tx, rt) => {
          if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).length !== 1 || !taskId) fail('host.invalid_request', 'task.get takes { task_id }');
          const task = tx.get('tasks', taskId);
          if (!task || task.accountable_soul !== rt.soul_id) fail('caller_mismatch', `${taskId} is not a task of this runtime's Soul`);
          return { task, proposals: tx.list('proposals').map(([, p]) => p).filter((p) => p.task_id === taskId) };
        });
      };

      const list = () => store.tx((tx) => tx.list('tasks').map(([, t]) => ({ task_id: t.task_id, status: t.status, revision: t.revision, accountable_soul: t.accountable_soul, ...(t.waiting_reason ? { waiting_reason: t.waiting_reason } : {}), ...(t.deadline ? { deadline: t.deadline } : {}) })));

      ctx.hq.register({ op: 'tasks.list', auth: 'owner', handler: async () => list() });
      // The owner's offer: the requester is the control socket's auth class.
      ctx.hq.register({ op: 'tasks.offer', auth: 'owner', handler: async (payload) => offer(payload, { from: { kind: 'owner' } }) });
      ctx.hq.register({
        op: 'tasks.get', auth: 'owner',
        handler: async (payload) => {
          if (!payload || typeof payload.task_id !== 'string' || Object.keys(payload).length !== 1) fail('host.invalid_request', 'tasks.get takes { task_id }');
          return (await get(payload.task_id)) ?? fail('host.invalid_request', `unknown task ${payload.task_id}`);
        },
      });
      ctx.broker.registerKind({ kind: 'task.commit', schema: schemas['task-commitment'], consume: (message, meta) => commit(message, meta) });
      // A member delivery carries a runtime, never an offer source, so offer()
      // refuses it (and receipts the refusal).
      ctx.broker.registerKind({ kind: 'task.offer', consume: (message) => offer(message, {}) });
      ctx.broker.registerKind({ kind: 'task.directives', consume: directives });
      ctx.broker.registerKind({ kind: 'task.get', consume: memberGet });

      return { provides: { offer, commit, wait, cancel, expire, get, list, directives } };
    },
  });
}

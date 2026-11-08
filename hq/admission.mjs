// hq/v1 admission (plan §9 PR 12; 0.4 §5; soul-contracts schemas/hq/v1):
// Hello, Admit, Equip, Ready and Lease, as an HQ plugin built on the SDK.
// The catalog gives admission, leases and epochs to agent-bot-daemon, so this
// plugin stays in HQ; the Soul runtime's HQ side adds validation and render
// handlers later (§4.4 step 4).
//
// What it enforces now:
// - Every record is checked against the pinned schema, inbound and outbound
//   (fail closed: HQ never sends a record its own contract refuses).
// - Versions: N and N-1 per contract, highest common wins (R7, T14).
// - Definitions: only digests the owner accepted in HQ's config admit
//   (`definition_not_accepted`), until accept-revision lands (§9 PR 21).
// - Epochs: one current installation per Soul on this HQ. A move needs the
//   current epoch; an older one is `stale_epoch` (T15).
// - Leases: a generation per admission, renewals in sequence, expiry.
// - Caller binding: the admission-socket connection that sent Hello owns its
//   runtimes; any other connection gets `caller_mismatch` (T01, in the
//   cooperative form: HQ cannot yet tell members apart, only connections).
// - Profile: the one in force, with a warning when weaker than requested (R8).
//
// It provides withLiveRuntime to the task service (hq-tasks), so a task
// commit checks the runtime and commits without an admission in between.
// For the member broker socket (plan §4.9) it provides verifyBinding, which
// the broker plugin calls on a `bind` frame, and withBoundRuntime, which a
// consumer uses for a message the broker delivered with its bound runtime.
//
// Equip carries no credentials yet: grants and credential references arrive
// with §9 PRs 18 and 21. It hands out one opaque grant handle per member.
import { timingSafeEqual } from 'node:crypto';
import { definePlugin } from '../sdk/plugin.mjs';
import { fail, HostError } from '../sdk/errors.mjs';
import { canonicalDigest } from '../sdk/wire/canonical-json.mjs';
import { validate } from '../sdk/wire/schema.mjs';
import { negotiateVersions, supportWindow } from '../sdk/wire/versions.mjs';
import { profileWarning } from './profile.mjs';

export const CURRENT_VERSIONS = Object.freeze({ hq: 1, wire: 1, task: 1 });
export const SCHEMA_NAMES = Object.freeze(['hello', 'admission-result', 'equip', 'ready-and-lease-renewal']);
const DEFAULT_LEASE_TTL_MS = 60_000;
const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// hq/v1 admission-result admitted_runtimes[].channel_binding.
const CHANNEL_BINDING = /^[A-Za-z0-9_-]{16,128}$/;

// Compare two bindings without leaking where they differ.
const sameBinding = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const iso = (ms) => new Date(ms).toISOString();

export function admissionPlugin({ schemas, profileReasons = () => [] }) {
  for (const n of SCHEMA_NAMES) if (!schemas?.[n]) throw new TypeError(`admission needs the pinned hq/v1 ${n} schema`);

  const check = (name, value, inbound) => {
    const errors = validate(schemas[name], value);
    if (!errors.length) return;
    const first = errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ');
    if (inbound) fail('host.invalid_request', `not a valid hq/v1 ${name}: ${first}`, { errors: errors.slice(0, 10) });
    throw new Error(`HQ built an invalid hq/v1 ${name} (${first}); refusing to send it`);
  };

  return definePlugin({
    name: 'hq-admission',
    version: '0.1.0',
    hostApi: 1,
    services: ['store', 'receipts', 'clock', 'random', 'config', 'profile', 'log'],
    async init(ctx) {
      const { store, receipts, clock, random, config, profile } = ctx.services;
      const ttl = () => config.get('leaseTtlMs') ?? DEFAULT_LEASE_TTL_MS;
      const accepted = (soul, digest) => (config.get('acceptedDefinitions')?.[soul] ?? []).includes(digest);
      const id = (prefix, bytes = 12) => `${prefix}_${random.hex(bytes)}`;
      const callerOf = (meta) => {
        if (typeof meta?.session !== 'string' || !meta.session) fail('caller_mismatch', 'no authenticated connection for this request');
        return meta.session;
      };

      // Receipt every decision, refusals included. Receipts carry no channel
      // bindings or handles.
      const receipted = (op, fn) => async (payload, meta) => {
        try {
          return await fn(payload, meta);
        } catch (e) {
          if (e instanceof HostError) {
            await receipts.append({ kind: `hq.${op.toLowerCase()}.refused`, code: e.code, caller: meta?.session, ...(payload?.request_id ? { request_id: payload.request_id } : {}), ...(payload?.runtime_id ? { runtime_id: payload.runtime_id } : {}) }).catch(() => {});
          }
          throw e;
        }
      };

      async function hello(payload, meta) {
        const caller = callerOf(meta);
        check('hello', payload, true);
        const digest = canonicalDigest(payload);
        const now = clock.now();
        // One transaction: the repeat check, the decision and its records, so
        // two Hellos with one request_id cannot both admit.
        const { result, repeat } = await store.tx(async (tx) => {
          const earlier = tx.get('hellos', payload.request_id);
          if (earlier) {
            if (earlier.caller !== caller) fail('caller_mismatch', `request ${payload.request_id} belongs to another connection`);
            if (earlier.digest !== digest) fail('host.invalid_request', `request ${payload.request_id} was already used with different content`);
            return { result: earlier.result, repeat: true };
          }
          const negotiated = negotiateVersions(payload.supported_versions, supportWindow(CURRENT_VERSIONS), { required: ['hq', 'wire'] });
          if (!accepted(payload.soul_id, payload.definition_digest)) {
            fail('definition_not_accepted', `the owner has not accepted definition ${payload.definition_digest} for ${payload.soul_id}`);
          }
          const soul = tx.get('souls', payload.soul_id);
          const priorEpoch = payload.prior_installation_epoch;
          let epoch;
          if (soul && soul.installation_id === payload.installation_id) {
            if (priorEpoch !== undefined && priorEpoch !== soul.epoch) fail('stale_epoch', `installation ${payload.installation_id} is at epoch ${soul.epoch}, not ${priorEpoch}`);
            epoch = soul.epoch; // a restart of the current installation keeps its epoch
          } else if (soul) {
            if (priorEpoch === undefined) fail('stale_epoch', `${payload.soul_id} is installed here as ${soul.installation_id} (epoch ${soul.epoch}); a new installation needs a move`);
            if (priorEpoch < soul.epoch) fail('stale_epoch', `HQ's current epoch for ${payload.soul_id} is ${soul.epoch}; a copy replacing epoch ${priorEpoch} is refused`);
            epoch = priorEpoch + 1;
          } else {
            epoch = priorEpoch === undefined ? 1 : priorEpoch + 1; // first start, or arrival after a move
          }
          const leaseGeneration = (soul?.lease_generation ?? 0) + 1;
          const leaseExpires = now + ttl();
          // A new admission supersedes the Soul's earlier runtimes.
          for (const [rid, rt] of tx.list('runtimes')) {
            if (rt.soul_id === payload.soul_id && !rt.superseded) tx.put('runtimes', rid, { ...rt, superseded: true });
          }
          const admitted = payload.requested_roles.map((r) => ({ member_id: r.member_id, role: r.role, runtime_id: id('rt', 8), channel_binding: id('cb', 16) }));
          const inForce = profile.current();
          const warning = profileWarning(payload.requested_profile, inForce, profileReasons());
          const decision = {
            contract: 'hq/v1',
            request_id: payload.request_id,
            decision_id: id('dec', 8),
            installation_epoch: epoch,
            profile: inForce,
            negotiated_versions: negotiated,
            admitted_runtimes: admitted,
            lease_generation: leaseGeneration,
            lease_expires_at: iso(leaseExpires),
            ...(warning ? { warnings: [warning] } : {}),
          };
          check('admission-result', decision, false);
          tx.put('souls', payload.soul_id, { installation_id: payload.installation_id, epoch, lease_generation: leaseGeneration, decision_id: decision.decision_id, definition_digest: payload.definition_digest, admitted_at: now });
          for (const a of admitted) {
            tx.put('runtimes', a.runtime_id, {
              soul_id: payload.soul_id, installation_id: payload.installation_id, member_id: a.member_id, role: a.role,
              channel_binding: a.channel_binding, caller, epoch, lease_generation: leaseGeneration,
              lease_expires_at: leaseExpires, renewal_sequence: 0, ready: false, superseded: false,
            });
          }
          tx.put('hellos', payload.request_id, { caller, digest, result: decision, at: now });
          return { result: decision, repeat: false };
        });
        if (!repeat) {
          await receipts.append({ kind: 'hq.admission', request_id: result.request_id, decision_id: result.decision_id, soul_id: payload.soul_id, installation_id: payload.installation_id, installation_epoch: result.installation_epoch, lease_generation: result.lease_generation, profile_in_force: result.profile, runtimes: result.admitted_runtimes.length, caller });
        }
        return result;
      }

      async function admit(payload, meta) {
        const caller = callerOf(meta);
        if (!payload || typeof payload !== 'object' || typeof payload.request_id !== 'string' || Object.keys(payload).length !== 1) {
          fail('host.invalid_request', 'Admit takes { request_id } of an earlier Hello');
        }
        const prior = await store.tx((tx) => tx.get('hellos', payload.request_id));
        if (!prior) fail('host.invalid_request', `no admission for request ${payload.request_id}`);
        if (prior.caller !== caller) fail('caller_mismatch', `request ${payload.request_id} belongs to another connection`);
        return prior.result;
      }

      // A runtime that is neither superseded nor past its lease, or the reason.
      function current(rt, runtimeId, now) {
        if (rt.superseded) fail('lease_expired', `runtime ${runtimeId} was superseded by a newer admission; send Hello again`);
        if (now > rt.lease_expires_at) fail('lease_expired', `runtime ${runtimeId}'s lease expired at ${iso(rt.lease_expires_at)}; send Hello again`);
        return rt;
      }

      // Look up a live runtime for its caller, or refuse with the reason.
      function liveRuntime(tx, runtimeId, caller, now) {
        const rt = tx.get('runtimes', runtimeId);
        if (!rt) fail('host.invalid_request', `unknown runtime ${runtimeId}`);
        if (rt.caller !== caller) fail('caller_mismatch', `runtime ${runtimeId} was admitted to another connection`);
        return current(rt, runtimeId, now);
      }

      async function equip(payload, meta) {
        const caller = callerOf(meta);
        if (!payload || typeof payload !== 'object' || Object.keys(payload).length !== 1 || typeof payload.runtime_id !== 'string' || !RUNTIME_ID.test(payload.runtime_id)) {
          fail('host.invalid_request', 'Equip takes { runtime_id }');
        }
        const now = clock.now();
        const record = await store.tx((tx) => {
          const rt = liveRuntime(tx, payload.runtime_id, caller, now);
          const handle = rt.handle ?? id('gh', 16);
          if (!rt.handle) tx.put('runtimes', payload.runtime_id, { ...rt, handle });
          return {
            contract: 'hq/v1',
            runtime_id: payload.runtime_id,
            grant_handles: [{ member_id: rt.member_id, channel_binding: rt.channel_binding, handle }],
            credential_references: [],
            approved_destinations: [],
            budget_sub_allocations: { working: 0, maintenance: 0 },
          };
        });
        check('equip', record, false);
        await receipts.append({ kind: 'hq.equip', runtime_id: payload.runtime_id, credential_references: 0, caller });
        return record;
      }

      const renew = (op) => async (payload, meta) => {
        const caller = callerOf(meta);
        check('ready-and-lease-renewal', payload, true);
        const now = clock.now();
        const out = await store.tx((tx) => {
          const rt = liveRuntime(tx, payload.runtime_id, caller, now);
          if (payload.installation_epoch !== rt.epoch) fail('stale_epoch', `runtime ${payload.runtime_id} is at epoch ${rt.epoch}, not ${payload.installation_epoch}`);
          if (payload.lease_generation !== rt.lease_generation) fail('lease_expired', `runtime ${payload.runtime_id} holds lease generation ${rt.lease_generation}, not ${payload.lease_generation}`);
          if (payload.renewal_sequence <= rt.renewal_sequence) fail('host.invalid_request', `renewal ${payload.renewal_sequence} is not after ${rt.renewal_sequence}: replay refused`);
          if (op === 'Lease' && !rt.ready) fail('host.invalid_request', `runtime ${payload.runtime_id} has not sent Ready`);
          const leaseExpires = now + ttl();
          tx.put('runtimes', payload.runtime_id, {
            ...rt, ready: true, renewal_sequence: payload.renewal_sequence, lease_expires_at: leaseExpires,
            readiness_state: payload.readiness_state, auth_state: payload.auth_state, observed_health: payload.observed_health,
          });
          return { contract: 'hq/v1', runtime_id: payload.runtime_id, installation_epoch: rt.epoch, lease_generation: rt.lease_generation, lease_expires_at: iso(leaseExpires) };
        });
        if (op === 'Ready') await receipts.append({ kind: 'hq.ready', runtime_id: payload.runtime_id, readiness_state: payload.readiness_state, caller });
        return out;
      };

      async function soulsList() {
        return store.tx((tx) => {
          const runtimes = tx.list('runtimes').map(([, rt]) => rt).filter((rt) => !rt.superseded);
          return tx.list('souls').map(([soulId, s]) => ({
            soul_id: soulId,
            installation_id: s.installation_id,
            installation_epoch: s.epoch,
            lease_generation: s.lease_generation,
            runtimes: runtimes.filter((rt) => rt.soul_id === soulId).map((rt) => ({ member_id: rt.member_id, role: rt.role, ready: rt.ready, lease_expires_at: iso(rt.lease_expires_at) })),
          }));
        });
      }

      ctx.hq.register({ op: 'Hello', auth: 'entry-point', handler: receipted('Hello', hello) });
      ctx.hq.register({ op: 'Admit', auth: 'entry-point', handler: receipted('Admit', admit) });
      ctx.hq.register({ op: 'Equip', auth: 'entry-point', handler: receipted('Equip', equip) });
      ctx.hq.register({ op: 'Ready', auth: 'entry-point', handler: receipted('Ready', renew('Ready')) });
      ctx.hq.register({ op: 'Lease', auth: 'entry-point', handler: receipted('Lease', renew('Lease')) });
      ctx.hq.register({ op: 'souls.list', auth: 'owner', handler: soulsList });

      // For the task service (§9 PR 13): run `fn(runtime)` on a live runtime
      // of this caller, inside admission's own transaction queue, so no Hello,
      // Ready or Lease changes the runtime, its epoch or its lease while `fn`
      // decides. `fn` may open its own plugin's transaction; it must not call
      // back into admission.
      const withLiveRuntime = (runtimeId, caller, fn) => store.tx(async (tx) => fn(Object.freeze(liveRuntime(tx, runtimeId, caller, clock.now()))));
      // For the task deadline sweep: `fn(held)` inside the same queue, where
      // held(soulId, generation) says whether a live runtime of that Soul
      // still holds that lease generation.
      const withLeases = (fn) => store.tx(async (tx) => {
        const now = clock.now();
        const live = tx.list('runtimes').map(([, rt]) => rt).filter((rt) => !rt.superseded && now <= rt.lease_expires_at);
        return fn((soulId, generation) => live.some((rt) => rt.soul_id === soulId && rt.lease_generation === generation));
      });
      // For the broker plugin (§4.9): does this binding speak for this live
      // runtime? An unknown runtime and a wrong binding get the same answer,
      // so a probe learns nothing about which runtimes exist. Receipted
      // without the binding.
      async function verifyBinding(input) {
        const { runtime_id: runtimeId, channel_binding: binding } = input ?? {};
        try {
          if (!input || typeof input !== 'object' || Object.keys(input).length !== 2
            || typeof runtimeId !== 'string' || !RUNTIME_ID.test(runtimeId)
            || typeof binding !== 'string' || !CHANNEL_BINDING.test(binding)) {
            fail('host.invalid_request', 'bind takes { runtime_id, channel_binding } from the admission result');
          }
          const bound = await store.tx((tx) => {
            const rt = tx.get('runtimes', runtimeId);
            if (!rt || !sameBinding(rt.channel_binding, binding)) fail('caller_mismatch', `the channel binding does not match runtime ${runtimeId}`);
            current(rt, runtimeId, clock.now());
            return Object.freeze({ runtime_id: runtimeId, soul_id: rt.soul_id, member_id: rt.member_id, role: rt.role, installation_epoch: rt.epoch, lease_generation: rt.lease_generation });
          });
          await receipts.append({ kind: 'hq.bind', runtime_id: runtimeId, soul_id: bound.soul_id, member_id: bound.member_id });
          return bound;
        } catch (e) {
          if (e instanceof HostError) await receipts.append({ kind: 'hq.bind.refused', code: e.code, ...(typeof runtimeId === 'string' && RUNTIME_ID.test(runtimeId) ? { runtime_id: runtimeId } : {}) }).catch(() => {});
          throw e;
        }
      }
      // For a consumer of a brokered message: `fn(runtime)` on the live
      // runtime the broker bound, in admission's queue, as withLiveRuntime.
      // The binding was checked at bind; liveness is checked here, every time.
      const withBoundRuntime = (runtimeId, fn) => store.tx(async (tx) => {
        const rt = tx.get('runtimes', runtimeId);
        if (!rt) fail('host.invalid_request', `unknown runtime ${runtimeId}`);
        return fn(Object.freeze(current(rt, runtimeId, clock.now())));
      });
      return { provides: { withLiveRuntime, withLeases, verifyBinding, withBoundRuntime } };
    },
  });
}

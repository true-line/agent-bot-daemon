// createTestHost (plan §4.6): the plugin host on in-memory services, with a
// fake identity service (canned responses), a deterministic clock and
// random, a fake signer and fake member principals. Plugin repositories run
// their own tests on it, plus the conformance suite (conformance.mjs).
import { createHost } from './host.mjs';
import { definePlugin } from './plugin.mjs';
import { createCore, decideApproval, fakeIdentityService, fakeSigner, testClock, testRandom } from './services.mjs';

// Stands in for the identity plugin when a test doesn't bring one. Its init
// reads device status from the signer (the read-only probe §4.4 allows) and
// it answers device.status and device.enroll.
export function fakeIdentityPlugin({ name = 'agent-bot-identity', version = '1.0.0' } = {}) {
  let signer;
  return definePlugin({
    name,
    version,
    hostApi: 1,
    services: [],
    async init(ctx) {
      signer = ctx.signer;
      ctx.hq.register({ op: 'device.status', auth: 'owner', handler: async () => ({ device: signer.deviceStatus() }) });
      ctx.hq.register({ op: 'device.enroll', auth: 'owner', handler: async () => ({ enrolled: true, restart: true }) });
      return { device: signer.deviceStatus() };
    },
  });
}

export function createTestHost({
  plugins = [],
  services = {},
  identityPlugin = 'agent-bot-identity',
  device = 'enrolled',
  link = 'ok',
  identityRoutes = {},
  tokenTtlMs,
  profile = 'managed-cooperative',
  config = {},
  budgets = {},
  seed = 'agent-bot-sdk-test',
  start = Date.UTC(2026, 0, 1),
  initTimeoutMs = 10_000,
  stopDeadlineMs = 5_000,
} = {}) {
  const clock = testClock(start);
  const identity = fakeIdentityService({ routes: identityRoutes, link, seed: `${seed}/identity`, ...(tokenTtlMs ? { tokenTtlMs } : {}) });
  const signer = fakeSigner({ device });
  const core = createCore({ clock, random: testRandom(seed), profile, config, identity, signer, budgets });
  const all = plugins.some((p) => p.name === identityPlugin) ? plugins : [fakeIdentityPlugin({ name: identityPlugin }), ...plugins];
  const host = createHost({ plugins: all, identityPlugin, core, services, initTimeoutMs, stopDeadlineMs });
  return Object.freeze({
    ...host,
    get mode() { return host.mode; },
    clock,
    identity,
    signer,
    owner: Object.freeze({
      decide: (id, decision) => decideApproval(core, id, decision),
      pending: () => [...core.approvals.values()].filter((a) => a.state === 'pending').map((a) => ({ ...a })),
    }),
    receipts: () => structuredClone(core.receipts),
    logs: () => structuredClone(core.logs),
    members: () => [...core.members.values()].map((m) => structuredClone(m)),
    tokensHeld: () => core.tokens.size,
    table: (plugin, table) => Object.fromEntries(structuredClone([...(core.tables.get(`${plugin}\0${table}`) ?? [])])),
  });
}

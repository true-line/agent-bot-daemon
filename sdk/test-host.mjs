// createTestHost (plan §4.6): the plugin host on in-memory services, with a
// fake identity service (canned responses), a deterministic clock and
// random, a fake signer and fake member principals. Plugin repositories run
// their own tests on it, plus the conformance suite (conformance.mjs).
// Identity is HQ core (PDR-0027), so the fake signer and fake identity
// service stand in for it; no identity plugin is needed.
import { createHost } from './host.mjs';
import { createCore, decideApproval, fakeIdentityService, fakeSigner, testClock, testRandom } from './services.mjs';

export function createTestHost({
  plugins = [],
  services = {},
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
  const host = createHost({ plugins, core, services, initTimeoutMs, stopDeadlineMs });
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

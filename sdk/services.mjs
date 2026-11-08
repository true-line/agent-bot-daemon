// Host services (plan §4.3), in their in-memory form.
//
// The test host uses these directly; the real HQ (§9 PR 12) replaces the
// backing for store, identityService, credentials, approvals and launch and
// keeps these interfaces. A plugin sees only the services it declared, and
// each service is bound to the plugin's name.
//
// Credential custody (D4, platform trust domains): HQ holds the device key
// and short-lived credentials in memory only. Nothing here stores a token,
// writes one to the store, a receipt or a log, or hands one to a member:
// `credentials.issue` returns an opaque reference, and every live token is
// redacted from receipts and logs. Host-side credentials at rest and signed
// policy live in agent-bot-machine's admin sandbox, which this SDK does not
// model; the daemon–machine channel arrives with the HQ skeleton.
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { fail, HostError } from './errors.mjs';
import { canonicalDigest } from './wire/canonical-json.mjs';
import { HOST_SERVICES } from './plugin.mjs';

export const PROFILES = Object.freeze(['managed-protected', 'managed-cooperative', 'standalone-unenforced']);
export const DEVICE_STATES = Object.freeze(['enrolled', 'unenrolled', 'revoked']);
export const IDENTITY_LINK_STATES = Object.freeze(['ok', 'unreachable']);

const TABLE = /^[a-z][a-z0-9_]{0,63}$/;
// Env names that carry a secret. A *_REF holding a credential reference is fine.
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY)/i;
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const deepFreeze = (v) => {
  if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
  return v;
};
const requireString = (v, what) => { if (typeof v !== 'string' || !v) fail('host.invalid_request', `${what} must be a non-empty string`); };

// Deterministic clock and random for tests; the real host passes its own.
export function testClock(start = Date.UTC(2026, 0, 1)) {
  let t = start;
  return { now: () => t, advance: (ms) => { if (!(ms >= 0)) throw new TypeError('advance by a non-negative number'); t += ms; return t; } };
}

export function testRandom(seed = 'agent-bot-sdk-test') {
  let counter = 0;
  const bytes = (n) => {
    const out = Buffer.alloc(n);
    for (let off = 0; off < n; off += 32) {
      createHash('sha256').update(`${seed}\0${counter++}`).digest().copy(out, off);
    }
    return out;
  };
  return { bytes, hex: (n = 16) => bytes(n).toString('hex') };
}

// A fake identity service with canned signed responses (§4.6). `routes`
// maps "METHOD /path" to (body) => ({ status?, body }). Every response, error
// responses included, carries the §4.7 headers: an Ed25519 signature over
// `agent-bot-sig-v1\n<status>\n<hex sha256(body)>\n<request jti>`, the jti,
// and a key id from `keySet` (shaped like the release's server-keys.json).
// The key derives from `seed`, so tests are deterministic. Link state and
// revocation are the test's levers for the identity outcomes (§4.4, §4.7).
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function fakeIdentityService({ routes = {}, link = 'ok', tokenTtlMs = 5 * 60_000, seed = 'fake-identity-service', kid = 'fake-2026-01' } = {}) {
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, createHash('sha256').update(seed).digest()]), format: 'der', type: 'pkcs8' });
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  let jtiCounter = 0;
  const signed = (status, body, jti) => {
    const text = JSON.stringify(body ?? null);
    const digest = createHash('sha256').update(text).digest('hex');
    const signature = edSign(null, Buffer.from(`agent-bot-sig-v1\n${status}\n${digest}\n${jti}`), privateKey).toString('base64url');
    return { status, headers: { 'Agent-Bot-Signature': signature, 'Agent-Bot-Request-Jti': jti, 'Agent-Bot-Key-Id': kid }, body: clone(body ?? null), text };
  };
  const svc = {
    link,
    revoked: false,
    mints: [],
    tokenTtlMs,
    keySet: Object.freeze([Object.freeze({ kid, x, notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z', status: 'active' })]),
    setLink(state) { if (!IDENTITY_LINK_STATES.includes(state)) throw new TypeError(`link is one of ${IDENTITY_LINK_STATES}`); svc.link = state; },
    revoke() { svc.revoked = true; },
    route(method, path, handler) { routes[`${method} ${path}`] = handler; },
    check() {
      if (svc.link === 'unreachable') fail('credential_unavailable', 'the identity service is unreachable');
      if (svc.revoked) fail('device_revoked', 'the identity service reports this device revoked: re-enroll');
    },
    async call(method, path, body, { jti = `jti_${++jtiCounter}` } = {}) {
      svc.check();
      const handler = routes[`${method} ${path}`];
      if (!handler) return signed(404, { error: 'not_found' }, jti);
      const out = (await handler(clone(body))) ?? {};
      return signed(out.status ?? 200, out.body, jti);
    },
    async mint({ reference, task, operation, now, random }) {
      svc.check();
      svc.mints.push({ reference, task, operation, issuedAt: now });
      return { token: `fake-token-${random.hex(16)}`, expiresAt: now + svc.tokenTtlMs };
    },
  };
  return svc;
}

// A fake signer: device status for HQ core's identity bootstrap, test
// enrollment, and signatures over approval records. Real HQ uses the
// platform signer's non-exportable device key; this only proves the record
// was not edited.
export function fakeSigner({ device = 'enrolled' } = {}) {
  if (!DEVICE_STATES.includes(device)) throw new TypeError(`device is one of ${DEVICE_STATES}`);
  const signer = {
    device,
    deviceStatus: () => signer.device,
    // Test enrollment: a fresh device key, so a revoked record is never revived.
    enroll: () => { signer.device = 'enrolled'; signer.generation = (signer.generation ?? 0) + 1; return { keyGeneration: signer.generation }; },
    sign: (bytes) => `fake-sig-v0:${createHash('sha256').update('fake-signer\0').update(bytes).digest('hex')}`,
    verify: (bytes, sig) => sig === signer.sign(bytes),
  };
  return signer;
}

// State shared by every plugin's services inside one host. The host owns it;
// plugins only reach it through their bound services.
export function createCore({ clock = testClock(), random = testRandom(), profile = 'managed-cooperative', config = {}, identity = fakeIdentityService(), signer = fakeSigner(), budgets = {} } = {}) {
  if (!PROFILES.includes(profile)) throw new TypeError(`profile is one of ${PROFILES}`);
  return {
    clock, random, profile, identity, signer,
    config: deepFreeze(clone(config)),
    tables: new Map(),          // `${plugin}\0${table}` → Map(key → value)
    blobs: new Map(),           // `${plugin}\0${digest}` → Buffer
    locks: new Map(),           // `${plugin}\0${name}` → Promise tail
    receipts: [],
    logs: [],
    subscriptions: new Map(),   // type → Set({ plugin, phase, handler })
    tokens: new Map(),          // `${reference}\0${task}\0${operation}` → { token, expiresAt }
    references: new Map(),      // opaque member reference → underlying reference
    approvals: new Map(),       // id → record
    budgets: new Map(Object.entries(clone(budgets)).map(([soul, pools]) => [soul, { ceilings: pools, reserved: new Map() }])),
    members: new Map(),
    phases: new Map(),          // plugin → 'init' | 'start' | 'running' | 'stop' | 'stopped'
    deviceRevoked: false,
    onDeviceRevoked: [],
  };
}

// Replace every live token in a value before it is written to a receipt or
// log. Tokens are short-lived and in memory only; none may reach disk.
export function redact(core, value) {
  const live = [...core.tokens.values()].map((t) => t.token);
  if (!live.length) return clone(value);
  const scrub = (v) => {
    if (typeof v === 'string') return live.reduce((s, tok) => s.split(tok).join('[redacted]'), v);
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
  return scrub(clone(value));
}

// Device revocation (§4.7): drop every token and resolved credential now,
// refuse new resolutions, and record a receipt.
export function revokeDevice(core, why = 'identity service reported the device revoked') {
  if (core.deviceRevoked) return;
  core.deviceRevoked = true;
  core.tokens.clear();
  core.receipts.push({ seq: core.receipts.length + 1, at: core.clock.now(), plugin: 'hq', profile: core.profile, kind: 'device.revoked', reason: why });
  for (const cb of core.onDeviceRevoked) cb(why);
}

// Run an identity-service interaction and map a revoked answer onto HQ's
// device_revoked state before re-raising it.
async function viaIdentity(core, fn) {
  if (core.deviceRevoked) fail('device_revoked', 'device revoked: re-enroll');
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HostError && e.code === 'device_revoked') revokeDevice(core);
    throw e;
  }
}

function storeService(core, plugin) {
  const tableKey = (table) => {
    if (typeof table !== 'string' || !TABLE.test(table)) fail('host.invalid_request', `table ${JSON.stringify(table)} must match ${TABLE}`);
    return `${plugin}\0${table}`;
  };
  const refuseInInit = () => { if (core.phases.get(plugin) === 'init') fail('host.init_write_forbidden', `${plugin}: init must not write authority state`); };
  const serial = async (key, fn) => {
    const prev = core.locks.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const tail = prev.then(() => mine);
    core.locks.set(key, tail);
    await prev;
    try { return await fn(); } finally { release(); if (core.locks.get(key) === tail) core.locks.delete(key); }
  };
  async function runTx(fn) {
    const staged = new Map();
    const view = (table) => {
      const key = tableKey(table);
      if (!staged.has(key)) staged.set(key, new Map(core.tables.get(key) ?? []));
      return staged.get(key);
    };
    let wrote = false;
    const tx = Object.freeze({
      get: (table, key) => clone(view(table).get(key)),
      has: (table, key) => view(table).has(key),
      list: (table) => [...view(table).entries()].map(([k, v]) => [k, clone(v)]),
      put: (table, key, value) => { refuseInInit(); requireString(key, 'key'); wrote = true; view(table).set(key, clone(value)); },
      delete: (table, key) => { refuseInInit(); wrote = true; return view(table).delete(key); },
    });
    const result = await fn(tx);
    if (wrote) for (const [key, rows] of staged) core.tables.set(key, rows);
    return result;
  }
  return Object.freeze({
    // fn(tx) runs against a private copy of the tables it touches. A throw
    // rolls everything back; a return commits all writes at once. A plugin's
    // transactions run one at a time, so none is lost to an interleaving;
    // don't open a transaction inside another (it would wait forever).
    tx: (fn) => serial(`${plugin}\0\0tx`, () => runTx(fn)),
    blob: Object.freeze({
      async put(bytes) {
        refuseInInit();
        const buf = Buffer.from(bytes);
        const digest = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
        core.blobs.set(`${plugin}\0${digest}`, buf);
        return digest;
      },
      async get(digest) {
        const b = core.blobs.get(`${plugin}\0${digest}`);
        return b ? Buffer.from(b) : undefined;
      },
    }),
    // Serialise work under a named lock within this plugin.
    lock(name, fn) {
      requireString(name, 'lock name');
      return serial(`${plugin}\0lock\0${name}`, fn);
    },
  });
}

function credentialsService(core, plugin) {
  const tokenKey = (reference, task, operation) => `${reference}\0${task}\0${operation}`;
  return Object.freeze({
    // One token per (task, operation), held in HQ memory only and never
    // reused for another operation (§4.7). Callers use it for that one
    // operation and must not persist, log or forward it.
    async resolve(reference, { task, operation } = {}) {
      requireString(reference, 'reference');
      requireString(task, 'task');
      requireString(operation, 'operation');
      const underlying = core.references.get(reference) ?? reference;
      const key = tokenKey(underlying, task, operation);
      const cached = core.tokens.get(key);
      const now = core.clock.now();
      if (cached && !core.deviceRevoked) {
        if (cached.expiresAt > now) return cached.token;
        core.tokens.delete(key); // used until expiry and never after
      }
      return viaIdentity(core, async () => {
        const minted = await core.identity.mint({ reference: underlying, task, operation, now, random: core.random });
        core.tokens.set(key, minted);
        return minted.token;
      });
    },
    // The operation reached a terminal state: drop its token.
    release({ reference, task, operation } = {}) {
      const underlying = core.references.get(reference) ?? reference;
      return core.tokens.delete(tokenKey(underlying, task, operation));
    },
    // For Equip: an opaque reference a member can hold. It names the
    // credential; it is not one, and resolving it needs HQ.
    issue(reference) {
      requireString(reference, 'reference');
      if (core.deviceRevoked) fail('device_revoked', 'device revoked: re-enroll');
      const opaque = `credref_${core.random.hex(16)}`;
      core.references.set(opaque, reference);
      return opaque;
    },
  });
}

function identityServiceService(core, plugin, routes) {
  const allowed = (route) => routes.some((r) => (r.endsWith('*') ? route.startsWith(r.slice(0, -1)) : route === r));
  return Object.freeze({
    async call(method, route, body) {
      requireString(method, 'method');
      requireString(route, 'route');
      if (core.phases.get(plugin) === 'init') fail('host.init_network_forbidden', `${plugin}: init must not call the identity service`);
      if (!allowed(route)) fail('host.route_not_allowed', `${plugin} may not call ${route}`, { route });
      return viaIdentity(core, () => core.identity.call(method.toUpperCase(), route, body));
    },
  });
}

// Digest-bound approvals (0.4 §8, T24): the record names the canonical
// digest of the exact action; editing the action invalidates it.
function approvalsService(core, plugin) {
  return Object.freeze({
    async request({ action, digest, scope, reason, cost, expiry } = {}) {
      if (action === undefined) fail('host.invalid_request', 'an approval request names its action');
      const actual = canonicalDigest(action);
      if (digest !== undefined && digest !== actual) fail('approval_mismatch', 'the stated digest is not the action\'s canonical digest', { stated: digest, actual });
      const id = `appr_${core.random.hex(12)}`;
      core.approvals.set(id, { id, plugin, digest: actual, scope, reason, cost, expiry, state: 'pending', requestedAt: core.clock.now() });
      return { id, digest: actual, state: 'pending' };
    },
    async decided(id) {
      const r = core.approvals.get(id);
      if (!r || r.plugin !== plugin) return undefined;
      const { plugin: _p, ...record } = r;
      return clone(record);
    },
    // Refuse unless the owner approved this exact action and it has not expired.
    async verify(id, action) {
      const r = core.approvals.get(id);
      if (!r || r.plugin !== plugin || r.state !== 'approved') fail('approval_mismatch', `no owner approval ${id}`);
      if (r.expiry !== undefined && core.clock.now() >= r.expiry) fail('approval_mismatch', `approval ${id} expired`);
      if (canonicalDigest(action) !== r.digest) fail('approval_mismatch', 'the action changed after approval', { approved: r.digest });
      if (!core.signer.verify(Buffer.from(`${r.id}\n${r.digest}\n${r.state}`), r.signature)) fail('approval_mismatch', `approval ${id} signature does not verify`);
      return true;
    },
  });
}

// The owner side of approvals, used by the host's owner session (and tests).
export function decideApproval(core, id, decision) {
  const r = core.approvals.get(id);
  if (!r) throw new TypeError(`no approval ${id}`);
  if (!['approved', 'denied'].includes(decision)) throw new TypeError('decision is approved or denied');
  r.state = decision;
  r.decidedAt = core.clock.now();
  r.signature = core.signer.sign(Buffer.from(`${r.id}\n${r.digest}\n${r.state}`));
  return clone(r);
}

// One ceiling per Soul with working and maintenance sub-allocations (R5).
function budgetsService(core, plugin) {
  const account = (soul, pool) => {
    const a = core.budgets.get(soul);
    if (!a || !(pool in a.ceilings)) fail('budget_exhausted', `no ${pool} budget for ${soul}`, { soul, pool });
    return a;
  };
  const used = (a, pool) => [...a.reserved.values()].filter((r) => r.pool === pool).reduce((s, r) => s + r.amount, 0);
  return Object.freeze({
    async reserve({ soul, pool = 'working', amount } = {}) {
      requireString(soul, 'soul');
      if (!(Number.isFinite(amount) && amount >= 0)) fail('host.invalid_request', 'amount must be a non-negative number');
      const a = account(soul, pool);
      if (used(a, pool) + amount > a.ceilings[pool]) fail('budget_exhausted', `${soul} ${pool} budget exhausted`, { soul, pool, ceiling: a.ceilings[pool] });
      const id = `rsv_${core.random.hex(12)}`;
      a.reserved.set(id, { pool, amount, plugin });
      return id;
    },
    async settle(id, actual) {
      for (const a of core.budgets.values()) {
        const r = a.reserved.get(id);
        if (r) { r.amount = actual; r.settled = true; return; }
      }
      fail('host.invalid_request', `no reservation ${id}`);
    },
    async release(id) {
      for (const a of core.budgets.values()) if (a.reserved.get(id)?.settled === undefined && a.reserved.delete(id)) return;
      fail('host.invalid_request', `no open reservation ${id}`);
    },
    async remaining({ soul, pool = 'working' } = {}) {
      const a = account(soul, pool);
      return a.ceilings[pool] - used(a, pool);
    },
  });
}

// Fake member principals. The real launcher creates per-member principals
// and a private HOME/XDG_*/PATH/temp (0.4 §4); members get references, never
// secrets, so an env var that looks like a credential is refused.
function launchService(core, plugin) {
  return Object.freeze({
    async member({ soul, role, principal, home, env = {} } = {}) {
      for (const [k, v] of Object.entries({ soul, role, principal, home })) requireString(v, k);
      for (const [k, v] of Object.entries(env)) {
        if (typeof v !== 'string') fail('host.invalid_request', `env ${k} must be a string`);
        if (SECRET_NAME.test(k)) fail('host.secret_in_env', `env ${k} looks like a credential; members get credential references only`, { name: k });
      }
      const id = `mbr_${core.random.hex(8)}`;
      core.members.set(id, { id, plugin, soul, role, principal, home, env: { ...env }, state: 'running', startedAt: core.clock.now() });
      return id;
    },
    async track(id) {
      const m = core.members.get(id);
      return m && m.plugin === plugin ? { id: m.id, soul: m.soul, role: m.role, state: m.state } : undefined;
    },
    async stop(id) {
      const m = core.members.get(id);
      if (m && m.plugin === plugin) m.state = 'stopped';
    },
  });
}

function eventsService(core, plugin) {
  return Object.freeze({
    // In process, at most once; a failing subscriber is logged, never retried.
    publish(type, payload) {
      requireString(type, 'event type');
      const subs = [...(core.subscriptions.get(type) ?? [])];
      const value = clone(payload);
      queueMicrotask(() => {
        for (const s of subs) {
          try {
            const r = s.handler(clone(value));
            if (r && typeof r.catch === 'function') r.catch((e) => core.logs.push({ level: 'error', plugin: s.plugin, message: `event ${type}: ${e.message}` }));
          } catch (e) {
            core.logs.push({ level: 'error', plugin: s.plugin, message: `event ${type}: ${e.message}` });
          }
        }
      });
    },
    // Subscriptions made in start are removed at stop; those made in init last.
    subscribe(type, handler) {
      requireString(type, 'event type');
      if (typeof handler !== 'function') fail('host.invalid_request', 'handler must be a function');
      const sub = { plugin, phase: core.phases.get(plugin) === 'init' ? 'init' : 'start', handler };
      if (!core.subscriptions.has(type)) core.subscriptions.set(type, new Set());
      core.subscriptions.get(type).add(sub);
      return () => core.subscriptions.get(type)?.delete(sub);
    },
  });
}

// At stop, drop the plugin's start-phase subscriptions; before a re-init,
// drop all of them (init subscribes again).
export function dropSubscriptions(core, plugin, { phase } = {}) {
  for (const subs of core.subscriptions.values()) for (const s of subs) if (s.plugin === plugin && (!phase || s.phase === phase)) subs.delete(s);
}

function receiptsService(core, plugin) {
  return Object.freeze({
    // Receipt fields per 0.4 §7; HQ adds sequence, time, plugin and profile.
    async append(record) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) fail('host.invalid_request', 'a receipt is an object');
      const r = { ...redact(core, record), seq: core.receipts.length + 1, at: core.clock.now(), plugin, profile: core.profile };
      core.receipts.push(r);
      return r.seq;
    },
  });
}

function logService(core, plugin) {
  const write = (level) => (message, fields) => {
    core.logs.push({ level, plugin, at: core.clock.now(), ...redact(core, { message: String(message), ...(fields === undefined ? {} : { fields }) }) });
  };
  return Object.freeze({ debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') });
}

function configService(core, plugin) {
  const section = core.config[plugin] ?? Object.freeze({});
  return Object.freeze({ section: () => section, get: (key) => section[key] });
}

const FACTORIES = {
  config: configService,
  store: storeService,
  log: logService,
  receipts: receiptsService,
  events: eventsService,
  clock: (core) => Object.freeze({ now: () => core.clock.now() }),
  random: (core) => Object.freeze({ bytes: (n) => core.random.bytes(n), hex: (n) => core.random.hex(n) }),
  profile: (core) => Object.freeze({ current: () => core.profile }),
  identityService: (core, plugin, routes) => identityServiceService(core, plugin, routes),
  credentials: credentialsService,
  approvals: approvalsService,
  launch: launchService,
  budgets: budgetsService,
};

// The services object a plugin's ctx carries: declared services work,
// undeclared ones throw host.undeclared_service on access.
export function bindServices(core, plugin, overrides = {}) {
  const declared = new Set(plugin.services);
  const services = {};
  for (const name of HOST_SERVICES) {
    let instance;
    Object.defineProperty(services, name, {
      enumerable: declared.has(name),
      get() {
        if (!declared.has(name)) fail('host.undeclared_service', `${plugin.name} did not declare the ${name} service`, { service: name });
        instance ??= overrides[name] ? overrides[name](core, plugin.name) : FACTORIES[name](core, plugin.name, plugin.identityServiceRoutes);
        return instance;
      },
    });
  }
  return Object.freeze(services);
}

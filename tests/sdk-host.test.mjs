// The plugin host on the test host (plan §4.2–§4.4, §4.6, §4.7): resolve,
// identity-first bootstrap in HQ core (PDR-0027) and its three identity
// outcomes, degraded
// fan-out, registration rules, dispatch and auth, and the host services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createHost } from '../sdk/host.mjs';
import { definePlugin } from '../sdk/plugin.mjs';
import { createTestHost } from '../sdk/test-host.mjs';
import { fakeSigner } from '../sdk/services.mjs';
import { canonicalDigest } from '../sdk/wire/canonical-json.mjs';

const code = (c) => (e) => e.code === c;
const plugin = (name, extra = {}) => definePlugin({ version: '1.0.0', hostApi: 1, async init() {}, ...extra, name });
const stateOf = (host, name) => host.status().plugins.find((p) => p.name === name);

// A plugin that hands its ctx to the test, for exercising services directly.
function probe(name, services, { routes, onInit, onStart } = {}) {
  const box = {};
  box.plugin = plugin(name, {
    services,
    ...(routes ? { identityServiceRoutes: routes } : {}),
    async init(ctx) { box.ctx = ctx; await onInit?.(ctx); },
    async start(ctx) { await onStart?.(ctx); },
  });
  return box;
}

test('init and start run in dependency order; stop runs in reverse', async () => {
  const log = [];
  const mk = (name, requires = {}) => definePlugin({
    name, version: '1.0.0', hostApi: 1, requires,
    async init() { log.push(`init ${name}`); },
    async start() { log.push(`start ${name}`); },
    async stop() { log.push(`stop ${name}`); },
  });
  const souls = mk('agent-bot-souls', { 'agent-comms': '^1.0.0' });
  const comms = mk('agent-comms');
  const identity = mk('agent-bot-identity');
  const host = createTestHost({ plugins: [souls, identity, comms] });
  const s = await host.start();
  assert.equal(s.mode, 'running');
  assert.equal(s.admissions, true);
  assert.deepEqual(s.identity, { device: 'enrolled', link: 'ok' });
  assert.deepEqual(log, ['init agent-bot-identity', 'init agent-comms', 'init agent-bot-souls', 'start agent-bot-identity', 'start agent-comms', 'start agent-bot-souls']);
  log.length = 0;
  await host.stop();
  assert.deepEqual(log, ['stop agent-bot-souls', 'stop agent-comms', 'stop agent-bot-identity']);
  assert.equal(host.status().mode, 'stopped');
});

test('identity is HQ core: device status and enrollment are core operations no plugin can take (PDR-0027)', async () => {
  const tried = {};
  const p = plugin('agent-bot-identity', {
    async init(ctx) {
      for (const op of ['status', 'device.status', 'device.enroll']) {
        try { ctx.hq.register({ op, auth: 'owner', handler() {} }); tried[op] = 'ok'; } catch (e) { tried[op] = e.code; }
      }
      ctx.tools.register({ name: 'gh', description: 'A tool.', inputSchema: { type: 'object' }, class: 'read', handler() {} });
      ctx.commands.register({ name: 'whoami', visibility: 'public', module: 'cli/whoami.mjs' });
      ctx.hooks.register({ name: 'pre-commit', handler() {} });
    },
  });
  const host = createTestHost({ plugins: [p] });
  await host.start();
  assert.deepEqual(tried, { status: 'host.duplicate_registration', 'device.status': 'host.duplicate_registration', 'device.enroll': 'host.duplicate_registration' });
  assert.deepEqual(await host.dispatch('device.status', { auth: 'owner' }), { device: 'enrolled', link: 'ok' });
  const regs = host.registrations();
  assert.deepEqual([regs.tools, regs.commands, regs.hooks].map((l) => l.map((r) => r.key)), [['gh'], ['whoami'], ['pre-commit']]);
  assert.deepEqual(regs.hq, []);
});

test('unenrolled device: safe mode; no plugin starts; status and enrollment work; no Soul is admitted', async () => {
  const other = plugin('agent-comms', { async init(ctx) { ctx.hq.register({ op: 'tasks.list', auth: 'owner', handler: async () => [] }); } });
  const host = createTestHost({ device: 'unenrolled', plugins: [other] });
  const s = await host.start();
  assert.equal(s.mode, 'safe');
  assert.equal(s.admissions, false);
  assert.match(s.reason, /not enrolled/);
  assert.equal(stateOf(host, 'agent-comms').state, 'waiting');
  assert.deepEqual(await host.dispatch('device.status', { auth: 'owner' }), { device: 'unenrolled', link: 'ok' });
  assert.equal((await host.dispatch('status', { auth: 'owner' })).mode, 'safe');
  await assert.rejects(host.dispatch('Hello', { auth: 'entry-point', payload: {} }), code('host.safe_mode'));
  await assert.rejects(host.dispatch('tasks.list', { auth: 'owner' }), code('host.safe_mode'));
  assert.deepEqual(await host.dispatch('device.enroll', { auth: 'owner' }), { enrolled: true, restart: true, keyGeneration: 1 });
  assert.equal(host.receipts().at(-1).kind, 'device.enrolled');
  await host.stop();
  const after = await host.start();
  assert.equal(after.mode, 'running');
  assert.equal(stateOf(host, 'agent-comms').state, 'running');
  assert.deepEqual(await host.dispatch('tasks.list', { auth: 'owner' }), []);
});

test('a missing, failing or silent signer: safe mode', async () => {
  const noSigner = createHost({ plugins: [plugin('agent-comms')], core: undefined });
  assert.equal((await noSigner.start()).mode, 'running', 'the default core carries a test signer');

  const throwing = createTestHost({ plugins: [plugin('agent-comms')] });
  throwing.signer.deviceStatus = () => { throw new Error('no Secure Enclave'); };
  const s1 = await throwing.start();
  assert.equal(s1.mode, 'safe');
  assert.match(s1.reason, /signer unavailable: no Secure Enclave/);
  assert.equal(stateOf(throwing, 'agent-comms').state, 'waiting');

  const silent = createTestHost();
  silent.signer.deviceStatus = () => undefined;
  const s2 = await silent.start();
  assert.equal(s2.mode, 'safe');
  assert.match(s2.reason, /no device status/);
  assert.equal(typeof fakeSigner().enroll, 'function');
});

test('revoked device: device_revoked state, not safe mode; credentials refused, local work continues', async () => {
  const p = probe('agent-comms', ['credentials', 'store'], {
    onInit: (ctx) => ctx.hq.register({ op: 'tasks.list', auth: 'owner', handler: async () => ['local'] }),
  });
  const host = createTestHost({ device: 'revoked', plugins: [p.plugin] });
  const s = await host.start();
  assert.equal(s.mode, 'device_revoked');
  assert.equal(s.admissions, true);
  assert.match(s.reason, /re-enroll/);
  await assert.rejects(p.ctx.services.credentials.resolve('gh:repo', { task: 't1', operation: 'op1' }), code('device_revoked'));
  assert.throws(() => p.ctx.services.credentials.issue('gh:repo'), code('device_revoked'));
  assert.deepEqual(await host.dispatch('tasks.list', { auth: 'owner' }), ['local']);
  assert.equal(host.receipts().filter((r) => r.kind === 'device.revoked').length, 1);
});

test('identity service unreachable: admissions proceed; credentials wait with credential_unavailable (retryable)', async () => {
  const p = probe('agent-comms', ['credentials']);
  const host = createTestHost({ link: 'unreachable', plugins: [p.plugin] });
  const s = await host.start();
  assert.equal(s.mode, 'running');
  assert.equal(s.admissions, true);
  const err = await p.ctx.services.credentials.resolve('gh:repo', { task: 't1', operation: 'op1' }).catch((e) => e);
  assert.equal(err.code, 'credential_unavailable');
  assert.equal(err.retryable, true);
  host.identity.setLink('ok');
  assert.match(await p.ctx.services.credentials.resolve('gh:repo', { task: 't1', operation: 'op1' }), /^fake-token-/);
});

test('revocation at runtime drops every token immediately and refuses new resolutions', async () => {
  const p = probe('agent-comms', ['credentials']);
  const host = createTestHost({ plugins: [p.plugin] });
  await host.start();
  await p.ctx.services.credentials.resolve('gh:repo', { task: 't1', operation: 'op1' });
  await p.ctx.services.credentials.resolve('gh:repo', { task: 't1', operation: 'op2' });
  assert.equal(host.tokensHeld(), 2);
  host.identity.revoke();
  await assert.rejects(p.ctx.services.credentials.resolve('gh:repo', { task: 't1', operation: 'op3' }), code('device_revoked'));
  assert.equal(host.tokensHeld(), 0);
  assert.equal(host.status().mode, 'device_revoked');
  // Even the cached (task, operation) is gone.
  await assert.rejects(p.ctx.services.credentials.resolve('gh:repo', { task: 't1', operation: 'op1' }), code('device_revoked'));
});

test('resolve: missing, mismatched, unsupported hostApi and cyclic plugins are degraded with reasons, and so are their dependents', async () => {
  const host = createTestHost({
    plugins: [
      plugin('needs-ghost', { requires: { ghost: '^1.0.0' } }),
      plugin('base'),
      plugin('needs-new-base', { requires: { base: '^2.0.0' } }),
      plugin('future-api', { hostApi: 3 }),
      plugin('cycle-a', { requires: { 'cycle-b': '^1.0.0' } }),
      plugin('cycle-b', { requires: { 'cycle-a': '^1.0.0' } }),
      plugin('after-cycle', { requires: { 'cycle-a': '^1.0.0' } }),
      plugin('needs-future', { requires: { 'future-api': '^1.0.0' } }),
      plugin('fine', { optional: { 'future-api': '^9.0.0' } }),
    ],
  });
  const s = await host.start();
  assert.equal(s.mode, 'running');
  const reason = (n) => stateOf(host, n).reason;
  assert.equal(reason('needs-ghost'), 'requires ghost, which is not installed');
  assert.equal(reason('needs-new-base'), 'requires base ^2.0.0, installed 1.0.0');
  assert.match(reason('future-api'), /hostApi 3 unsupported/);
  assert.equal(reason('cycle-a'), 'dependency cycle');
  assert.equal(reason('cycle-b'), 'dependency cycle');
  assert.match(reason('after-cycle'), /cycle/);
  assert.equal(reason('needs-future'), 'dependency future-api degraded');
  assert.equal(stateOf(host, 'fine').state, 'running', 'an unsatisfied optional dependency is just absent');
});

test('a failing non-identity plugin is degraded, its dependents do not start, and status says why', async () => {
  const host = createTestHost({
    plugins: [
      plugin('agent-comms', { async start() { throw new Error('relay config invalid'); } }),
      plugin('agent-bot-souls', { requires: { 'agent-comms': '^1.0.0' } }),
      plugin('independent'),
    ],
  });
  await host.start();
  assert.deepEqual(stateOf(host, 'agent-comms'), { name: 'agent-comms', version: '1.0.0', state: 'degraded', reason: 'start failed: relay config invalid' });
  assert.equal(stateOf(host, 'agent-bot-souls').reason, 'dependency agent-comms degraded');
  assert.equal(stateOf(host, 'independent').state, 'running');
});

test('provided services reach dependents as ctx.deps', async () => {
  let seen;
  const host = createTestHost({
    plugins: [
      plugin('agent-comms', { async init() { return { provides: { send: (m) => `sent ${m}` } }; } }),
      plugin('agent-bot-souls', { requires: { 'agent-comms': '^1.0.0' }, async init(ctx) { seen = ctx.deps; } }),
    ],
  });
  await host.start();
  assert.equal(seen['agent-comms'].send('x'), 'sent x');
  assert.equal(Object.isFrozen(seen), true);
});

test('duplicate plugin names are refused before anything runs', () => {
  assert.throws(() => createTestHost({ plugins: [plugin('x'), plugin('x')] }), code('host.duplicate_plugin'));
});

test('registration rules: hq/v1 operations only, matching auth, core-owned status, one owner per name, init only', async () => {
  const attempts = {};
  const tryReg = (label, fn) => { try { fn(); attempts[label] = 'ok'; } catch (e) { attempts[label] = e.code; } };
  let late;
  const a = plugin('plugin-a', {
    async init(ctx) {
      tryReg('unknown op', () => ctx.hq.register({ op: 'exec', auth: 'owner', handler() {} }));
      tryReg('wrong auth', () => ctx.hq.register({ op: 'Hello', auth: 'owner', handler() {} }));
      tryReg('status', () => ctx.hq.register({ op: 'status', auth: 'owner', handler() {} }));
      tryReg('no handler', () => ctx.hq.register({ op: 'tasks.get', auth: 'owner' }));
      tryReg('first', () => ctx.hq.register({ op: 'tasks.list', auth: 'owner', handler: () => 'first' }));
      tryReg('again own', () => ctx.hq.register({ op: 'tasks.list', auth: 'owner', handler: () => 'second' }));
      tryReg('kind', () => ctx.broker.registerKind({ kind: 'notices.take', consume() {} }));
      tryReg('bad adapter', () => ctx.broker.registerAdapter({ id: 'gh', class: 'exec', validate() {}, call() {} }));
      tryReg('adapter', () => ctx.broker.registerAdapter({ id: 'gh', class: 'service', validate() {}, call() {} }));
      late = ctx;
    },
  });
  const b = plugin('plugin-b', { async init(ctx) { ctx.hq.register({ op: 'tasks.list', auth: 'owner', handler() {} }); } });
  const host = createTestHost({ plugins: [a, b] });
  await host.start();
  assert.deepEqual(attempts, {
    'unknown op': 'host.unknown_operation', 'wrong auth': 'host.auth_mismatch', status: 'host.duplicate_registration',
    'no handler': 'host.invalid_request', first: 'ok', 'again own': 'host.duplicate_registration', kind: 'ok', 'bad adapter': 'host.invalid_request', adapter: 'ok',
  });
  assert.match(stateOf(host, 'plugin-b').reason, /host.duplicate_registration: operation tasks.list is already registered by plugin-a/);
  assert.equal(await host.dispatch('tasks.list', { auth: 'owner' }), 'first');
  assert.throws(() => late.hq.register({ op: 'tasks.get', auth: 'owner', handler() {} }), code('host.registration_closed'));
  const regs = host.registrations();
  assert.deepEqual(regs.hq.filter((r) => r.plugin === 'plugin-a'), [{ key: 'tasks.list', auth: 'owner', plugin: 'plugin-a' }]);
  assert.deepEqual(regs.adapters, [{ key: 'gh', class: 'service', plugin: 'plugin-a' }]);
});

test('init may not write authority state, call the identity service, or overrun its timeout', async () => {
  const host = createTestHost({
    initTimeoutMs: 50,
    plugins: [
      plugin('writes', { services: ['store'], async init(ctx) { await ctx.services.store.tx((tx) => tx.put('grants', 'g1', {})); } }),
      plugin('blob-writes', { services: ['store'], async init(ctx) { await ctx.services.store.blob.put('x'); } }),
      plugin('calls-out', { services: ['identityService'], identityServiceRoutes: ['/api/*'], async init(ctx) { await ctx.services.identityService.call('GET', '/api/x'); } }),
      plugin('slow', { async init() { await new Promise((r) => setTimeout(r, 500)); } }),
      plugin('reads', { services: ['store'], async init(ctx) { await ctx.services.store.tx((tx) => tx.get('grants', 'g1')); } }),
    ],
  });
  await host.start();
  assert.match(stateOf(host, 'writes').reason, /host.init_write_forbidden/);
  assert.match(stateOf(host, 'blob-writes').reason, /host.init_write_forbidden/);
  assert.match(stateOf(host, 'calls-out').reason, /host.init_network_forbidden/);
  assert.match(stateOf(host, 'slow').reason, /host.timeout: slow init exceeded 50 ms/);
  assert.equal(stateOf(host, 'reads').state, 'running', 'read-only probes are allowed');
  assert.deepEqual(host.registrations().hq, []);
});

test('stop runs under a deadline; an overrun is reported and the rest still stop', async () => {
  const stopped = [];
  const host = createTestHost({
    plugins: [
      plugin('hangs', { async stop() { await new Promise(() => {}); } }),
      plugin('polite', { requires: { hangs: '^1.0.0' }, async stop(_ctx, { reason, deadlineMs }) { stopped.push([reason, deadlineMs]); } }),
    ],
  });
  await host.start();
  const t0 = Date.now();
  const report = await host.stop({ reason: 'upgrade', deadlineMs: 40 });
  assert.ok(Date.now() - t0 < 1_000);
  assert.deepEqual(stopped, [['upgrade', 40]]);
  const hangs = report.find((r) => r.name === 'hangs');
  assert.equal(hangs.ok, false);
  assert.equal(hangs.code, 'host.timeout');
  assert.deepEqual(report.map((r) => r.name), ['polite', 'hangs'], 'reverse order, and the overrun does not stop the rest');
});

test('dispatch: unknown operations, not running, auth class, strict JSON, degraded owner, payload isolation', async () => {
  let got;
  const host = createTestHost({
    plugins: [
      plugin('agent-bot-souls', {
        async init(ctx) {
          ctx.hq.register({ op: 'Hello', auth: 'entry-point', handler: async (payload, meta) => { got = { payload, meta }; payload.mutated = true; return { ok: true }; } });
        },
      }),
      plugin('broken', { async init(ctx) { ctx.hq.register({ op: 'grants.list', auth: 'owner', handler: () => [] }); }, async start() { throw new Error('no'); } }),
    ],
  });
  await assert.rejects(host.dispatch('Hello', { auth: 'entry-point' }), code('host.not_running'));
  await host.start();
  await assert.rejects(host.dispatch('exec', { auth: 'owner' }), code('host.unknown_operation'));
  await assert.rejects(host.dispatch('Hello', { auth: 'owner' }), code('host.auth_mismatch'));
  await assert.rejects(host.dispatch('grants.revoke', { auth: 'entry-point' }), code('host.auth_mismatch'));
  await assert.rejects(host.dispatch('grants.revoke', { auth: 'owner' }), code('host.unknown_operation'));
  await assert.rejects(host.dispatch('grants.list', { auth: 'owner' }), code('host.plugin_degraded'));
  const payload = { contract: 'hq/v1' };
  assert.deepEqual(await host.dispatch('Hello', { auth: 'entry-point', payload, session: 's1' }), { ok: true });
  assert.equal(payload.mutated, undefined, 'handlers get a copy');
  assert.deepEqual(got.meta, { auth: 'entry-point', session: 's1' });
  await assert.rejects(host.dispatchJson('Hello', '{"request_id":"a","request_id":"b"}', { auth: 'entry-point' }), code('host.invalid_json'));
  assert.deepEqual(await host.dispatchJson('Hello', '{"request_id":"a"}', { auth: 'entry-point' }), { ok: true });
});

test('services: only declared ones are reachable', async () => {
  const p = probe('agent-comms', ['log']);
  await createTestHost({ plugins: [p.plugin] }).start();
  p.ctx.services.log.info('hello');
  assert.throws(() => p.ctx.services.credentials, code('host.undeclared_service'));
  assert.deepEqual(Object.keys(p.ctx.services), ['log']);
});

test('store: plugin-scoped tables, rollback on throw, serial transactions, blobs, locks', async () => {
  const a = probe('plugin-a', ['store']);
  const b = probe('plugin-b', ['store']);
  const host = createTestHost({ plugins: [a.plugin, b.plugin] });
  await host.start();
  const sa = a.ctx.services.store;
  await sa.tx((tx) => tx.put('tasks', 't1', { n: 1 }));
  assert.equal(await b.ctx.services.store.tx((tx) => tx.get('tasks', 't1')), undefined, 'another plugin cannot see it');
  await assert.rejects(sa.tx((tx) => { tx.put('tasks', 't2', {}); tx.put('tasks', 't1', { n: 99 }); throw new Error('abort'); }), /abort/);
  assert.deepEqual(host.table('plugin-a', 'tasks'), { t1: { n: 1 } });
  await assert.rejects(sa.tx((tx) => tx.put('../etc', 'k', 1)), code('host.invalid_request'));
  const value = { n: 1 };
  await sa.tx((tx) => tx.put('tasks', 't3', value));
  value.n = 2;
  assert.deepEqual(await sa.tx((tx) => tx.get('tasks', 't3')), { n: 1 }, 'stored by value');
  // Concurrent read-modify-write loses nothing.
  await sa.tx((tx) => tx.put('counters', 'c', 0));
  await Promise.all(Array.from({ length: 20 }, () => sa.tx(async (tx) => { const n = tx.get('counters', 'c'); await null; tx.put('counters', 'c', n + 1); })));
  assert.equal(host.table('plugin-a', 'counters').c, 20);
  const digest = await sa.blob.put(Buffer.from('soul'));
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal((await sa.blob.get(digest)).toString(), 'soul');
  assert.equal(await b.ctx.services.store.blob.get(digest), undefined);
  const order = [];
  await Promise.all([1, 2, 3].map((i) => sa.lock('l', async () => { order.push(`in ${i}`); await new Promise((r) => setTimeout(r, 5)); order.push(`out ${i}`); })));
  assert.deepEqual(order, ['in 1', 'out 1', 'in 2', 'out 2', 'in 3', 'out 3']);
});

test('credentials: one token per task and operation, in memory only, never in receipts or logs, gone at stop', async () => {
  const p = probe('agent-comms', ['credentials', 'receipts', 'log']);
  const host = createTestHost({ plugins: [p.plugin], tokenTtlMs: 60_000 });
  await host.start();
  const { credentials, receipts, log } = p.ctx.services;
  await assert.rejects(credentials.resolve('gh:repo', { task: 't1' }), code('host.invalid_request'));
  const t1 = await credentials.resolve('gh:repo', { task: 't1', operation: 'op1' });
  assert.equal(await credentials.resolve('gh:repo', { task: 't1', operation: 'op1' }), t1, 'same operation, same token');
  const t2 = await credentials.resolve('gh:repo', { task: 't1', operation: 'op2' });
  assert.notEqual(t2, t1, 'never reused across operations');
  assert.deepEqual(host.identity.mints.map((m) => [m.task, m.operation]), [['t1', 'op1'], ['t1', 'op2']]);
  host.clock.advance(60_000);
  assert.notEqual(await credentials.resolve('gh:repo', { task: 't1', operation: 'op1' }), t1, 'used until expiry and never after');
  assert.equal(credentials.release({ reference: 'gh:repo', task: 't1', operation: 'op2' }), true);

  const ref = credentials.issue('gh:repo');
  assert.match(ref, /^credref_[0-9a-f]{32}$/);
  const viaRef = await credentials.resolve(ref, { task: 't9', operation: 'op9' });
  assert.equal(host.identity.mints.at(-1).reference, 'gh:repo');

  await receipts.append({ kind: 'action.sent', token: viaRef, note: `bearer ${viaRef}` });
  log.error(`call failed with ${viaRef}`, { header: `Bearer ${viaRef}` });
  const written = JSON.stringify([host.receipts(), host.logs()]);
  assert.equal(written.includes(viaRef), false);
  assert.match(written, /\[redacted\]/);
  await host.stop();
  assert.equal(host.tokensHeld(), 0);
});

test('identityService: allowlisted routes only, through the fake service', async () => {
  const p = probe('agent-comms', ['identityService'], { routes: ['/api/daemon/notices*'] });
  const host = createTestHost({ plugins: [p.plugin], identityRoutes: { 'POST /api/daemon/notices/take': (body) => ({ body: { notices: [], echo: body } }) } });
  await host.start();
  const r = await p.ctx.services.identityService.call('post', '/api/daemon/notices/take', { max: 5 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { notices: [], echo: { max: 5 } });
  // Canned responses are signed the §4.7 way, so a hardened client can be tested against them.
  const [key] = host.identity.keySet;
  assert.equal(r.headers['Agent-Bot-Key-Id'], key.kid);
  const signedText = `agent-bot-sig-v1\n200\n${createHash('sha256').update(r.text).digest('hex')}\n${r.headers['Agent-Bot-Request-Jti']}`;
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' });
  assert.equal(verify(null, Buffer.from(signedText), pub, Buffer.from(r.headers['Agent-Bot-Signature'], 'base64url')), true);
  assert.equal(verify(null, Buffer.from(signedText.replace('\n200\n', '\n201\n')), pub, Buffer.from(r.headers['Agent-Bot-Signature'], 'base64url')), false);
  const missing = await p.ctx.services.identityService.call('GET', '/api/daemon/notices/none');
  assert.equal(missing.status, 404);
  assert.ok(missing.headers['Agent-Bot-Signature'], 'error responses are signed too');
  await assert.rejects(p.ctx.services.identityService.call('GET', '/oauth/token'), code('host.route_not_allowed'));
  host.identity.setLink('unreachable');
  await assert.rejects(p.ctx.services.identityService.call('POST', '/api/daemon/notices/take'), code('credential_unavailable'));
});

test('approvals are bound to the canonical digest of the exact action (T24)', async () => {
  const p = probe('agent-comms', ['approvals']);
  const host = createTestHost({ plugins: [p.plugin] });
  await host.start();
  const { approvals } = p.ctx.services;
  const action = { op: 'github.merge', repo: 'r', pr: 7 };
  await assert.rejects(approvals.request({ action, digest: 'sha256:00' }), code('approval_mismatch'));
  const { id, digest } = await approvals.request({ action, digest: canonicalDigest({ pr: 7, repo: 'r', op: 'github.merge' }), reason: 'merge', expiry: host.clock.now() + 1_000 });
  assert.equal(digest, canonicalDigest(action));
  await assert.rejects(approvals.verify(id, action), code('approval_mismatch'), 'pending is not approved');
  host.owner.decide(id, 'approved');
  assert.equal((await approvals.decided(id)).state, 'approved');
  assert.equal(await approvals.verify(id, { pr: 7, op: 'github.merge', repo: 'r' }), true, 'key order does not matter');
  await assert.rejects(approvals.verify(id, { ...action, pr: 8 }), code('approval_mismatch'), 'an edited action is not approved');
  host.clock.advance(1_000);
  await assert.rejects(approvals.verify(id, action), code('approval_mismatch'), 'expired');
  const denied = await approvals.request({ action });
  host.owner.decide(denied.id, 'denied');
  await assert.rejects(approvals.verify(denied.id, action), code('approval_mismatch'));
});

test('budgets: reserve within the ceiling, refuse beyond it, release frees', async () => {
  const p = probe('agent-comms', ['budgets']);
  const host = createTestHost({ plugins: [p.plugin], budgets: { soul_1: { working: 10, maintenance: 2 } } });
  await host.start();
  const { budgets } = p.ctx.services;
  const r1 = await budgets.reserve({ soul: 'soul_1', amount: 7 });
  await assert.rejects(budgets.reserve({ soul: 'soul_1', amount: 4 }), code('budget_exhausted'));
  await budgets.reserve({ soul: 'soul_1', pool: 'maintenance', amount: 2 });
  await budgets.release(r1);
  assert.equal(await budgets.remaining({ soul: 'soul_1' }), 10);
  const r2 = await budgets.reserve({ soul: 'soul_1', amount: 5 });
  await budgets.settle(r2, 3);
  assert.equal(await budgets.remaining({ soul: 'soul_1' }), 7);
  await assert.rejects(budgets.release(r2), code('host.invalid_request'), 'a settled reservation is not released');
  await assert.rejects(budgets.reserve({ soul: 'soul_2', amount: 1 }), code('budget_exhausted'));
});

test('launch: members get references, never secrets', async () => {
  const p = probe('agent-bot-souls', ['launch']);
  const host = createTestHost({ plugins: [p.plugin] });
  await host.start();
  const { launch } = p.ctx.services;
  const member = { soul: 'soul_1', role: 'lead', principal: 'member-1', home: '/state/soul_1/m1' };
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'DB_PASSWORD', 'client_secret']) {
    await assert.rejects(launch.member({ ...member, env: { [name]: 'x' } }), code('host.secret_in_env'), name);
  }
  const id = await launch.member({ ...member, env: { AGENT_BOT_CREDENTIAL_REF: 'credref_0123', LANG: 'C' } });
  assert.deepEqual(await launch.track(id), { id, soul: 'soul_1', role: 'lead', state: 'running' });
  await launch.stop(id);
  assert.equal((await launch.track(id)).state, 'stopped');
});

test('events: in process, at most once; start-phase subscriptions end at stop; init ones are not duplicated on restart', async () => {
  const seen = [];
  const pub = probe('publisher', ['events']);
  const sub = probe('subscriber', ['events'], {
    onInit: (ctx) => ctx.services.events.subscribe('soul.ready', (e) => seen.push(['init', e.soul])),
    onStart: (ctx) => ctx.services.events.subscribe('soul.ready', (e) => seen.push(['start', e.soul])),
  });
  const host = createTestHost({ plugins: [pub.plugin, sub.plugin] });
  await host.start();
  pub.ctx.services.events.publish('soul.ready', { soul: 's1' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen.sort(), [['init', 's1'], ['start', 's1']]);
  await host.stop();
  await host.start();
  seen.length = 0;
  pub.ctx.services.events.publish('soul.ready', { soul: 's2' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen.sort(), [['init', 's2'], ['start', 's2']]);
});

test('receipts, config, clock, random and profile', async () => {
  const p = probe('agent-comms', ['receipts', 'config', 'clock', 'random', 'profile']);
  const host = createTestHost({ plugins: [p.plugin], profile: 'managed-protected', config: { 'agent-comms': { relays: ['site'] }, other: { secret: 'no' } } });
  await host.start();
  const { receipts, config, clock, random, profile } = p.ctx.services;
  assert.equal(profile.current(), 'managed-protected');
  assert.deepEqual(config.section(), { relays: ['site'] });
  assert.throws(() => { config.section().relays.push('x'); }, TypeError);
  assert.equal(clock.now(), Date.UTC(2026, 0, 1));
  const r = random.hex(8);
  assert.equal(r, createTestHost({ seed: 'agent-bot-sdk-test' }).core.random.hex(8), 'deterministic');
  await receipts.append({ kind: 'relay.connected' });
  assert.deepEqual(host.receipts().at(-1), { kind: 'relay.connected', seq: 1, at: Date.UTC(2026, 0, 1), plugin: 'agent-comms', profile: 'managed-protected' });
});

// Review hardening (PR #86).

test('a timed-out init keeps running in the background but can no longer touch host state', async () => {
  const late = {};
  const host = createTestHost({
    initTimeoutMs: 30,
    plugins: [plugin('slow', {
      services: ['store', 'receipts'],
      async init(ctx) {
        await new Promise((r) => setTimeout(r, 120));
        for (const [what, fn] of Object.entries({
          tx: () => ctx.services.store.tx((tx) => tx.put('grants', 'g1', {})),
          receipt: () => ctx.services.receipts.append({ kind: 'late' }),
          register: async () => ctx.tools.register({ name: 'late_tool', description: 'A tool.', inputSchema: { type: 'object' }, class: 'read', handler() {} }),
        })) {
          try { await fn(); late[what] = 'ok'; } catch (e) { late[what] = e.code; }
        }
      },
    })],
  });
  await host.start();
  assert.match(stateOf(host, 'slow').reason, /host.timeout/);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(late, { tx: 'host.context_revoked', receipt: 'host.context_revoked', register: 'host.context_revoked' });
  assert.deepEqual(host.table('slow', 'grants'), {});
  assert.equal(host.receipts().some((r) => r.kind === 'late'), false);
  assert.deepEqual(host.registrations().tools, []);
});

test('init changes no host state through any service (§4.4)', async () => {
  const tries = {
    approvals: (s) => s.approvals.request({ action: { a: 1 } }),
    budgets: (s) => s.budgets.reserve({ soul: 'soul_1', amount: 1 }),
    issue: async (s) => s.credentials.issue('gh:repo'),
    resolve: (s) => s.credentials.resolve('gh:repo', { task: 't', operation: 'o' }),
    launch: (s) => s.launch.member({ soul: 's', role: 'r', principal: 'p', home: '/h' }),
    receipts: (s) => s.receipts.append({ kind: 'x' }),
    publish: async (s) => s.events.publish('x', {}),
  };
  const services = ['approvals', 'budgets', 'credentials', 'launch', 'receipts', 'events'];
  const host = createTestHost({
    budgets: { soul_1: { working: 5 } },
    plugins: Object.entries(tries).map(([name, fn]) => plugin(name, { services, async init(ctx) { await fn(ctx.services); } })),
  });
  await host.start();
  for (const name of Object.keys(tries)) {
    assert.match(stateOf(host, name).reason, name === 'resolve' ? /host.init_network_forbidden/ : /host.init_write_forbidden/, name);
  }
  assert.equal(host.receipts().length, 0);
  assert.deepEqual(host.members(), []);
  assert.deepEqual(host.owner.pending(), []);
});

test('credentials: a context kept after stop cannot mint again', async () => {
  const p = probe('agent-comms', ['credentials']);
  const host = createTestHost({ plugins: [p.plugin] });
  await host.start();
  await p.ctx.services.credentials.resolve('gh:repo', { task: 't1', operation: 'op1' });
  await host.stop();
  assert.equal(host.tokensHeld(), 0);
  await assert.rejects(p.ctx.services.credentials.resolve('gh:repo', { task: 't1', operation: 'op1' }), code('host.context_revoked'));
  assert.equal(host.identity.mints.length, 1);
});

test('credentials: concurrent resolves share one mint; a mint in flight at revocation is not cached', async () => {
  const p = probe('agent-comms', ['credentials']);
  const host = createTestHost({ plugins: [p.plugin] });
  await host.start();
  const args = ['gh:repo', { task: 't1', operation: 'op1' }];
  const [a, b] = await Promise.all([p.ctx.services.credentials.resolve(...args), p.ctx.services.credentials.resolve(...args)]);
  assert.equal(a, b);
  assert.equal(host.identity.mints.length, 1);
  assert.equal(host.tokensHeld(), 1);

  const inFlight = p.ctx.services.credentials.resolve('gh:repo', { task: 't1', operation: 'op2' });
  host.identity.revoke();
  assert.equal(host.tokensHeld(), 0, 'revocation drops cached tokens at once');
  await assert.rejects(inFlight, code('device_revoked'));
  assert.equal(host.tokensHeld(), 0);
});

test('a live token used as an object key is redacted from receipts and logs', async () => {
  const p = probe('agent-comms', ['credentials', 'receipts', 'log']);
  const host = createTestHost({ plugins: [p.plugin] });
  await host.start();
  const token = await p.ctx.services.credentials.resolve('gh:repo', { task: 't1', operation: 'op1' });
  await p.ctx.services.receipts.append({ kind: 'k', [token]: 1, nested: { [token]: token } });
  p.ctx.services.log.info('m', { [token]: true });
  assert.equal(JSON.stringify(host.receipts()).includes(token), false);
  assert.equal(JSON.stringify(host.logs()).includes(token), false);
});

test('budgets: a plugin settles only its own reservations, with a valid amount, once', async () => {
  const a = probe('plugin-a', ['budgets']);
  const b = probe('plugin-b', ['budgets']);
  const host = createTestHost({ plugins: [a.plugin, b.plugin], budgets: { soul_1: { working: 10 } } });
  await host.start();
  const id = await a.ctx.services.budgets.reserve({ soul: 'soul_1', amount: 4 });
  await assert.rejects(b.ctx.services.budgets.settle(id, 0), code('host.invalid_request'));
  await assert.rejects(b.ctx.services.budgets.release(id), code('host.invalid_request'));
  for (const bad of [-1, NaN, Infinity, '3', undefined]) await assert.rejects(a.ctx.services.budgets.settle(id, bad), code('host.invalid_request'), String(bad));
  assert.equal(await a.ctx.services.budgets.remaining({ soul: 'soul_1' }), 6);
  await a.ctx.services.budgets.settle(id, 12);
  assert.equal(await a.ctx.services.budgets.remaining({ soul: 'soul_1' }), -2, 'spend over the reservation is recorded');
  await assert.rejects(a.ctx.services.budgets.reserve({ soul: 'soul_1', amount: 0.5 }), code('budget_exhausted'));
  await assert.rejects(a.ctx.services.budgets.settle(id, 1), code('host.invalid_request'), 'settled once');
});

test('re-enrolling a revoked device: the next start runs with a new key', async () => {
  const p = probe('agent-comms', ['credentials']);
  const host = createTestHost({ device: 'revoked', plugins: [p.plugin] });
  assert.equal((await host.start()).mode, 'device_revoked');
  assert.deepEqual(await host.dispatch('device.enroll', { auth: 'owner' }), { enrolled: true, restart: true, keyGeneration: 1 });
  await host.stop();
  const s = await host.start();
  assert.equal(s.mode, 'running');
  assert.equal(s.identity.device, 'enrolled');
  assert.match(await p.ctx.services.credentials.resolve('gh:repo', { task: 't1', operation: 'op1' }), /^fake-token-/);
});

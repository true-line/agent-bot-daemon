import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createIdentityService, signatureBytes, validateServerKeys } from '../hq/identity-service.mjs';
import { testClock } from '../sdk/services.mjs';
import { definePlugin } from '../sdk/plugin.mjs';
import { startHQ } from './hq-harness.mjs';

const SERVER = 'https://identity.example.test';
const before = '2026-01-01T00:00:00Z', after = '2027-01-01T00:00:00Z';
const decode = (jwt) => jwt.split('.').slice(0, 2).map((x) => JSON.parse(Buffer.from(x, 'base64url')));
const digest = (s) => createHash('sha256').update(s).digest('base64url');
const code = (want) => (e) => e.code === want;

function fixture() {
  const clock = testClock(Date.UTC(2026, 10, 13));
  const device = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const responseKey = generateKeyPairSync('ed25519');
  const keySet = [{ kid: 'release-key-1', x: responseKey.publicKey.export({ format: 'jwk' }).x, notBefore: before, notAfter: after, status: 'active' }];
  let count = 0;
  const state = { requests: [], tokens: 0, apiCalls: 0, revocations: 0, device: 'enrolled', mode: 'ok', expiresIn: 900, mutate: (r) => r };
  const enrollment = {
    deviceStatus: async () => state.device,
    markRevoked() { state.device = 'revoked'; state.revocations++; },
    assertion({ ephemeralJwk }) {
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ iss: 'dev_hq', sub: 'dev_hq', jti: `assertion_${++count}`, aud: `${SERVER}/oauth/token`, cnf: { jwk: ephemeralJwk }, iat: clock.now() / 1000, exp: clock.now() / 1000 + 120 })).toString('base64url');
      return `${header}.${body}.${sign('sha256', Buffer.from(`${header}.${body}`), { key: device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    },
  };
  const tokenKeys = new Map(), usedNonces = new Set();
  const signed = (status, body, jti) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'Agent-Bot-Key-Id': keySet[0].kid, 'Agent-Bot-Request-Jti': jti, 'Agent-Bot-Signature': sign(null, signatureBytes(status, text, jti), responseKey.privateKey).toString('base64url') };
    return state.mutate({ status, text, headers });
  };
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    state.requests.push({ url, init });
    let out;
    if (url === `${SERVER}/oauth/token`) {
      state.tokens++;
      if (state.mode === 'token-outage') throw new Error('NETWORK_SECRET_CANARY');
      const form = new URLSearchParams(init.body);
      const assertion = form.get('assertion');
      const [header, claims] = decode(assertion);
      const parts = assertion.split('.');
      assert.equal(header.alg, 'ES256');
      assert.equal(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: device.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')), true);
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      assert.equal(claims.aud, `${SERVER}/oauth/token`);
      assert.equal('d' in claims.cnf.jwk, false);
      const accessToken = `access-secret-canary-${state.tokens}`;
      tokenKeys.set(accessToken, claims.cnf.jwk);
      out = signed(state.mode === 'token-revoked' || state.mode === 'software-refused' ? 400 : 200, state.mode === 'software-refused' ? { error: 'profile_insufficient', error_description: 'SECRET_CANARY' } : state.mode === 'token-revoked' ? { error: 'invalid_grant', error_description: 'SECRET_CANARY' } : { access_token: accessToken, token_type: 'DPoP', expires_in: state.expiresIn, harnesses: ['codex'] }, claims.jti);
    } else {
      state.apiCalls++;
      const token = init.headers.authorization.slice('DPoP '.length);
      const proof = init.headers.DPoP;
      const [header, claims] = decode(proof), parts = proof.split('.');
      assert.deepEqual(header.jwk, tokenKeys.get(token));
      assert.equal(header.typ, 'dpop+jwt');
      assert.equal(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: createPublicKey({ key: header.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')), true);
      assert.equal(claims.htm, init.method);
      assert.equal(claims.htu, url);
      assert.equal(claims.ath, digest(token));
      assert.equal(claims.iat, Math.floor(clock.now() / 1000));
      assert.equal(usedNonces.has(claims.jti), false);
      usedNonces.add(claims.jti);
      if (state.hold) await state.hold;
      if (state.mode === 'advance-clock') clock.advance(301_000);
      out = signed(state.mode === 'api-revoked' ? 401 : state.mode === 'unauthorized' ? 401 : 200, state.mode === 'api-revoked' ? { error: 'device_revoked', detail: 'SECRET_CANARY' } : state.mode === 'unauthorized' ? { error: 'invalid_token' } : { notices: [], harness: 'codex' }, claims.jti);
    }
    return new Response(out.text, { status: out.status, headers: out.headers });
  };
  const make = (over = {}) => createIdentityService({ server: SERVER, enrollment, keySet, fetchImpl, clock, ...over });
  return { state, keySet, clock, enrollment, make, fetchImpl };
}

test('the HQ signer assertion mints one in-memory token; each API request gets a fresh bound DPoP proof', async () => {
  const f = fixture(), client = f.make();
  try {
    const replies = await Promise.all(Array.from({ length: 4 }, () => client.call('POST', '/api/daemon/notices/take', { harness: 'codex' })));
    assert.equal(f.state.tokens, 1, 'concurrent calls share a token refresh');
    assert.equal(f.state.apiCalls, 4);
    assert.deepEqual(replies[0].body, { notices: [], harness: 'codex' });
    assert.ok(replies[0].headers['agent-bot-signature']);
    f.clock.advance(841_000);
    await client.call('GET', '/api/daemon/whoami');
    assert.equal(f.state.tokens, 2, 'a near-expiry token is replaced with a fresh ephemeral key');
    assert.equal(client.status().tokenCached, true);
    assert.doesNotMatch(JSON.stringify(client.status()), /secret-canary/);
  } finally { client.close(); }
});

test('release trust refuses missing pins, private keys, duplicate ids, malformed public keys and invalid lifetimes', async () => {
  const f = fixture();
  for (const keys of [[{ ...f.keySet[0], d: 'PRIVATE_CANARY' }], [f.keySet[0], f.keySet[0]], [{ ...f.keySet[0], x: 'AA' }], [{ ...f.keySet[0], status: 'unknown' }], [{ ...f.keySet[0], notAfter: before }]]) {
    assert.throws(() => validateServerKeys({ server: SERVER, keys }, SERVER), TypeError);
  }
  for (const notBefore of ['2026-01-01', '2026-01-01T00:00:00', '2026-02-30T00:00:00Z', 'January 1 2026', '2026-01-01T24:00:00Z']) {
    assert.throws(() => validateServerKeys({ server: SERVER, keys: [{ ...f.keySet[0], notBefore }] }, SERVER), TypeError);
  }
  assert.throws(() => validateServerKeys({ server: SERVER, keys: [f.keySet[0], { ...f.keySet[0], kid: 'conflicting-alias', status: 'retired' }] }, SERVER), /exactly one/);
  assert.throws(() => validateServerKeys({ server: 'https://other.example.test', keys: f.keySet }, SERVER), TypeError);
  const client = f.make({ keySet: [] });
  await assert.rejects(client.call('GET', '/api/daemon/whoami'), code('credential_unavailable'));
  assert.equal(f.state.requests.length, 0, 'no TOFU request is made when the release lacks keys');
});

for (const mode of ['missing-signature', 'wrong-kid', 'wrong-nonce', 'tampered-body', 'invalid-signature']) test(`a ${mode} reply is refused before JSON or revocation can be trusted`, async () => {
  const f = fixture();
  f.state.mutate = (r) => {
    if (mode === 'missing-signature') delete r.headers['Agent-Bot-Signature'];
    if (mode === 'wrong-kid') r.headers['Agent-Bot-Key-Id'] = 'foreign-key';
    if (mode === 'wrong-nonce') r.headers['Agent-Bot-Request-Jti'] = 'old-request';
    if (mode === 'tampered-body') r.text = '{not json SECRET_CANARY';
    if (mode === 'invalid-signature') r.headers['Agent-Bot-Signature'] = 'A'.repeat(86);
    return r;
  };
  const client = f.make();
  try {
    await assert.rejects(client.call('GET', '/api/daemon/whoami'), (e) => e.code === 'credential_unavailable' && !/SECRET_CANARY|not JSON/.test(e.message));
    assert.equal(f.state.revocations, 0);
    assert.equal(f.state.apiCalls, 0, 'an unverified token reply is never used');
  } finally { client.close(); }
});

test('retired, not-yet-valid and expired keys are refused, and a pre-published next key works in its interval', async () => {
  for (const key of [{ status: 'retired' }, { notBefore: after, notAfter: '2028-01-01T00:00:00Z' }, { notAfter: '2026-02-01T00:00:00Z' }]) {
    const f = fixture(), client = f.make({ keySet: [{ ...f.keySet[0], ...key }] });
    await assert.rejects(client.call('GET', '/api/daemon/whoami'), code('credential_unavailable'));
    assert.equal(f.state.requests.length, 0);
  }
  const f = fixture(), client = f.make({ keySet: [{ ...f.keySet[0], status: 'next' }] });
  await client.call('GET', '/api/daemon/whoami');
  client.close();
});

for (const mode of ['token-revoked', 'api-revoked']) test(`verified ${mode} drops credentials and revokes HQ enrollment once`, async () => {
  const f = fixture(), client = f.make();
  let notified = 0;
  client.onRevoke(() => notified++);
  f.state.mode = mode;
  await assert.rejects(client.call('POST', '/api/daemon/notices/take', { harness: 'codex' }), code('device_revoked'));
  const calls = f.state.requests.length;
  await assert.rejects(client.call('GET', '/api/daemon/whoami'), code('device_revoked'));
  assert.deepEqual([f.state.revocations, notified, client.status().tokenCached, f.state.requests.length], [1, 1, false, calls]);
  client.close();
});

test('an outage, oversized response, hanging body and stale response fail closed with no secret in errors', async () => {
  const f = fixture();
  const cases = [
    { fetchImpl: async () => { throw new Error('SECRET_CANARY'); } },
    { maxBodyBytes: 10 },
    { timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) },
  ];
  for (const options of cases) {
    const client = f.make(options);
    try { await assert.rejects(client.call('GET', '/api/daemon/whoami'), (e) => e.code === 'credential_unavailable' && !/SECRET_CANARY/.test(e.message)); }
    finally { client.close(); }
  }
  const client = f.make();
  f.state.mode = 'advance-clock';
  await assert.rejects(client.call('GET', '/api/daemon/whoami'), code('credential_unavailable'));
  client.close();
});

test('a verified 401 invalidates its token without replaying the request', async () => {
  const f = fixture(), client = f.make();
  f.state.mode = 'unauthorized';
  assert.equal((await client.call('POST', '/api/daemon/notices/ack', { harness: 'codex', ids: ['lease-1'] })).status, 401);
  assert.equal(f.state.apiCalls, 1);
  assert.equal(client.status().tokenCached, false);
  f.state.mode = 'ok';
  await client.call('GET', '/api/daemon/whoami');
  assert.equal(f.state.tokens, 2);
  client.close();
});

test('a valid token survives an early refresh outage, but never its expiry or an owner-policy refusal', async () => {
  const f = fixture(), client = f.make();
  await client.call('GET', '/api/daemon/whoami');
  f.clock.advance(841_000);
  f.state.mode = 'token-outage';
  await Promise.all([client.call('GET', '/api/daemon/whoami'), client.call('GET', '/api/daemon/whoami')]);
  assert.equal(f.state.apiCalls, 3);
  f.clock.advance(60_000);
  await assert.rejects(client.call('GET', '/api/daemon/whoami'), code('credential_unavailable'));
  assert.equal(f.state.apiCalls, 3);
  client.close();
  const g = fixture(), refused = g.make();
  await refused.call('GET', '/api/daemon/whoami');
  g.clock.advance(841_000);
  g.state.mode = 'software-refused';
  await assert.rejects(refused.call('GET', '/api/daemon/whoami'), (e) => e.code === 'profile_insufficient' && !/SECRET_CANARY/.test(e.message));
  assert.equal(g.state.revocations, 0);
  assert.equal(g.state.apiCalls, 1);
  refused.close();
});

test('a caller cannot redirect a proof or choose a harness outside enrollment', async () => {
  const f = fixture(), client = f.make();
  for (const path of ['https://elsewhere.test', '//elsewhere.test/api/daemon/x', '/api/daemon/../x', '/api/daemon/x?url=elsewhere']) await assert.rejects(client.call('POST', path, {}), code('host.invalid_request'));
  await assert.rejects(client.call('POST', '/api/daemon/notices/take', { harness: 'other' }), code('host.route_not_allowed'));
  assert.equal(f.state.apiCalls, 0);
  client.close();
});

test('closing while an API reply is in flight prevents a late credential result', async () => {
  const f = fixture(), client = f.make();
  let release;
  f.state.hold = new Promise((r) => { release = r; });
  const pending = client.call('GET', '/api/daemon/whoami');
  while (!f.state.apiCalls) await new Promise((r) => setTimeout(r, 1));
  client.close();
  release();
  await assert.rejects(pending, code('host.context_revoked'));
  assert.equal(client.status().tokenCached, false);
});

test('revocation refuses an already submitted request even when its fetch ignores cancellation', async () => {
  const f = fixture(), client = f.make();
  let release;
  f.state.hold = new Promise((r) => { release = r; });
  const pending = client.call('GET', '/api/daemon/whoami');
  const rejected = assert.rejects(pending, code('device_revoked'));
  while (!f.state.apiCalls) await new Promise((r) => setTimeout(r, 1));
  f.state.hold = undefined;
  f.state.mode = 'api-revoked';
  await assert.rejects(client.call('GET', '/api/daemon/whoami'), code('device_revoked'));
  release();
  await rejected;
  assert.equal(client.status().tokenCached, false);
  client.close();
});

test('closing during a shared refresh cannot cache a late access token', async () => {
  const f = fixture();
  let release, arrived;
  const waiting = new Promise((r) => { arrived = r; });
  const held = new Promise((r) => { release = r; });
  const client = f.make({ fetchImpl: async (...args) => { const out = await f.fetchImpl(...args); arrived(); await held; return out; } });
  const pending = client.call('GET', '/api/daemon/whoami');
  const rejected = assert.rejects(pending, code('host.context_revoked'));
  await waiting;
  client.close();
  release();
  await rejected;
  assert.equal(client.status().tokenCached, false);
  assert.equal(f.state.apiCalls, 0);
});


test('HQ signer revocation drops the transport token and refuses an in-flight late reply', async () => {
  const f = fixture(), client = f.make();
  await client.call('GET', '/api/daemon/whoami');
  assert.equal(client.status().tokenCached, true);
  const hq = await startHQ({ identity: client });
  let release;
  f.state.hold = new Promise((r) => { release = r; });
  const pending = client.call('GET', '/api/daemon/whoami');
  const refused = assert.rejects(pending, code('host.context_revoked'));
  try {
    while (f.state.apiCalls < 2) await new Promise((r) => setTimeout(r, 1));
    hq.legacy.state.device = 'revoked';
    await hq.hq.legacyTick();
    assert.equal(hq.hq.status().mode, 'device_revoked');
    assert.equal(client.status().tokenCached, false);
    release();
    await refused;
  } finally { release(); await hq.done(); }
});

test('revocation reaches every listener and HQ drops SDK credentials even when enrollment persistence throws', async () => {
  const f = fixture();
  f.enrollment.markRevoked = () => { throw new Error('PERSISTENCE_SECRET_CANARY'); };
  const client = f.make();
  client.onRevoke(() => { throw new Error('OBSERVER_SECRET_CANARY'); });
  const probe = definePlugin({
    name: 'revocation-probe', version: '1.0.0', hostApi: 1, services: ['credentials'],
    async init(ctx) { return { provides: { resolve: () => ctx.services.credentials.resolve('test-reference', { task: 'test-task', operation: 'test-operation' }) } }; },
  });
  const hq = await startHQ({ plugins: [probe], identity: { ...client, mint: async () => ({ token: 'SDK_CREDENTIAL_CANARY', expiresAt: f.clock.now() + 60_000 }) } });
  let lastNotified = 0;
  client.onRevoke(() => { lastNotified += 1; });
  try {
    await hq.hq.host.provided('revocation-probe').resolve();
    await client.call('GET', '/api/daemon/whoami');
    assert.equal(hq.hq.core.tokens.size, 1);
    assert.equal(client.status().tokenCached, true);
    f.state.mode = 'api-revoked';
    await assert.rejects(client.call('GET', '/api/daemon/whoami'), code('device_revoked'));
    assert.equal(lastNotified, 1, 'a failing observer does not skip later observers');
    assert.equal(hq.hq.status().mode, 'device_revoked');
    assert.equal(hq.hq.core.tokens.size, 0);
    assert.equal(hq.hq.core.minting.size, 0);
    assert.equal(client.status().tokenCached, false);
    assert.equal(client.status().revocationPersistenceFailed, true);
    assert.equal(client.status().revocationListenerFailed, true);
    assert.doesNotMatch(JSON.stringify(client.status()), /SECRET_CANARY/);
    await assert.rejects(hq.hq.host.provided('revocation-probe').resolve(), code('device_revoked'));
  } finally { await hq.done(); }
});

for (const phase of ['access refresh', 'daemon API']) test(`HQ shutdown closes the identity transport before a blocked plugin stop (${phase})`, async () => {
  const f = fixture();
  let releaseReply, arrived, releaseStop, stopping;
  const replyHeld = new Promise((r) => { releaseReply = r; });
  const replyArrived = new Promise((r) => { arrived = r; });
  const stopHeld = new Promise((r) => { releaseStop = r; });
  const stopStarted = new Promise((r) => { stopping = r; });
  let hold = false;
  const client = f.make({ fetchImpl: async (url, init) => {
    const response = await f.fetchImpl(url, init);
    if (hold && (phase === 'access refresh') === url.endsWith('/oauth/token')) { arrived(); await replyHeld; }
    return response;
  } });
  const probe = definePlugin({
    name: 'shutdown-probe', version: '1.0.0', hostApi: 1,
    services: ['identityService'], identityServiceRoutes: ['/api/daemon/whoami'],
    async init(ctx) { return { provides: { call: () => ctx.services.identityService.call('GET', '/api/daemon/whoami') } }; },
    async stop() { stopping(); await stopHeld; },
  });
  const hq = await startHQ({ identity: client, plugins: [probe] });
  let shutdown;
  try {
    if (phase === 'daemon API') await client.call('GET', '/api/daemon/whoami');
    hold = true;
    const pending = hq.hq.host.provided('shutdown-probe').call();
    const rejected = assert.rejects(pending, code('host.context_revoked'));
    await replyArrived;
    hq.hq.core.tokens.set('shutdown-test', { token: 'SDK_SHUTDOWN_CANARY', expiresAt: f.clock.now() + 60_000 });
    shutdown = hq.hq.stop();
    await stopStarted;
    assert.equal(hq.hq.status().mode, 'stopping');
    assert.equal(hq.hq.core.tokens.size, 0, 'SDK credentials are dropped before blocked stop callbacks');
    assert.equal(client.status().tokenCached, false);
    assert.equal(f.state.requests.at(-1).init.signal.aborted, true);
    await assert.rejects(hq.hq.host.provided('shutdown-probe').call(), code('host.context_revoked'));
    releaseReply();
    await rejected;
    assert.equal(client.status().tokenCached, false);
    assert.equal(f.state.apiCalls, phase === 'access refresh' ? 0 : 2, 'shutdown starts no new API request');
    releaseStop();
    await shutdown;
  } finally { releaseReply(); releaseStop(); await shutdown?.catch(() => {}); await hq.done(); }
});

test('an authenticated access token already expired on arrival is neither cached nor sent to the daemon API', async () => {
  const f = fixture();
  f.state.expiresIn = 1;
  const client = f.make({ fetchImpl: async (url, init) => {
    const reply = await f.fetchImpl(url, init);
    if (url.endsWith('/oauth/token')) f.clock.advance(2000);
    return reply;
  } });
  try {
    await assert.rejects(client.call('GET', '/api/daemon/whoami'), (e) => e.code === 'credential_unavailable' && /expired/.test(e.message));
    assert.equal(f.state.apiCalls, 0);
    assert.equal(client.status().tokenCached, false);
  } finally { client.close(); }
});

test('a token that expires between access acquisition and daemon fetch is refused before sending', async () => {
  const f = fixture(), client = f.make();
  f.state.expiresIn = 1;
  let advanced = false;
  const body = { get harness() { if (!advanced) { advanced = true; f.clock.advance(2000); } return 'codex'; } };
  try {
    await assert.rejects(client.call('POST', '/api/daemon/notices/take', body), (e) => e.code === 'credential_unavailable' && /expired/.test(e.message));
    assert.equal(f.state.apiCalls, 0);
    assert.equal(client.status().tokenCached, false);
  } finally { client.close(); }
});

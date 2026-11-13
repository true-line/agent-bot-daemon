// HQ's identity-service link (plan §4.7 / row 10). Device assertions stay
// with enrollment's signer. Access tokens and their ephemeral DPoP keys live
// only in this process; replies are authenticated before JSON is parsed.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fail, HostError } from '../sdk/errors.mjs';
import { GRANT_JWT_BEARER, validateServiceUrl } from './enrollment.mjs';

const TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SKEW_MS = 5 * 60_000;
const B64URL = /^[A-Za-z0-9_-]+$/;
const nonce = () => randomBytes(24).toString('base64url');
const hash = (bytes) => createHash('sha256').update(bytes).digest();
const TRANSIENT = Symbol('identity-service transient outage');
const unavailable = (reason, transient = false) => {
  const error = new HostError('credential_unavailable', `identity service: ${reason}`);
  if (transient) error[TRANSIENT] = true;
  throw error;
};
const ownObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
function dateMillis(value) {
  if (typeof value !== 'string') return NaN;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!parts) return NaN;
  const [, y, m, d, h, min, sec] = parts.map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return m >= 1 && m <= 12 && d >= 1 && d <= days && h < 24 && min < 60 && sec < 60 ? Date.parse(value) : NaN;
}

export function signatureBytes(status, text, jti) {
  return Buffer.from(`agent-bot-sig-v1\n${status}\n${hash(text).toString('hex')}\n${jti}`);
}

// A release pin, never populated by fetching the service on first use. The
// public manifest's dates are operator-provided evidence, not guessed TTLs.
export function validateServerKeys(manifest, server) {
  if (!ownObject(manifest) || Object.keys(manifest).some((k) => !['server', 'keys'].includes(k))
    || manifest.server !== server || !Array.isArray(manifest.keys)) throw new TypeError('server-keys.json names this service and a keys array');
  const seen = new Set(), publicKeys = new Set();
  return Object.freeze(manifest.keys.map((k) => {
    if (!ownObject(k) || Object.keys(k).some((name) => !['kid', 'x', 'notBefore', 'notAfter', 'status'].includes(name))) throw new TypeError('a server key has only kid, x, notBefore, notAfter and status');
    if (typeof k.kid !== 'string' || !B64URL.test(k.kid) || k.kid.length > 128 || seen.has(k.kid)) throw new TypeError('server key ids are unique base64url strings');
    if (typeof k.x !== 'string' || !B64URL.test(k.x) || Buffer.from(k.x, 'base64url').length !== 32 || Buffer.from(k.x, 'base64url').toString('base64url') !== k.x) throw new TypeError('a server key is an Ed25519 public key');
    if (!['active', 'next', 'retired'].includes(k.status)) throw new TypeError('a server key is active, next or retired');
    const before = dateMillis(k.notBefore), after = dateMillis(k.notAfter);
    if (typeof k.notBefore !== 'string' || typeof k.notAfter !== 'string' || !Number.isFinite(before) || !Number.isFinite(after) || before >= after) throw new TypeError('a server key has an ordered validity interval');
    createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' });
    if (publicKeys.has(k.x)) throw new TypeError('a server public key has exactly one key id and lifecycle record');
    seen.add(k.kid);
    publicKeys.add(k.x);
    return Object.freeze({ ...k });
  }));
}

export function releaseServerKeys(server, file = new URL('../governance/server-keys.json', import.meta.url)) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const keys = validateServerKeys(manifest, manifest.server);
  return manifest.server === server ? keys : [];
}

export function createIdentityService({
  server,
  enrollment,
  keySet = releaseServerKeys(server),
  fetchImpl = globalThis.fetch,
  clock = { now: () => Date.now() },
  timeoutMs = TIMEOUT_MS,
  maxBodyBytes = MAX_BODY_BYTES,
} = {}) {
  validateServiceUrl(server);
  if (!enrollment || typeof enrollment.assertion !== 'function' || typeof enrollment.deviceStatus !== 'function') throw new TypeError('the identity-service link needs HQ enrollment');
  keySet = validateServerKeys({ server, keys: keySet }, server);
  if (!(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_SKEW_MS)) throw new TypeError('identity-service timeout is at most five minutes');
  if (!(Number.isSafeInteger(maxBodyBytes) && maxBodyBytes > 0 && maxBodyBytes <= MAX_BODY_BYTES)) throw new TypeError('identity-service body cap is at most one MiB');
  let token;
  let refreshing;
  let epoch = 0;
  let closed = false;
  let revoked = false;
  let revocationListenerFailed = false;
  let revocationPersistenceFailed = false;
  let link = 'not-checked';
  const listeners = new Set();
  const requests = new Set();

  const check = () => {
    if (revoked) fail('device_revoked', 'device revoked: re-enroll');
    if (closed) fail('host.context_revoked', 'the identity-service link is closed');
    const now = clock.now();
    if (!keySet.some((k) => k.status !== 'retired' && Date.parse(k.notBefore) <= now && now < Date.parse(k.notAfter))) unavailable('no current release-pinned response-signing key');
  };
  const drop = () => { token = undefined; epoch += 1; };
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    drop();
    // Revocation is effective in memory even if an observer or the local
    // enrollment store fails. Every listener gets its own attempt, before
    // persistence, so a disk error cannot leave HQ's SDK credentials live.
    const attempt = (fn, failed) => {
      try { Promise.resolve(fn()).catch(failed); } catch { failed(); }
    };
    for (const listener of listeners) attempt(listener, () => { revocationListenerFailed = true; });
    attempt(() => enrollment.markRevoked?.('device_revoked'), () => { revocationPersistenceFailed = true; });
  };
  const alive = (generation) => {
    check();
    if (epoch !== generation) fail('host.context_revoked', 'identity credentials were dropped while the request was in flight');
  };
  const freshAccess = (current) => {
    if (current.expiresAt <= clock.now()) {
      if (token === current) token = undefined;
      unavailable('access token expired before the daemon request');
    }
  };

  // Includes reading the response body in the deadline. A fetch that resolves
  // its headers but never ends its body must not hold a credential operation.
  async function request(path, init, jti, accessToken) {
    check();
    const started = clock.now();
    const generation = epoch;
    const controller = new AbortController();
    requests.add(controller);
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, timeoutMs);
    });
    try {
      const work = (async () => {
        if (accessToken) freshAccess(accessToken);
        const response = await fetchImpl(`${server}${path}`, { ...init, redirect: 'error', signal: controller.signal });
        if (response.status >= 300 && response.status < 400) unavailable('redirect refused');
        const declared = response.headers.get('content-length');
        if (declared && Number(declared) > maxBodyBytes) unavailable('response exceeds the body cap');
        let bytes;
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          const cancel = () => { reader.cancel().catch(() => {}); };
          controller.signal.addEventListener('abort', cancel, { once: true });
          const parts = [];
          let size = 0;
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > maxBodyBytes) { controller.abort(); unavailable('response exceeds the body cap'); }
              parts.push(Buffer.from(value));
            }
          } finally { controller.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
          bytes = Buffer.concat(parts);
        } else {
          bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > maxBodyBytes) unavailable('response exceeds the body cap');
        }
        alive(generation);
        if (controller.signal.aborted) unavailable('request failed or timed out');
        const now = clock.now();
        if (now < started || now - started > MAX_SKEW_MS) unavailable('response is outside the request freshness window');
        const kid = response.headers.get('agent-bot-key-id');
        const key = keySet.find((k) => k.kid === kid);
        if (!key || key.status === 'retired' || now < Date.parse(key.notBefore) || now >= Date.parse(key.notAfter)) unavailable('unknown, retired or out-of-window response-signing key');
        const signature = response.headers.get('agent-bot-signature');
        if (response.headers.get('agent-bot-request-jti') !== jti || typeof signature !== 'string' || !B64URL.test(signature)
          || Buffer.from(signature, 'base64url').length !== 64
          || !verify(null, signatureBytes(response.status, bytes, jti), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' }), Buffer.from(signature, 'base64url'))) unavailable('response signature or request nonce did not verify');
        let body;
        try { body = JSON.parse(bytes.toString('utf8')); } catch { unavailable('authenticated response is not JSON'); }
        link = 'ok';
        if (body?.error === 'device_revoked' || (path === '/oauth/token' && body?.error === 'invalid_grant')) { revoke(); fail('device_revoked', 'device revoked: re-enroll'); }
        if (body?.error === 'profile_insufficient') fail('profile_insufficient', 'the identity service refused this device key storage under owner policy');
        return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text: bytes.toString('utf8'), body };
      })();
      return await Promise.race([work, deadline]);
    } catch (e) {
      if (e?.code === 'device_revoked' || e?.code === 'host.context_revoked' || e?.code === 'profile_insufficient') throw e;
      link = 'unreachable';
      // No raw server body, URL, request, token or arbitrary exception text
      // crosses into logs, receipts or owner diagnostics.
      if (e?.code === 'credential_unavailable') throw e;
      unavailable('request failed or timed out', true);
    } finally {
      clearTimeout(timer);
      requests.delete(controller);
      controller.abort();
    }
  }

  async function access() {
    check();
    const state = await enrollment.deviceStatus();
    if (state === 'revoked') { revoke(); fail('device_revoked', 'device revoked: re-enroll'); }
    if (state !== 'enrolled') unavailable('HQ is not enrolled');
    if (token && token.expiresAt <= clock.now()) token = undefined;
    if (token && token.expiresAt > clock.now() + 60_000) return token;
    if (refreshing) return refreshing;
    const generation = epoch;
    const pending = (async () => {
      const started = clock.now();
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const ephemeralJwk = publicKey.export({ format: 'jwk' });
      const assertion = enrollment.assertion({ ephemeralJwk });
      let claims;
      try { claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url')); } catch { unavailable('HQ assertion is malformed'); }
      if (typeof claims.jti !== 'string' || claims.jti.length < 8) unavailable('HQ assertion has no request nonce');
      const out = await request('/oauth/token', {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: GRANT_JWT_BEARER, assertion }).toString(),
      }, claims.jti);
      alive(generation);
      const result = out.body;
      if (out.status >= 500) unavailable('access token service is temporarily unavailable', true);
      if (out.status !== 200 || result?.token_type !== 'DPoP' || typeof result.access_token !== 'string' || !result.access_token
        || !Number.isSafeInteger(result.expires_in) || result.expires_in <= 0 || result.expires_in > 900) unavailable('access token was refused or malformed');
      const candidate = { value: result.access_token, expiresAt: started + result.expires_in * 1000, privateKey, publicJwk: ephemeralJwk, harnesses: Array.isArray(result.harnesses) ? result.harnesses.filter((h) => typeof h === 'string') : [] };
      // expires_in is measured conservatively from the request's start.
      // A slow but authenticated response must not cache an expired token.
      freshAccess(candidate);
      token = candidate;
      return token;
    })().catch((e) => {
      // Share the fallback with every concurrent waiter, as well as the
      // refresh itself. Revocation and owner-policy refusals never use it.
      if (e?.[TRANSIENT] && !closed && !revoked && token?.expiresAt > clock.now()) return token;
      throw e;
    });
    refreshing = pending;
    try { return await pending; } finally { if (refreshing === pending) refreshing = undefined; }
  }

  return {
    keySet,
    get link() { return link; },
    check,
    onRevoke(listener) { listeners.add(listener); },
    status: () => ({ link, revoked, releasePinned: true, trustedKeys: keySet.length, tokenCached: Boolean(token), revocationListenerFailed, revocationPersistenceFailed }),
    async call(method, path, body) {
      check();
      if (typeof method !== 'string' || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)
        || typeof path !== 'string' || !/^\/api\/daemon\/[A-Za-z0-9/_-]+$/.test(path)) fail('host.invalid_request', 'the identity link accepts a daemon API method and path only');
      const current = await access();
      const generation = epoch;
      alive(generation);
      freshAccess(current);
      // Notices are scoped twice: the owner selects queues, and HQ refuses
      // a queue outside this enrolled device's current scope before sending.
      if (body?.harness !== undefined && !current.harnesses.includes(body.harness)) fail('host.route_not_allowed', 'the harness is outside this device enrollment');
      const jti = nonce();
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt', jwk: current.publicJwk })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ htm: method, htu: `${server}${path}`, iat: Math.floor(clock.now() / 1000), jti, ath: hash(current.value).toString('base64url') })).toString('base64url');
      const unsigned = `${header}.${payload}`;
      const proof = `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key: current.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
      const reply = await request(path, { method, headers: { accept: 'application/json', authorization: `DPoP ${current.value}`, DPoP: proof, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, jti, current);
      alive(generation);
      if (reply.status === 401) drop(); // Never replay an external write automatically.
      return reply;
    },
    mint: async () => unavailable('credential-reference resolution arrives with plan row 18'),
    close() { closed = true; drop(); for (const controller of requests) controller.abort(); },
  };
}

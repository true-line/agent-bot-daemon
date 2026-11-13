// HQ's own enrollment with the identity service (plan §9 row 15c; §4.4,
// §4.7; PDR-0027). The device key is the HQ signer's key: the enrollment
// proof and the later jwt-bearer assertion are signed through the signer,
// and the device record names that key's thumbprint and its key_storage.
//
// This replaces the legacy bridge as the source of device status only when
// the owner sets `enrollment.source` to `hq` in HQ's config. The default
// stays `legacy`, so a host enrolled by the existing agent-bot keeps working.
//
// The flow is the identity service's device-code grant, as the existing
// client runs it (agent-bot-identity, identity/server-client.mjs):
//
//   GET  /.well-known/agent-bot-server-key      pin the response-signing key
//   POST /oauth/device_authorization            proof signed by the device key
//   POST /oauth/token (device_code grant)       polled until the owner approves
//
// `enroll` returns as soon as the service has issued a user code. HQ polls
// in the background; `progress()` (shown by status and device.status) says
// pending, approved or failed. The device is enrolled from HQ's next start.
//
// State, in identity/ under HQ's state directory (0700, files 0600):
//   device.json           the device record (no secret: ids and the key thumbprint)
//   device.previous.json  the record a re-enrollment replaced
//   server-key.json       the pinned Ed25519 response-signing key
//
// Re-enrollment (`force`, or after a revocation) makes a fresh key first: a
// revoked device record is never revived (§4.7), and a key that has been
// enrolled is not enrolled twice. Unlike the legacy client, the old
// enrollment is not kept alive while the new grant is pending: there is one
// signer key, so HQ is unenrolled (safe mode at its next start) until the
// owner approves.
//
// Access tokens, DPoP and authenticated replies belong to identity-service.mjs
// (§9 row 10); credential resolution is row 18. `assertion()` builds the
// assertion the link sends. This enrollment record retains its transitional
// first-use server key; the link trusts only its separate release pin.
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fail } from '../sdk/errors.mjs';

export const DEFAULT_IDENTITY_SERVICE = 'https://agents.true-line.ai';
export const GRANT_DEVICE_CODE = 'urn:ietf:params:oauth:grant-type:device_code';
export const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 64 * 1024;
const HARNESS = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PLATFORMS = { darwin: 'macos', linux: 'linux', win32: 'windows' };

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// A bare origin: https anywhere, http only on loopback (tests, local service).
export function validateServiceUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('HQ config: enrollment.server is a URL'); }
  if (u.origin !== raw) throw new Error('HQ config: enrollment.server is a bare origin, with no path, query or trailing slash');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('HQ config: enrollment.server is https (http only on loopback)');
  return raw;
}

export function validateEnrollmentConfig(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('HQ config: enrollment is an object');
  for (const k of Object.keys(e)) if (!['source', 'server'].includes(k)) throw new Error(`HQ config: unknown key enrollment.${k}`);
  if (e.source !== undefined && !['legacy', 'hq'].includes(e.source)) throw new Error('HQ config: enrollment.source is legacy or hq');
  if (e.server !== undefined) {
    if (e.source !== 'hq') throw new Error('HQ config: enrollment.server is only for the hq source');
    validateServiceUrl(e.server);
  }
  return e;
}

function ensureDir(dir, uid) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} is owned by uid ${st.uid}, not HQ's uid ${uid}`);
  if (st.mode & 0o077) throw new Error(`${dir} has mode ${(st.mode & 0o777).toString(8)}; it must be 0700`);
}

function readJsonFile(path, uid) {
  if (!existsSync(path)) return undefined;
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${path} is owned by uid ${st.uid}, not HQ's uid ${uid}`);
  if (st.mode & 0o077) throw new Error(`${path} has mode ${(st.mode & 0o777).toString(8)}; it must be 0600`);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} is not a JSON object`);
  return value;
}

function writeJsonFile(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function createEnrollment({
  home,
  signer,                               // the HQ signer: signJws, report, createKey
  server = DEFAULT_IDENTITY_SERVICE,
  fetchImpl = globalThis.fetch,
  clock = { now: () => Date.now() },
  sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); }),
  uid = process.getuid?.(),
  deviceName = hostname(),
  platform = PLATFORMS[process.platform] ?? 'other',
  onEvent = () => {},                   // ({ kind, ...details }) for receipts
} = {}) {
  if (!home) throw new TypeError('createEnrollment needs HQ\'s state directory (home)');
  if (!signer) throw new TypeError('createEnrollment needs the HQ signer');
  validateServiceUrl(server);
  const dir = join(home, 'identity');
  const paths = { device: join(dir, 'device.json'), previous: join(dir, 'device.previous.json'), serverKey: join(dir, 'server-key.json') };
  let grant;       // { state: pending | approved | failed, ... } for the current HQ process
  let polling;

  const seconds = () => Math.floor(clock.now() / 1000);
  const iso = () => new Date(clock.now()).toISOString();
  const key = () => {
    const r = signer.report();
    if (!r.available) throw new Error(`the signer is unavailable: ${r.reason}`);
    return r;
  };

  // One request: never follow a redirect (it could forward a proof), bounded
  // in time and size, JSON or nothing.
  async function request(path, form) {
    const init = form
      ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form).toString() }
      : { method: 'GET', headers: { accept: 'application/json' } };
    let res;
    try {
      res = await fetchImpl(`${server}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      fail('credential_unavailable', `the identity service is unreachable (${e?.name === 'TimeoutError' ? 'timed out' : e?.cause?.code ?? e?.code ?? 'network error'})`);
    }
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new Error(`the identity service answered ${path} with more than ${MAX_BODY_BYTES} bytes`);
    let body;
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = { error: `http_${res.status}` };
    return { ok: res.ok, status: res.status, body };
  }

  const oauthMessage = (what, body) => `${what}: ${body.error ?? 'error'}${typeof body.error_description === 'string' ? ` (${body.error_description.slice(0, 200)})` : ''}`;

  function record() {
    return readJsonFile(paths.device, uid);
  }

  async function pinServerKey() {
    const pinned = readJsonFile(paths.serverKey, uid);
    if (pinned && pinned.server === server) return pinned;
    const { ok, body } = await request('/.well-known/agent-bot-server-key');
    const jwk = body?.keys?.[0];
    if (!ok || jwk?.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || Buffer.from(jwk.x, 'base64url').length !== 32) {
      throw new Error(`the identity service's response-signing key is unavailable (${body?.error ?? 'malformed key'})`);
    }
    const pin = { kty: 'OKP', crv: 'Ed25519', x: jwk.x, ...(typeof jwk.kid === 'string' ? { kid: jwk.kid } : {}), server, pinned_at: iso() };
    writeJsonFile(paths.serverKey, pin);
    return pin;
  }

  // enrolled only while the record names this server and the signer's current key.
  function stateOf(rec, thumbprint) {
    if (!rec) return 'unenrolled';
    if (rec.revoked_at) return 'revoked';
    if (rec.server !== server || rec.jkt !== thumbprint) return 'unenrolled';
    return 'enrolled';
  }

  async function poll(auth, started) {
    let interval = Number(auth.interval) > 0 ? Number(auth.interval) : 5;
    const deadline = started + (Number(auth.expires_in) > 0 ? Number(auth.expires_in) : 900) * 1000;
    for (;;) {
      await sleep(interval * 1000);
      if (clock.now() > deadline) throw new Error('the device code expired before the owner approved it');
      const { body } = await request('/oauth/token', { grant_type: GRANT_DEVICE_CODE, device_code: auth.device_code });
      if (typeof body.device_id === 'string' && body.device_id.length > 0 && body.device_id.length <= 256) return body;
      if (body.error === 'slow_down') interval += 5;
      else if (body.error !== 'authorization_pending') throw new Error(oauthMessage('enrollment was refused', body));
    }
  }

  const enrollment = {
    source: `HQ enrollment with ${server}`,

    async deviceStatus() {
      return stateOf(record(), key().thumbprint);
    },

    // What status and device.status show about the enrollment.
    progress() {
      let rec;
      try { rec = record(); } catch { rec = undefined; }
      return {
        server,
        ...(rec ? { device_id: rec.device_id, key_storage: rec.key_storage, enrolled_at: rec.enrolled_at, ...(rec.revoked_at ? { revoked_at: rec.revoked_at } : {}) } : {}),
        ...(grant ? { grant: { ...grant } } : {}),
      };
    },

    // Start (or report) the device-code grant. Resolves once the service has
    // issued a user code; approval is polled for in the background.
    async enroll(payload = {}) {
      const harnesses = payload.harnesses;
      if (!Array.isArray(harnesses) || harnesses.length === 0 || harnesses.length > 32 || !harnesses.every((h) => typeof h === 'string' && HARNESS.test(h))) {
        fail('host.invalid_request', 'enroll names at least one harness (lowercase letters, digits and hyphens)');
      }
      if (payload.force !== undefined && typeof payload.force !== 'boolean') fail('host.invalid_request', 'force is a boolean');
      if (payload.device_name !== undefined && (typeof payload.device_name !== 'string' || payload.device_name.length === 0 || payload.device_name.length > 128)) fail('host.invalid_request', 'device_name is a string of at most 128 characters');
      if (grant?.state === 'pending') return { pending: true, ...grant };

      ensureDir(dir, uid);
      const rec = record();
      let k = key();
      const state = stateOf(rec, k.thumbprint);
      if (state === 'enrolled' && payload.force !== true) fail('host.invalid_request', 'this HQ is already enrolled; pass force to re-enroll with a fresh key');
      // A key that has been enrolled, here or for a revoked record, is never enrolled again.
      if (rec && rec.jkt === k.thumbprint) {
        signer.createKey({ replace: true });
        k = key();
      }
      if (rec) renameSync(paths.device, paths.previous);

      const serverKey = await pinServerKey();
      const aud = `${server}/oauth/device_authorization`;
      const name = payload.device_name ?? deviceName;
      const proof = signer.signJws({ typ: 'ab-enroll+jwt', jwk: signer.publicJwk() }, { aud, iat: seconds(), jti: b64url(randomBytes(16)) }, { kid: false });
      const { ok, body: auth } = await request('/oauth/device_authorization', { device_name: name, platform, key_storage: k.key_storage, tags: '', harnesses: harnesses.join(' '), proof });
      if (!ok || typeof auth.user_code !== 'string' || typeof auth.device_code !== 'string') throw new Error(oauthMessage('device authorization failed', auth));

      const started = clock.now();
      grant = {
        state: 'pending',
        user_code: auth.user_code,
        ...(typeof auth.verification_uri === 'string' ? { verification_uri: auth.verification_uri } : {}),
        ...(typeof auth.verification_uri_complete === 'string' ? { verification_uri_complete: auth.verification_uri_complete } : {}),
        expires_at: new Date(started + (Number(auth.expires_in) > 0 ? Number(auth.expires_in) : 900) * 1000).toISOString(),
        key_thumbprint: k.thumbprint,
        key_storage: k.key_storage,
        key_generation: k.generation,
      };
      onEvent({ kind: 'device.enroll.started', key_storage: k.key_storage, key_generation: k.generation });

      polling = poll(auth, started).then((result) => {
        const saved = {
          server, device_id: result.device_id, jkt: k.thumbprint, key_storage: k.key_storage, key_generation: k.generation,
          method: 'device_code', platform, device_name: name,
          harnesses: Array.isArray(result.harnesses) ? result.harnesses.filter((h) => typeof h === 'string').slice(0, 64) : harnesses,
          server_key_id: serverKey.kid ?? null, enrolled_at: iso(),
        };
        writeJsonFile(paths.device, saved);
        grant = { state: 'approved', device_id: saved.device_id, key_thumbprint: k.thumbprint, key_storage: k.key_storage, restart: true };
        onEvent({ kind: 'device.enrolled', device_id: saved.device_id, key_storage: k.key_storage });
      }, (e) => {
        grant = { state: 'failed', reason: e.message, key_thumbprint: k.thumbprint };
        onEvent({ kind: 'device.enroll.failed', reason: e.message });
      });
      return { pending: true, ...grant };
    },

    // Resolves when the grant in flight (if any) has ended, either way.
    settled: async () => { await polling; },

    // The identity service said this device is revoked: record it so every
    // later start reports device_revoked until the owner re-enrolls.
    markRevoked(detail = 'device_revoked') {
      const rec = record();
      if (rec && !rec.revoked_at) writeJsonFile(paths.device, { ...rec, revoked_at: iso(), revoked_detail: String(detail).slice(0, 200) });
    },

    // The jwt-bearer assertion for a token request (§4.7), signed by the
    // device key and bound to the caller's ephemeral DPoP key.
    assertion({ ephemeralJwk } = {}) {
      const rec = record();
      const k = key();
      const state = stateOf(rec, k.thumbprint);
      if (state === 'revoked') fail('device_revoked', 'device revoked: re-enroll');
      if (state !== 'enrolled') fail('host.invalid_request', 'this HQ is not enrolled');
      if (!ephemeralJwk || typeof ephemeralJwk !== 'object' || 'd' in ephemeralJwk) throw new TypeError('assertion needs the public ephemeral key');
      const t = seconds();
      return signer.signJws({ typ: 'JWT' }, {
        iss: rec.device_id, sub: rec.device_id, aud: `${server}/oauth/token`, iat: t, exp: t + 120, jti: b64url(randomBytes(16)), cnf: { jwk: ephemeralJwk },
      }, { kid: false });
    },
  };
  return enrollment;
}

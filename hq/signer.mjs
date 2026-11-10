// The HQ signer (plan §9 PR 15, first slice; §3.2; PDR-0027): one P-256 key
// held for HQ, used through sign() only. HQ signs approval records with it
// now; the identity-service assertion and enrollment move onto it in the
// next slices, and until they do the device HQ reports is still the legacy
// enrollment's (hq/legacy.mjs), whose own key this is not.
//
// Two key backends sit behind one interface:
//
// - softwareKeyBackend: a PKCS#8 key file in HQ's state directory
//   (signer/device-key.pem, 0600). This is the transition custody the plan
//   allows through stage 1. It reports key_storage=software, and HQ never
//   reports managed-protected while it is in use (hq/profile.mjs).
// - helperKeyBackend: an external helper that holds a non-exportable key in
//   the platform's hardware (TPM on Linux, Secure Enclave on macOS) and
//   signs with it. HQ runs it once per request and keeps no key file. It
//   reports key_storage=hardware on the helper's word: attestation of that
//   claim is the identity service's check (§9 PR 17), not this module's.
//
// The helper protocol, agent-bot-hq-signer/1. HQ runs `<command...> <op>`
// with one JSON object on stdin and reads one JSON object from stdout:
//
//   status            → { protocol, key_storage: "hardware", present, jwk? }
//   create {replace}  → { protocol, key_storage: "hardware", jwk }
//   sign   {message}  → { protocol, signature }
//
// `jwk` is the public key only (kty EC, crv P-256, x, y). `message` is the
// base64url of the bytes to sign (at most 32 KiB); the helper hashes them
// with SHA-256 and signs, and `signature` is the base64url IEEE P1363
// signature (64 bytes). A non-zero exit, another protocol, a
// private member in the JWK, or anything else malformed is a helper failure.
//
// What HQ checks whatever the backend says:
//
// - The key is pinned. HQ records the public key's thumbprint when the key
//   is created (signer/pin.json). A backend that later presents another key,
//   or none, is an unavailable signer, which is safe mode (§4.4).
// - Every signature is verified against the pinned key before it is used,
//   so a helper cannot hand back a signature made with a different key.
// - Re-keying is explicit. createKey({ replace: true }) makes a fresh key
//   and a new generation; signatures from the old key stop verifying, as a
//   re-enrollment requires (§4.7: a revoked device record is never revived).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const SIGNER_PROTOCOL = 'agent-bot-hq-signer/1';
export const SIGNATURE_PREFIX = 'hq-sig-v1';
export const KEY_STORAGES = Object.freeze(['hardware', 'software']);

const HELPER_TIMEOUT_MS = 30_000;
const HELPER_MAX_OUTPUT = 64 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024;
const B64URL = /^[A-Za-z0-9_-]+$/;

export class SignerError extends Error {
  constructor(message) { super(message); this.name = 'SignerError'; }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// The public half of a P-256 JWK, and nothing else a backend may have sent.
export function publicJwk(jwk) {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) throw new SignerError('the signer key is not a JWK');
  if ('d' in jwk) throw new SignerError('the signer backend returned a private key');
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new SignerError('the signer key is not a P-256 key');
  for (const k of ['x', 'y']) {
    if (typeof jwk[k] !== 'string' || !B64URL.test(jwk[k]) || Buffer.from(jwk[k], 'base64url').length !== 32) throw new SignerError(`the signer key has no valid ${k} coordinate`);
  }
  const out = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  try { createPublicKey({ key: out, format: 'jwk' }); } catch { throw new SignerError('the signer key is not a point on P-256'); }
  return out;
}

// RFC 7638 thumbprint: SHA-256 over the required members in lexical order.
export function jwkThumbprint(jwk) {
  const { crv, kty, x, y } = publicJwk(jwk);
  return createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest('base64url');
}

function ensureDir(dir, uid) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new SignerError(`${dir} is not a directory`);
  if (uid !== undefined && st.uid !== uid) throw new SignerError(`${dir} is owned by uid ${st.uid}, not HQ's uid ${uid}`);
  if (st.mode & 0o077) throw new SignerError(`${dir} has mode ${(st.mode & 0o777).toString(8)}; the signer directory must be 0700`);
}

function readPrivateFile(path, uid) {
  const st = lstatSync(path);
  if (!st.isFile()) throw new SignerError(`${path} is not a regular file`);
  if (uid !== undefined && st.uid !== uid) throw new SignerError(`${path} is owned by uid ${st.uid}, not HQ's uid ${uid}`);
  if (st.mode & 0o077) throw new SignerError(`${path} has mode ${(st.mode & 0o777).toString(8)}; it must be 0600`);
  return readFileSync(path, 'utf8');
}

function writePrivateFile(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// Transition custody: a key file in HQ's own state directory.
export function softwareKeyBackend({ dir, uid = process.getuid?.() } = {}) {
  if (!dir) throw new TypeError('softwareKeyBackend needs the signer directory');
  const path = join(dir, 'device-key.pem');
  const load = () => {
    const key = createPrivateKey(readPrivateFile(path, uid));
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new SignerError(`${path} is not a P-256 key`);
    return key;
  };
  return {
    kind: 'software',
    keyStorage: 'software',
    describe: () => 'key file in HQ state (transition custody)',
    status() {
      if (!existsSync(path)) return { present: false };
      return { present: true, jwk: publicJwk(createPublicKey(load()).export({ format: 'jwk' })) };
    },
    create({ replace = false } = {}) {
      if (existsSync(path) && !replace) throw new SignerError('a signer key already exists; replacing it is a re-enrollment');
      ensureDir(dir, uid);
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      writePrivateFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
      return { jwk: publicJwk(publicKey.export({ format: 'jwk' })) };
    },
    sign(bytes) {
      return cryptoSign('sha256', bytes, { key: load(), dsaEncoding: 'ieee-p1363' });
    },
    keyFiles: () => (existsSync(path) ? [path] : []),
  };
}

// run(argv, input) → { code, stdout, error? }. The default runs the helper
// without a shell and waits for it: the signer interface is synchronous, and
// HQ signs rarely (an approval, an assertion), so a short block is accepted.
export function helperRunner({ timeoutMs = HELPER_TIMEOUT_MS, env } = {}) {
  return (argv, input) => {
    const r = spawnSync(argv[0], argv.slice(1), { input, timeout: timeoutMs, maxBuffer: HELPER_MAX_OUTPUT, env: env ?? process.env, windowsHide: true, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return { code: r.status ?? -1, stdout: String(r.stdout ?? ''), ...(r.error ? { error: r.error.message } : {}) };
  };
}

// A hardware key behind a helper. HQ holds no key file for this backend.
export function helperKeyBackend({ command, run = helperRunner() } = {}) {
  if (!Array.isArray(command) || command.length === 0 || !command.every((a) => typeof a === 'string' && a.length > 0)) throw new TypeError('helperKeyBackend needs the helper command as a list of strings');
  const call = (op, body = {}) => {
    const r = run([...command, op], JSON.stringify(body));
    if (r.code !== 0) throw new SignerError(`the signer helper failed on ${op} (exit ${r.code}${r.error ? `, ${r.error}` : ''})`);
    let out;
    try { out = JSON.parse(r.stdout); } catch { throw new SignerError(`the signer helper answered ${op} with something that is not JSON`); }
    if (!out || typeof out !== 'object' || Array.isArray(out)) throw new SignerError(`the signer helper answered ${op} with something that is not an object`);
    if (out.protocol !== SIGNER_PROTOCOL) throw new SignerError(`the signer helper speaks ${String(out.protocol)}, not ${SIGNER_PROTOCOL}`);
    return out;
  };
  const hardware = (out, op) => {
    if (out.key_storage !== 'hardware') throw new SignerError(`the signer helper reported key_storage=${String(out.key_storage)} on ${op}; a helper holds hardware keys only`);
  };
  return {
    kind: 'helper',
    keyStorage: 'hardware',
    describe: () => `helper ${command[0]}`,
    status() {
      const out = call('status');
      hardware(out, 'status');
      if (out.present === false) return { present: false };
      if (out.present !== true) throw new SignerError('the signer helper did not say whether a key is present');
      return { present: true, jwk: publicJwk(out.jwk) };
    },
    create({ replace = false } = {}) {
      const out = call('create', { replace });
      hardware(out, 'create');
      return { jwk: publicJwk(out.jwk) };
    },
    sign(bytes) {
      if (bytes.length > MAX_MESSAGE_BYTES) throw new SignerError(`the signer signs at most ${MAX_MESSAGE_BYTES} bytes`);
      const out = call('sign', { message: b64url(bytes) });
      if (typeof out.signature !== 'string' || !B64URL.test(out.signature)) throw new SignerError('the signer helper returned no signature');
      const sig = Buffer.from(out.signature, 'base64url');
      if (sig.length !== 64) throw new SignerError('the signer helper returned a signature that is not 64 bytes');
      return sig;
    },
    keyFiles: () => [],
  };
}

// Pick the backend HQ's config names. The default is the transition key.
export function backendFromConfig(cfg = {}, { home, uid, run } = {}) {
  const kind = cfg.backend ?? 'software';
  if (kind === 'software') return softwareKeyBackend({ dir: join(home, 'signer'), uid });
  if (kind === 'helper') return helperKeyBackend({ command: cfg.command, ...(run ? { run } : {}) });
  throw new TypeError(`HQ config: signer.backend is software or helper, not ${String(kind)}`);
}

export function validateSignerConfig(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('HQ config: signer is an object');
  for (const k of Object.keys(s)) if (!['backend', 'command'].includes(k)) throw new Error(`HQ config: unknown key signer.${k}`);
  if (s.backend !== undefined && !['software', 'helper'].includes(s.backend)) throw new Error('HQ config: signer.backend is software or helper');
  const helper = s.backend === 'helper';
  if (helper && !(Array.isArray(s.command) && s.command.length > 0 && s.command.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 1024))) {
    throw new Error('HQ config: signer.command is the helper command as a non-empty list of strings');
  }
  if (helper && !s.command[0].startsWith('/')) throw new Error('HQ config: signer.command names the helper by absolute path');
  if (!helper && s.command !== undefined) throw new Error('HQ config: signer.command is only for the helper backend');
  return s;
}

// createSigner({ home, backend, enrollment }) → the signer HQ core uses.
//
// `enrollment` answers deviceStatus() and enroll() (today the legacy bridge).
// The key is created on first use, so a fresh HQ has a signer before it has
// an enrollment of its own.
export function createSigner({ home, backend, enrollment, uid = process.getuid?.(), clock = { now: () => Date.now() } } = {}) {
  if (!home) throw new TypeError('createSigner needs HQ\'s state directory (home)');
  if (!backend) throw new TypeError('createSigner needs a key backend');
  const dir = join(home, 'signer');
  const pinPath = join(dir, 'pin.json');
  let pin;       // { thumbprint, jwk, key_storage, backend, generation, created_at }
  let publicKey; // KeyObject for the pinned JWK

  function readPin() {
    if (!existsSync(pinPath)) return undefined;
    let p;
    try { p = JSON.parse(readPrivateFile(pinPath, uid)); } catch (e) {
      if (e instanceof SignerError) throw e;
      throw new SignerError(`${pinPath} is not JSON`);
    }
    let ok = false;
    try {
      ok = p && typeof p === 'object' && jwkThumbprint(p.jwk) === p.thumbprint && KEY_STORAGES.includes(p.key_storage)
        && typeof p.backend === 'string' && Number.isSafeInteger(p.generation) && p.generation >= 1;
    } catch { /* a malformed key is not a pin */ }
    if (!ok) throw new SignerError(`${pinPath} is not a signer pin`);
    return p;
  }
  function setPin(p) {
    pin = p;
    publicKey = createPublicKey({ key: p.jwk, format: 'jwk' });
  }
  function writePin(jwk, generation) {
    ensureDir(dir, uid);
    const p = { thumbprint: jwkThumbprint(jwk), jwk: publicJwk(jwk), key_storage: backend.keyStorage, backend: backend.kind, generation, created_at: new Date(clock.now()).toISOString() };
    writePrivateFile(pinPath, `${JSON.stringify(p, null, 2)}\n`);
    setPin(p);
    return p;
  }

  // Load the pinned key, creating the first one. Throws when the backend's
  // key is missing or is not the pinned one: that signer is unavailable.
  function ready() {
    if (pin) return pin;
    const pinned = readPin();
    const seen = backend.status();
    if (!pinned) {
      if (seen.present) return writePin(seen.jwk, 1); // adopt a key the backend already holds
      return writePin(backend.create({ replace: false }).jwk, 1);
    }
    if (pinned.backend !== backend.kind) throw new SignerError(`the signer key was pinned on the ${pinned.backend} backend, and HQ is configured for ${backend.kind}; changing custody is a re-enrollment`);
    if (!seen.present) throw new SignerError('the pinned signer key is gone from its backend');
    if (jwkThumbprint(seen.jwk) !== pinned.thumbprint) throw new SignerError('the signer backend holds a different key from the pinned one');
    setPin(pinned);
    return pinned;
  }

  function signRaw(bytes) {
    ready();
    const sig = backend.sign(bytes);
    if (!cryptoVerify('sha256', bytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig)) throw new SignerError('the signer backend returned a signature that the pinned key does not verify');
    return sig;
  }

  const signer = {
    source: `HQ signer (${backend.describe()}); device status from ${enrollment?.source ?? 'no enrollment source'}`,

    // Device state is the enrollment's. A signer that cannot present its
    // pinned key throws first, so HQ starts in safe mode (§4.4).
    async deviceStatus() {
      ready();
      if (typeof enrollment?.deviceStatus !== 'function') throw new SignerError('no enrollment source is configured');
      return enrollment.deviceStatus();
    },
    enroll(payload) {
      if (typeof enrollment?.enroll !== 'function') throw new SignerError('no enrollment source is configured');
      return enrollment.enroll(payload);
    },

    // `hq-sig-v1.<key thumbprint>.<signature>` over the bytes (ES256).
    sign(bytes) {
      const sig = signRaw(Buffer.from(bytes));
      return `${SIGNATURE_PREFIX}.${pin.thumbprint}.${b64url(sig)}`;
    },
    // True only for a signature by the key pinned now.
    verify(bytes, signature) {
      try {
        ready();
        if (typeof signature !== 'string') return false;
        const parts = signature.split('.');
        if (parts.length !== 3 || parts[0] !== SIGNATURE_PREFIX || parts[1] !== pin.thumbprint || !B64URL.test(parts[2])) return false;
        const sig = Buffer.from(parts[2], 'base64url');
        if (sig.length !== 64) return false;
        return cryptoVerify('sha256', Buffer.from(bytes), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig);
      } catch { return false; }
    },
    // A compact ES256 JWS, for the identity-service assertion (§4.7).
    signJws(header, payload) {
      ready();
      const protectedHeader = { ...header, alg: 'ES256', kid: pin.thumbprint };
      const input = `${b64url(JSON.stringify(protectedHeader))}.${b64url(JSON.stringify(payload))}`;
      return `${input}.${b64url(signRaw(Buffer.from(input, 'ascii')))}`;
    },

    // A fresh key and a new generation. With a key already pinned this is a
    // re-enrollment and has to be asked for by name.
    createKey({ replace = false } = {}) {
      const pinned = pin ?? readPin();
      if (pinned && !replace) throw new SignerError('a signer key is already pinned; replacing it is a re-enrollment');
      const { jwk } = backend.create({ replace: Boolean(pinned) || backend.status().present });
      const p = writePin(jwk, (pinned?.generation ?? 0) + 1);
      return { thumbprint: p.thumbprint, generation: p.generation, key_storage: p.key_storage };
    },

    // What status shows. Never throws: an unavailable signer says why.
    report() {
      try {
        const p = ready();
        return { available: true, backend: p.backend, key_storage: p.key_storage, alg: 'ES256', thumbprint: p.thumbprint, generation: p.generation, key_files: backend.keyFiles().length };
      } catch (e) {
        return { available: false, backend: backend.kind, key_storage: backend.keyStorage, reason: e.message };
      }
    },
    publicJwk: () => ({ ...ready().jwk }),
    get keyStorage() { return backend.keyStorage; },
  };
  return signer;
}

// Remove the transition key file once custody has moved to hardware. Used by
// the re-enrollment path; the pin is rewritten by createKey on the new backend.
export function removeSoftwareKey({ home }) {
  const path = join(home, 'signer', 'device-key.pem');
  if (existsSync(path)) rmSync(path);
  return !existsSync(path);
}

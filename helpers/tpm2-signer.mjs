#!/usr/bin/env node
// A TPM 2.0 signer helper for HQ (plan §9 row 15b; protocol
// agent-bot-hq-signer/1, described in hq/signer.mjs). Experimental: HQ uses
// a helper only when the owner turns on features.hardwareSigner.
//
//   tpm2-signer.mjs [--handle 0x81010020] <status|create|sign>
//
// The key is a P-256 signing key created inside the TPM (fixedtpm,
// fixedparent, sensitivedataorigin: it was never outside the chip and cannot
// be duplicated out of it) and kept at a persistent handle in the owner
// hierarchy, so the host holds no key file and no wrapped key blob. The
// helper shells out to tpm2-tools; which TPM it talks to is tpm2-tools'
// own choice (TPM2TOOLS_TCTI, by default the kernel resource manager at
// /dev/tpmrm0), so HQ's account needs access to that device (the `tss`
// group on most distributions).
//
// Limits, stated: the owner hierarchy is used with an empty authorization,
// the key has no authorization value of its own, and anyone who can open
// the TPM device can ask the chip to sign with it. What the chip prevents is
// copying the key off the host. This helper reports key_storage=hardware
// whatever TPM answers, including a software TPM: attestation is the
// identity service's check (row 17).
import { createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROTOCOL = 'agent-bot-hq-signer/1';
const DEFAULT_HANDLE = '0x81010020';
const MAX_MESSAGE_BYTES = 32 * 1024;
const KEY_ATTRIBUTES = 'fixedtpm|fixedparent|sensitivedataorigin|userwithauth|sign';

function parse(argv) {
  const args = { handle: DEFAULT_HANDLE };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--handle') args.handle = argv[++i];
    else rest.push(argv[i]);
  }
  if (rest.length !== 1) throw new Error('usage: tpm2-signer.mjs [--handle 0x8101XXXX] <status|create|sign>');
  // Persistent handles in the owner hierarchy: 0x81000000–0x817FFFFF.
  if (!/^0x81[0-7][0-9a-fA-F]{5}$/.test(args.handle ?? '')) throw new Error('--handle is a persistent owner-hierarchy handle, 0x81000000 to 0x817fffff');
  args.handle = args.handle.toLowerCase();
  args.op = rest[0];
  return args;
}

const tpm = (tool, args) => execFileSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });

function withScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hq-tpm-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function present(handle) {
  return tpm('tpm2_getcap', ['handles-persistent']).toLowerCase().split(/\s+/).includes(handle);
}

function publicJwkOf(handle) {
  return withScratch((dir) => {
    const pem = join(dir, 'pub.pem');
    tpm('tpm2_readpublic', ['-c', handle, '-f', 'pem', '-o', pem]);
    const { kty, crv, x, y } = createPublicKey(readFileSync(pem, 'utf8')).export({ format: 'jwk' });
    if (kty !== 'EC' || crv !== 'P-256') throw new Error(`the key at ${handle} is not a P-256 key`);
    return { kty, crv, x, y };
  });
}

function create(handle, replace) {
  if (present(handle)) {
    if (!replace) throw new Error(`a key already exists at ${handle}; replacing it is a re-enrollment`);
    tpm('tpm2_evictcontrol', ['-C', 'o', '-c', handle]);
  }
  // Talking to a TPM directly (no resource manager, as with a software TPM
  // over a socket), each tool leaves its transient objects loaded and the
  // chip has room for about three. Flush them before and after. Behind the
  // kernel resource manager (/dev/tpmrm0) this flushes nothing of anyone else's.
  const flush = () => { try { tpm('tpm2_flushcontext', ['-t']); } catch { /* nothing to flush */ } };
  flush();
  withScratch((dir) => {
    const f = (n) => join(dir, n);
    tpm('tpm2_createprimary', ['-C', 'o', '-G', 'ecc256', '-c', f('primary.ctx')]);
    tpm('tpm2_create', ['-C', f('primary.ctx'), '-G', 'ecc256:ecdsa-sha256', '-a', KEY_ATTRIBUTES, '-u', f('key.pub'), '-r', f('key.priv')]);
    tpm('tpm2_load', ['-C', f('primary.ctx'), '-u', f('key.pub'), '-r', f('key.priv'), '-c', f('key.ctx')]);
    try { tpm('tpm2_evictcontrol', ['-C', 'o', '-c', f('key.ctx'), handle]); } finally { flush(); }
  });
  return publicJwkOf(handle);
}

function sign(handle, message) {
  return withScratch((dir) => {
    const msg = join(dir, 'msg.bin');
    const sig = join(dir, 'sig.bin');
    writeFileSync(msg, message, { mode: 0o600 });
    // The TPM hashes the message itself; `plain` is r || s, 32 bytes each.
    tpm('tpm2_sign', ['-c', handle, '-g', 'sha256', '-s', 'ecdsa', '-f', 'plain', '-o', sig, msg]);
    const raw = readFileSync(sig);
    if (raw.length !== 64) throw new Error(`the TPM returned a ${raw.length}-byte signature, not 64`);
    return raw.toString('base64url');
  });
}

function main() {
  const { handle, op } = parse(process.argv.slice(2));
  const text = readFileSync(0, 'utf8');
  const body = text.trim() ? JSON.parse(text) : {};
  const base = { protocol: PROTOCOL, key_storage: 'hardware' };
  if (op === 'status') {
    return present(handle) ? { ...base, present: true, jwk: publicJwkOf(handle) } : { ...base, present: false };
  }
  if (op === 'create') return { ...base, jwk: create(handle, body.replace === true) };
  if (op === 'sign') {
    if (typeof body.message !== 'string' || !/^[A-Za-z0-9_-]*$/.test(body.message)) throw new Error('sign needs a base64url message');
    const message = Buffer.from(body.message, 'base64url');
    if (message.length === 0 || message.length > MAX_MESSAGE_BYTES) throw new Error(`sign takes 1 to ${MAX_MESSAGE_BYTES} bytes`);
    return { protocol: PROTOCOL, signature: sign(handle, message) };
  }
  throw new Error(`unknown operation ${op}`);
}

try {
  process.stdout.write(JSON.stringify(main()));
} catch (e) {
  // Errors go to stderr; HQ reads the exit code and treats the signer as unavailable.
  process.stderr.write(`tpm2-signer: ${String(e.stderr ?? e.message).trim()}\n`);
  process.exitCode = 1;
}

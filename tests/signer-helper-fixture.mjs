#!/usr/bin/env node
// A stand-in for a hardware signer helper (hq/signer.mjs, protocol
// agent-bot-hq-signer/1). The "hardware" is a key file OUTSIDE HQ's state
// directory, so the tests can show HQ holds no key file of its own.
//
//   node signer-helper-fixture.mjs <keyfile> <status|create|sign>
//
// FAKE_SIGNER_MODE makes it misbehave: software (claims a software key),
// private (returns the private JWK), protocol (another protocol), wrong-key
// (signs with a different key), exit (fails), garbage (not JSON).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [keyfile, op] = process.argv.slice(2);
const mode = process.env.FAKE_SIGNER_MODE ?? 'ok';
const protocol = mode === 'protocol' ? 'agent-bot-hq-signer/9' : 'agent-bot-hq-signer/1';
const key_storage = mode === 'software' ? 'software' : 'hardware';
const body = JSON.parse(readFileSync(0, 'utf8') || '{}');
const reply = (o) => { process.stdout.write(mode === 'garbage' ? 'not json' : JSON.stringify({ protocol, ...o })); };
const jwkOf = (pem) => {
  const key = createPrivateKey(pem);
  return mode === 'private' ? key.export({ format: 'jwk' }) : createPublicKey(key).export({ format: 'jwk' });
};
const fresh = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });

if (mode === 'exit') process.exit(3);
if (op === 'status') {
  if (!existsSync(keyfile)) reply({ key_storage, present: false });
  else reply({ key_storage, present: true, jwk: jwkOf(readFileSync(keyfile, 'utf8')) });
} else if (op === 'create') {
  if (existsSync(keyfile) && body.replace !== true) process.exit(4);
  const pem = fresh();
  writeFileSync(keyfile, pem, { mode: 0o600 });
  reply({ key_storage, jwk: jwkOf(pem) });
} else if (op === 'sign') {
  const pem = mode === 'wrong-key' ? fresh() : readFileSync(keyfile, 'utf8');
  const signature = sign('sha256', Buffer.from(body.message, 'base64url'), { key: createPrivateKey(pem), dsaEncoding: 'ieee-p1363' });
  reply({ signature: signature.toString('base64url') });
} else {
  process.exit(2);
}

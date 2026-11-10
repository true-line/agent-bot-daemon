// A member's side of the broker socket, for tests that run it as another OS
// account (tests/hq-member-accounts.test.mjs). Self-contained on purpose: the
// test copies this one file somewhere that account can read, so it imports
// nothing from the repository.
//
//   node member-client.mjs '<json>'
//   { "path": "<socket>", "steps": [ { "op": "<kind>", "payload": {…} }
//                                   | { "bind": { "runtime_id", "key" } } ] }
// A `bind` step asks for a challenge and answers it with the keyed proof.
// Prints one JSON line: { "connected": true, "responses": [...] } or
// { "connected": false, "error": "<code>" }.
import { createHmac } from 'node:crypto';
import { connect } from 'node:net';

const input = JSON.parse(process.argv[2]);
const socket = connect(input.path);
const waiting = new Map();
let next = 1;
let buf = '';
const done = (out) => { process.stdout.write(`${JSON.stringify(out)}\n`); socket.destroy(); process.exit(0); };
const request = (op, payload) => new Promise((resolve) => {
  const id = next++;
  waiting.set(id, resolve);
  socket.write(`${JSON.stringify({ id, op, payload })}\n`);
});

socket.setEncoding('utf8');
socket.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  }
});
socket.once('error', (e) => done({ connected: false, error: e.code ?? String(e.message) }));
socket.once('connect', async () => {
  const responses = [];
  for (const step of input.steps ?? []) {
    if (step.bind) {
      const { runtime_id: runtimeId, key } = step.bind;
      const challenge = await request('bind.challenge', { runtime_id: runtimeId });
      if (!challenge.ok) { responses.push(challenge); continue; }
      const { nonce, context } = challenge.result;
      const proof = createHmac('sha256', Buffer.from(key, 'utf8')).update(`${context}\n${nonce}\n${runtimeId}`).digest('hex');
      responses.push(await request('bind', { runtime_id: runtimeId, proof }));
    } else {
      responses.push(await request(step.op, step.payload));
    }
  }
  done({ connected: true, responses });
});
setTimeout(() => done({ connected: false, error: 'timeout' }), 10_000).unref();

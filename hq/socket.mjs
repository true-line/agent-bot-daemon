// HQ's local sockets (plan §7.1, §7.2, §4.9): the control socket for the
// owner, the admission socket for Soul entry points, and the member broker
// socket, whose frames go to the plugin serving the broker. The auth class of a request is
// the socket it arrived on, never a field the client sends: an entry point
// cannot reach owner operations by claiming to be the owner, and the owner's
// client cannot send Hello on the control socket.
//
// Access control. All three sockets are Unix domain sockets created 0600 in HQ's
// 0700 state directory, so only HQ's own OS account can connect. Node has no
// peer-credential API (getpeereid / SO_PEERCRED), so the skeleton relies on
// the file mode. That is exact while HQ runs in the owner's account, which is
// the interim layout (D4's stated risk; plan §10.3 HQ-RISK-07). When HQ moves
// to its own account (D6) the owner's client connects from another account,
// and a peer-credential check must replace the file mode before that move (#88).
// Windows named pipes are not built yet (#89); HQ refuses to start there.
//
// Framing: one JSON object per line (NDJSON), strictly parsed.
//   request   {"id": <string|number>, "op": "<hq/v1 operation, or a broker message kind>", "payload": <any>}
//   result    {"id": ..., "ok": true, "result": <any>}
//   refusal   {"id": ..., "ok": false, "refusal": <common/v1 error response>}
//   host      {"id": ..., "ok": false, "host_refusal": {"code": "host.…", "explanation", "correlation_id"}}
// A registry code goes in `refusal`, shaped exactly as soul-contracts'
// common/v1 error response. A host code has no registry entry, so it goes in
// `host_refusal` and never in a contract record. soul-contracts does not yet
// specify the hq/v1 request envelope; this framing is HQ's until it does.
import { connect as netConnect, createServer } from 'node:net';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { HostError, REGISTRY_CODES } from '../sdk/errors.mjs';
import { redact } from '../sdk/services.mjs';
import { parseStrict } from '../sdk/wire/strict-json.mjs';

export const MAX_LINE_BYTES = 1 << 20;
const REQUEST_KEYS = new Set(['id', 'op', 'payload']);
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const clip = (s) => {
  const text = String(s ?? '').trim() || 'refused';
  return text.length > 512 ? `${text.slice(0, 509)}...` : text;
};

// Is something listening on `path`? Used to tell a stale socket file from a
// running HQ before replacing it.
function live(path) {
  return new Promise((resolve) => {
    const s = netConnect(path);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

// A Unix socket path must fit sun_path with its terminating NUL: 104 bytes
// on macOS and the BSDs, 108 on Linux. Past that, listen fails with a bare
// EINVAL, so HQ says what is wrong before it touches anything.
export function checkSocketPath(path, platform = process.platform) {
  const max = (platform === 'linux' ? 108 : 104) - 1;
  const len = Buffer.byteLength(path);
  if (len > max) throw new Error(`socket path ${path} is ${len} bytes; ${platform} allows ${max}. Choose a shorter --home`);
}

export async function listenSocket({ path, auth, dispatch, core, newSession, endSession }) {
  if (process.platform === 'win32') throw new Error('HQ on Windows needs a named pipe with an owner DACL, which is not built yet (#89)');
  checkSocketPath(path);
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error(`${path} exists and is not a socket; refusing to replace it`);
    if (await live(path)) throw new Error(`another HQ is listening on ${path}`);
    unlinkSync(path);
  }
  const conns = new Set();

  const log = (level, message, fields) => core.logs.push({ level, plugin: 'hq', at: core.clock.now(), ...redact(core, { message, fields }) });

  function respondError(e, id, op, payload) {
    const correlation = `corr_${core.random.hex(8)}`;
    if (e instanceof HostError && e.code in REGISTRY_CODES) {
      const refusal = { error: e.code, explanation: clip(redact(core, e.message)), correlation_id: correlation };
      if (typeof payload?.request_id === 'string' && REQUEST_ID.test(payload.request_id)) refusal.request_id = payload.request_id;
      log('warn', `refused ${op ?? '?'}: ${e.code}`, { correlation_id: correlation, auth });
      return { id, ok: false, refusal };
    }
    if (e instanceof HostError) {
      log('warn', `refused ${op ?? '?'}: ${e.code}`, { correlation_id: correlation, auth });
      return { id, ok: false, host_refusal: { code: e.code, explanation: clip(redact(core, e.message)), correlation_id: correlation } };
    }
    log('error', `internal error in ${op ?? '?'}: ${e?.message ?? e}`, { correlation_id: correlation, auth });
    return { id, ok: false, host_refusal: { code: 'host.internal', explanation: `internal error; the HQ log has correlation ${correlation}`, correlation_id: correlation } };
  }

  async function handle(line, session) {
    let req;
    try {
      req = parseStrict(line);
    } catch (e) {
      return respondError(new HostError('host.invalid_json', `request is not strict JSON: ${e.message}`), null);
    }
    if (!req || typeof req !== 'object' || Array.isArray(req)) return respondError(new HostError('host.invalid_request', 'a request is a JSON object'), null);
    const id = typeof req.id === 'string' || Number.isSafeInteger(req.id) ? req.id : null;
    const extra = Object.keys(req).filter((k) => !REQUEST_KEYS.has(k));
    if (extra.length) return respondError(new HostError('host.invalid_request', `unknown request field ${extra[0]}`), id);
    if (typeof req.op !== 'string') return respondError(new HostError('host.invalid_request', 'a request names its op'), id);
    try {
      const result = await dispatch(req.op, { auth, payload: req.payload, session });
      return { id, ok: true, result: result === undefined ? null : result };
    } catch (e) {
      return respondError(e, id, req.op, req.payload);
    }
  }

  const server = createServer((socket) => {
    conns.add(socket);
    const session = newSession();
    let buf = '';
    let queue = Promise.resolve();
    const send = (obj) => { if (!socket.destroyed) socket.write(`${JSON.stringify(obj)}\n`); };
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      if (Buffer.byteLength(buf) > MAX_LINE_BYTES && !buf.includes('\n')) {
        send(respondError(new HostError('host.invalid_request', `request line exceeds ${MAX_LINE_BYTES} bytes`), null));
        socket.end();
        buf = '';
        return;
      }
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        queue = queue.then(() => handle(line, session)).then(send, (e) => send(respondError(e, null)));
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { conns.delete(socket); endSession(session); });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  chmodSync(path, 0o600);

  return {
    path,
    auth,
    connections: () => conns.size,
    close: () => new Promise((resolve) => {
      for (const s of conns) s.destroy();
      server.close(() => { try { unlinkSync(path); } catch { /* already gone */ } resolve(); });
    }),
  };
}

// A minimal client for the CLI and the tests: request(op, payload) resolves
// with the response object, matched by id.
export function connectSocket(path) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(path);
    const pending = new Map();
    let next = 1;
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        const key = pending.has(msg.id) ? msg.id : null;
        const waiter = pending.get(key);
        if (waiter) { pending.delete(key); waiter(msg); }
      }
    });
    const fail = (e) => { for (const w of pending.values()) w({ ok: false, transport_error: String(e?.message ?? e) }); pending.clear(); };
    socket.on('close', () => fail(new Error('connection closed')));
    socket.once('error', (e) => { reject(e); fail(e); });
    socket.once('connect', () => resolve({
      request(op, payload) {
        const id = next++;
        return new Promise((res) => { pending.set(id, res); socket.write(`${JSON.stringify({ id, op, ...(payload === undefined ? {} : { payload }) })}\n`); });
      },
      // Send raw text (tests of the framing); resolves with the next response.
      raw(text) {
        return new Promise((res) => { pending.set(null, res); socket.write(text); });
      },
      close: () => new Promise((res) => {
        if (socket.closed || socket.destroyed) { res(); return; }
        socket.once('close', res);
        socket.end();
      }),
    }));
  });
}

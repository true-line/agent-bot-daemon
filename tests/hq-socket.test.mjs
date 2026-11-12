// HQ's local sockets and owner sessions (hq/socket.mjs, hq/hq.mjs; plan §7.1,
// §7.2): status over the control socket, auth by socket, strict framing,
// refusal shapes, owner sessions in the store, and restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '../sdk/wire/schema.mjs';
import { createCore } from '../sdk/services.mjs';
import { createHQ } from '../hq/hq.mjs';
import { checkSocketPath, connectSocket, listenSocket, MAX_LINE_BYTES, takeover } from '../hq/socket.mjs';
import { errorResponseSchema, hello, schemas, startHQ, tempHome } from './hq-harness.mjs';

test('status over the control socket reports managed-cooperative honestly, with reasons and the legacy daemon', async () => {
  const t = await startHQ();
  try {
    for (const p of [t.hq.paths.control, t.hq.paths.admission]) assert.equal(statSync(p).mode & 0o777, 0o600, p);
    const owner = await t.owner();
    const res = await owner.request('status');
    assert.equal(res.ok, true);
    const s = res.result;
    assert.equal(s.mode, 'running');
    assert.equal(s.admissions, true);
    assert.equal(s.profile, 'managed-cooperative');
    assert.match(s.hq.profileReasons.join('\n'), /not _agent-bot-hq/);
    assert.equal(s.identity.device, 'enrolled');
    assert.equal(s.identity.link, 'not-linked');
    assert.equal(s.legacy.state, 'running');
    assert.equal(s.hq.ownerSessions, 1);
    assert.match(s.hq.sockets.access, /no peer-credential check/);
    assert.deepEqual(s.plugins.map((p) => [p.name, p.state]), [['hq-admission', 'running'], ['hq-tasks', 'running']]);
  } finally { await t.done(); }
});

test('the auth class is the socket: no entry-point operation on the control socket, no owner operation on the admission socket', async () => {
  const t = await startHQ();
  try {
    const owner = await t.owner();
    const entry = await t.entry();
    const a = await owner.request('Hello', hello());
    assert.equal(a.host_refusal.code, 'host.auth_mismatch');
    const b = await entry.request('status');
    assert.equal(b.host_refusal.code, 'host.auth_mismatch');
    const c = await entry.request('souls.list');
    assert.equal(c.host_refusal.code, 'host.auth_mismatch');
    const d = await owner.request('no.such.op');
    assert.equal(d.host_refusal.code, 'host.unknown_operation');
  } finally { await t.done(); }
});

test('framing: strict JSON, known fields only, bounded lines', async () => {
  const t = await startHQ();
  try {
    const owner = await t.owner();
    assert.equal((await owner.raw('{"op": "status",\n')).host_refusal.code, 'host.invalid_json');
    assert.equal((await owner.raw('{"op": "status", "op": "status"}\n')).host_refusal.code, 'host.invalid_json');
    assert.equal((await owner.raw('[1]\n')).host_refusal.code, 'host.invalid_request');
    assert.equal((await owner.raw('{"id": 7, "op": "status", "auth": "owner"}\n')).host_refusal.code, 'host.invalid_request');
    assert.equal((await owner.raw('{"id": 8}\n')).host_refusal.code, 'host.invalid_request');
    const ok = await owner.raw('{"id": "x1", "op": "status"}\n');
    assert.equal(ok.id, 'x1');
    assert.equal(ok.ok, true);

    const big = await t.owner();
    const res = await big.raw('x'.repeat(MAX_LINE_BYTES + 10));
    assert.equal(res.host_refusal.code, 'host.invalid_request');
    assert.match(res.host_refusal.explanation, /exceeds/);

    // The same line with its newline, so the limit is met on the line itself
    // rather than on an unterminated buffer; it never reaches dispatch.
    for (const connect of [t.owner, t.entry, t.member]) {
      const c = await connect();
      const r = await c.raw(`{"id":1,"op":"status","payload":"${'x'.repeat(MAX_LINE_BYTES)}"}\n`);
      assert.equal(r.host_refusal.code, 'host.invalid_request');
      assert.match(r.host_refusal.explanation, /exceeds/);
    }
  } finally { await t.done(); }
});

test('a registry refusal is exactly a common/v1 error response; a host refusal stays out of it', async () => {
  const t = await startHQ({ config: { acceptedDefinitions: {} } });
  try {
    const entry = await t.entry();
    const res = await entry.request('Hello', hello());
    assert.equal(res.ok, false);
    assert.equal(res.refusal.error, 'definition_not_accepted');
    assert.equal(res.refusal.request_id, 'req_0001');
    assert.deepEqual(validate(errorResponseSchema, res.refusal), []);
    assert.equal(res.host_refusal, undefined);

    const host = await entry.request('Equip', { runtime_id: 'rt_nope' });
    assert.equal(host.refusal, undefined);
    assert.equal(host.host_refusal.code, 'host.invalid_request');
    assert.match(host.host_refusal.correlation_id, /^corr_[0-9a-f]{16}$/);
    assert.ok(t.hq.core.logs.some((l) => l.fields?.correlation_id === host.host_refusal.correlation_id));
  } finally { await t.done(); }
});

test('owner sessions are recorded in the store, closed on disconnect, and closed by a restart after a crash', async () => {
  const home = tempHome();
  const t = await startHQ({ home });
  const owner = await t.owner();
  await owner.request('status');
  const table = () => [...t.hq.core.tables.get('hq\0sessions').entries()];
  assert.equal(table().length, 1);
  const [id, s] = table()[0];
  assert.match(id, /^os_[0-9a-f]{24}$/);
  assert.equal(s.auth, 'owner');
  assert.equal(s.closed_at, undefined);
  await owner.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(table()[0][1].closed_at);
  await t.done({ keep: true });

  // Simulate a crash: a session left open on disk is closed at the next start.
  const disk = JSON.parse(readFileSync(join(home, 'store.json'), 'utf8'));
  const sessions = disk.tables.find(([k]) => k === 'hq\0sessions');
  sessions[1].push(['os_crashed', { opened_at: 1, account: 'user', auth: 'owner' }]);
  writeFileSync(join(home, 'store.json'), JSON.stringify(disk), { mode: 0o600 });
  const again = await startHQ({ home });
  try {
    assert.equal(again.hq.core.tables.get('hq\0sessions').get('os_crashed').closed_by, 'restart');
  } finally { await again.done(); }
});

test('admissions survive a restart; receipts record start and stop', async () => {
  const home = tempHome();
  const t = await startHQ({ home });
  const entry = await t.entry();
  const first = await entry.request('Hello', hello());
  assert.equal(first.ok, true);
  await t.done({ keep: true });

  const again = await startHQ({ home });
  try {
    const owner = await again.owner();
    const souls = (await owner.request('souls.list')).result;
    assert.equal(souls.length, 1);
    assert.equal(souls[0].installation_epoch, 1);
    const kinds = again.hq.core.receipts.map((r) => r.kind);
    assert.deepEqual(kinds.filter((k) => k.startsWith('hq.')).slice(0, 4), ['hq.started', 'hq.admission', 'hq.stopped', 'hq.started']);
    assert.ok(again.hq.core.receipts.every((r) => r.profile === 'managed-cooperative'));
  } finally { await again.done(); }
});

test('a second HQ on the same directory is refused, and so is a non-socket in the socket path', async () => {
  const t = await startHQ();
  try {
    const twin = createHQ({ home: t.home, schemas, config: {}, signer: { deviceStatus: () => 'enrolled' }, legacy: { tick: async () => ({}), report: () => ({}) }, account: 'user', platform: 'darwin' });
    await assert.rejects(twin.start(), /another HQ is listening/);
  } finally { await t.done(); }

  const home = tempHome();
  try {
    writeFileSync(join(home, 'control.sock'), 'not a socket');
    const hq = createHQ({ home, schemas, config: {}, signer: { deviceStatus: () => 'enrolled' }, legacy: { tick: async () => ({}), report: () => ({}) }, account: 'user', platform: 'darwin' });
    await assert.rejects(hq.start(), /is not a socket/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('config is validated and must not be writable by others; no plugin may be called hq', async () => {
  const home = tempHome();
  try {
    const base = { home, schemas, signer: { deviceStatus: () => 'enrolled' }, legacy: { tick: async () => ({}), report: () => ({}) }, account: 'user', platform: 'darwin' };
    await assert.rejects(createHQ({ ...base, config: { surprise: 1 } }).start(), /unknown key surprise/);
    await assert.rejects(createHQ({ ...base, config: { acceptedDefinitions: { nope: [] } } }).start(), /not a Soul ID/);
    await assert.rejects(createHQ({ ...base, config: { leaseTtlMs: 5 } }).start(), /leaseTtlMs/);
    writeFileSync(join(home, 'config.json'), '{}');
    chmodSync(join(home, 'config.json'), 0o666);
    await assert.rejects(createHQ(base).start(), /writable by group or others/);
    assert.throws(() => createHQ({ ...base, plugins: [{ name: 'hq' }] }), /no plugin may be named hq/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a socket path too long for sun_path is refused with a reason, before HQ writes anything', async () => {
  assert.throws(() => checkSocketPath(`/${'x'.repeat(103)}`, 'darwin'), /allows 103/);
  checkSocketPath(`/${'x'.repeat(102)}`, 'darwin');
  checkSocketPath(`/${'x'.repeat(106)}`, 'linux');
  assert.throws(() => checkSocketPath(`/${'x'.repeat(107)}`, 'linux'), /allows 107/);
  const base = tempHome();
  const home = join(base, 'h'.repeat(Math.max(1, 120 - base.length)));
  try {
    await assert.rejects(startHQ({ home }), /Choose a shorter --home/);
    assert.equal(existsSync(join(home, 'store.json')), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('takeover: only a listener that allows it, only the first request, and only with nothing after it', async () => {
  const home = tempHome();
  const core = createCore();
  const calls = [];
  let gate;
  // Every op answers with a takeover that echoes the stream back; `slow`
  // waits for the test first.
  const dispatch = async (op, meta) => {
    calls.push([op, meta.takeover === true]);
    if (op === 'plain') return { plain: true };
    if (op === 'slow') await new Promise((r) => { gate = r; });
    return takeover({ taken: op }, {
      open: () => { calls.push(['open', op]); return (socket) => socket.pipe(socket); },
      cancel: () => { calls.push(['cancel', op]); },
    });
  };
  const listen = (name, canTakeOver) => listenSocket({ path: join(home, name), auth: 'entry-point', dispatch, core, newSession: () => 's', endSession: () => {}, ...(canTakeOver ? { takeover: true } : {}) });
  const closed = await listen('closed.sock', false);
  const open = await listen('open.sock', true);
  try {
    // A listener without it: an internal error, cancelled, never opened.
    const c = await connectSocket(closed.path);
    assert.equal((await c.request('grab')).host_refusal.code, 'host.internal');
    assert.equal((await c.request('plain')).ok, true, 'the connection still parses requests');
    await c.close();
    assert.deepEqual(calls.splice(0), [['grab', false], ['cancel', 'grab'], ['plain', false]]);
    // Not the first request: refused and cancelled.
    const d = await connectSocket(open.path);
    assert.equal((await d.request('plain')).ok, true);
    assert.equal((await d.request('grab')).host_refusal.code, 'host.invalid_request');
    await d.close();
    assert.deepEqual(calls.splice(0), [['plain', true], ['grab', false], ['cancel', 'grab']]);
    // The first request, alone: answered, then the bytes are the new owner's.
    const e = await connectSocket(open.path);
    assert.deepEqual((await e.request('grab')).result, { taken: 'grab' });
    assert.deepEqual(await e.raw('{"id":7,"op":"plain"}\n'), { id: 7, op: 'plain' }, 'echoed, not dispatched');
    await e.close();
    assert.deepEqual(calls.splice(0), [['grab', true], ['open', 'grab']]);
    // An oversized buffer while the first request is in flight refuses the
    // connection, and the takeover that follows is not honoured.
    const f = await connectSocket(open.path);
    const refusal = f.raw(`{"id":1,"op":"slow"}\n${'x'.repeat(MAX_LINE_BYTES + 1)}`);
    assert.match((await refusal).host_refusal.explanation, /exceeds/);
    gate();
    await new Promise((r) => setTimeout(r, 20));
    await f.close();
    assert.deepEqual(calls.splice(0), [['slow', true], ['cancel', 'slow']]);
  } finally {
    await closed.close();
    await open.close();
    rmSync(home, { recursive: true, force: true });
  }
});

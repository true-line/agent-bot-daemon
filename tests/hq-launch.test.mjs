// HQ-controlled agent launch (hq/launch.mjs; plan §9 row 16b, T02).
//
// These run everywhere: sudo is an injected stand-in (tests/hq-harness.mjs
// fakeSudo) and the harness accounts do not exist. They prove what HQ asks
// for, in what order it refuses, how the attached connection behaves, and
// which process group HQ signals (the one the wrapper reports), and when it
// declares a launch uncontained. What they cannot show is the kernel keeping an agent out of
// HQ's state; that is tests/hq-launch-real.test.mjs, on real accounts in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, testClock } from '../sdk/services.mjs';
import { agentArgv, AGENT_PATH, createLauncher, groupArgv, KILL_WAIT_MS, LAUNCH_SHELL, MAX_PENDING, PGID_MARKER, STDERR_LINE, STDERR_LINES } from '../hq/launch.mjs';
import { attachTo, DIGEST, fakeSudo, fakeTimers, harnessLayout, helloOn, SOUL, startHQ } from './hq-harness.mjs';

const A = 'hqm_a';
const B = 'hqm_b';
const NODE = '/usr/bin/node';
const ENV = { AGENT_BOT_SOULS_SOCKET: '/run/souls/s.sock', AGENT_BOT_SOULS_MEMBER_TOKEN: 'member-token-not-for-receipts', AGENT_BOT_SOULS_MEMBER_ID: 'm_lead', AGENT_BOT_SOULS_ROLE: 'lead' };
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, what, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (fn()) return; await tick(); }
  assert.fail(`timed out waiting for ${what}`);
}

// The lead runs on adapter-a and the specialist on adapter-b; `accounts`
// maps adapters to harness accounts.
// `sudo` passes options to fakeSudo (pty, report, before).
async function setup({ accounts = { 'adapter-a': A, 'adapter-b': B }, rule = true, refuse, harnesses = true, platform = 'linux', home, layout, timers, graceMs, sudo: sudoOptions = {} } = {}) {
  const l = layout ?? harnessLayout();
  const sudo = fakeSudo({ rule, ...(refuse ? { refuse } : {}), ...sudoOptions });
  const t = await startHQ({
    ...(home ? { home } : {}),
    platform,
    accounts: l.resolve,
    harnessLstat: l.lstat,
    launch: { spawn: sudo.spawn, ...(timers ? { timers } : {}), ...(graceMs ? { graceMs } : {}) },
    config: { acceptedDefinitions: { [SOUL]: [DIGEST] }, ...(harnesses ? { harnesses: { dir: l.dir, accounts } } : {}) },
  });
  // The entry point's connection: it sent Hello, so it owns the runtimes.
  const ep = await t.entry();
  const admitted = (await ep.request('Hello', helloOn('adapter-a', 'adapter-b'))).result;
  const rt = (role) => admitted.admitted_runtimes.find((a) => a.role === role);
  const endpoint = (account) => t.status.hq.sockets.harnesses.find((m) => m.account === account).path;
  const receipts = (kind) => t.hq.core.receipts.filter((r) => r.kind === kind);
  const launch = (over = {}, conn = ep) => conn.request('launch', { runtime_id: rt('lead').runtime_id, command: [NODE, 'adapter.mjs', '--acp'], env: ENV, ...over });
  // launch, then attach on a new connection.
  const started = async (over, opts) => {
    const res = await launch(over);
    assert.equal(res.ok, true, JSON.stringify(res));
    const conn = await attachTo(t.hq.paths.admission, { launch_id: res.result.launch_id, attach: res.result.attach }, opts);
    assert.equal(conn.answer.ok, true, JSON.stringify(conn.answer));
    return { ...res.result, conn, child: sudo.agents.at(-1) };
  };
  return { ...t, l, sudo, ep, admitted, rt, get spec() { return { runtime_id: rt('specialist').runtime_id, env: {} }; }, endpoint, receipts, launch, started, cleanup: async (opts) => { await t.done(opts); if (!opts?.keep && !layout) l.remove(); } };
}
const refused = (res, code) => {
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.refusal?.error ?? res.host_refusal?.code, code, JSON.stringify(res));
  return res.refusal?.explanation ?? res.host_refusal?.explanation;
};

test('HQ asks sudo for exactly one form: the harness account, the fixed shell with soul and agent as arguments, detached, the allowed env, its endpoint, a fixed PATH', async () => {
  process.env.HQ_LAUNCH_CANARY = 'canary-from-hqs-environment';
  const t = await setup();
  try {
    // Readiness: one probe per account, as that account, of /bin/true.
    assert.deepEqual(t.sudo.probes().sort(), [['-n', '-u', A, '--', '/bin/true'], ['-n', '-u', B, '--', '/bin/true']]);
    const { child, launch_id: launchId } = await t.started();
    assert.match(launchId, /^ln_[0-9a-f]{24}$/);
    assert.equal(child.file, '/usr/bin/sudo');
    assert.deepEqual(child.args, ['-n', '-H', '-u', A, '--', '/bin/sh', '-c', LAUNCH_SHELL, 'sh', SOUL, 'm_lead', NODE, 'adapter.mjs', '--acp']);
    assert.equal(LAUNCH_SHELL, 'read -r _ _ _ _ g _ 2>/dev/null </proc/self/stat && printf \'agent-bot-hq-launch pgid %s\\n\' "$g" >&2; umask 077 && d="$HOME/.agent-bot-hq/souls/$1/$2" && mkdir -p "$d" && chmod 0700 "$d" && cd "$d" && shift 2 && exec "$@"');
    assert.deepEqual(child.opts.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(child.opts.cwd, '/');
    assert.equal(child.opts.detached, true, 'its own session and process group');
    // Nothing of HQ's own environment (the canary above is in it): only the
    // four, HQ's broker path, PATH.
    assert.deepEqual(child.opts.env, { ...ENV, AGENT_BOT_SOULS_BROKER: t.endpoint(A), PATH: AGENT_PATH });
    assert.equal(Object.getPrototypeOf(child.opts.env), Object.prototype);
    // The specialist's harness is another account; its launch goes there.
    await t.started(t.spec);
    assert.deepEqual(t.sudo.agents.at(-1).args.slice(0, 11), ['-n', '-H', '-u', B, '--', '/bin/sh', '-c', LAUNCH_SHELL, 'sh', SOUL, 'm_spec']);
    assert.equal(t.sudo.agents.at(-1).opts.env.AGENT_BOT_SOULS_BROKER, t.endpoint(B));
    assert.deepEqual(t.receipts('hq.launch').map((r) => [r.member_id, r.adapter_id, r.account]), [['m_lead', 'adapter-a', A], ['m_spec', 'adapter-b', B]]);
  } finally { delete process.env.HQ_LAUNCH_CANARY; await t.cleanup(); }
});

test('the launch shell, run by /bin/sh here: the group marker first, a 0700 directory per Soul and agent under HOME, the command as arguments, nothing interpolated', () => {
  const home = mkdtempSync(join(tmpdir(), 'hq-shell-'));
  try {
    const marker = join(home, 'interpolated');
    const run = (memberId) => {
      const r = spawnSync('/bin/sh', ['-c', LAUNCH_SHELL, 'sh', SOUL, memberId, '/bin/sh', '-c', 'pwd; umask; printf "%s\\n" "$1"', 'x', `$(touch ${marker})`], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      // With /proc (Linux), stderr is exactly the marker naming this shell's
      // group; without it (macOS) the read fails silently and the rest runs.
      if (process.platform === 'linux') assert.match(r.stderr, new RegExp(`^${PGID_MARKER} [1-9][0-9]*\\n$`));
      else assert.equal(r.stderr, '');
      return r.stdout.split('\n');
    };
    const [cwd, mask, arg] = run('m_lead');
    const dir = join(home, '.agent-bot-hq', 'souls', SOUL, 'm_lead');
    assert.equal(cwd.replace(/^\/private/, ''), dir.replace(/^\/private/, ''));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const parent of [join(home, '.agent-bot-hq'), join(home, '.agent-bot-hq', 'souls'), join(home, '.agent-bot-hq', 'souls', SOUL)]) assert.equal(statSync(parent).mode & 0o777, 0o700, parent);
    assert.equal(mask, '0077');
    assert.equal(arg, `$(touch ${marker})`);
    assert.throws(() => statSync(marker), /ENOENT/, 'the argument was never evaluated');
    // A directory that exists with looser bits is made 0700 again.
    execFileSync('chmod', ['0755', dir]);
    run('m_lead');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally { rmSync(home, { recursive: true, force: true }); }
  // Only pattern-checked IDs reach it.
  assert.throws(() => agentArgv(A, SOUL, '../x', [NODE]), /valid soul_id and member_id/);
  assert.throws(() => agentArgv(A, 'agent_x', 'm_lead', [NODE]), /valid soul_id and member_id/);
});

test('signals: the TERM and KILL to one process group, and nothing else; the group ID is a positive integer above 1', () => {
  assert.deepEqual(groupArgv(A, 'TERM', 4242), ['-n', '-u', A, '--', '/bin/sh', '-c', 'kill -TERM -4242 2>/dev/null; exit 0']);
  assert.deepEqual(groupArgv(A, 'KILL', 4242), ['-n', '-u', A, '--', '/bin/sh', '-c', 'kill -KILL -4242 2>/dev/null; exit 0']);
  for (const bad of [1, 0, -5, 1.5, '4242', '1; rm -rf ~', Number.MAX_SAFE_INTEGER + 2, undefined]) assert.throws(() => groupArgv(A, 'KILL', bad), /not a process group ID/, String(bad));
  assert.throws(() => groupArgv(A, 'HUP', 4242), /no group signal/);
});

test('launch refuses in order, before anything is reserved or started', async () => {
  const t = await setup({ accounts: { 'adapter-a': A } });
  try {
    const lead = t.rt('lead').runtime_id;
    const bad = { command: ['relative/node'] };
    // 1. A connection that does not own the runtime, even with a bad command.
    const other = await t.entry();
    refused(await t.launch(bad, other), 'caller_mismatch');
    refused(await other.request('launch', { runtime_id: 'rt_nope', command: [NODE] }), 'host.invalid_request');
    // 3. An agent whose harness has no account, even with a bad command.
    assert.match(refused(await t.launch({ ...t.spec, ...bad }), 'host.launch_unavailable'), /harness of agent m_spec .* \(adapter adapter-b\) has no account in HQ's config/);
    // 5. Already reserved or running, even with a bad command.
    const first = await t.launch();
    assert.equal(first.ok, true);
    assert.match(refused(await t.launch(bad), 'host.launch_busy'), /already has a launch \(reserved\)/);
    // 6. The payload, last.
    const s = await setup({ accounts: { 'adapter-a': A }, layout: harnessLayout() });
    try {
      const cases = [
        [{ command: [] }, /1 to 64/], [{ command: 'node' }, /1 to 64/], [{ command: Array(65).fill(NODE) }, /1 to 64/],
        [{ command: ['node'] }, /absolute path/], [{ command: [NODE, 'a\0b'] }, /no NUL/], [{ command: [NODE, 7] }, /no NUL/], [{ command: [NODE, 'x'.repeat(4097)] }, /at most 4096/],
        [{ env: { PATH: '/tmp' } }, /not one a launch may set/], [{ env: { LD_PRELOAD: '/tmp/x.so' } }, /not one a launch may set/],
        [{ env: { AGENT_BOT_SOULS_BROKER: '/tmp/other.sock' } }, /set by HQ to the harness account's own endpoint/],
        [{ env: { AGENT_BOT_SOULS_ROLE: 'lead\nX=1' } }, /no NUL or newline/], [{ env: { AGENT_BOT_SOULS_ROLE: 3 } }, /no NUL or newline/], [{ env: [] }, /maps variable names/],
        [{ extra: 1 }, /launch takes/], [{ runtime_id: 7 }, /launch takes/],
      ];
      for (const [over, why] of cases) assert.match(refused(await s.launch(over), 'host.invalid_request'), why, JSON.stringify(over).slice(0, 80));
      assert.equal(s.sudo.agents.length, 0);
      assert.equal((await s.launch()).ok, true, 'the refusals reserved nothing');
    } finally { await s.cleanup(); }
    assert.equal(t.sudo.agents.length, 0, 'nothing was started');
    const codes = t.receipts('hq.launch.refused').map((r) => r.code);
    assert.deepEqual(codes, ['caller_mismatch', 'host.invalid_request', 'host.launch_unavailable', 'host.launch_busy']);
    assert.ok(t.receipts('hq.launch.refused').every((r) => r.op === 'launch' && !('command' in r) && !('env' in r)));
    assert.equal(t.receipts('hq.launch.refused')[0].runtime_id, lead);
  } finally { await t.cleanup(); }
});

test('launch is refused without harnesses, off Linux, and for an account the rule does not cover', async () => {
  for (const [opts, why] of [
    [{ harnesses: false }, /no harnesses in HQ's config/],
    [{ rule: false }, /launch is not available for account hqm_a: the provisioner's rule does not let HQ start hqm_a \(sudo -n -u hqm_a exited 1: sudo: a password is required\)/],
  ]) {
    const t = await setup(opts);
    try {
      assert.match(refused(await t.launch(), 'host.launch_unavailable'), why);
      assert.equal(t.sudo.agents.length, 0);
    } finally { await t.cleanup(); }
  }
  // Off Linux there are no harness accounts at all: HQ refuses the config at
  // start (hq/harness-accounts.mjs), and without them every launch is refused.
  const t = await setup({ harnesses: false, platform: 'darwin' });
  try {
    assert.match(refused(await t.launch(), 'host.launch_unavailable'), /this host is darwin/);
    assert.equal(t.sudo.probes().length, 0, 'no sudo off Linux');
  } finally { await t.cleanup(); }
});

test('a reservation is single use, lasts 30 seconds, and does not survive a restart', async () => {
  const t = await setup();
  try {
    const attach = (r, token = r.attach) => attachTo(t.hq.paths.admission, { launch_id: r.launch_id, attach: token });
    // Expired.
    const late = (await t.launch()).result;
    t.clock.advance(30_000);
    refused((await attach(late)).answer, 'caller_mismatch');
    // A wrong token spends it: the right one no longer attaches.
    const one = (await t.launch()).result;
    refused((await attach(one, 'f'.repeat(64))).answer, 'caller_mismatch');
    refused((await attach(one)).answer, 'caller_mismatch');
    // A used token does not attach twice.
    const two = (await t.launch()).result;
    assert.equal((await attach(two)).answer.ok, true);
    refused((await attach(two)).answer, 'caller_mismatch');
    refused((await attachTo(t.hq.paths.admission, { launch_id: two.launch_id })).answer, 'host.invalid_request');
    assert.equal(t.sudo.agents.length, 1);
    // No token or environment value in any receipt or log.
    const disk = JSON.stringify([t.hq.core.receipts, t.hq.core.logs]);
    for (const secret of [late.attach, one.attach, two.attach, ENV.AGENT_BOT_SOULS_MEMBER_TOKEN, ENV.AGENT_BOT_SOULS_SOCKET]) assert.ok(!disk.includes(secret), 'no token or env value is kept');
  } finally { await t.cleanup(); }

  const first = await setup();
  const r = (await first.launch()).result;
  const { home, l } = first;
  await first.cleanup({ keep: true });
  const again = await setup({ home, layout: l });
  try {
    refused((await attachTo(again.hq.paths.admission, { launch_id: r.launch_id, attach: r.attach })).answer, 'caller_mismatch');
    assert.deepEqual(again.status.hq.launch.launches, []);
  } finally { await again.cleanup(); l.remove(); }
});

test('the number of reservations waiting for attach is bounded', async () => {
  const n = MAX_PENDING + 1;
  const endpoints = Array.from({ length: n }, (_, i) => ({ account: `m${i}`, uid: 70000 + i, path: `/run/m${i}/broker.sock` }));
  const core = createCore({ clock: testClock() });
  const sudo = fakeSudo();
  const launcher = createLauncher({
    core, platform: 'linux', configured: true, spawn: sudo.spawn,
    harnesses: { endpoints, accountOf: (adapter) => endpoints.find((e) => e.account === adapter) },
    withLiveRuntime: async (runtimeId, caller, fn) => fn({ soul_id: SOUL, member_id: runtimeId, adapter_id: runtimeId, harness_uid: endpoints.find((e) => e.account === runtimeId).uid }),
  });
  await launcher.probe();
  const meta = { auth: 'entry-point', session: 'ep_x' };
  for (let i = 0; i < MAX_PENDING; i++) await launcher.dispatch('launch', { ...meta, payload: { runtime_id: `m${i}`, command: [NODE] } });
  await assert.rejects(launcher.dispatch('launch', { ...meta, payload: { runtime_id: `m${MAX_PENDING}`, command: [NODE] } }), { code: 'host.launch_busy' });
  // They expire, and then there is room.
  core.clock.advance(30_000);
  assert.ok(await launcher.dispatch('launch', { ...meta, payload: { runtime_id: `m${MAX_PENDING}`, command: [NODE] } }));
  await assert.rejects(launcher.dispatch('launch', { auth: 'owner', session: 'os_x', payload: {} }), { code: 'host.auth_mismatch' });
});

test('attach is the first and only request on its connection; bytes after it refuse it', async () => {
  const t = await setup();
  try {
    // Bytes in the same write as the request: refused, closed, nothing started, slot free.
    const r = (await t.launch()).result;
    const greedy = await attachTo(t.hq.paths.admission, { launch_id: r.launch_id, attach: r.attach }, { trailing: '{"jsonrpc":"2.0"}\n' });
    assert.match(refused(greedy.answer, 'host.invalid_request'), /send nothing until HQ answers/);
    await greedy.closed;
    assert.equal(greedy.output(), '', 'the trailing bytes were neither parsed nor answered');
    assert.equal(t.sudo.agents.length, 0);
    assert.equal(t.receipts('hq.launch').length, 0);
    // Not the first request: refused, and the reservation is not spent.
    const s = (await t.launch()).result;
    const late = await t.entry();
    await late.request('Admit', { request_id: 'req_0001' });
    assert.match(refused(await late.request('launch.attach', { launch_id: s.launch_id, attach: s.attach }), 'host.invalid_request'), /first and only request/);
    const conn = await attachTo(t.hq.paths.admission, { launch_id: s.launch_id, attach: s.attach });
    assert.equal(conn.answer.ok, true);
    assert.deepEqual(conn.answer.result, { launch_id: s.launch_id });
  } finally { await t.cleanup(); }
});

test('the attached connection is the agent\'s stdin and stdout, in order and complete', async () => {
  const t = await setup();
  try {
    const { conn, child } = await t.started();
    const got = [];
    child.stdin.on('data', (d) => got.push(d));
    // Something that looks like a request is the agent's, not HQ's.
    const big = `${JSON.stringify({ id: 9, op: 'status' })}\n${'x'.repeat(1 << 20)}\n`;
    conn.write(big);
    await until(() => Buffer.concat(got).length === Buffer.byteLength(big), 'the agent to read all of stdin');
    assert.equal(Buffer.concat(got).toString(), big);
    child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    assert.equal(await conn.line(), '{"jsonrpc":"2.0","id":1,"result":{}}');
  } finally { await t.cleanup(); }
});

test('an agent that exits ends its connection after its last output, and its group gets the KILL', async () => {
  const t = await setup();
  try {
    const { conn, child, launch_id: launchId } = await t.started();
    child.stdout.write('last words\n');
    child.exit(3);
    assert.equal(await conn.closed, 'last words\n');
    await until(() => t.receipts('hq.launch.exited').length === 1, 'the exit receipt');
    assert.deepEqual(t.sudo.signals(), [`${A} kill -KILL -${child.pgid}`]);
    const [r] = t.receipts('hq.launch.exited');
    assert.deepEqual([r.launch_id, r.exit_code, r.signal, r.reason, r.contained], [launchId, 3, null, 'exited', true]);
    assert.deepEqual(Object.keys(r).filter((k) => !['seq', 'at', 'profile', 'plugin', 'kind'].includes(k)).sort(), ['account', 'contained', 'exit_code', 'launch_id', 'member_id', 'reason', 'signal', 'soul_id'], 'no process group in the receipt');
    // The slot is free again.
    assert.equal((await t.launch()).ok, true);
  } finally { await t.cleanup(); }
});

test('closing the attached connection stops the agent', async () => {
  const t = await setup();
  try {
    const { conn, child } = await t.started();
    conn.end();
    await until(() => t.receipts('hq.launch.exited').length === 1, 'the exit receipt');
    assert.equal(child.stdin.writableEnded, true);
    assert.deepEqual(t.sudo.signals(), [`${A} kill -TERM -${child.pgid}`, `${A} kill -KILL -${child.pgid}`]);
    const [r] = t.receipts('hq.launch.exited');
    assert.deepEqual([r.reason, r.signal, r.contained], ['attach-closed', 'SIGTERM', true]);
  } finally { await t.cleanup(); }
});

test('stop: stdin closed, TERM to the launch\'s group, KILL after the grace period; idempotent, and only for the launching connection', async () => {
  const timers = fakeTimers();
  const t = await setup({ timers, graceMs: 2000 });
  try {
    const { child, launch_id: launchId } = await t.started();
    child.stubborn = true; // ignores TERM and stdin EOF
    refused(await (await t.entry()).request('launch.stop', { launch_id: launchId }), 'caller_mismatch');
    refused(await t.ep.request('launch.stop', { runtime_id: t.rt('lead').runtime_id }), 'host.invalid_request');

    const answer = t.ep.request('launch.stop', { launch_id: launchId });
    await until(() => t.sudo.signals().length === 1, 'the TERM');
    assert.equal(child.stdin.writableEnded, true, 'stdin is closed first');
    assert.deepEqual(child.signals, ['SIGTERM'], 'HQ also signals its own child, best effort');
    assert.deepEqual(t.sudo.signals(), [`${A} kill -TERM -${child.pgid}`]);
    await until(() => timers.pending().includes(2000), 'the grace timer');
    timers.advance(1999);
    await tick();
    assert.deepEqual(t.sudo.signals(), [`${A} kill -TERM -${child.pgid}`], 'no KILL inside the grace period');
    assert.equal(child.alive, true);
    timers.advance(1);
    await until(() => t.sudo.signals().length === 2, 'the KILL');
    const res = await answer;
    assert.deepEqual(t.sudo.signals(), [`${A} kill -TERM -${child.pgid}`, `${A} kill -KILL -${child.pgid}`], 'the group, and nothing else');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.result, { launch_id: launchId, state: 'exited' });
    assert.equal(child.alive, false);
    const [r] = t.receipts('hq.launch.exited');
    assert.deepEqual([r.reason, r.signal, r.contained], ['stopped', 'SIGKILL', true]);
    // Idempotent.
    assert.deepEqual((await t.ep.request('launch.stop', { launch_id: launchId })).result, { launch_id: launchId, state: 'exited' });
    assert.equal(t.receipts('hq.launch.exited').length, 1);
    // A reservation is stopped by dropping it.
    const r2 = (await t.launch()).result;
    assert.equal((await t.ep.request('launch.stop', { launch_id: r2.launch_id })).ok, true);
    refused((await attachTo(t.hq.paths.admission, { launch_id: r2.launch_id, attach: r2.attach })).answer, 'caller_mismatch');
  } finally { await t.cleanup(); }
});

test('two launches in one account: stopping one signals only its group and leaves the other running', async () => {
  const t = await setup({ accounts: { 'adapter-a': A, 'adapter-b': A } });
  try {
    assert.deepEqual(t.status.hq.sockets.harnesses.map((h) => [h.account, h.adapters]), [[A, ['adapter-a', 'adapter-b']]]);
    const lead = await t.started();
    const spec = await t.started(t.spec);
    assert.deepEqual([lead.child.args[3], spec.child.args[3]], [A, A]);
    assert.notEqual(lead.child.pgid, spec.child.pgid);

    assert.deepEqual((await t.ep.request('launch.stop', { launch_id: lead.launch_id })).result, { launch_id: lead.launch_id, state: 'exited' });
    assert.deepEqual(t.sudo.signals(), [`${A} kill -TERM -${lead.child.pgid}`, `${A} kill -KILL -${lead.child.pgid}`], 'no other signal');
    assert.equal(lead.child.alive, false);
    assert.equal(spec.child.alive, true, 'the other launch is untouched');
    assert.equal(spec.child.stdin.writableEnded, false);
    assert.deepEqual(t.receipts('hq.launch.exited').map((r) => [r.member_id, r.contained]), [['m_lead', true]]);

    await t.ep.request('launch.stop', { launch_id: spec.launch_id });
    assert.deepEqual(t.sudo.signals().slice(2), [`${A} kill -TERM -${spec.child.pgid}`, `${A} kill -KILL -${spec.child.pgid}`]);
    assert.deepEqual(t.receipts('hq.launch.exited').map((r) => [r.member_id, r.contained]), [['m_lead', true], ['m_spec', true]]);
  } finally { await t.cleanup(); }
});

// The wrapper's group marker (hq/launch.mjs header).
const stderrLogged = (t) => t.hq.core.logs.filter((g) => g.message.startsWith(`agent m_lead in ${A} stderr: `)).map((g) => g.message.slice(`agent m_lead in ${A} stderr: `.length));

test('the marker names the group: taken, not logged, and the group signals use it, not sudo\'s pid', async () => {
  const t = await setup(); // pty: the agent's group is not sudo's pid
  try {
    const { child } = await t.started();
    assert.notEqual(child.pgid, child.pid);
    child.stderr.write('ordinary stderr\n');
    await until(() => stderrLogged(t).length === 1, 'the stderr line');
    assert.deepEqual(stderrLogged(t), ['ordinary stderr'], 'the marker is not logged');
    await t.ep.request('launch.stop', { launch_id: t.receipts('hq.launch')[0].launch_id });
    assert.deepEqual(t.sudo.signals(), [`${A} kill -TERM -${child.pgid}`, `${A} kill -KILL -${child.pgid}`]);
    assert.ok(!t.sudo.signals().some((x) => x.endsWith(` -${child.pid}`)), 'sudo\'s pid is never signalled');
    assert.equal(child.alive, false);
    assert.equal(t.receipts('hq.launch.exited')[0].contained, true);
  } finally { await t.cleanup(); }
});

test('the marker after sudo\'s own warnings is still taken; the warnings are logged', async () => {
  const t = await setup({ sudo: { before: ['sudo: unable to resolve host box: Name or service not known'] } });
  try {
    const { child } = await t.started();
    await until(() => stderrLogged(t).length === 1, 'the warning');
    assert.deepEqual(stderrLogged(t), ['sudo: unable to resolve host box: Name or service not known']);
    child.exit(0);
    await until(() => t.receipts('hq.launch.exited').length === 1, 'the exit receipt');
    assert.deepEqual(t.sudo.signals(), [`${A} kill -KILL -${child.pgid}`]);
  } finally { await t.cleanup(); }
});

test('a later marker line is ordinary stderr: logged, and the group stays the first', async () => {
  const t = await setup();
  try {
    const { child } = await t.started();
    child.stderr.write(`${PGID_MARKER} 777\n`);
    await until(() => stderrLogged(t).length === 1, 'the second marker line');
    assert.deepEqual(stderrLogged(t), [`${PGID_MARKER} 777`]);
    child.exit(0);
    await until(() => t.receipts('hq.launch.exited').length === 1, 'the exit receipt');
    assert.deepEqual(t.sudo.signals(), [`${A} kill -KILL -${child.pgid}`]);
  } finally { await t.cleanup(); }
});

test('a malformed marker, or one naming group 0 or 1, is ignored and logged; HQ falls back to sudo\'s pid', async () => {
  const bad = [`${PGID_MARKER} 1`, `${PGID_MARKER} 0`, `${PGID_MARKER} -42`, `${PGID_MARKER}  42`, `${PGID_MARKER} 42 `, `${PGID_MARKER} 42x`, ` ${PGID_MARKER} 42`, `${PGID_MARKER} 12345678901234567`, `${PGID_MARKER} 9007199254740993`, `${PGID_MARKER} `];
  const t = await setup({ sudo: { report: false, pty: false, before: bad } });
  try {
    const { child } = await t.started();
    await until(() => stderrLogged(t).length === bad.length, 'every line logged');
    assert.deepEqual(stderrLogged(t), bad.map((x) => x.slice(0, STDERR_LINE)));
    child.exit(0);
    await until(() => t.receipts('hq.launch.exited').length === 1, 'the exit receipt');
    assert.deepEqual(t.sudo.signals(), [`${A} kill -KILL -${child.pid}`], 'sudo\'s pid, the group without a pty');
    assert.equal(t.receipts('hq.launch.exited')[0].contained, true);
  } finally { await t.cleanup(); }
});

test('stop before the marker waits for it, bounded, then falls back to sudo\'s pid', async () => {
  // No marker ever: the wait ends after 5 s and the signals go to sudo's pid.
  const timers = fakeTimers();
  const t = await setup({ timers, sudo: { report: false, pty: false } });
  try {
    const { child, launch_id: launchId } = await t.started();
    const answer = t.ep.request('launch.stop', { launch_id: launchId });
    await until(() => child.stdin.writableEnded && timers.pending().includes(5000), 'the wait for the marker');
    timers.advance(4999);
    await tick();
    assert.deepEqual(t.sudo.signals(), [], 'nothing is signalled while HQ waits');
    timers.advance(1);
    const res = await answer;
    assert.deepEqual(res.result, { launch_id: launchId, state: 'exited' });
    assert.deepEqual(t.sudo.signals(), [`${A} kill -TERM -${child.pid}`, `${A} kill -KILL -${child.pid}`]);
  } finally { await t.cleanup(); }

  // The marker arrives during the wait: the signals use it.
  const timers2 = fakeTimers();
  const u = await setup({ timers: timers2, sudo: { report: false } });
  try {
    const { child, launch_id: launchId } = await u.started();
    const answer = u.ep.request('launch.stop', { launch_id: launchId });
    await until(() => child.stdin.writableEnded && timers2.pending().includes(5000), 'the wait for the marker');
    assert.deepEqual(u.sudo.signals(), []);
    child.stderr.write(`${PGID_MARKER} ${child.pgid}\n`);
    const res = await answer;
    assert.deepEqual(res.result, { launch_id: launchId, state: 'exited' });
    assert.deepEqual(u.sudo.signals(), [`${A} kill -TERM -${child.pgid}`, `${A} kill -KILL -${child.pgid}`]);
  } finally { await u.cleanup(); }
});

test('a failed TERM to the group leaves the launch uncontained: slot kept, status and receipt say so, the log names the group to check', async () => {
  const t = await setup({ refuse: (args) => /^kill -TERM -/.test(args.at(-1)), graceMs: 20 });
  try {
    const owner = await t.owner();
    const { child, launch_id: launchId } = await t.started();
    const res = await t.ep.request('launch.stop', { launch_id: launchId });
    assert.deepEqual(res.result, { launch_id: launchId, state: 'uncontained' }, 'the KILL still went, but the TERM failed');
    assert.deepEqual(t.sudo.signals(), [`${A} kill -TERM -${child.pgid}`, `${A} kill -KILL -${child.pgid}`]);
    const [r] = t.receipts('hq.launch.exited');
    assert.equal(r.contained, false);
    const s = (await owner.request('status')).result.hq.launch.launches;
    assert.deepEqual(s.map((x) => [x.launch_id, x.state]), [[launchId, 'uncontained']]);
    assert.match(s[0].uncontained, new RegExp(`the TERM to process group ${child.pgid} \\(reported by the wrapper; sudo pid ${child.pid}\\) failed`));
    assert.match(refused(await t.launch(), 'host.launch_busy'), new RegExp(`uncontained launch ${launchId} .*check the processes of hqm_a, then restart HQ`));
    assert.deepEqual((await t.ep.request('launch.stop', { launch_id: launchId })).result, { launch_id: launchId, state: 'uncontained' });
    const logged = t.hq.core.logs.find((g) => g.level === 'error' && g.message.includes('is not contained'));
    assert.match(logged.message, new RegExp(`pgrep -g ${child.pgid} -u hqm_a`));
    assert.ok(t.hq.core.logs.some((g) => new RegExp(`TERM to process group ${child.pgid} for launch .* failed: sudo exited 1: sudo: a password is required`).test(g.message)));
    // Another agent is not held by it.
    assert.equal((await t.launch(t.spec)).ok, true);
  } finally { await t.cleanup(); }

  // HQ restart clears it: launches are in memory only.
  const again = await setup();
  try { assert.equal((await again.launch()).ok, true); } finally { await again.cleanup(); }
});

test('a failed KILL to the group, or an agent still running after it, leaves the launch uncontained', async () => {
  const failed = await setup({ refuse: (args) => /^kill -KILL -/.test(args.at(-1)) });
  try {
    const { child } = await failed.started();
    child.exit(0);
    await until(() => failed.receipts('hq.launch.exited').length === 1, 'the exit receipt');
    assert.equal(failed.receipts('hq.launch.exited')[0].contained, false);
    const [l] = (await (await failed.owner()).request('status')).result.hq.launch.launches;
    assert.equal(l.state, 'uncontained');
    assert.match(l.uncontained, new RegExp(`the KILL to process group ${child.pgid} .*failed`));
    refused(await failed.launch(), 'host.launch_busy');
  } finally { await failed.cleanup(); }

  const timers = fakeTimers();
  const t = await setup({ timers, graceMs: 1000 });
  try {
    const { child, launch_id: launchId } = await t.started();
    child.immortal = true; // survives every signal: what HQ cannot confirm
    const answer = t.ep.request('launch.stop', { launch_id: launchId });
    await until(() => timers.pending().includes(1000), 'the grace timer');
    timers.advance(1000);
    // The KILL is answered (its own 5 s timeout cleared); then only the wait for the agent is left.
    const killed = () => t.sudo.calls.find((c) => /^kill -KILL -\d{2,}/.test(c.args.at(-1)));
    await until(() => killed()?.closed && timers.pending().length === 1 && timers.pending()[0] === KILL_WAIT_MS, 'the wait after the KILL');
    timers.advance(KILL_WAIT_MS);
    const res = await answer;
    assert.deepEqual(res.result, { launch_id: launchId, state: 'uncontained' });
    const [r] = t.receipts('hq.launch.exited');
    assert.deepEqual([r.contained, r.reason], [false, 'stopped']);
    const owner = await t.owner();
    const [l] = (await owner.request('status')).result.hq.launch.launches;
    assert.match(l.uncontained, new RegExp(`sudo \\(pid ${child.pid}\\) was still running 5000 ms after the KILL to process group ${child.pgid}`));
    child.exit(null, 'SIGKILL'); // let the stand-in go
  } finally { await t.cleanup(); }
});

test('HQ stop stops every agent\'s group before its sockets close, and refuses new launches meanwhile', async () => {
  const t = await setup();
  const { conn, child } = await t.started();
  const spec = await t.launch(t.spec);
  assert.equal(spec.ok, true);
  await t.done({ keep: true });
  try {
    assert.equal(child.alive, false);
    assert.equal(child.stdin.writableEnded, true);
    assert.deepEqual(t.sudo.signals(), [`${A} kill -TERM -${child.pgid}`, `${A} kill -KILL -${child.pgid}`]);
    const kinds = t.hq.core.receipts.map((r) => r.kind);
    assert.ok(kinds.indexOf('hq.launch.exited') < kinds.indexOf('hq.stopped'));
    assert.equal(t.receipts('hq.launch.exited')[0].reason, 'hq-stopping');
    assert.equal(t.sudo.agents.length, 1, 'the reservation was dropped, never started');
    await conn.closed;
  } finally { t.l.remove(); }
});

test('receipts name the launch without its environment or token; stderr reaches the log clipped and rate limited', async () => {
  const t = await setup();
  try {
    const { child, launch_id: launchId, attach } = await t.started({ command: [NODE, 'adapter.mjs', '--token-in-argv-is-hashed'] });
    const [r] = t.receipts('hq.launch');
    assert.deepEqual(Object.keys(r).filter((k) => !['seq', 'at', 'profile', 'plugin', 'kind'].includes(k)).sort(), ['account', 'adapter_id', 'argv0', 'argv_sha256', 'launch_id', 'member_id', 'runtime_id', 'soul_id']);
    assert.deepEqual([r.launch_id, r.account, r.member_id, r.adapter_id, r.argv0], [launchId, A, 'm_lead', 'adapter-a', NODE]);
    assert.match(r.argv_sha256, /^sha256:[0-9a-f]{64}$/);

    const prefix = `agent m_lead in ${A} stderr: `;
    const line = (n) => `line ${n} ${'y'.repeat(10)}`;
    child.stderr.write(`${'z'.repeat(5000)}\n`);
    for (let i = 0; i < STDERR_LINES + 20; i++) child.stderr.write(`${line(i)}\n`);
    const logged = () => t.hq.core.logs.filter((g) => g.message.startsWith(prefix));
    await until(() => logged().length === STDERR_LINES, 'the stderr lines');
    await tick();
    assert.equal(logged().length, STDERR_LINES, 'no more than the window allows');
    assert.ok(logged().every((g) => g.message.length <= prefix.length + STDERR_LINE));
    assert.equal(logged()[0].fields.launch_id, launchId);
    t.clock.advance(10_000);
    child.stderr.write('after the window\n');
    await until(() => logged().length === STDERR_LINES + 1, 'the next window');
    assert.ok(t.hq.core.logs.some((g) => /21 stderr lines dropped/.test(g.message)));
    // The agent prints its own token: the log has it redacted.
    child.stderr.write(`token ${ENV.AGENT_BOT_SOULS_MEMBER_TOKEN}\n`);
    await until(() => logged().length === STDERR_LINES + 2, 'the token line');
    assert.equal(logged().at(-1).message, `${prefix}token [redacted]`);

    child.exit(0);
    await until(() => t.receipts('hq.launch.exited').length === 1, 'the exit receipt');
    const kept = JSON.stringify([t.hq.core.receipts, t.hq.core.logs]);
    for (const secret of [attach, ENV.AGENT_BOT_SOULS_MEMBER_TOKEN, ENV.AGENT_BOT_SOULS_SOCKET, '--token-in-argv-is-hashed']) assert.ok(!kept.includes(secret), `${secret} is not kept`);
  } finally { await t.cleanup(); }
});

test('the agent\'s token never reaches the log from its stderr: whole, inside a line, twice, split across chunks, or cut at the oversize limit', async () => {
  const t = await setup();
  const TOKEN = ENV.AGENT_BOT_SOULS_MEMBER_TOKEN;
  try {
    const { child } = await t.started();
    const lines = () => stderrLogged(t);
    const write = async (text) => { child.stderr.write(text); await tick(); };
    let n = 0;
    const next = async (what) => { n += 1; await until(() => lines().length === n, what); return lines().at(-1); };

    await write(`${TOKEN}\n`);
    assert.equal(await next('own line'), '[redacted]');
    await write(`auth=${TOKEN}; ok\n`);
    assert.equal(await next('inside a line'), 'auth=[redacted]; ok');
    await write(`${TOKEN} and ${TOKEN}\n`);
    assert.equal(await next('twice'), '[redacted] and [redacted]');
    await write(`before ${TOKEN.slice(0, 10)}`);
    await write(`${TOKEN.slice(10)} after\n`);
    assert.equal(await next('split across chunks'), 'before [redacted] after');
    // A whole line over the limit, the token across the clip point: redacted
    // before the clip.
    await write(`${'f'.repeat(STDERR_LINE - 5)}${TOKEN}\n`);
    assert.equal(await next('long line'), `${'f'.repeat(STDERR_LINE - 5)}[redacted]`.slice(0, STDERR_LINE - 3) + '...');
    // Logged before its end is seen: a trailing proper prefix of the token is
    // dropped, and the rest of the line, the token's tail, is never logged.
    // The chunk is one character over the limit, so the prefix starts before
    // the clip point whenever it is longer than four characters.
    for (const k of [1, 12, TOKEN.length - 1]) {
      const pad = 'a'.repeat(STDERR_LINE + 1 - k);
      await write(`${pad}${TOKEN.slice(0, k)}`);
      assert.equal(await next(`cut after ${k}`), `${pad.slice(0, STDERR_LINE - 3)}...`);
      await write(`${TOKEN.slice(k)} tail\n`);
    }
    // A whole token inside a line logged before its end.
    await write(`${'b'.repeat(STDERR_LINE - 20)}${TOKEN}${'c'.repeat(40)}`);
    assert.equal(await next('whole token in a cut line'), `${'b'.repeat(STDERR_LINE - 20)}[redacted]${'c'.repeat(40)}`.slice(0, STDERR_LINE - 3) + '...');
    await write('rest\n');
    await write('after\n');
    assert.equal(await next('the next line'), 'after');

    const logs = JSON.stringify(t.hq.core.logs);
    assert.ok(!logs.includes(TOKEN));
    for (let k = 8; k < TOKEN.length; k++) assert.ok(!logs.includes(TOKEN.slice(0, k)), `no prefix of ${k} characters`);
    for (let k = 1; k < TOKEN.length - 7; k++) assert.ok(!logs.includes(TOKEN.slice(k)), `no suffix from ${k}`);
    assert.ok(logs.includes('[redacted]'));
    child.exit(0);
    await until(() => t.receipts('hq.launch.exited').length === 1, 'the exit receipt');
    assert.ok(!JSON.stringify([t.hq.core.receipts, t.hq.core.logs]).includes(TOKEN));
  } finally { await t.cleanup(); }
});

test('a token equal to a name HQ prints is redacted from the whole stderr message, the dropped-lines warning included', async () => {
  const t = await setup();
  try {
    // The token is the agent's own member ID, which the message prefix carries.
    const { child } = await t.started({ env: { ...ENV, AGENT_BOT_SOULS_MEMBER_TOKEN: 'm_lead' } });
    const lines = () => t.hq.core.logs.filter((g) => g.message.startsWith(`agent [redacted] in ${A} stderr: `));
    for (let i = 0; i < STDERR_LINES + 3; i++) child.stderr.write(`line ${i}\n`);
    await until(() => lines().length === STDERR_LINES, 'the window filled');
    assert.equal(lines()[0].message, `agent [redacted] in ${A} stderr: line 0`);
    t.clock.advance(10_000);
    child.stderr.write('after the window\n');
    await until(() => lines().length === STDERR_LINES + 1, 'the next window');
    const warning = t.hq.core.logs.filter((g) => /stderr lines dropped/.test(g.message));
    assert.deepEqual(warning.map((g) => g.message), [`agent [redacted] in ${A}: 3 stderr lines dropped`]);
    const fromSink = t.hq.core.logs.filter((g) => / stderr(:| lines dropped)/.test(g.message));
    assert.equal(fromSink.length, STDERR_LINES + 2);
    assert.ok(fromSink.every((g) => !g.message.includes('m_lead')));
    child.exit(0);
    await until(() => t.receipts('hq.launch.exited').length === 1, 'the exit receipt');
  } finally { await t.cleanup(); }
});

test('the group is fixed by the first signal: a marker during the grace period is stderr, and TERM and KILL go to the same group', async () => {
  const timers = fakeTimers();
  const t = await setup({ timers, graceMs: 2000, sudo: { report: false } });
  try {
    const { child, launch_id: launchId } = await t.started();
    child.stubborn = true;
    const answer = t.ep.request('launch.stop', { launch_id: launchId });
    await until(() => child.stdin.writableEnded && timers.pending().includes(5000), 'the wait for the marker');
    timers.advance(5000);
    await until(() => t.sudo.signals().length === 1 && timers.pending().includes(2000), 'the TERM and the grace timer');
    assert.deepEqual(t.sudo.signals(), [`${A} kill -TERM -${child.pid}`], 'no marker: sudo\'s pid');
    // The marker arrives late, naming another group.
    assert.notEqual(child.pgid, child.pid);
    child.stderr.write(`${PGID_MARKER} ${child.pgid}\n`);
    await until(() => stderrLogged(t).length === 1, 'the late marker logged');
    assert.deepEqual(stderrLogged(t), [`${PGID_MARKER} ${child.pgid}`]);
    timers.advance(2000);
    await until(() => t.sudo.signals().length === 2, 'the KILL');
    assert.deepEqual(t.sudo.signals(), [`${A} kill -TERM -${child.pid}`, `${A} kill -KILL -${child.pid}`], 'both to the fixed group');
    // sudo's pid was not the agent's group, so the agent survived: uncontained,
    // judged against the group that got both signals.
    const killed = () => t.sudo.calls.find((c) => /^kill -KILL -/.test(c.args.at(-1)));
    await until(() => killed()?.closed && timers.pending().includes(KILL_WAIT_MS), 'the wait after the KILL');
    timers.advance(KILL_WAIT_MS);
    assert.deepEqual((await answer).result, { launch_id: launchId, state: 'uncontained' });
    const logged = t.hq.core.logs.find((g) => g.level === 'error' && g.message.includes('is not contained'));
    assert.match(logged.message, new RegExp(`process group ${child.pid} \\(sudo's pid; the wrapper reported none before HQ signalled\\).*pgrep -g ${child.pid} -u hqm_a`));
    child.exit(null, 'SIGKILL');
  } finally { await t.cleanup(); }
});

test('a spawn that fails after attach answered: spawn-failed receipt with the code, no signal, slot freed, connection closed, the account unavailable', async () => {
  const t = await setup({ sudo: { spawnError: 'ENOENT' } });
  try {
    const owner = await t.owner();
    const res = await t.launch();
    const conn = await attachTo(t.hq.paths.admission, { launch_id: res.result.launch_id, attach: res.result.attach });
    assert.equal(conn.answer.ok, true, 'attach had already answered');
    await until(() => t.receipts('hq.launch.exited').length === 1, 'the exit receipt');
    await conn.closed;
    const [r] = t.receipts('hq.launch.exited');
    assert.deepEqual([r.launch_id, r.reason, r.spawn_error, r.exit_code, r.signal, r.contained], [res.result.launch_id, 'spawn-failed', 'ENOENT', null, null, true]);
    assert.ok(!JSON.stringify(r).includes('/usr/bin/sudo'), 'a code, never a path');
    assert.deepEqual(t.sudo.signals(), [], 'nothing started, nothing signalled');
    const logged = t.hq.core.logs.filter((g) => g.level === 'error' && /sudo could not be run \(ENOENT\)/.test(g.message));
    assert.equal(logged.length, 1);
    assert.match(logged[0].message, /in hqm_a/);
    const s = (await owner.request('status')).result;
    assert.deepEqual(s.hq.launch.launches, [], 'the slot is free');
    const a = s.hq.launch.accounts.find((x) => x.account === A);
    assert.equal(a.available, false);
    assert.match(a.reason, /sudo could not be run for a launch \(ENOENT\)/);
    assert.ok(s.hq.profileReasons.some((x) => /harness launch is not available for hqm_a \(sudo could not be run/.test(x)));
    // Later launches in that account are unavailable, not busy; the other account is untouched.
    assert.match(refused(await t.launch(), 'host.launch_unavailable'), /sudo could not be run for a launch \(ENOENT\)/);
    assert.equal((await t.launch(t.spec)).ok, true);
  } finally { await t.cleanup(); }
});

test('a passing spawn error fails that launch only: spawn-failed receipt, the account stays available', async () => {
  const t = await setup({ sudo: { spawnError: 'EAGAIN' } });
  try {
    const owner = await t.owner();
    const res = await t.launch();
    const conn = await attachTo(t.hq.paths.admission, { launch_id: res.result.launch_id, attach: res.result.attach });
    await until(() => t.receipts('hq.launch.exited').length === 1, 'the exit receipt');
    await conn.closed;
    const [r] = t.receipts('hq.launch.exited');
    assert.deepEqual([r.reason, r.spawn_error, r.contained], ['spawn-failed', 'EAGAIN', true]);
    const logged = t.hq.core.logs.filter((g) => g.level === 'error' && /sudo could not be run \(EAGAIN\)/.test(g.message));
    assert.equal(logged.length, 1);
    assert.doesNotMatch(logged[0].message, /unavailable/);
    const s = (await owner.request('status')).result;
    assert.deepEqual(s.hq.launch.launches, []);
    assert.equal(s.hq.launch.accounts.find((x) => x.account === A).available, true);
    assert.equal((await t.launch()).ok, true, 'the next launch is accepted');
  } finally { await t.cleanup(); }
});

test('a failed pipe to or from the agent is logged once per stream, never dropped; the launch goes on and still stops', async () => {
  const t = await setup();
  try {
    const { conn, child, launch_id: launchId } = await t.started();
    const said = (re) => t.hq.core.logs.filter((g) => re.test(g.message));
    child.stdout.emit('error', Object.assign(new Error('read EIO'), { code: 'EIO' }));
    child.stdout.emit('error', Object.assign(new Error('read EIO'), { code: 'EIO' }));
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    const out = said(/the agent's stdout failed \(EIO\)/);
    assert.equal(out.length, 1, 'once per stream');
    assert.deepEqual([out[0].level, out[0].fields.launch_id], ['warn', launchId]);
    // An agent that exited with input unread is ordinary, not a warning.
    assert.deepEqual(said(/the agent's stdin failed \(EPIPE\)/).map((g) => g.level), ['info']);
    const live = (await (await t.owner()).request('status')).result.hq.launch.launches;
    assert.equal(live.find((x) => x.launch_id === launchId).state, 'running');
    conn.end();
    await until(() => t.receipts('hq.launch.exited').length === 1, 'the exit receipt');
    assert.equal(t.receipts('hq.launch.exited')[0].contained, true);
  } finally { await t.cleanup(); }
});

test('status lists launches and per-account readiness, without commands, environments or tokens', async () => {
  const t = await setup();
  try {
    const owner = await t.owner();
    const { launch_id: launchId, attach } = await t.started();
    const s = (await owner.request('status')).result;
    assert.deepEqual(s.hq.launch.accounts, [{ account: A, available: true }, { account: B, available: true }]);
    assert.deepEqual(s.hq.launch.launches, [{ launch_id: launchId, account: A, soul_id: SOUL, member_id: 'm_lead', state: 'running', started_at: new Date(t.clock.now()).toISOString() }]);
    const text = JSON.stringify(s);
    for (const secret of [attach, ENV.AGENT_BOT_SOULS_MEMBER_TOKEN, 'adapter.mjs']) assert.ok(!text.includes(secret));
  } finally { await t.cleanup(); }

  const off = await setup({ rule: false });
  try {
    const s = (await (await off.owner()).request('status')).result;
    assert.deepEqual(s.hq.launch.accounts.map((a) => [a.account, a.available]), [[A, false], [B, false]]);
    assert.match(s.hq.launch.accounts[0].reason, /password is required/);
  } finally { await off.cleanup(); }
});

test('the profile reasons name what keeps agents from their harness accounts, and the label stays cooperative', async () => {
  const reasons = async (opts) => {
    const t = await setup(opts);
    try {
      const s = (await (await t.owner()).request('status')).result;
      assert.equal(s.profile, 'managed-cooperative');
      assert.ok(!JSON.stringify(s).includes('managed-protected'));
      return { all: s.hq.profileReasons, d7: s.hq.profileReasons.filter((r) => r.endsWith('(D7)')), warning: t.admitted.warnings?.[0] };
    } finally { await t.cleanup(); }
  };
  const none = await reasons({ harnesses: false });
  assert.deepEqual(none.d7, ['agents of every harness share one account: no OS account per harness credential (D7)']);
  const rule = await reasons({ rule: false });
  assert.equal(rule.d7.length, 1);
  assert.match(rule.d7[0], /^harness launch is not available for hqm_a \(.*\); hqm_b \(.*\), so HQ cannot start agents in those accounts \(D7\)$/);
  const partial = await reasons({ accounts: { 'adapter-a': A } });
  assert.deepEqual(partial.d7, [`agents whose harness has no account of its own: ${SOUL}/m_spec (adapter adapter-b) (D7)`]);
  // The Hello that admitted that agent already said so.
  assert.match(partial.warning, /agents whose harness has no account of its own: .*m_spec \(adapter adapter-b\)/);
  const shared = await reasons({ accounts: { 'adapter-a': A, 'adapter-b': A } });
  assert.deepEqual(shared.d7, [], 'one account per harness credential is the model, not a gap');
  const all = await reasons({});
  assert.deepEqual(all.d7, []);
  assert.equal(all.all.length, none.all.length - 1);
  assert.doesNotMatch(all.warning, /D7/);
});

test('launch operations exist only on the admission socket; the control and broker sockets never take over', async () => {
  const t = await setup();
  try {
    const r = (await t.launch()).result;
    const owner = await t.owner();
    refused(await owner.request('launch.attach', { launch_id: r.launch_id, attach: r.attach }), 'host.unknown_operation');
    refused(await owner.request('launch', { runtime_id: t.rt('lead').runtime_id, command: [NODE] }), 'host.unknown_operation');
    assert.equal((await owner.request('status')).ok, true, 'the control connection still parses requests');
    const broker = await t.member();
    assert.equal((await broker.request('launch.attach', { launch_id: r.launch_id, attach: r.attach })).ok, false);
    // The reservation was untouched by both.
    assert.equal((await attachTo(t.hq.paths.admission, { launch_id: r.launch_id, attach: r.attach })).answer.ok, true);
  } finally { await t.cleanup(); }
});

test('the test harness refuses to reach the real sudo outside the CI real-account tests', async () => {
  const l = harnessLayout();
  try {
    await assert.rejects(startHQ({
      platform: 'linux', accounts: l.resolve, harnessLstat: l.lstat,
      config: { acceptedDefinitions: { [SOUL]: [DIGEST] }, harnesses: { dir: l.dir, accounts: { 'adapter-a': A } } },
    }), /a test reached the real spawn for sudo: \/usr\/bin\/sudo -n -u hqm_a -- \/bin\/true/);
    if (!(process.platform === 'linux' && process.env.HQ_HARNESS_ACCOUNTS)) {
      await assert.rejects(startHQ({ realSudo: true }), /realSudo is for the CI real-account tests only/);
    }
  } finally { l.remove(); }
});

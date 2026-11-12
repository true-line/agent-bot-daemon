// T02 on real OS accounts (plan §9 row 16b). The CI job creates two harness
// accounts with real 0700 homes and their endpoint directories, as the
// provisioner would; HQ runs as the job's own account with its state in a
// 0700 temporary directory, and starts each agent itself, through sudo and the
// real launch + launch.attach path. What runs as the agent is
// tests/agent-probe.mjs, and what it reports comes back over the attached
// connection. It is the proof the logic tests cannot give: the kernel keeps
// an agent HQ started out of HQ's state, out of the other harness account,
// and away from HQ's tooling; stop ends an agent that ignores TERM; stopping
// one launch leaves another launch in the same account running; and a process
// that leaves its launch's group (setsid) is NOT stopped by HQ, which is the
// stated limit (hq/launch.mjs header), so the test ends it itself.
//
//   HQ_HARNESS_DIR       the harness endpoint directory
//   HQ_HARNESS_ACCOUNTS  two account names, comma-separated
//   HQ_REQUIRE_HARNESS_ACCOUNTS=1  fail instead of skipping when unset (CI)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROKER_ENV, REQUEST_ENV } from '../hq/launch.mjs';
import { referenceBroker } from './broker-fixture.mjs';
import { attachTo, DIGEST, helloOn, SOUL, startHQ, tempHome } from './hq-harness.mjs';

const dir = process.env.HQ_HARNESS_DIR;
const [A, B] = (process.env.HQ_HARNESS_ACCOUNTS ?? '').split(',').filter(Boolean);
const ready = process.platform === 'linux' && dir && A && B;
if (!ready && process.env.HQ_REQUIRE_HARNESS_ACCOUNTS === '1') {
  test('harness accounts are required here', () => assert.fail('HQ_REQUIRE_HARNESS_ACCOUNTS=1 but HQ_HARNESS_DIR and HQ_HARNESS_ACCOUNTS are not set on Linux'));
}
const skip = ready ? false : 'needs two harness accounts (CI creates them)';
const repo = fileURLToPath(new URL('..', import.meta.url));
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const passwd = (account) => execFileSync('getent', ['passwd', account], { encoding: 'utf8' }).trim().split(':');
// pgrep's pids, by number; no match is an empty list.
const pgrep = (args) => {
  try { return execFileSync('pgrep', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch (e) { if (e.status === 1) return []; throw e; }
};
// Every process of an account.
const processesOf = (account) => pgrep(['-u', account]);
// Whether one process of the account runs, asked as that account.
const running = (account, pid) => {
  try { execFileSync('sudo', ['-n', '-u', account, '--', '/bin/sh', '-c', `kill -0 ${Number(pid)}`], { stdio: 'ignore' }); return true; } catch { return false; }
};
// The test's own cleanup of a process HQ does not stop.
const killAs = (account, pid) => {
  try { execFileSync('sudo', ['-n', '-u', account, '--', '/bin/sh', '-c', `kill -KILL ${Number(pid)}`], { stdio: 'ignore' }); } catch { /* already gone */ }
};
// The sudo HQ spawned (HQ runs in this process): its pid, for the messages.
const sudoChildren = () => pgrep(['-P', String(process.pid), '-x', 'sudo']);
async function until(fn, what, ms) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); }
  assert.fail(`timed out after ${ms} ms waiting for ${what}`);
}

// The harness accounts cannot read the checkout, so the probe, and a copy of
// HQ's own tooling for the agent to try, go to a world-readable directory.
function publicCopy() {
  const pub = mkdtempSync('/tmp/hq-agent-probe-');
  copyFileSync(join(repo, 'tests/agent-probe.mjs'), join(pub, 'agent-probe.mjs'));
  for (const d of ['hq', 'sdk', 'scripts', 'governance']) cpSync(join(repo, d), join(pub, d), { recursive: true });
  const open = (p) => {
    chmodSync(p, statSync(p).isDirectory() ? 0o755 : 0o644);
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) open(join(p, f));
  };
  open(pub);
  return pub;
}

// `accounts` maps the two adapters, adapter-a (the lead's) and adapter-b (the
// specialist's), to harness accounts.
async function withHQ(accounts, fn) {
  const pub = publicCopy();
  const home = tempHome();
  const config = { acceptedDefinitions: { [SOUL]: [DIGEST] }, harnesses: { dir, accounts } };
  // On disk too, so the agent's attempt to read it is an attempt on a real file.
  writeFileSync(join(home, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  process.env.HQ_LAUNCH_CANARY = 'set-in-hqs-environment-only';
  const t = await startHQ({ home, platform: 'linux', config, plugins: [referenceBroker()], launch: { graceMs: 1000 }, realSudo: true });
  try {
    const used = [...new Set(Object.values(accounts))];
    assert.deepEqual(t.status.hq.launch.accounts.map((a) => [a.account, a.available, a.reason]), used.map((a) => [a, true, undefined]), 'the job\'s account may start every harness account');
    const entry = await t.entry();
    const admitted = (await entry.request('Hello', helloOn('adapter-a', 'adapter-b'))).result.admitted_runtimes;
    const endpoint = (account) => t.status.hq.sockets.harnesses.find((m) => m.account === account).path;
    const start = async (input, role = 'lead') => {
      const rt = admitted.find((a) => a.role === role);
      const res = await entry.request('launch', {
        runtime_id: rt.runtime_id,
        command: [process.execPath, join(pub, 'agent-probe.mjs'), JSON.stringify(input)],
        env: { AGENT_BOT_SOULS_SOCKET: t.hq.paths.admission, AGENT_BOT_SOULS_MEMBER_TOKEN: 'not-a-real-token', AGENT_BOT_SOULS_MEMBER_ID: rt.member_id, AGENT_BOT_SOULS_ROLE: role },
      });
      assert.equal(res.ok, true, JSON.stringify(res));
      const conn = await attachTo(t.hq.paths.admission, { launch_id: res.result.launch_id, attach: res.result.attach });
      assert.equal(conn.answer.ok, true, JSON.stringify(conn.answer));
      return { conn, launchId: res.result.launch_id };
    };
    const exited = () => t.hq.core.receipts.filter((r) => r.kind === 'hq.launch.exited');
    await fn({ t, pub, home, entry, endpoint, start, exited });
  } finally {
    delete process.env.HQ_LAUNCH_CANARY;
    await t.done();
    rmSync(pub, { recursive: true, force: true });
  }
}

test('T02 on real accounts: an agent HQ started works in its own 0700 directory and reads nothing of HQ\'s or the other harness account\'s', { skip }, async () => {
  await withHQ({ 'adapter-a': A, 'adapter-b': B }, async ({ t, pub, home, endpoint, start, exited }) => {
    const key = join(home, 'signer', 'device-key.pem');
    const files = { 'store.json': join(home, 'store.json'), 'config.json': join(home, 'config.json'), 'signer key': key };
    for (const [name, path] of Object.entries(files)) assert.ok(existsSync(path), `${name} exists, so reading it is a real attempt`);
    const before = { key: sha(key), config: sha(files['config.json']) };
    const [, , uidA, , , homeA] = passwd(A);
    const [, , , , , homeB] = passwd(B);
    const { conn } = await start({
      mode: 'probe',
      hq: { home, files, sockets: { 'control.sock': t.hq.paths.control, 'admission.sock': t.hq.paths.admission, 'broker.sock': t.hq.paths.broker }, main: join(pub, 'hq/main.mjs') },
      other: { home: homeB, endpointDir: join(dir, B), endpoint: endpoint(B) },
    });
    const line = await conn.line();
    const report = JSON.parse(line);
    await conn.closed;

    // Who and where it ran: its own directory under the account's real home.
    assert.equal(report.uid, Number(uidA));
    assert.equal(report.home, homeA);
    assert.equal(report.cwd, join(homeA, '.agent-bot-hq', 'souls', SOUL, 'm_lead'));
    assert.equal(report.cwdMode, 0o700, `mode ${report.cwdMode.toString(8)}`);
    // Its environment: HQ's never reaches it; the launch's variables do.
    assert.ok(!report.env.includes('HQ_LAUNCH_CANARY'), JSON.stringify(report.env));
    assert.deepEqual(report.env.filter((n) => n.startsWith('HQ_')), []);
    assert.deepEqual(report.env.filter((n) => n.startsWith('AGENT_BOT_')).sort(), [...REQUEST_ENV, BROKER_ENV].sort());
    assert.equal(report.broker, endpoint(A));
    // Every attempt fails, each for want of permission.
    for (const [name, r] of Object.entries(report.attempts)) {
      assert.equal(r.ok, false, `${name}: ${JSON.stringify(r)}`);
      if (name.startsWith('run ')) assert.match(r.stderr, /EACCES|permission denied/i, `${name}: ${JSON.stringify(r)}`);
      else assert.equal(r.code, 'EACCES', `${name}: ${JSON.stringify(r)}`);
    }
    assert.equal(Object.keys(report.attempts).length, 12);
    // And the controls succeed, so the failures are the boundary, not a broken probe.
    for (const [name, r] of Object.entries(report.controls)) assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`);
    // HQ's state is as it was.
    assert.deepEqual({ key: sha(key), config: sha(files['config.json']) }, before);
    await until(() => exited().length === 1, 'the exit receipt', 15_000);
    const [r] = exited();
    assert.deepEqual([r.account, r.exit_code, r.reason, r.contained], [A, 0, 'exited', true]);
    // The probe starts nothing outside its group, so nothing is left.
    assert.deepEqual(processesOf(A), [], 'nothing of the account is left');
  });
});

test('T02 on real accounts: stop ends an agent that ignores TERM and the end of stdin', { skip }, async () => {
  await withHQ({ 'adapter-a': A, 'adapter-b': B }, async ({ entry, start, exited }) => {
    assert.deepEqual(processesOf(A), [], 'the account starts with nothing running');
    const { conn, launchId } = await start({ mode: 'stubborn' });
    const agent = JSON.parse(await conn.line());
    assert.equal(agent.ready, true);
    const sudo = sudoChildren();
    // What the message names: sudo's pid, the group the agent (and so the
    // wrapper's marker) reports, and whether they differ (sudo's use_pty).
    const groups = `sudo pid ${sudo.join(',') || 'not found'}, reported group ${agent.pgid}, ${sudo.includes(agent.pgid) ? 'the same' : 'they differ'}; agent pid ${agent.pid}`;
    assert.ok(running(A, agent.pid), `the agent runs (${groups})`);
    const res = await entry.request('launch.stop', { launch_id: launchId });
    assert.deepEqual(res.result, { launch_id: launchId, state: 'exited' }, `${JSON.stringify(res)} (${groups})`);
    // Stop returned after the group KILL; the kernel reaps within moments.
    await until(() => !running(A, agent.pid), `the agent to go (${groups})`, 5_000);
    await conn.closed;
    const [r] = exited();
    assert.deepEqual([r.reason, r.contained], ['stopped', true], groups);
    assert.deepEqual(processesOf(A), [], `nothing of the account is left (${groups})`);
  });
});

test('T02 on real accounts: two launches in one harness account; stopping one leaves the other running', { skip }, async () => {
  await withHQ({ 'adapter-a': A, 'adapter-b': A }, async ({ entry, start, exited }) => {
    assert.deepEqual(processesOf(A), [], 'the account starts with nothing running');
    const lead = await start({ mode: 'stubborn' }, 'lead');
    const spec = await start({ mode: 'stubborn' }, 'specialist');
    const l = JSON.parse(await lead.conn.line());
    const s = JSON.parse(await spec.conn.line());
    // Each launch is its own process group.
    assert.notEqual(l.pgid, s.pgid, `lead ${JSON.stringify(l)} specialist ${JSON.stringify(s)}`);
    assert.ok(running(A, l.pid) && running(A, s.pid), 'both agents run');

    const res = await entry.request('launch.stop', { launch_id: lead.launchId });
    assert.deepEqual(res.result, { launch_id: lead.launchId, state: 'exited' }, JSON.stringify(res));
    await until(() => !running(A, l.pid), 'the stopped agent to go', 5_000);
    await lead.conn.closed;
    assert.ok(running(A, s.pid), `the other launch runs on (group ${l.pgid} was signalled; ${A} has ${processesOf(A)})`);
    assert.deepEqual(exited().map((r) => [r.member_id, r.contained]), [['m_lead', true]]);

    const res2 = await entry.request('launch.stop', { launch_id: spec.launchId });
    assert.deepEqual(res2.result, { launch_id: spec.launchId, state: 'exited' }, JSON.stringify(res2));
    await until(() => !running(A, s.pid), 'the second agent to go', 5_000);
    await spec.conn.closed;
    assert.deepEqual(exited().map((r) => [r.member_id, r.contained]), [['m_lead', true], ['m_spec', true]]);
  });
});

test('T02 on real accounts: a child that leaves the launch\'s group (setsid) survives stop; HQ does not claim it', { skip }, async () => {
  let escaped;
  try {
    await withHQ({ 'adapter-a': A, 'adapter-b': B }, async ({ entry, start, exited }) => {
      const { conn, launchId } = await start({ mode: 'stubborn', escape: true });
      const agent = JSON.parse(await conn.line());
      escaped = agent.escaped;
      assert.ok(Number.isSafeInteger(escaped) && escaped > 1, JSON.stringify(agent));
      await until(() => running(A, escaped), 'the setsid child', 10_000);
      const res = await entry.request('launch.stop', { launch_id: launchId });
      assert.deepEqual(res.result, { launch_id: launchId, state: 'exited' }, JSON.stringify(res));
      await until(() => !running(A, agent.pid), 'the agent to go', 5_000);
      await conn.closed;
      // The limit, as stated: HQ stopped the group, the launch is contained
      // as far as HQ can tell, and the child that left the group runs on.
      assert.deepEqual(exited().map((r) => [r.reason, r.contained]), [['stopped', true]]);
      assert.ok(running(A, escaped), `the setsid child ${escaped} survives stop (${A} has ${processesOf(A)})`);
    });
  } finally {
    // The test ends it itself.
    if (escaped) {
      killAs(A, escaped);
      await until(() => !running(A, escaped), 'the setsid child to end', 5_000);
    }
  }
});

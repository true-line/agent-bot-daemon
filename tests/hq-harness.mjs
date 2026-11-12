// Shared setup for the HQ skeleton tests: a real HQ (store, sockets, SDK
// host, admission plugin) in a fresh 0700 directory, with the legacy
// commands replaced by canned output and a deterministic clock.
import { EventEmitter } from 'node:events';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { verify } from '../scripts/soul-contracts.mjs';
import { testClock } from '../sdk/services.mjs';
import { SCHEMA_NAMES } from '../hq/admission.mjs';
import { TASK_SCHEMA_NAMES, TASK_WIRE_SCHEMA_NAMES } from '../hq/tasks.mjs';
import { createHQ } from '../hq/hq.mjs';
import { legacyDaemon, legacySigner } from '../hq/legacy.mjs';
import { connectSocket } from '../hq/socket.mjs';

export const contracts = verify().dir;
const load = (contract, names) => names.map((n) => [n, JSON.parse(readFileSync(join(contracts, 'schemas', contract, `${n}.schema.json`), 'utf8'))]);
export const schemas = Object.fromEntries([...load('hq/v1', SCHEMA_NAMES), ...load('task/v1', TASK_SCHEMA_NAMES), ...load('wire/v1', TASK_WIRE_SCHEMA_NAMES)]);
export const errorResponseSchema = JSON.parse(readFileSync(join(contracts, 'schemas/common/v1/error-response.schema.json'), 'utf8'));
export const fixture = (rel) => JSON.parse(readFileSync(join(contracts, 'fixtures', rel), 'utf8'));

export const SOUL = 'agent_0b3f1e2a-7c4d-4e8f-9a1b-2c3d4e5f6a7b';
export const DIGEST = `sha256:${'a1'.repeat(32)}`;
export const hello = (over = {}) => ({ ...fixture('positive/hello.first-start.json').input, ...over });

export const tempHome = () => mkdtempSync(join(tmpdir(), 'hq-'));

// Canned legacy CLI. `device` is what `agent-bot server status --json`
// reports; `daemon` what `agent-bot daemon status --json` reports.
export function fakeLegacy({ device = 'enrolled', daemon = 'running' } = {}) {
  const state = { device, daemon, calls: [] };
  const run = async (argv) => {
    const cmd = argv.join(' ');
    state.calls.push(cmd);
    if (cmd.includes('server status')) {
      if (state.device === 'broken') return { code: 1, stdout: 'not json' };
      if (state.device === 'revoked') return { code: 0, stdout: JSON.stringify({ enrolled: true, remote: { revoked: true } }) };
      return { code: 0, stdout: JSON.stringify({ enrolled: state.device === 'enrolled', device: { device_id: 'dev-x' } }) };
    }
    if (cmd.includes('daemon status')) {
      if (state.daemon === 'garbled') return { code: 0, stdout: '{}' };
      return { code: 0, stdout: JSON.stringify({ running: state.daemon === 'running', pid: 4242, version: '0.15.17', souls: [{ id: 'agent_x', soulDir: '/private/path' }] }) };
    }
    if (cmd.includes('daemon start')) { state.daemon = 'running'; return { code: 0, stdout: '' }; }
    return { code: 127, stdout: '' };
  };
  return { state, run };
}

export async function startHQ({ device = 'enrolled', daemon = 'running', supervise = false, config, home = tempHome(), plugins, pluginsDir, pins, devPlugins, account = 'user', platform = 'darwin', signer, enrollment, accounts, harnessLstat, launch = {}, realSudo = false } = {}) {
  // `realSudo`: only the CI real-account tests, only on Linux with their accounts set.
  if (realSudo && !(process.platform === 'linux' && process.env.HQ_HARNESS_ACCOUNTS)) throw new Error('realSudo is for the CI real-account tests only (Linux, HQ_HARNESS_ACCOUNTS set)');
  const legacy = fakeLegacy({ device, daemon });
  const clock = testClock(Date.UTC(2026, 10, 8));
  const hq = createHQ({
    home,
    schemas,
    config: config ?? { acceptedDefinitions: { [SOUL]: [DIGEST] } },
    // null: let HQ pick the enrollment source from its config.
    ...(enrollment === null ? {} : { enrollment: enrollment ?? legacySigner({ run: legacy.run }) }),
    ...(signer ? { signer } : {}),
    legacy: legacyDaemon({ run: legacy.run, supervise, clock }),
    clock,
    account,
    platform,
    ...(accounts ? { accounts } : {}),
    ...(harnessLstat ? { harnessLstat } : {}),
    launch: { ...launch, ...(launch.spawn || realSudo ? {} : { spawn: noRealSudo }) },
    plugins,
    pluginsDir,
    pins,
    devPlugins,
  });
  const status = await hq.start();
  await hq.settled();
  try { checkNoRealSudo(); } catch (e) { await hq.stop(); throw e; }
  const clients = [];
  const owner = async () => { const c = await connectSocket(hq.paths.control); clients.push(c); return c; };
  const entry = async () => { const c = await connectSocket(hq.paths.admission); clients.push(c); return c; };
  // `path`: a harness account's own endpoint (row 16a); the shared socket otherwise.
  const member = async (path = hq.paths.broker) => { const c = await connectSocket(path); clients.push(c); return c; };
  const done = async ({ keep = false } = {}) => {
    for (const c of clients) await c.close().catch(() => {});
    await hq.stop();
    if (!keep) rmSync(home, { recursive: true, force: true });
    checkNoRealSudo();
  };
  return { hq, home, status, legacy, clock, owner, entry, member, done };
}

// Two harness accounts that do not exist, for the tests that run everywhere
// (rows 16a, 16b): an endpoint directory each, laid out as the provisioner
// would, and a 0700 home each. The homes are this user's directories, and an
// account's home must be the account's, so `lstat` stands in the account as
// their owner; `owners` lets a test change that.
export const HARNESS_UIDS = Object.freeze({ hqm_a: 61001, hqm_b: 61002 });
export function harnessLayout(accounts = Object.keys(HARNESS_UIDS)) {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  chmodSync(dir, 0o755);
  const homesDir = mkdtempSync(join(tmpdir(), 'mh-'));
  const gids = {};
  const homes = {};
  const owners = {};
  for (const account of accounts) {
    const endpoint = join(dir, account);
    mkdirSync(endpoint);
    chmodSync(endpoint, 0o2750);
    gids[account] = statSync(endpoint).gid;
    homes[account] = join(homesDir, account);
    mkdirSync(homes[account]);
    chmodSync(homes[account], 0o700);
    owners[account] = HARNESS_UIDS[account];
  }
  const resolve = (name) => {
    if (!(name in HARNESS_UIDS)) throw new Error(`harness account ${name} does not exist on this host`);
    return { uid: HARNESS_UIDS[name], gid: gids[name], groupMembers: [], home: homes[name] };
  };
  const lstat = (path) => {
    const st = lstatSync(path);
    const account = Object.keys(homes).find((a) => homes[a] === path);
    return account ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: owners[account] }) : st;
  };
  const remove = () => { rmSync(dir, { recursive: true, force: true }); rmSync(homesDir, { recursive: true, force: true }); };
  return { dir, homes, owners, gids, resolve, lstat, remove };
}

// Hello with one role per adapter: the fixture's lead on `lead`, its
// specialist on `spec` (the fixture puts both on fake-adapter).
export const helloOn = (lead, spec = lead, over = {}) => {
  const base = hello();
  const [l, s] = base.requested_roles;
  return { ...base, requested_roles: [{ ...l, adapter_id: lead }, { ...s, adapter_id: spec }], ...over };
};

// A child process with in-memory pipes, for hq/launch.mjs's injected spawn.
export class FakeChild extends EventEmitter {
  constructor(file, args, opts, pid) {
    super();
    Object.assign(this, { file, args, opts, pid, signals: [], alive: true });
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }
  // HQ's signal goes to sudo, which runs as root: EPERM, as on a real host.
  kill(signal = 'SIGTERM') {
    this.signals.push(signal);
    setImmediate(() => this.emit('error', Object.assign(new Error(`kill ${signal}: EPERM`), { code: 'EPERM' })));
    return false;
  }
  exit(code, signal = null) {
    if (!this.alive) return;
    this.alive = false;
    this.emit('exit', code, signal);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => { this.closed = true; this.emit('close', code, signal); });
  }
}

// A stand-in for /usr/bin/sudo under the provisioner's rule. Each agent it
// starts is a FakeChild with a process group, `pgid`: with `pty` (sudo's
// use_pty, Ubuntu's default) a new group, not sudo's pid; without it, sudo's
// pid. Unless `report` is false, the wrapper's first stderr output is the
// marker naming that group, after any `before` lines (sudo's own warnings).
// The readiness probe and the signal commands answer at once; `rule: false`
// answers as sudo -n without the rule, and `refuse(args)` makes one call fail
// the same way. A group TERM ends the agent in that group unless it is
// `stubborn`; a group KILL ends it unless it is `immortal`. Nothing else is
// ever signalled.
export function fakeSudo({ rule = true, refuse = () => false, pty = true, report = true, before = [] } = {}) {
  const calls = [];
  const agents = [];
  let pid = 4000;
  const spawn = (file, args, opts) => {
    const child = new FakeChild(file, args, opts, (pid += 1));
    calls.push(child);
    if (args[1] === '-H') {
      child.pgid = pty ? child.pid + 50000 : child.pid;
      agents.push(child);
      setImmediate(() => {
        if (!child.alive) return;
        for (const line of before) child.stderr.write(`${line}\n`);
        if (report) child.stderr.write(`agent-bot-hq-launch pgid ${child.pgid}\n`);
      });
      return child;
    }
    const account = args[2];
    const script = args.at(-1);
    setImmediate(() => {
      if (!rule || refuse(args)) { child.stderr.write('sudo: a password is required\n'); child.exit(1); return; }
      const group = /^kill -(TERM|KILL) -(\d+) 2>\/dev\/null; exit 0$/.exec(script);
      for (const a of agents) {
        if (!a.alive || a.args[3] !== account || a.immortal) continue;
        if (group && a.pgid === Number(group[2]) && (group[1] === 'KILL' || !a.stubborn)) a.exit(null, `SIG${group[1]}`);
      }
      child.exit(0);
    });
    return child;
  };
  const signals = () => calls.filter((c) => /^kill -/.test(c.args.at(-1) ?? '')).map((c) => `${c.args[2]} ${c.args.at(-1).replace(' 2>/dev/null; exit 0', '')}`);
  const probes = () => calls.filter((c) => c.args.at(-1) === '/bin/true').map((c) => c.args);
  return { spawn, calls, agents, signals, probes };
}

// Tests never run the real sudo, except the CI real-account tests, which ask
// for it with `realSudo`. Any other launcher spawn lands here: it records the
// call and throws, and startHQ and done() fail on it.
const sudoReached = [];
export function noRealSudo(file, args) {
  sudoReached.push(`${file} ${args.join(' ')}`);
  throw new Error(`a test reached the real spawn for ${file}; inject launch.spawn (tests/hq-harness.mjs fakeSudo)`);
}
const checkNoRealSudo = () => {
  if (sudoReached.length) throw new Error(`a test reached the real spawn for sudo: ${sudoReached.splice(0).join(' | ')}`);
};

// Timers that move only when the test says so.
export function fakeTimers() {
  let now = 0;
  let pending = [];
  return {
    setTimeout(fn, ms) { const t = { fn, at: now + ms, unref() { return t; } }; pending.push(t); return t; },
    clearTimeout(t) { pending = pending.filter((x) => x !== t); },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = pending.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        pending = pending.filter((t) => t !== due);
        due.fn();
      }
    },
    pending: () => pending.map((t) => t.at - now),
  };
}

// `launch.attach` as the first request on a new admission connection, then
// the connection as the agent's stdio. `trailing` is written with the
// request, in the same write. Resolves once HQ answers.
export function attachTo(path, payload, { trailing = '' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(path);
    let head = Buffer.alloc(0);
    let answered = false;
    let all = '';
    let rest = '';
    const waiters = [];
    let closedResolve;
    const closed = new Promise((r) => { closedResolve = r; });
    const flush = () => {
      let nl;
      while (waiters.length && (nl = rest.indexOf('\n')) !== -1) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        waiters.shift()(line);
      }
    };
    const out = (answer) => ({
      answer, socket, closed,
      write: (text) => socket.write(text),
      line: () => new Promise((r) => { waiters.push(r); flush(); }),
      output: () => all,
      end: () => socket.end(),
    });
    socket.on('data', (chunk) => {
      if (answered) { all += chunk; rest += chunk; flush(); return; }
      head = Buffer.concat([head, chunk]);
      const nl = head.indexOf(0x0a);
      if (nl === -1) return;
      answered = true;
      const tail = head.subarray(nl + 1).toString('utf8');
      all += tail;
      rest += tail;
      resolve(out(JSON.parse(head.subarray(0, nl).toString('utf8'))));
      flush();
    });
    socket.on('close', () => { closedResolve(all); if (!answered) resolve(out(null)); });
    socket.once('error', (e) => { if (!answered) reject(e); });
    socket.once('connect', () => socket.write(`${JSON.stringify({ id: 1, op: 'launch.attach', payload })}\n${trailing}`));
  });
}

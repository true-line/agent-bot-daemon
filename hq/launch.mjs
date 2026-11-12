// HQ-controlled agent launch (plan §9 row 16b; T02).
//
// HQ starts each agent in the OS account of its harness (D7 as amended by
// platform PDR-0053: one account per harness credential, shared by the agents
// of every Soul on that harness) and is its parent, so the entry point gets
// the agent's stdin and stdout from HQ instead of spawning the adapter itself.
// HQ is not root. Its one privilege is the rule agent-bot-machine installs at
// provisioning (the owner's decision of 2026-11-10, plan §9 16b):
//
//   Runas_Alias ABHQ_MEMBERS = <harness accounts>
//   Defaults:<hq> env_reset, !setenv
//   Defaults:<hq> env_keep = "AGENT_BOT_SOULS_SOCKET AGENT_BOT_SOULS_MEMBER_TOKEN AGENT_BOT_SOULS_MEMBER_ID AGENT_BOT_SOULS_ROLE AGENT_BOT_SOULS_BROKER"
//   <hq> ALL = (ABHQ_MEMBERS) NOPASSWD: NOSETENV: ALL
//
// HQ cannot widen it: the rule is the provisioner's, names harness accounts
// only, and resets the environment to that list. This module is the only code
// that uses it, and it starts an agent in exactly one form:
//
//   /usr/bin/sudo -n -H -u <account> -- /bin/sh -c '<LAUNCH_SHELL>' sh <soul_id> <member_id> <command...>
//
// with the four variables a request may name, the account's own broker
// endpoint as AGENT_BOT_SOULS_BROKER, and a fixed PATH. HQ's own environment
// never reaches the child. The account comes from HQ's config for the
// runtime's adapter, fixed at admission, never from the request. As that
// account, the shell first reports its process group (below), then makes the
// agent's own working directory, $HOME/.agent-bot-hq/souls/<soul_id>/<member_id>,
// 0700 (umask 077, mkdir -p, chmod), changes into it and execs the command.
// soul_id and member_id are positional arguments, pattern-checked here and at
// admission, and the command is arguments too: nothing is interpolated into
// the shell. HOME is the account's real home (hq/harness-accounts.mjs
// verifies it is 0700 and the account's), because the harness's own sign-in
// lives there. The directory is the agent's working state on this host;
// capturing it into the Soul's package is not this slice.
//
// Two steps on the admission socket (hq/socket.mjs, takeover):
//   launch        { runtime_id, command, env }  on the connection that owns
//                 the runtime. Checks, then reserves; nothing runs yet.
//                 Returns { launch_id, attach, expires_at }; `attach` is a
//                 one-time token, good for 30 seconds.
//   launch.attach { launch_id, attach }  the first and only request on a NEW
//                 connection. Spends the token, right or wrong, starts the
//                 agent, answers { launch_id }, and from then on the
//                 connection is the agent's stdin and stdout.
//   launch.stop   { launch_id }  on the connection that called launch.
//                 Idempotent; answers the launch's state.
// Closing the attached connection stops the agent; when the agent exits, HQ
// closes the connection after the agent's remaining stdout. One launch runs
// per (soul_id, member_id) at a time.
//
// The launch's process group. A harness account is shared, and HQ does not
// own everything in it (the harness's own sign-in session, a harness the
// owner started, Souls HQ did not start), so HQ stops only what it started:
// the launch's process group. sudo is spawned detached, so HQ's own signals
// and terminal never reach the launch. Where the agent's group is depends on
// sudo: without a pty the command stays in sudo's group; with `use_pty`,
// which Ubuntu's sudoers sets, sudo's monitor puts it in a new session and
// group. So HQ does not guess. The wrapper's first action, before the agent
// exists, is to read its own group from /proc/self/stat (field 5, with the
// shell's `read` builtin) and print one line on stderr:
//
//   agent-bot-hq-launch pgid <n>
//
// HQ takes the FIRST stderr line that matches that exactly (digits only, a
// safe integer above 1) as the group and does not log it. Lines before it
// (sudo's own warnings) are logged as agent stderr. A later matching line is
// ordinary stderr. Why the first match is genuine: the pipe's only writers
// before the agent exists are sudo (root, whose messages never take that
// form) and the wrapper, which prints the marker before it execs the agent,
// so nothing the agent writes can come first. The one gap is a wrapper whose
// read failed and printed nothing: then the agent's own stderr could carry
// the first match. At worst such a forged line points HQ's TERM and KILL at
// another group of the same harness account: HQ sends them as that account,
// so they reach only processes the agent could already signal itself, and
// the launch's real group is then left unstopped, as a process that leaves
// its group would be (below). If the marker never arrives (the read failed,
// or stop came first and SIGNAL_TIMEOUT_MS passed), HQ falls back to sudo's
// pid as the group, and the check that sudo exited after the KILL decides
// whether the launch is contained.
//
// Stop. HQ cannot signal a process of another uid. Stop closes the agent's
// stdin, then, as the harness account through the same rule, sends
// `kill -TERM -<pgid>`, waits the grace period, and sends
// `kill -KILL -<pgid>`. A launch that exits on its own gets the same KILL to
// its group. That is all HQ stops.
//
// What that does not stop: a process that leaves the launch's group (setsid,
// or a group of its own) keeps running in the harness account after stop.
// Agents in one harness account are one trust domain to the host. Containing
// a process that leaves its group needs a kernel grouping HQ cannot make
// without root (a cgroup), which is not this slice.
//
// Every signal command ends `2>/dev/null; exit 0`, so `kill` finding nothing
// to signal is success and any other exit means sudo or the rule failed. A
// failed signal, a timeout, a spawn error, or sudo still running
// KILL_WAIT_MS after the KILL is a launch HQ could not contain: its state is
// `uncontained`, its slot is kept (a new launch for that Soul and agent is
// host.launch_busy and says why), status shows it, its `hq.launch.exited`
// receipt says `contained: false`, and the log says what the owner must
// check. Only an HQ restart clears it.
//
// Readiness. At start HQ runs `sudo -n -u <account> -- /bin/true` once per
// harness account, in parallel and bounded. Without the rule HQ still starts
// and serves row 16a; launch for that account is host.launch_unavailable,
// and status and the profile reasons say why.
//
// Linux only: elsewhere every launch is refused (macOS waits for row 29).
// Launches are in memory only, so after a restart nothing runs under HQ and an
// old launch ID or token is refused. HQ does not clean up after a crash: an
// agent left running by an HQ that stopped abnormally keeps running.
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fail, HostError } from '../sdk/errors.mjs';
import { pushReceipt, redact } from '../sdk/services.mjs';
import { takeover } from './socket.mjs';

export const SUDO = '/usr/bin/sudo';
export const AGENT_PATH = '/usr/local/bin:/usr/bin:/bin';
// First the group marker (a failed read prints nothing; HQ then falls back),
// then the agent's directory. $1 is the soul_id and $2 the member_id; both are
// checked against their patterns before they get here, and neither is ever
// part of the script.
export const PGID_MARKER = 'agent-bot-hq-launch pgid';
export const LAUNCH_SHELL = `read -r _ _ _ _ g _ 2>/dev/null </proc/self/stat && printf '${PGID_MARKER} %s\\n' "$g" >&2; umask 077 && d="$HOME/.agent-bot-hq/souls/$1/$2" && mkdir -p "$d" && chmod 0700 "$d" && cd "$d" && shift 2 && exec "$@"`;
const MARKER_LINE = /^agent-bot-hq-launch pgid ([0-9]{1,16})$/;
export const REQUEST_ENV = Object.freeze(['AGENT_BOT_SOULS_SOCKET', 'AGENT_BOT_SOULS_MEMBER_TOKEN', 'AGENT_BOT_SOULS_MEMBER_ID', 'AGENT_BOT_SOULS_ROLE']);
export const BROKER_ENV = 'AGENT_BOT_SOULS_BROKER';
export const LAUNCH_OPERATIONS = Object.freeze(['launch', 'launch.attach', 'launch.stop']);
const SIGNALS = new Set(['TERM', 'KILL']);
const SOUL_ID = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LAUNCH_ID = /^ln_[0-9a-f]{24}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const LAUNCH_KEYS = new Set(['runtime_id', 'command', 'env']);
const MAX_ARGS = 64;
const MAX_ARG = 4096;
const MAX_ENV_VALUE = 4096;
export const RESERVE_MS = 30_000;
export const MAX_PENDING = 32;
export const DEFAULT_GRACE_MS = 5_000;
export const KILL_WAIT_MS = 5_000;
const SIGNAL_TIMEOUT_MS = 5_000;
export const PROBE_TIMEOUT_MS = 3_000;
const CLOSE_WAIT_MS = 10_000;
// An agent's stderr goes to HQ's log, a line at a time: each line clipped,
// and at most STDERR_LINES per window, so an agent cannot flood HQ.
export const STDERR_LINE = 1024;
export const STDERR_LINES = 100;
export const STDERR_WINDOW_MS = 10_000;

export function agentArgv(account, soulId, memberId, command) {
  if (!SOUL_ID.test(soulId) || !MEMBER_ID.test(memberId)) throw new TypeError('agentArgv needs a valid soul_id and member_id');
  return ['-n', '-H', '-u', account, '--', '/bin/sh', '-c', LAUNCH_SHELL, 'sh', soulId, memberId, ...command];
}
export const probeArgv = (account) => ['-n', '-u', account, '--', '/bin/true'];
// A signal to one launch's process group. The group ID must be a positive
// safe integer above 1: `-1` would be the whole account, and nothing else
// may reach the shell string.
export function groupArgv(account, signal, pgid) {
  if (!SIGNALS.has(signal)) throw new TypeError(`no group signal ${signal}`);
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new TypeError(`${pgid} is not a process group ID HQ may signal`);
  return ['-n', '-u', account, '--', '/bin/sh', '-c', `kill -${signal} -${pgid} 2>/dev/null; exit 0`];
}

const iso = (ms) => new Date(ms).toISOString();
const argvDigest = (command) => `sha256:${createHash('sha256').update(JSON.stringify(command)).digest('hex')}`;
const sameToken = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const clipLine = (s, max = STDERR_LINE) => (s.length > max ? `${s.slice(0, max - 3)}...` : s);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// A command: 1 to 64 bounded strings without NUL, the first an absolute path.
export function validCommand(command) {
  if (!Array.isArray(command) || command.length < 1 || command.length > MAX_ARGS) fail('host.invalid_request', `command is a list of 1 to ${MAX_ARGS} arguments`);
  for (const a of command) {
    if (typeof a !== 'string' || a.length > MAX_ARG || a.includes('\0')) fail('host.invalid_request', `each argument is a string of at most ${MAX_ARG} characters with no NUL`);
  }
  if (!command[0].startsWith('/')) fail('host.invalid_request', 'command[0] is an absolute path');
  return [...command];
}

// The variables a launch may set: exactly REQUEST_ENV. Anything else is
// refused, never dropped, and AGENT_BOT_SOULS_BROKER is HQ's to set.
export function validEnv(env) {
  if (env === undefined) return {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('host.invalid_request', 'env maps variable names to strings');
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === BROKER_ENV) fail('host.invalid_request', `${BROKER_ENV} is set by HQ to the harness account's own endpoint; a launch may not name it`);
    if (!REQUEST_ENV.includes(k)) fail('host.invalid_request', `env ${JSON.stringify(k.slice(0, 64))} is not one a launch may set (${REQUEST_ENV.join(', ')})`);
    if (typeof v !== 'string' || v.length > MAX_ENV_VALUE || /[\0\r\n]/.test(v)) fail('host.invalid_request', `env ${k} is a string of at most ${MAX_ENV_VALUE} characters with no NUL or newline`);
    out[k] = v;
  }
  return out;
}

// harnesses: the harness account plan (hq/harness-accounts.mjs), with
// `configured` false when the owner's config has no harnesses.
// withLiveRuntime is hq-admission's (the caller and liveness check). mode()
// is the host's mode.
export function createLauncher({
  core,
  harnesses = { endpoints: [], accountOf: () => undefined },
  configured = false,
  platform = process.platform,
  spawn = nodeSpawn,
  timers = { setTimeout, clearTimeout },
  graceMs = DEFAULT_GRACE_MS,
  mode = () => 'running',
  withLiveRuntime,
}) {
  const readiness = new Map(); // account → { available, reason? }
  const launches = new Map(); // launch_id → launch
  const slots = new Map(); // soul \n member → launch_id
  let closing = false;

  const log = (level, message, fields) => core.logs.push({ level, plugin: 'hq', at: core.clock.now(), ...redact(core, { message, ...(fields ? { fields } : {}) }) });
  const receipt = (record) => pushReceipt(core, { plugin: 'hq', ...record }).catch((e) => log('error', `launch receipt not persisted: ${e?.message ?? e}`));
  const slotOf = (l) => `${l.soul_id}\n${l.member_id}`;
  const release = (l) => {
    if (launches.get(l.launch_id) === l) launches.delete(l.launch_id);
    if (slots.get(slotOf(l)) === l.launch_id) slots.delete(slotOf(l));
  };
  const expire = () => {
    const now = core.clock.now();
    for (const l of [...launches.values()]) if (l.state === 'reserved' && l.expires <= now) release(l);
  };
  const pending = () => [...launches.values()].filter((l) => l.state === 'reserved').length;
  const within = (promise, ms) => new Promise((resolve) => {
    const timer = timers.setTimeout(() => resolve(false), ms);
    promise.then(() => { timers.clearTimeout(timer); resolve(true); });
  });
  const callerOf = (meta) => {
    if (typeof meta?.session !== 'string' || !meta.session) fail('caller_mismatch', 'no authenticated connection for this request');
    return meta.session;
  };
  const requireRunning = () => {
    const m = mode();
    if (closing) fail('host.not_running', 'HQ is stopping');
    if (m === 'safe') fail('host.safe_mode', 'safe mode: launch is unavailable');
    if (m !== 'running') fail('host.not_running', `host is ${m}`);
  };

  // Run sudo once, bounded; resolves with { code, signal, stderr } and never rejects.
  function runOnce(args, timeoutMs, stdio) {
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let stderr = '';
      const done = (r) => { if (settled) return; settled = true; timers.clearTimeout(timer); resolve(r); };
      const timer = timers.setTimeout(() => {
        try { child?.kill('SIGKILL'); } catch { /* sudo runs as root; it may not be ours to signal */ }
        done({ code: null, signal: null, timedOut: true, stderr });
      }, timeoutMs);
      try {
        child = spawn(SUDO, args, { stdio, env: { PATH: AGENT_PATH }, cwd: '/' });
      } catch (e) {
        done({ code: null, signal: null, error: e.code ?? e.message, stderr });
        return;
      }
      child.stderr?.setEncoding?.('utf8');
      child.stderr?.on('data', (d) => { if (stderr.length < 512) stderr += d; });
      child.on('error', (e) => { if (child.pid === undefined) done({ code: null, signal: null, error: e.code ?? e.message, stderr }); });
      child.once('close', (code, signal) => done({ code, signal, stderr }));
    });
  }
  const why = (r) => (r.timedOut ? 'timed out' : r.error ? `sudo could not run (${r.error})` : `sudo exited ${r.code ?? r.signal}${r.stderr.trim() ? `: ${clipLine(r.stderr.trim().split('\n')[0], 200)}` : ''}`);

  async function probeAccount(account) {
    const r = await runOnce(probeArgv(account), PROBE_TIMEOUT_MS, ['ignore', 'ignore', 'pipe']);
    if (r.code === 0) return { available: true };
    const how = r.timedOut ? `sudo did not answer within ${PROBE_TIMEOUT_MS} ms`
      : r.error ? `sudo could not run (${r.error})`
        : `sudo -n -u ${account} exited ${r.code ?? r.signal}${r.stderr.trim() ? `: ${clipLine(r.stderr.trim().split('\n')[0], 200)}` : ''}`;
    return { available: false, reason: `the provisioner's rule does not let HQ start ${account} (${how})` };
  }

  // At HQ start. Every account in parallel, each bounded by PROBE_TIMEOUT_MS.
  async function probe() {
    if (platform !== 'linux') return;
    await Promise.all(harnesses.endpoints.map(async (e) => {
      const r = await probeAccount(e.account);
      readiness.set(e.account, Object.freeze(r));
      if (!r.available) log('warn', `launch unavailable for harness account ${e.account}: ${r.reason}`);
    }));
  }

  const accounts = () => harnesses.endpoints.map((e) => ({
    account: e.account,
    ...(readiness.get(e.account) ?? { available: false, reason: platform === 'linux' ? 'not checked' : `launch needs Linux; this host is ${platform}` }),
  }));

  // One signal command as the harness account. True only when sudo ran it
  // and the shell's `exit 0` came back: the rule held and kill ran.
  async function signal(l, args, what) {
    const r = await runOnce(args, SIGNAL_TIMEOUT_MS, 'ignore');
    if (r.code === 0 && !r.timedOut && !r.error) return true;
    log('error', `${what} for launch ${l.launch_id} in ${l.account} failed: ${why(r)}`, { launch_id: l.launch_id });
    return false;
  }
  // The group to signal: the one the wrapper reported, else sudo's pid. A
  // spawn that never got a pid started nothing, so there is no group.
  const groupOf = (l) => l.pgid ?? l.sudoPid;
  const signalGroup = (l, sig) => (groupOf(l) === undefined ? Promise.resolve(true) : signal(l, groupArgv(l.account, sig, groupOf(l)), `${sig} to process group ${groupOf(l)}`));
  // Before signalling: the marker, or the end of the launch, bounded.
  const awaitGroup = async (l) => { if (l.pgid === undefined) await within(Promise.race([l.grouped.promise, l.closed.promise]), SIGNAL_TIMEOUT_MS); };
  const describeGroup = (l) => (l.pgid !== undefined ? `process group ${l.pgid} (reported by the wrapper; sudo pid ${l.sudoPid})` : `process group ${l.sudoPid} (sudo's pid; the wrapper reported none)`);

  // The first marker line is the launch's group (see the header for why the
  // first match is genuine and what a forged one could do), not stderr.
  function takeMarker(l, line) {
    if (l.pgid !== undefined) return false;
    const m = MARKER_LINE.exec(line.endsWith('\r') ? line.slice(0, -1) : line); // a pty may add a carriage return
    const n = m ? Number(m[1]) : NaN;
    if (!Number.isSafeInteger(n) || n <= 1) return false;
    l.pgid = n;
    l.grouped.resolve();
    return true;
  }

  function stderrSink(l) {
    const prefix = `agent ${l.member_id} in ${l.account} stderr: `;
    let partial = '';
    let skipping = false;
    let windowStart = core.clock.now();
    let count = 0;
    let dropped = 0;
    const emit = (line) => {
      const now = core.clock.now();
      if (now - windowStart >= STDERR_WINDOW_MS) {
        if (dropped) log('warn', `agent ${l.member_id} in ${l.account}: ${dropped} stderr lines dropped`, { launch_id: l.launch_id });
        windowStart = now;
        count = 0;
        dropped = 0;
      }
      if (count >= STDERR_LINES) { dropped += 1; return; }
      count += 1;
      log('info', `${prefix}${clipLine(line)}`, { launch_id: l.launch_id });
    };
    return (chunk) => {
      const parts = (partial + chunk).split('\n');
      partial = parts.pop();
      for (const p of parts) {
        if (skipping) { skipping = false; continue; } // the rest of a line already clipped
        if (takeMarker(l, p)) continue;
        emit(p);
      }
      if (partial.length > STDERR_LINE) {
        if (!skipping) emit(partial);
        skipping = true;
        partial = '';
      }
    };
  }

  // The agent runs: its whole life, from spawn to the receipt that it ended.
  async function lifecycle(l) {
    await Promise.race([l.exited.promise, l.halted.promise]);
    const failures = [];
    if (l.state === 'exiting') {
      // Ended on its own: what it left in its group goes too.
      await awaitGroup(l);
      if (!(await signalGroup(l, 'KILL'))) failures.push(`the KILL to ${describeGroup(l)} failed`);
    } else {
      failures.push(...(await l.stopping));
    }
    const gone = l.exit !== undefined;
    if (!gone) failures.push(`sudo (pid ${l.sudoPid}) was still running ${KILL_WAIT_MS} ms after the KILL to ${describeGroup(l)}`);
    if (!gone || !(await within(l.closed.promise, CLOSE_WAIT_MS))) {
      for (const s of [l.proc.stdin, l.proc.stdout, l.proc.stderr]) s?.destroy();
      if (gone) log('warn', `launch ${l.launch_id}: the agent's pipes did not close; HQ closed them`, { launch_id: l.launch_id });
    }
    const contained = failures.length === 0;
    if (contained) {
      l.state = 'exited';
      release(l);
    } else {
      // Fail closed: the slot stays taken until HQ restarts.
      l.state = 'uncontained';
      l.uncontained = failures.join('; ');
      log('error', `launch ${l.launch_id} of agent ${l.member_id} (${l.soul_id}) in ${l.account} is not contained: ${l.uncontained}. Check for processes of ${l.account} in ${describeGroup(l)} (pgrep -g ${groupOf(l)} -u ${l.account}), end any that remain, and check that the provisioner's sudoers rule is in place; HQ keeps this agent's slot until it restarts.`, { launch_id: l.launch_id });
    }
    if (l.socket && !l.socket.destroyed) {
      l.socket.end();
      timers.setTimeout(() => l.socket.destroy(), CLOSE_WAIT_MS)?.unref?.();
    }
    await receipt({ kind: 'hq.launch.exited', launch_id: l.launch_id, soul_id: l.soul_id, member_id: l.member_id, account: l.account, exit_code: l.exit?.code ?? null, signal: l.exit?.signal ?? null, reason: l.reason, contained });
  }

  function start(l) {
    if (launches.get(l.launch_id) !== l || l.state !== 'attaching') fail('caller_mismatch', 'no launch waits for this attach');
    if (closing) { release(l); fail('host.not_running', 'HQ is stopping'); }
    let proc;
    try {
      // detached: sudo leads a new session, so HQ's signals and terminal never reach the launch.
      proc = spawn(SUDO, agentArgv(l.account, l.soul_id, l.member_id, l.command), { stdio: ['pipe', 'pipe', 'pipe'], env: { ...l.env, [BROKER_ENV]: l.endpoint, PATH: AGENT_PATH }, cwd: '/', detached: true });
    } catch (e) {
      release(l);
      fail('host.launch_unavailable', `sudo could not be started: ${e.message}`);
    }
    const sudoPid = Number.isSafeInteger(proc.pid) && proc.pid > 1 ? proc.pid : undefined;
    Object.assign(l, { proc, sudoPid, pgid: undefined, state: 'running', started_at: core.clock.now(), env: undefined, exited: deferred(), closed: deferred(), halted: deferred(), grouped: deferred() });
    const ended = (code, signal) => {
      l.exit ??= { code, signal };
      if (l.state === 'running') { l.state = 'exiting'; l.reason = 'exited'; }
      l.exited.resolve();
    };
    proc.once('exit', ended);
    proc.once('close', (code, signal) => { ended(code, signal); l.closed.resolve(); });
    // A failed kill is an error event too; only a failed spawn ends the launch.
    proc.on('error', () => { if (proc.pid === undefined) { ended(null, null); l.closed.resolve(); } });
    for (const s of [proc.stdin, proc.stdout, proc.stderr]) s?.on('error', () => {});
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', stderrSink(l));
    l.done = lifecycle(l);
    receipt({ kind: 'hq.launch', launch_id: l.launch_id, soul_id: l.soul_id, member_id: l.member_id, adapter_id: l.adapter_id, runtime_id: l.runtime_id, account: l.account, argv_sha256: argvDigest(l.command), argv0: l.command[0] });
    return (socket) => {
      l.socket = socket;
      socket.on('error', () => {});
      socket.pipe(proc.stdin);
      // Not ended by the pipe: HQ ends the connection when the agent is gone.
      proc.stdout.pipe(socket, { end: false });
      socket.once('close', () => { terminate(l, 'attach-closed'); });
    };
  }

  // Stop one launch: a reservation is dropped, a running agent's group is
  // stopped. Resolves when its lifecycle has ended. Idempotent.
  function terminate(l, reason) {
    if (l.state === 'reserved' || l.state === 'attaching') { release(l); return Promise.resolve(); }
    if (l.state !== 'running') return l.done ?? Promise.resolve();
    l.state = 'stopping';
    l.reason = reason;
    // Resolves with what failed, if anything.
    l.stopping = (async () => {
      const failures = [];
      if (l.socket) l.socket.unpipe(l.proc.stdin);
      l.proc.stdin.end();
      try { l.proc.kill('SIGTERM'); } catch { /* EPERM: sudo runs as root */ }
      await awaitGroup(l);
      if (!(await signalGroup(l, 'TERM'))) failures.push(`the TERM to ${describeGroup(l)} failed`);
      await within(l.exited.promise, graceMs);
      if (!(await signalGroup(l, 'KILL'))) failures.push(`the KILL to ${describeGroup(l)} failed`);
      await within(l.exited.promise, KILL_WAIT_MS);
      return failures;
    })();
    l.stopping.then(l.halted.resolve);
    return l.done;
  }

  async function launch(payload, meta) {
    const caller = callerOf(meta);
    requireRunning();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((k) => !LAUNCH_KEYS.has(k))
      || typeof payload.runtime_id !== 'string' || !RUNTIME_ID.test(payload.runtime_id)) {
      fail('host.invalid_request', 'launch takes { runtime_id, command, env }');
    }
    // Inside admission's queue: the runtime cannot change while HQ decides.
    return withLiveRuntime(payload.runtime_id, caller, (rt) => {
      if (platform !== 'linux' || !configured) fail('host.launch_unavailable', `launch needs harness accounts on Linux (§9 row 16b); this host is ${platform}${configured ? '' : ' with no harnesses in HQ\'s config'}`);
      const endpoint = harnesses.accountOf(rt.adapter_id);
      if (!endpoint) fail('host.launch_unavailable', `the harness of agent ${rt.member_id} of ${rt.soul_id} (adapter ${rt.adapter_id ?? 'unknown'}) has no account in HQ's config`);
      if (rt.harness_uid !== endpoint.uid) fail('host.launch_unavailable', `runtime ${payload.runtime_id} was not admitted for account ${endpoint.account}; send Hello again`);
      const ready = readiness.get(endpoint.account);
      if (!ready?.available) fail('host.launch_unavailable', `launch is not available for account ${endpoint.account}: ${ready?.reason ?? 'not checked'}`);
      expire();
      const slot = `${rt.soul_id}\n${rt.member_id}`;
      const holder = slots.has(slot) ? launches.get(slots.get(slot)) : undefined;
      if (holder?.state === 'uncontained') {
        fail('host.launch_busy', `agent ${rt.member_id} of ${rt.soul_id} has an uncontained launch ${holder.launch_id} (${holder.uncontained}); check the processes of ${holder.account}, then restart HQ to clear it`);
      }
      if (holder) fail('host.launch_busy', `agent ${rt.member_id} of ${rt.soul_id} already has a launch (${holder.state})`);
      if (pending() >= MAX_PENDING) fail('host.launch_busy', `${MAX_PENDING} launches already wait for attach`);
      if (!SOUL_ID.test(rt.soul_id) || !MEMBER_ID.test(rt.member_id)) fail('host.invalid_request', 'the runtime\'s soul_id or member_id is not valid');
      const command = validCommand(payload.command);
      const env = validEnv(payload.env);
      const now = core.clock.now();
      const l = {
        launch_id: `ln_${core.random.hex(12)}`, attach: core.random.hex(32), state: 'reserved', expires: now + RESERVE_MS, caller,
        soul_id: rt.soul_id, member_id: rt.member_id, adapter_id: rt.adapter_id, runtime_id: payload.runtime_id, account: endpoint.account, endpoint: endpoint.path, command, env,
      };
      launches.set(l.launch_id, l);
      slots.set(slot, l.launch_id);
      return { launch_id: l.launch_id, attach: l.attach, expires_at: iso(l.expires) };
    });
  }

  async function attach(payload, meta) {
    requireRunning();
    if (meta?.takeover !== true) fail('host.invalid_request', 'launch.attach is the first and only request on a new admission connection');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 2
      || typeof payload.launch_id !== 'string' || !LAUNCH_ID.test(payload.launch_id) || typeof payload.attach !== 'string' || !TOKEN.test(payload.attach)) {
      fail('host.invalid_request', 'launch.attach takes { launch_id, attach }');
    }
    expire();
    const l = launches.get(payload.launch_id);
    const waiting = l?.state === 'reserved';
    // Compared in constant time, against a stand-in when nothing waits, and
    // spent by the first attach, right or wrong.
    const matches = sameToken(waiting ? l.attach : '0'.repeat(64), payload.attach) && waiting;
    if (waiting) l.attach = undefined;
    if (!matches) {
      if (waiting) release(l);
      fail('caller_mismatch', 'no launch waits for this attach');
    }
    l.state = 'attaching';
    return takeover({ launch_id: l.launch_id }, { open: () => start(l), cancel: () => { if (l.state === 'attaching') release(l); } });
  }

  async function stop(payload, meta) {
    const caller = callerOf(meta);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || typeof payload.launch_id !== 'string' || !LAUNCH_ID.test(payload.launch_id)) {
      fail('host.invalid_request', 'launch.stop takes { launch_id }');
    }
    const l = launches.get(payload.launch_id);
    if (l && l.caller !== caller) fail('caller_mismatch', `launch ${payload.launch_id} belongs to another connection`);
    if (l) await terminate(l, 'stopped');
    return { launch_id: payload.launch_id, state: l?.state === 'uncontained' ? 'uncontained' : 'exited' };
  }

  // Receipt every refusal, with the IDs that are safe to keep: never a
  // token, a command or an environment value.
  const receipted = (op, fn) => async (payload, meta) => {
    try {
      return await fn(payload, meta);
    } catch (e) {
      if (e instanceof HostError) {
        const p = payload && typeof payload === 'object' ? payload : {};
        await receipt({
          kind: 'hq.launch.refused', op, code: e.code,
          ...(typeof meta?.session === 'string' ? { caller: meta.session } : {}),
          ...(typeof p.runtime_id === 'string' && RUNTIME_ID.test(p.runtime_id) ? { runtime_id: p.runtime_id } : {}),
          ...(typeof p.launch_id === 'string' && LAUNCH_ID.test(p.launch_id) ? { launch_id: p.launch_id } : {}),
        });
      }
      throw e;
    }
  };
  const handlers = { launch: receipted('launch', launch), 'launch.attach': receipted('launch.attach', attach), 'launch.stop': receipted('launch.stop', stop) };

  return {
    probe,
    accounts,
    // For the admission socket: an operation of LAUNCH_OPERATIONS.
    dispatch: async (op, meta = {}) => {
      if (meta.auth !== 'entry-point') fail('host.auth_mismatch', `${op} needs auth entry-point`);
      return handlers[op](meta.payload, meta);
    },
    // At HQ stop, before the sockets close: every launch's group stopped.
    async stopAll() {
      closing = true;
      await Promise.all([...launches.values()].map((l) => terminate(l, 'hq-stopping')));
    },
    // For status: no command, no environment, no token.
    report() {
      expire();
      return {
        accounts: accounts(),
        launches: [...launches.values()].map((l) => ({
          launch_id: l.launch_id, account: l.account, soul_id: l.soul_id, member_id: l.member_id, state: l.state,
          ...(l.started_at !== undefined ? { started_at: iso(l.started_at) } : {}),
          ...(l.uncontained ? { uncontained: l.uncontained } : {}),
        })),
      };
    },
  };
}

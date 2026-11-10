// The strangler bridge (plan §9 PR 12, §8.2): HQ runs beside today's
// per-account daemon (agent-bot-identity's `agent-bot daemon`) and leaves it
// unchanged. Two things cross the bridge, both through the existing CLI:
//
// - Device status. Until enrollment moves into HQ (§9 row 15c), the device
//   HQ reports is the one the existing agent-bot enrolled. `legacySigner`
//   reads it from `agent-bot server status --json` and maps it onto HQ
//   core's three device states. Anything it cannot read is an unavailable
//   signer, which is safe mode (§4.4). It signs nothing: the HQ signer
//   (hq/signer.mjs) signs, and takes device status and enrollment from here.
// - Supervision. `legacyDaemon` probes `agent-bot daemon status --json` and
//   reports running, stopped or unknown. It starts a stopped daemon only when
//   the owner turns `supervise` on in HQ's config; it never stops one.
//
// Only the fields HQ reports are kept from either command's output. Soul
// lists, paths and device details stay out of HQ's status and store.
import { execFile } from 'node:child_process';
import { fail } from '../sdk/errors.mjs';

const TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 1 << 20;

// run(argv) → { code, stdout }. The default runs the command without a shell.
export function execRunner({ timeoutMs = TIMEOUT_MS, env } = {}) {
  return (argv) => new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, env: env ?? process.env, windowsHide: true }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout ?? ''), error: err && typeof err.code !== 'number' ? String(err.message) : undefined });
    });
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

const REVOKED = /\b(revoked|invalid_grant)\b/i;

// Map `agent-bot server status --json` onto enrolled | unenrolled | revoked.
export function deviceStateFrom(out) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return undefined;
  const remote = out.remote && typeof out.remote === 'object' ? out.remote : {};
  if (out.revoked === true || remote.revoked === true || remote.status === 'revoked' || out.device_state === 'revoked') return 'revoked';
  if (typeof out.error === 'string' && REVOKED.test(out.error)) return 'revoked';
  if (out.enrolled === false) return 'unenrolled';
  if (out.enrolled === true) return 'enrolled';
  return undefined;
}

export function legacySigner({ command = ['agent-bot', 'server', 'status', '--json'], run = execRunner() } = {}) {
  const signer = {
    source: 'agent-bot server status (legacy enrollment)',
    async deviceStatus() {
      const r = await run(command);
      const out = parseJson(r.stdout);
      const state = deviceStateFrom(out);
      if (!state) throw new Error(`${command.join(' ')} gave no device state (exit ${r.code}${r.error ? `, ${r.error}` : ''})`);
      return state;
    },
    // Enrollment stays in the existing CLI until §9 row 15c moves it into HQ.
    enroll() {
      fail('host.invalid_request', 'enroll with `agent-bot server enroll` for now; HQ enrollment arrives in §9 row 15c');
    },
    sign() { throw new Error('the legacy enrollment signs nothing; hq/signer.mjs is the HQ signer'); },
    verify() { return false; },
  };
  return signer;
}

export function legacyDaemon({
  status = ['agent-bot', 'daemon', 'status', '--json'],
  start = ['agent-bot', 'daemon', 'start'],
  supervise = false,
  run = execRunner(),
  clock = { now: () => Date.now() },
} = {}) {
  let last = { state: 'unknown', checkedAt: null };
  let starts = 0;

  async function probe() {
    const r = await run(status);
    const out = parseJson(r.stdout);
    if (out && typeof out === 'object' && typeof out.running === 'boolean') {
      last = {
        state: out.running ? 'running' : 'stopped',
        checkedAt: clock.now(),
        ...(typeof out.version === 'string' ? { version: out.version } : {}),
        ...(Number.isSafeInteger(out.pid) ? { pid: out.pid } : {}),
      };
    } else {
      last = { state: 'unknown', checkedAt: clock.now(), reason: `${status.join(' ')} gave no running flag (exit ${r.code})` };
    }
    return last;
  }

  // One supervision pass: probe, and start the daemon if it is stopped and
  // the owner turned supervision on. Unknown is never treated as stopped.
  async function tick() {
    const seen = await probe();
    if (supervise && seen.state === 'stopped') {
      starts += 1;
      const r = await run(start);
      last = { ...(await probe()), startAttempted: true, startExit: r.code };
    }
    return last;
  }

  return {
    probe,
    tick,
    report: () => ({ ...last, supervise, starts }),
  };
}

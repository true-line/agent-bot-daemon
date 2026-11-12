// What an agent can reach, run by HQ in a harness account
// (tests/hq-launch-real.test.mjs, T02). Self-contained on purpose: the test
// copies it somewhere that account can read, so it imports nothing from the
// repository.
//
//   node agent-probe.mjs '<json>'
//   { "mode": "probe", "hq": { "home", "files": {name: path}, "sockets": {name: path}, "main" },
//     "other": { "home", "endpointDir", "endpoint" } }
//   { "mode": "stubborn", "escape"?: true }
// `probe` prints one JSON line on stdout and exits; it reports its working
// directory and that directory's mode. `stubborn` prints { ready, pid, pgid,
// escaped } and then ignores SIGTERM and the end of stdin: only a KILL ends
// it. Its pgid is read from /proc/self/stat, as the launch wrapper's marker
// reads it (the wrapper execs into this process, so they are the same). With
// `escape` it first starts a child in a new session (setsid), which leaves
// the launch's process group and also ignores SIGTERM; `escaped` is its pid,
// else null.
import { execFile, spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

const input = JSON.parse(process.argv[2]);

if (input.mode === 'stubborn') {
  process.on('SIGTERM', () => {});
  process.stdin.on('end', () => {});
  process.stdin.resume();
  let escaped = null;
  if (input.escape) {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { detached: true, stdio: 'ignore' });
    child.unref();
    escaped = child.pid;
  }
  let pgid = null;
  try { pgid = Number(readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ')[2]); } catch { /* not Linux */ }
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, pgid, escaped })}\n`);
  setInterval(() => {}, 1000);
} else {
  const attempt = (fn) => { try { fn(); return { ok: true }; } catch (e) { return { ok: false, code: e.code ?? String(e.message).slice(0, 80) }; } };
  const dial = (path) => new Promise((resolve) => {
    const s = connect(path);
    const timer = setTimeout(() => { s.destroy(); resolve({ ok: false, code: 'timeout' }); }, 5000);
    s.once('connect', () => { clearTimeout(timer); s.destroy(); resolve({ ok: true }); });
    s.once('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: e.code }); });
  });
  const run = (args) => new Promise((resolve) => {
    execFile(process.execPath, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? err.signal) : 0, stderr: String(stderr).trim().split('\n')[0].slice(0, 200) });
    });
  });
  const { hq, other } = input;
  const attempts = {};
  for (const [name, path] of Object.entries(hq.files)) attempts[`read ${name}`] = attempt(() => readFileSync(path));
  attempts['list HQ state'] = attempt(() => readdirSync(hq.home));
  for (const [name, path] of Object.entries(hq.sockets)) attempts[`connect ${name}`] = await dial(path);
  attempts['list other home'] = attempt(() => readdirSync(other.home));
  attempts['list other endpoint directory'] = attempt(() => readdirSync(other.endpointDir));
  attempts['connect other endpoint'] = await dial(other.endpoint);
  attempts['run HQ status'] = await run([hq.main, 'status', '--home', hq.home]);
  attempts['run HQ signer rekey'] = await run([hq.main, 'signer', 'rekey', '--home', hq.home]);
  const controls = {
    'write own directory': attempt(() => { const f = join(process.cwd(), `.agent-probe-${process.pid}`); writeFileSync(f, 'x', { mode: 0o600 }); rmSync(f); }),
    'write own home': attempt(() => { const f = join(process.env.HOME, `.agent-probe-${process.pid}`); writeFileSync(f, 'x', { mode: 0o600 }); rmSync(f); }),
    'connect own endpoint': await dial(process.env.AGENT_BOT_SOULS_BROKER ?? '/nonexistent'),
  };
  const report = {
    uid: process.getuid(),
    cwd: process.cwd(),
    cwdMode: statSync(process.cwd()).mode & 0o7777,
    home: process.env.HOME ?? null,
    env: Object.keys(process.env).sort(),
    broker: process.env.AGENT_BOT_SOULS_BROKER ?? null,
    attempts,
    controls,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

// Harness accounts and their broker endpoints (plan §9 rows 16a and 16b; T01).
//
// One OS account per harness credential (D7 as amended by platform decision
// 53): the owner's config maps each adapter ID, the `adapter_id` of a role in
// Hello, to the account its harness runs in. One account is shared by the
// agents of every Soul on that harness, and several adapter IDs may name the
// same account.
//
// HQ must know which OS account is on a broker connection, and it must learn
// that from the host, never from a field the caller sends. Node has no
// peer-credential call, so the file system does the work: each harness
// account gets its own broker endpoint, in a directory only HQ and that
// account can enter. A connection that arrives on an endpoint is that
// account's, by the kernel's permission check on connect. That identifies the
// account, that is the harness credential, and nothing finer: two agents in
// one harness account are told apart only by the keyed proof at bind
// (hq/admission.mjs), and to the host they are one trust domain.
//
// Layout, made by the provisioner (agent-bot-machine, D1) and only verified
// here, because HQ is not root and cannot give a directory to another group:
//
//   <dir>/                    owned by HQ's account or root; not writable by
//                             group or others; others may traverse it
//   <dir>/<account>/          owned by HQ's account, group = the account's
//                             private group, mode 2750 (setgid)
//   <dir>/<account>/broker.sock   made by HQ, mode 0660; the setgid
//                             directory gives it the account's group
//
// A layout that is not exactly this is refused at start: HQ does not repair
// it, and never falls back to the shared socket for an account-bound runtime.
//
// The account's home (§9 row 16b) holds the harness's sign-in and its agents'
// working state (hq/launch.mjs starts each agent in a directory of its own
// under it). The provisioner makes it; HQ verifies it at start, beside the
// endpoint layout, and refuses to start on a home that is not a real
// directory, owned by the account's uid, with no group or other permission
// bits (0700). HQ is not root, so it cannot repair one.
//
// Linux only (row 16). macOS keeps the shared socket until row 29.
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

// The directory name predates platform PDR-0053, when these were member accounts;
// agent-bot-machine creates this path, so it stays.
export const DEFAULT_HARNESS_DIR = '/run/agent-bot-hq/members';
export const HARNESS_SOCKET = 'broker.sock';
// hq/v1 hello requested_roles[].adapter_id.
export const ADAPTER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// POSIX portable account names, as useradd accepts them.
const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;
const HARNESSES_KEYS = new Set(['dir', 'accounts']);

// config.harnesses: { dir?, accounts: { <adapter_id>: <account> } }
export function validateHarnessesConfig(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) throw new Error('HQ config: harnesses is an object');
  for (const k of Object.keys(h)) if (!HARNESSES_KEYS.has(k)) throw new Error(`HQ config: unknown key harnesses.${k}`);
  if (h.dir !== undefined && (typeof h.dir !== 'string' || !h.dir.startsWith('/') || h.dir.length > 80 || /[\0\n]/.test(h.dir))) {
    throw new Error('HQ config: harnesses.dir is an absolute path of at most 80 characters');
  }
  const a = h.accounts;
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('HQ config: harnesses.accounts maps adapter IDs to accounts');
  for (const [adapter, account] of Object.entries(a)) {
    if (!ADAPTER_ID.test(adapter)) throw new Error(`HQ config: harnesses.accounts: ${adapter} is not an adapter ID`);
    if (typeof account !== 'string' || !ACCOUNT.test(account)) throw new Error(`HQ config: harnesses.accounts.${adapter} is not an account name`);
  }
  return h;
}

// The host's record of an account: { uid, gid, groupMembers, home }. Through
// getent, so directory services count as well as /etc/passwd.
export function resolveAccount(name, { run = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }) } = {}) {
  let entry; // the account database record: name, uid, gid, home. It holds no secret.
  try { entry = run('getent', ['passwd', name]).trim().split('\n')[0].split(':'); } catch { throw new Error(`harness account ${name} does not exist on this host`); }
  const uid = Number(entry[2]);
  const gid = Number(entry[3]);
  const home = entry[5];
  if (entry[0] !== name || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || typeof home !== 'string') throw new Error(`harness account ${name}: unreadable passwd entry`);
  let groupMembers = [];
  try {
    const group = run('getent', ['group', String(gid)]).trim().split('\n')[0].split(':');
    groupMembers = (group[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  } catch { throw new Error(`harness account ${name}: its group ${gid} does not exist`); }
  return { uid, gid, groupMembers, home };
}

// The account's home: a directory, not a symlink, owned by the account, 0700.
function checkHome(account, info, lstat) {
  const home = info.home;
  if (typeof home !== 'string' || !home.startsWith('/') || home === '/') throw new Error(`harness account ${account} has no home directory of its own in its passwd entry`);
  let st;
  try { st = lstat(home); } catch { throw new Error(`home ${home} of harness account ${account} does not exist; the provisioner creates it`); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`home ${home} of harness account ${account} is not a directory`);
  if (st.uid !== info.uid) throw new Error(`home ${home} is owned by uid ${st.uid}, not ${account} (${info.uid})`);
  // Exactly 0700: no group or other bits, the owner's full access (the launch
  // shell makes the agent's directory in it), and no setuid, setgid or sticky bit.
  if ((st.mode & 0o7777) !== 0o700) throw new Error(`home ${home} has mode ${(st.mode & 0o7777).toString(8).padStart(4, '0')}; it holds the harness's sign-in and its agents' working state and must be 0700`);
  return home;
}

// Resolve and check every configured account once, its endpoint directory and
// its home. Returns { dir, endpoints: [{ account, uid, gid, path, home,
// adapters }], accountOf(adapterId) }, one endpoint per account.
export function planHarnessEndpoints(harnesses, { hqUid, platform = process.platform, resolve = resolveAccount, lstat = lstatSync } = {}) {
  if (platform !== 'linux') throw new Error(`HQ config: harnesses needs the Linux protected profile (§9 row 16); this host is ${platform}`);
  if (!Number.isSafeInteger(hqUid)) throw new Error('harness endpoints need HQ\'s own uid');
  const dir = harnesses.dir ?? DEFAULT_HARNESS_DIR;
  const stat = (path, what) => {
    let st;
    try { st = lstat(path); } catch { throw new Error(`${what} ${path} does not exist; the provisioner creates it`); }
    if (!st.isDirectory()) throw new Error(`${what} ${path} is not a directory`);
    return st;
  };
  const base = stat(dir, 'harness endpoint directory');
  if (base.uid !== hqUid && base.uid !== 0) throw new Error(`${dir} is owned by uid ${base.uid}, not HQ (${hqUid}) or root`);
  if (base.mode & 0o022) throw new Error(`${dir} is writable by group or others`);
  if (!(base.mode & 0o001)) throw new Error(`${dir} must let harness accounts traverse it (o+x)`);

  const adaptersOf = new Map(); // account → [adapter_id]
  for (const [adapter, account] of Object.entries(harnesses.accounts)) {
    if (!adaptersOf.has(account)) adaptersOf.set(account, []);
    adaptersOf.get(account).push(adapter);
  }
  const byAccount = new Map();
  const uids = new Map();
  for (const [account, adapters] of adaptersOf) {
    const info = resolve(account);
    if (info.uid === 0) throw new Error(`harness account ${account} is root`);
    if (info.uid === hqUid) throw new Error(`harness account ${account} is HQ's own account; a harness needs a separate one`);
    if (uids.has(info.uid)) throw new Error(`harness accounts ${uids.get(info.uid)} and ${account} share uid ${info.uid}`);
    uids.set(info.uid, account);
    const others = info.groupMembers.filter((m) => m !== account);
    if (others.length) throw new Error(`harness account ${account}'s group ${info.gid} also has ${others.join(', ')}; it must be a private group`);
    const endpointDir = join(dir, account);
    const st = stat(endpointDir, `endpoint directory for ${account}`);
    if (st.uid !== hqUid) throw new Error(`${endpointDir} is owned by uid ${st.uid}, not HQ (${hqUid})`);
    if (st.gid !== info.gid) throw new Error(`${endpointDir} has group ${st.gid}, not ${account}'s group ${info.gid}`);
    if ((st.mode & 0o7777) !== 0o2750) throw new Error(`${endpointDir} has mode ${(st.mode & 0o7777).toString(8)}; it must be 2750`);
    const home = checkHome(account, info, lstat);
    byAccount.set(account, Object.freeze({ account, uid: info.uid, gid: info.gid, path: join(endpointDir, HARNESS_SOCKET), home, adapters: Object.freeze([...adapters]) }));
  }
  return {
    dir,
    endpoints: [...byAccount.values()],
    accountOf: (adapterId) => (Object.hasOwn(harnesses.accounts, adapterId) ? byAccount.get(harnesses.accounts[adapterId]) : undefined),
  };
}

// After HQ made the socket: the setgid directory must have given it the
// account's group, or the harness cannot connect and nobody else may.
export function checkHarnessSocket(endpoint, { lstat = lstatSync } = {}) {
  const st = lstat(endpoint.path);
  if (!st.isSocket()) throw new Error(`${endpoint.path} is not a socket`);
  if (st.gid !== endpoint.gid) throw new Error(`${endpoint.path} has group ${st.gid}, not ${endpoint.account}'s group ${endpoint.gid}; is its directory setgid?`);
  if ((st.mode & 0o777) !== 0o660) throw new Error(`${endpoint.path} has mode ${(st.mode & 0o777).toString(8)}; it must be 0660`);
}

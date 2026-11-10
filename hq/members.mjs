// Member accounts and their broker endpoints (plan §9 row 16a; T01).
//
// HQ must know which OS account is on a member connection, and it must learn
// that from the host, never from a field the member sends. Node has no
// peer-credential call, so the file system does the work: each member account
// gets its own broker endpoint, in a directory only HQ and that account can
// enter. A connection that arrives on an endpoint is that account's, by the
// kernel's permission check on connect.
//
// Layout, made by the provisioner (agent-bot-machine, D1) and only verified
// here, because HQ is not root and cannot give a directory to another group:
//
//   <dir>/                    owned by HQ's account or root; not writable by
//                             group or others; others may traverse it
//   <dir>/<account>/          owned by HQ's account, group = the member's
//                             private group, mode 2750 (setgid)
//   <dir>/<account>/broker.sock   made by HQ, mode 0660; the setgid
//                             directory gives it the member's group
//
// A layout that is not exactly this is refused at start: HQ does not repair
// it, and never falls back to the shared socket for an account-bound member.
//
// Linux only (row 16). macOS keeps the shared socket until row 29.
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_MEMBERS_DIR = '/run/agent-bot-hq/members';
export const MEMBER_SOCKET = 'broker.sock';
const SOUL_ID = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// POSIX portable account names, as useradd accepts them.
const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;
const MEMBERS_KEYS = new Set(['dir', 'accounts']);

// config.members: { dir?, accounts: { <soul_id>: { <member_id>: <account> } } }
export function validateMembersConfig(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('HQ config: members is an object');
  for (const k of Object.keys(m)) if (!MEMBERS_KEYS.has(k)) throw new Error(`HQ config: unknown key members.${k}`);
  if (m.dir !== undefined && (typeof m.dir !== 'string' || !m.dir.startsWith('/') || m.dir.length > 80 || /[\0\n]/.test(m.dir))) {
    throw new Error('HQ config: members.dir is an absolute path of at most 80 characters');
  }
  const a = m.accounts;
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('HQ config: members.accounts maps Soul IDs to { member ID: account }');
  const seen = new Map();
  for (const [soul, members] of Object.entries(a)) {
    if (!SOUL_ID.test(soul)) throw new Error(`HQ config: members.accounts: ${soul} is not a Soul ID`);
    if (!members || typeof members !== 'object' || Array.isArray(members)) throw new Error(`HQ config: members.accounts.${soul} maps member IDs to accounts`);
    for (const [member, account] of Object.entries(members)) {
      if (!MEMBER_ID.test(member)) throw new Error(`HQ config: members.accounts.${soul}: ${member} is not a member ID`);
      if (typeof account !== 'string' || !ACCOUNT.test(account)) throw new Error(`HQ config: members.accounts.${soul}.${member} is not an account name`);
      // One account, one member: two members in one account are one trust domain.
      if (seen.has(account)) throw new Error(`HQ config: account ${account} is given to both ${seen.get(account)} and ${soul}/${member}; each member needs its own account`);
      seen.set(account, `${soul}/${member}`);
    }
  }
  return m;
}

// The host's record of an account: { uid, gid, groupMembers }. Through
// getent, so directory services count as well as /etc/passwd.
export function resolveAccount(name, { run = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }) } = {}) {
  let passwd;
  try { passwd = run('getent', ['passwd', name]).trim().split('\n')[0].split(':'); } catch { throw new Error(`member account ${name} does not exist on this host`); }
  const uid = Number(passwd[2]);
  const gid = Number(passwd[3]);
  if (passwd[0] !== name || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) throw new Error(`member account ${name}: unreadable passwd entry`);
  let groupMembers = [];
  try {
    const group = run('getent', ['group', String(gid)]).trim().split('\n')[0].split(':');
    groupMembers = (group[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  } catch { throw new Error(`member account ${name}: its group ${gid} does not exist`); }
  return { uid, gid, groupMembers };
}

// Resolve and check every configured account, and its endpoint directory.
// Returns { dir, endpoints: [{ account, uid, gid, path }], accountOf(soul, member) }.
export function planMemberEndpoints(members, { hqUid, platform = process.platform, resolve = resolveAccount, lstat = lstatSync } = {}) {
  if (platform !== 'linux') throw new Error(`HQ config: members needs the Linux protected profile (§9 row 16); this host is ${platform}`);
  if (!Number.isSafeInteger(hqUid)) throw new Error('member endpoints need HQ\'s own uid');
  const dir = members.dir ?? DEFAULT_MEMBERS_DIR;
  const stat = (path, what) => {
    let st;
    try { st = lstat(path); } catch { throw new Error(`${what} ${path} does not exist; the provisioner creates it`); }
    if (!st.isDirectory()) throw new Error(`${what} ${path} is not a directory`);
    return st;
  };
  const base = stat(dir, 'members directory');
  if (base.uid !== hqUid && base.uid !== 0) throw new Error(`${dir} is owned by uid ${base.uid}, not HQ (${hqUid}) or root`);
  if (base.mode & 0o022) throw new Error(`${dir} is writable by group or others`);
  if (!(base.mode & 0o001)) throw new Error(`${dir} must let member accounts traverse it (o+x)`);

  const byMember = new Map();
  const endpoints = [];
  const uids = new Map();
  for (const [soul, map] of Object.entries(members.accounts)) {
    for (const [member, account] of Object.entries(map)) {
      const info = resolve(account);
      if (info.uid === 0) throw new Error(`member account ${account} is root`);
      if (info.uid === hqUid) throw new Error(`member account ${account} is HQ's own account; a member needs a separate one`);
      if (uids.has(info.uid)) throw new Error(`member accounts ${uids.get(info.uid)} and ${account} share uid ${info.uid}`);
      uids.set(info.uid, account);
      const others = info.groupMembers.filter((m) => m !== account);
      if (others.length) throw new Error(`member account ${account}'s group ${info.gid} also has ${others.join(', ')}; it must be a private group`);
      const home = join(dir, account);
      const st = stat(home, `endpoint directory for ${account}`);
      if (st.uid !== hqUid) throw new Error(`${home} is owned by uid ${st.uid}, not HQ (${hqUid})`);
      if (st.gid !== info.gid) throw new Error(`${home} has group ${st.gid}, not ${account}'s group ${info.gid}`);
      if ((st.mode & 0o7777) !== 0o2750) throw new Error(`${home} has mode ${(st.mode & 0o7777).toString(8)}; it must be 2750`);
      const entry = Object.freeze({ account, uid: info.uid, gid: info.gid, path: join(home, MEMBER_SOCKET) });
      endpoints.push(entry);
      byMember.set(`${soul}\n${member}`, entry);
    }
  }
  return { dir, endpoints, accountOf: (soul, member) => byMember.get(`${soul}\n${member}`) };
}

// After HQ made the socket: the setgid directory must have given it the
// member's group, or the member cannot connect and nobody else may.
export function checkMemberSocket(endpoint, { lstat = lstatSync } = {}) {
  const st = lstat(endpoint.path);
  if (!st.isSocket()) throw new Error(`${endpoint.path} is not a socket`);
  if (st.gid !== endpoint.gid) throw new Error(`${endpoint.path} has group ${st.gid}, not ${endpoint.account}'s group ${endpoint.gid}; is its directory setgid?`);
  if ((st.mode & 0o777) !== 0o660) throw new Error(`${endpoint.path} has mode ${(st.mode & 0o777).toString(8)}; it must be 0660`);
}

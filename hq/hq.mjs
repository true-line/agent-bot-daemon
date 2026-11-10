// The HQ skeleton (plan §9 PR 12): HQ core on the SDK's plugin host, with a
// durable store, the control socket and owner sessions, the admission socket,
// profile reporting, and hq/v1 Hello, Admit, Equip, Ready and Lease. It runs
// beside the existing per-account daemon and leaves it unchanged (strangler,
// RISK-008 in the platform's register); hq/legacy.mjs is the bridge.
//
// Bootstrap follows §4.4 through the SDK host: HQ core reads device status
// first (here from the legacy enrollment, through the HQ signer), an
// unenrolled device or an unavailable signer is safe mode, a revoked one is
// device_revoked, and plugins start only after that. The sockets open in every mode, so the owner
// can always ask for status.
//
// Layout of the state directory (0700; HQ's account):
//   config.json     owner-written settings, read-only to HQ (optional)
//   store.json      the authoritative store (hq/store.mjs), 0600
//   signer/         the HQ signer's pin, and its key file under the software
//                   backend only (hq/signer.mjs), 0700
//   control.sock    hq/v1 for the owner, 0600
//   admission.sock  hq/v1 for Soul entry points, 0600
//   broker.sock     member broker frames, served by one plugin (§4.9), 0600
// A member account's own endpoint is outside this directory (hq/members.mjs).
//
// Interim account (D4's stated risk, plan §10.3 HQ-RISK-07): until
// agent-bot-machine provisions _agent-bot-hq (D6, its S6 slice), HQ runs in
// the owner's `user` account, so any process there, members included, can
// read the store and connect to every socket. HQ reports managed-cooperative
// and says why; the skeleton holds no credentials and no grants.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../sdk/host.mjs';
import { fail } from '../sdk/errors.mjs';
import { createCore, pushReceipt, revokeDevice } from '../sdk/services.mjs';
import { admissionPlugin } from './admission.mjs';
import { tasksPlugin } from './tasks.mjs';
import { legacyDaemon, legacySigner } from './legacy.mjs';
import { detectProfile } from './profile.mjs';
import { backendFromConfig, createSigner, validateSignerConfig } from './signer.mjs';
import { createEnrollment, validateEnrollmentConfig } from './enrollment.mjs';
import { loadPlugins } from './plugins.mjs';
import { checkSocketPath, listenSocket } from './socket.mjs';
import { checkMemberSocket, planMemberEndpoints, validateMembersConfig } from './members.mjs';
import { coreTable, CORE_PLUGIN, ensurePrivateDir, openStore } from './store.mjs';

export const HQ_VERSION = '0.1.0';
const CONFIG_KEYS = new Set(['standalone', 'leaseTtlMs', 'acceptedDefinitions', 'concurrentWriters', 'legacy', 'signer', 'features', 'enrollment', 'members']);
const FEATURE_KEYS = new Set(['hardwareSigner']);
const LEGACY_KEYS = new Set(['supervise', 'probeIntervalMs']);
const DEFAULT_PROBE_MS = 30_000;

export const cryptoRandom = () => ({ bytes: (n) => randomBytes(n), hex: (n = 16) => randomBytes(n).toString('hex') });

// No identity-service link yet: it arrives hardened from agent-bot-identity
// (§9 PR 10) and HQ resolves credential references in PR 18. Until then every
// credential waits with credential_unavailable, as an outage would (R9).
export function unlinkedIdentity() {
  const refuse = () => fail('credential_unavailable', 'HQ has no identity-service link yet (§9 PRs 10 and 18)');
  return { link: 'not-linked', keySet: [], check: refuse, call: async () => refuse(), mint: async () => refuse(), onRevoke() {} };
}

export function readConfig(home, { uid = process.getuid?.() } = {}) {
  const path = join(home, 'config.json');
  if (!existsSync(path)) return {};
  const st = statSync(path);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${path} is owned by uid ${st.uid}, not HQ's uid ${uid}`);
  if (st.mode & 0o022) throw new Error(`${path} is writable by group or others; HQ refuses it`);
  return validateConfig(JSON.parse(readFileSync(path, 'utf8')));
}

export function validateConfig(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('HQ config is a JSON object');
  for (const k of Object.keys(c)) if (!CONFIG_KEYS.has(k)) throw new Error(`HQ config: unknown key ${k}`);
  if (c.standalone !== undefined && typeof c.standalone !== 'boolean') throw new Error('HQ config: standalone is a boolean');
  if (c.leaseTtlMs !== undefined && !(Number.isSafeInteger(c.leaseTtlMs) && c.leaseTtlMs >= 1000)) throw new Error('HQ config: leaseTtlMs is an integer of at least 1000');
  if (c.acceptedDefinitions !== undefined) {
    const a = c.acceptedDefinitions;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('HQ config: acceptedDefinitions maps Soul IDs to digest lists');
    for (const [soul, list] of Object.entries(a)) {
      if (!/^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(soul)) throw new Error(`HQ config: ${soul} is not a Soul ID`);
      if (!Array.isArray(list) || list.some((d) => typeof d !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(d))) throw new Error(`HQ config: ${soul} needs a list of sha256: digests`);
    }
  }
  if (c.concurrentWriters !== undefined && (!Array.isArray(c.concurrentWriters)
    || !c.concurrentWriters.every((w) => typeof w === 'string' && w.length > 0 && w.length <= 256))) {
    throw new Error('HQ config: concurrentWriters is a list of workspaces');
  }
  // Feature flags, all off by default. hardwareSigner gates the helper
  // backend (a TPM or Secure Enclave key): it is experimental until its
  // helpers are qualified on real hardware, and nothing else waits on it.
  if (c.features !== undefined) {
    if (!c.features || typeof c.features !== 'object' || Array.isArray(c.features)) throw new Error('HQ config: features is an object');
    for (const [k, v] of Object.entries(c.features)) {
      if (!FEATURE_KEYS.has(k)) throw new Error(`HQ config: unknown key features.${k}`);
      if (typeof v !== 'boolean') throw new Error(`HQ config: features.${k} is a boolean`);
    }
  }
  if (c.enrollment !== undefined) validateEnrollmentConfig(c.enrollment);
  if (c.members !== undefined) validateMembersConfig(c.members);
  if (c.signer !== undefined) {
    validateSignerConfig(c.signer);
    if (c.signer.backend === 'helper' && c.features?.hardwareSigner !== true) {
      throw new Error('HQ config: the helper signer backend is behind a feature flag; set features.hardwareSigner to true to use it');
    }
  }
  if (c.legacy !== undefined) {
    if (!c.legacy || typeof c.legacy !== 'object' || Array.isArray(c.legacy)) throw new Error('HQ config: legacy is an object');
    for (const k of Object.keys(c.legacy)) if (!LEGACY_KEYS.has(k)) throw new Error(`HQ config: unknown key legacy.${k}`);
    if (c.legacy.supervise !== undefined && typeof c.legacy.supervise !== 'boolean') throw new Error('HQ config: legacy.supervise is a boolean');
    if (c.legacy.probeIntervalMs !== undefined && !(Number.isSafeInteger(c.legacy.probeIntervalMs) && c.legacy.probeIntervalMs >= 1000)) throw new Error('HQ config: legacy.probeIntervalMs is an integer of at least 1000');
  }
  return c;
}

export function createHQ({
  home,
  schemas,                       // pinned schemas by name: hq/v1 (admission.mjs SCHEMA_NAMES), task/v1 and wire/v1 (tasks.mjs TASK_SCHEMA_NAMES, TASK_WIRE_SCHEMA_NAMES)
  config,                        // defaults to <home>/config.json
  signer,                        // defaults to the HQ signer on the config's key backend (hq/signer.mjs)
  enrollment,                    // where device status and enrollment come from: the config's source by
                                 // default (legacy bridge, or hq/enrollment.mjs); may be a function of the signer
  legacy,                        // defaults to legacyDaemon with the config's supervise flag
  clock = { now: () => Date.now() },
  random = cryptoRandom(),
  platform = process.platform,
  account = userInfo().username,
  uid = process.getuid?.(),
  accounts,                      // how a member account name resolves to { uid, gid, groupMembers }
                                 // (hq/members.mjs resolveAccount by default)
  plugins = [],                  // plugin objects (tests); installed ones come from pluginsDir
  pluginsDir,                    // installed plugins, each checked against `pins` (§4.5)
  pins = { plugins: [] },        // governance/plugins.json
  devPlugins,                    // --dev-plugins: loaded without pins, always reported
  initTimeoutMs,
  stopDeadlineMs,
} = {}) {
  if (!home) throw new TypeError('createHQ needs a state directory (home)');
  for (const p of plugins) if (p?.name === CORE_PLUGIN) throw new Error(`no plugin may be named ${CORE_PLUGIN}: HQ core's tables use that name`);

  let core;
  let host;
  let store;
  let sockets = [];
  let timer;
  let profileInfo;
  let legacyRunner = legacy;
  let running = false;
  let firstTick = Promise.resolve();
  let pluginLoad = [];
  // Member accounts (§9 row 16a): the endpoints HQ opens, and which account
  // each live broker connection arrived from. A connection on the shared
  // broker socket has no entry.
  let memberPlan = { endpoints: [], accountOf: () => undefined };
  const brokerCallers = new Map();

  const paths = { home, control: join(home, 'control.sock'), admission: join(home, 'admission.sock'), broker: join(home, 'broker.sock') };

  function openSession() {
    const id = `os_${random.hex(12)}`;
    coreTable(core, 'sessions').set(id, { opened_at: clock.now(), account, auth: 'owner' });
    store.persist().catch((e) => core.logs.push({ level: 'error', plugin: 'hq', at: clock.now(), message: `owner session ${id} not persisted: ${e.message}` }));
    return id;
  }
  function closeSession(id) {
    const rows = coreTable(core, 'sessions');
    const s = rows.get(id);
    if (!s || s.closed_at) return;
    rows.set(id, { ...s, closed_at: clock.now() });
    store.persist().catch(() => {});
  }
  const openOwnerSessions = () => [...coreTable(core, 'sessions').values()].filter((s) => !s.closed_at).length;

  // One legacy pass: probe (and maybe start) the old daemon, and pick up a
  // device revocation the legacy enrollment now reports (§4.7).
  async function legacyTick() {
    try { await legacyRunner.tick(); } catch (e) { core.logs.push({ level: 'warn', plugin: 'hq', at: clock.now(), message: `legacy probe failed: ${e.message}` }); }
    if (host.mode === 'running') {
      try {
        if ((await signer.deviceStatus()) === 'revoked') revokeDevice(core, 'the enrollment reports the device revoked');
      } catch { /* an unreadable signer at runtime changes nothing; status shows the last probe */ }
    }
  }

  // The task deadline sweep (hq/tasks.mjs), on the same interval as the
  // legacy probe. A failed sweep is logged and retried on the next pass.
  async function sweepTasks() {
    const tasks = host.mode === 'running' ? host.provided('hq-tasks') : undefined;
    if (!tasks) return [];
    try { return await tasks.expire(); } catch (e) {
      core.logs.push({ level: 'warn', plugin: 'hq', at: clock.now(), message: `task sweep failed: ${e.message}` });
      return [];
    }
  }

  async function start() {
    if (running) throw new Error('HQ is already running');
    ensurePrivateDir(home, { uid });
    const cfg = validateConfig(config ?? readConfig(home, { uid }));
    // Enrollment events become receipts (an enrollment only starts once HQ is up).
    const onEnrollmentEvent = (e) => { if (core) pushReceipt(core, { plugin: 'hq', ...e }).catch(() => {}); };
    enrollment ??= cfg.enrollment?.source === 'hq'
      ? (s) => createEnrollment({ home, signer: s, ...(cfg.enrollment.server ? { server: cfg.enrollment.server } : {}), uid, clock, onEvent: onEnrollmentEvent })
      : legacySigner();
    signer ??= createSigner({ home, backend: backendFromConfig(cfg.signer, { home, uid }), enrollment, uid, clock });
    const signerReport = () => (typeof signer.report === 'function' ? signer.report() : undefined);
    profileInfo = detectProfile({ platform, account, standalone: cfg.standalone === true, keyStorage: signerReport()?.key_storage });
    legacyRunner ??= legacyDaemon({ supervise: cfg.legacy?.supervise === true, clock });

    memberPlan = cfg.members
      ? planMemberEndpoints(cfg.members, { hqUid: uid, platform, ...(accounts ? { resolve: accounts } : {}) })
      : { endpoints: [], accountOf: () => undefined };
    if (platform !== 'win32') for (const p of [paths.control, paths.admission, paths.broker, ...memberPlan.endpoints.map((e) => e.path)]) checkSocketPath(p, platform);
    store = openStore(home, { uid });
    core = createCore({
      clock, random, signer,
      profile: profileInfo.profile,
      identity: unlinkedIdentity(),
      persist: () => store.persist(),
      config: {
        'hq-admission': { acceptedDefinitions: cfg.acceptedDefinitions ?? {}, ...(cfg.leaseTtlMs ? { leaseTtlMs: cfg.leaseTtlMs } : {}) },
        'hq-tasks': { concurrentWriters: cfg.concurrentWriters ?? [] },
      },
    });
    store.load(core);
    // Sessions left open by a crash are closed now; they cannot be live.
    for (const [id, s] of coreTable(core, 'sessions')) if (!s.closed_at) coreTable(core, 'sessions').set(id, { ...s, closed_at: clock.now(), closed_by: 'restart' });

    // Installed plugins: digests checked against the pins before any plugin
    // code runs. A refused plugin never reaches the host; status and a
    // receipt say why.
    const admission = admissionPlugin({
      schemas,
      profileReasons: () => profileInfo.reasons,
      memberAccount: (soul, member) => memberPlan.accountOf(soul, member),
      callerOf: (connection) => brokerCallers.get(connection),
    });
    const builtIn = [admission, tasksPlugin({ schemas }), ...plugins];
    pluginLoad = [];
    const accepted = [];
    const taken = new Set([CORE_PLUGIN, ...builtIn.map((p) => p.name)]);
    const available = Object.fromEntries(builtIn.map((p) => [p.name, p.version]));
    for (const [dir, dev] of [[pluginsDir, false], [devPlugins, true]]) {
      if (!dir) continue;
      const out = await loadPlugins({ dir, pins, dev, available });
      pluginLoad.push(...out.report);
      for (const { plugin, entry } of out.loaded) {
        if (taken.has(plugin.name)) { Object.assign(entry, { state: 'refused', reason: `the name ${plugin.name} is taken` }); continue; }
        taken.add(plugin.name);
        available[plugin.name] = plugin.version;
        accepted.push(plugin);
      }
    }
    for (const r of pluginLoad.filter((x) => x.state === 'refused')) await pushReceipt(core, { plugin: 'hq', kind: 'hq.plugin.refused', name: r.name, reason: r.reason });

    host = createHost({
      plugins: [...builtIn, ...accepted],
      core,
      ...(initTimeoutMs ? { initTimeoutMs } : {}),
      ...(stopDeadlineMs ? { stopDeadlineMs } : {}),
      extraStatus: () => ({
        hq: {
          version: HQ_VERSION,
          account,
          profileReasons: profileInfo.reasons,
          sockets: {
            control: paths.control, admission: paths.admission, broker: paths.broker,
            access: 'file mode 0600 in a 0700 directory (no peer-credential check yet)',
            ...(memberPlan.endpoints.length ? { members: memberPlan.endpoints.map((e) => ({ account: e.account, path: e.path })), memberAccess: 'one endpoint per member account, mode 0660 in a 2750 directory of the member\'s private group' } : {}),
          },
          ownerSessions: openOwnerSessions(),
          pluginLoad,
          ...(signerReport() ? { signer: signerReport() } : {}),
          features: { hardwareSigner: cfg.features?.hardwareSigner === true },
          ...(signer.enrollmentProgress?.() ? { enrollment: signer.enrollmentProgress() } : {}),
          ...(devPlugins ? { devPlugins } : {}),
        },
        legacy: legacyRunner.report(),
      }),
    });
    await host.start();

    try {
      sockets = [
        await listenSocket({ path: paths.control, auth: 'owner', dispatch: host.dispatch, core, newSession: openSession, endSession: closeSession }),
        await listenSocket({ path: paths.admission, auth: 'entry-point', dispatch: host.dispatch, core, newSession: () => `ep_${random.hex(12)}`, endSession: () => {} }),
        // Each frame goes to the plugin serving the broker; `op` is the kind.
        await listenSocket({
          path: paths.broker, auth: 'member', core,
          dispatch: (kind, { payload, session }) => host.brokerAccept(kind, payload, { connection: session }),
          newSession: () => `bc_${random.hex(12)}`,
          endSession: (connection) => { host.brokerClosed(connection); },
        }),
      ];
      // One endpoint per member account. The account is recorded before the
      // connection's first frame and dropped when it closes.
      for (const endpoint of memberPlan.endpoints) {
        sockets.push(await listenSocket({
          path: endpoint.path, auth: 'member', core, mode: 0o660,
          dispatch: (kind, { payload, session }) => host.brokerAccept(kind, payload, { connection: session }),
          newSession: () => {
            const connection = `bc_${random.hex(12)}`;
            brokerCallers.set(connection, Object.freeze({ account: endpoint.account, uid: endpoint.uid }));
            return connection;
          },
          endSession: (connection) => { brokerCallers.delete(connection); host.brokerClosed(connection); },
        }));
        checkMemberSocket(endpoint);
      }
    } catch (e) {
      for (const s of sockets) await s.close();
      sockets = [];
      await host.stop({ reason: 'socket failed' }).catch(() => {});
      throw e;
    }
    running = true;
    await pushReceipt(core, { plugin: 'hq', kind: 'hq.started', mode: host.mode, version: HQ_VERSION });
    // The first legacy pass runs in the background: the legacy CLI can be
    // slow, and HQ answers status before it finishes (legacy state "unknown").
    firstTick = legacyTick();
    const every = cfg.legacy?.probeIntervalMs ?? DEFAULT_PROBE_MS;
    timer = setInterval(() => { legacyTick(); sweepTasks(); }, every);
    timer.unref?.();
    return host.status();
  }

  async function stop({ reason = 'shutdown' } = {}) {
    if (!running) return [];
    running = false;
    clearInterval(timer);
    await firstTick;
    for (const s of sockets) await s.close();
    sockets = [];
    const report = await host.stop({ reason });
    for (const [id, s] of coreTable(core, 'sessions')) if (!s.closed_at) coreTable(core, 'sessions').set(id, { ...s, closed_at: clock.now() });
    await pushReceipt(core, { plugin: 'hq', kind: 'hq.stopped', reason });
    return report;
  }

  return {
    start,
    stop,
    paths,
    status: () => host.status(),
    legacyTick,
    sweepTasks,
    // Resolves when the first legacy pass after start has finished.
    settled: () => firstTick,
    get host() { return host; },
    get core() { return core; },
  };
}

// The plugin host (plan §4.2, §4.4): resolve, identity-first bootstrap,
// init and start in dependency order, stop in reverse under a deadline,
// registration, and hq/v1 dispatch with auth.
//
// Identity is HQ core, not a plugin (PDR-0027): the host reads device status
// from the signer itself and answers status, device.status and device.enroll.
// No plugin can register those operations, and agent-bot-identity's plugin
// registers member surfaces (tools, commands, hooks) like any other.
//
// This is the seam the platform registers to agent-bot-daemon as
// `hq-plugin-contract`. The test host runs it on in-memory services; the
// real HQ (§9 PR 12) runs the same host on its store, control socket and
// signer. Plugins add no trust boundary: they all run in HQ's trust domain,
// which is why the host, not the plugin, owns dispatch and auth.
import { validateCommand, validateTool } from './declarations.mjs';
import { fail, HostError } from './errors.mjs';
import { HQ_OPERATIONS, SAFE_MODE_OPERATIONS, ADMISSION_OPERATIONS } from './operations.mjs';
import { HOST_API, supportedHostApis, validateManifest } from './plugin.mjs';
import { satisfies } from './semver.mjs';
import { bindServices, createCore, dropSubscriptions, dropTokens, DEVICE_STATES, pushReceipt, revokeDevice } from './services.mjs';
import { parseStrict } from './wire/strict-json.mjs';

const KIND = /^[a-z][a-z0-9_.-]{0,63}$/;
const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BROKER = 'broker';
const ADAPTER_CLASSES = ['inference', 'service'];
// Operations HQ core answers itself; a plugin registering one is refused.
const CORE_OPERATIONS = Object.freeze({ status: 'hq', 'device.status': 'hq', 'device.enroll': 'hq' });

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HostError('host.timeout', `${what} exceeded ${ms} ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

const describe = (e) => (e instanceof HostError ? `${e.code}: ${e.message}` : e?.message ?? String(e));

export function createHost({
  plugins = [],
  hostApi = HOST_API,
  initTimeoutMs = 10_000,
  stopDeadlineMs = 5_000,
  core = createCore(),
  services = {},
  // HQ adds its own status fields (profile reasons, sockets, the legacy
  // daemon); they are merged into every status answer.
  extraStatus,
} = {}) {
  const byName = new Map();
  for (const p of plugins) {
    validateManifest(p);
    if (byName.has(p.name)) fail('host.duplicate_plugin', `two plugins are named ${p.name}`, { name: p.name });
    byName.set(p.name, p);
  }

  const registries = { hq: new Map(), servers: new Map(), kinds: new Map(), adapters: new Map(), tools: new Map(), commands: new Map(), hooks: new Map(), probes: new Map() };
  const states = new Map();      // name → { state, reason }
  const provided = new Map();    // name → provides object
  const contexts = new Map();
  const leases = new Map();      // name → { live, why } for the plugin's current context
  let order = [];
  let started = [];
  let mode = 'created';          // created | starting | running | safe | device_revoked | stopping | stopped
  let modeReason;
  let admissions = false;
  let device;

  // Revocation at runtime (§4.7): not safe mode; admission and local work continue.
  core.onDeviceRevoked.push(() => {
    if (mode === 'running') { mode = 'device_revoked'; modeReason = 'device revoked: re-enroll'; }
    device = 'revoked';
  });

  const setState = (name, state, reason) => states.set(name, reason === undefined ? { state } : { state, reason });
  const requiresOf = (p) => Object.keys(p.requires);
  const optionalPresent = (p) => Object.entries(p.optional).filter(([d, r]) => byName.has(d) && satisfies(byName.get(d).version, r)).map(([d]) => d);
  const edgesOf = (p) => [...requiresOf(p), ...optionalPresent(p)].filter((d) => byName.has(d));

  // Mark a plugin degraded and every plugin that requires it, transitively.
  function degrade(name, reason) {
    const cur = states.get(name);
    if (cur?.state === 'degraded') return;
    setState(name, 'degraded', reason);
    for (const p of byName.values()) if (requiresOf(p).includes(name)) degrade(p.name, `dependency ${name} degraded`);
  }

  function resolve() {
    states.clear();
    for (const p of byName.values()) setState(p.name, 'resolved');
    const apis = supportedHostApis(hostApi);
    for (const p of byName.values()) {
      if (!apis.includes(p.hostApi)) { setState(p.name, 'degraded', `hostApi ${p.hostApi} unsupported (host supports ${apis.join(', ')})`); continue; }
      for (const [dep, range] of Object.entries(p.requires)) {
        const d = byName.get(dep);
        if (!d) { setState(p.name, 'degraded', `requires ${dep}, which is not installed`); break; }
        if (!satisfies(d.version, range)) { setState(p.name, 'degraded', `requires ${dep} ${range}, installed ${d.version}`); break; }
      }
    }
    // Kahn's algorithm over requires and satisfied optional edges.
    const indegree = new Map([...byName.keys()].map((n) => [n, 0]));
    for (const p of byName.values()) indegree.set(p.name, edgesOf(p).length);
    const ready = [...byName.keys()].filter((n) => indegree.get(n) === 0).sort();
    const sorted = [];
    while (ready.length) {
      const n = ready.shift();
      sorted.push(n);
      for (const p of byName.values()) {
        if (edgesOf(p).includes(n)) {
          indegree.set(p.name, indegree.get(p.name) - 1);
          if (indegree.get(p.name) === 0) { ready.push(p.name); ready.sort(); }
        }
      }
    }
    const cyclic = [...byName.keys()].filter((n) => !sorted.includes(n)).sort();
    const reaches = (from, to, seen = new Set()) => edgesOf(byName.get(from)).some((d) => d === to || (!seen.has(d) && cyclic.includes(d) && (seen.add(d), reaches(d, to, seen))));
    for (const n of cyclic) setState(n, 'degraded', reaches(n, n) ? 'dependency cycle' : 'depends on a dependency cycle');
    for (const n of [...states.keys()]) {
      const s = states.get(n);
      if (s.state === 'degraded') { setState(n, 'resolved'); degrade(n, s.reason); }
    }
    order = [...sorted, ...cyclic];
  }

  const revokeLease = (name, why) => { const l = leases.get(name); if (l?.live) { l.live = false; l.why = why; } };

  function register(registry, plugin, key, value, label, lease) {
    if (!lease.live) fail('host.context_revoked', `${plugin}: this context is no longer live (${lease.why})`);
    if (core.phases.get(plugin) !== 'init') fail('host.registration_closed', `${plugin}: ${label} registration is only allowed during init`);
    // A name has one registration. The same plugin registering it twice is
    // refused too: a re-init starts from cleared registrations, so a second
    // call within one init is a mistake, not a replacement (#94).
    const owner = registry.get(key);
    if (owner) fail('host.duplicate_registration', `${label} ${key} is already registered by ${owner.plugin}`, { key, owner: owner.plugin });
    registry.set(key, { ...value, plugin });
  }

  function makeContext(p, lease) {
    const name = p.name;
    const fn = (v, what) => { if (typeof v !== 'function') fail('host.invalid_request', `${name}: ${what} must be a function`); };
    const str = (v, what) => { if (typeof v !== 'string' || !v) fail('host.invalid_request', `${name}: ${what} must be a non-empty string`); };
    const deps = {};
    for (const d of [...requiresOf(p), ...optionalPresent(p)]) if (provided.has(d) && states.get(d)?.state !== 'degraded') deps[d] = provided.get(d);
    const ctx = {
      name,
      version: p.version,
      services: bindServices(core, p, services, lease),
      deps: Object.freeze(deps),
      hq: Object.freeze({
        register({ op, auth, schema, handler } = {}) {
          if (!(op in HQ_OPERATIONS)) fail('host.unknown_operation', `${name}: ${op} is not an hq/v1 operation`, { op });
          if (op in CORE_OPERATIONS) fail('host.duplicate_registration', `${op} is answered by HQ core`, { key: op, owner: CORE_OPERATIONS[op] });
          if (auth !== HQ_OPERATIONS[op]) fail('host.auth_mismatch', `${name}: ${op} needs auth ${HQ_OPERATIONS[op]}, not ${auth}`, { op, auth, expected: HQ_OPERATIONS[op] });
          fn(handler, `${op} handler`);
          register(registries.hq, name, op, { op, auth, schema, handler }, 'operation', lease);
        },
      }),
      broker: Object.freeze({
        registerKind({ kind, schema, consume } = {}) {
          if (typeof kind !== 'string' || !KIND.test(kind)) fail('host.invalid_request', `${name}: kind ${JSON.stringify(kind)} must match ${KIND}`);
          fn(consume, `${kind} consume`);
          register(registries.kinds, name, kind, { kind, schema, consume }, 'message kind', lease);
        },
        // The member broker socket (§4.9): one plugin serves it. HQ core
        // hands it every frame, and calls `closed(connection)` when a
        // connection ends so the plugin can drop that connection's binding.
        serve({ accept, closed } = {}) {
          fn(accept, 'broker accept');
          if (closed !== undefined) fn(closed, 'broker closed');
          register(registries.servers, name, BROKER, { accept, closed }, 'broker server', lease);
        },
        // Hand a message to the kind's consumer with the bound runtime. Only
        // the serving plugin, only while the host runs; the consumer gets the
        // runtime ID and nothing of the connection or its binding.
        async deliver(kind, message, { runtime_id: runtimeId } = {}) {
          if (!lease.live) fail('host.context_revoked', `${name}: this context is no longer live (${lease.why})`);
          if (registries.servers.get(BROKER)?.plugin !== name) fail('host.auth_mismatch', `${name}: only the plugin serving the broker delivers`);
          if (!['running', 'device_revoked'].includes(mode) || states.get(name)?.state !== 'running') fail('host.not_running', `${name}: delivery needs a running host and plugin`);
          if (typeof runtimeId !== 'string' || !RUNTIME_ID.test(runtimeId)) fail('host.invalid_request', `${name}: delivery names the bound runtime_id`);
          const reg = typeof kind === 'string' ? registries.kinds.get(kind) : undefined;
          if (!reg) fail('host.unknown_kind', `no plugin consumes ${JSON.stringify(kind)}`, { kind });
          if (states.get(reg.plugin)?.state !== 'running') fail('host.plugin_degraded', `${reg.plugin} is ${states.get(reg.plugin)?.state}`, { plugin: reg.plugin, ...states.get(reg.plugin) });
          return reg.consume(structuredClone(message), Object.freeze({ runtime_id: runtimeId }));
        },
        registerAdapter({ id, class: cls, validate, call, lookup } = {}) {
          str(id, 'adapter id');
          if (!ADAPTER_CLASSES.includes(cls)) fail('host.invalid_request', `${name}: adapter class is one of ${ADAPTER_CLASSES.join(', ')}`);
          fn(validate, `${id} validate`);
          fn(call, `${id} call`);
          if (lookup !== undefined) fn(lookup, `${id} lookup`);
          register(registries.adapters, name, id, { id, class: cls, validate, call, lookup }, 'adapter', lease);
        },
      }),
      // Member surfaces (§4.2.1, §4.2.2): the whole declaration is checked
      // before the lease and phase, so a malformed one is refused the same
      // way at any time.
      tools: Object.freeze({ register(tool) { const t = validateTool(name, tool); register(registries.tools, name, t.name, { tool: t }, 'tool', lease); } }),
      commands: Object.freeze({ register(cmd) { const c = validateCommand(name, cmd); register(registries.commands, name, c.name, { cmd: c }, 'command', lease); } }),
      hooks: Object.freeze({
        register(hook = {}) {
          str(hook.name, 'hook name');
          fn(hook.handler, `${hook.name} handler`);
          register(registries.hooks, name, hook.name, { hook }, 'hook', lease);
        },
      }),
      readiness: Object.freeze({
        register(probe = {}) {
          str(probe.name, 'probe name');
          fn(probe.check, `${probe.name} check`);
          register(registries.probes, name, probe.name, { probe }, 'readiness probe', lease);
        },
      }),
    };
    return Object.freeze(ctx);
  }

  function clearRegistrations(name) {
    for (const r of Object.values(registries)) for (const [k, v] of r) if (v.plugin === name) r.delete(k);
  }

  async function initPlugin(name) {
    const p = byName.get(name);
    clearRegistrations(name);
    dropSubscriptions(core, name);
    provided.delete(name);
    revokeLease(name, 'superseded by a new init');
    const lease = { live: true };
    leases.set(name, lease);
    const ctx = makeContext(p, lease);
    contexts.set(name, ctx);
    core.phases.set(name, 'init');
    try {
      const out = await withTimeout(p.init(ctx), initTimeoutMs, `${name} init`);
      if (out?.provides !== undefined) provided.set(name, Object.freeze({ ...out.provides }));
      setState(name, 'initialized');
      return out ?? {};
    } catch (e) {
      // A timed-out init may still be running: its context is revoked, so
      // nothing it does from here reaches host state.
      revokeLease(name, `init failed: ${describe(e)}`);
      clearRegistrations(name);
      dropSubscriptions(core, name);
      degrade(name, `init failed: ${describe(e)}`);
      return undefined;
    } finally {
      core.phases.set(name, 'idle');
    }
  }

  async function startPlugin(name) {
    const p = byName.get(name);
    core.phases.set(name, 'start');
    try {
      await p.start(contexts.get(name));
      setState(name, 'running');
      started.push(name);
      core.phases.set(name, 'running');
      return true;
    } catch (e) {
      dropSubscriptions(core, name, { phase: 'start' });
      core.phases.set(name, 'idle');
      revokeLease(name, `start failed: ${describe(e)}`);
      degrade(name, `start failed: ${describe(e)}`);
      return false;
    }
  }

  async function start() {
    if (!['created', 'stopped'].includes(mode)) fail('host.invalid_request', `host is ${mode}`);
    mode = 'starting';
    modeReason = undefined;
    admissions = false;
    started = [];
    resolve();

    // 1–2. HQ core identity: device status from the signer (PDR-0027).
    const enterSafe = (reason) => { mode = 'safe'; modeReason = reason; };
    let reported;
    try { reported = await core.signer.deviceStatus(); } catch (e) { enterSafe(`signer unavailable: ${describe(e)}`); }
    if (mode !== 'safe') {
      if (!DEVICE_STATES.includes(reported)) enterSafe(`signer reported no device status (one of ${DEVICE_STATES.join(', ')})`);
      else {
        device = core.deviceRevoked ? 'revoked' : reported;
        if (device === 'unenrolled') enterSafe('device not enrolled: run enroll');
        if (device === 'revoked') revokeDevice(core, 'the signer reported the device revoked at startup');
      }
    }

    if (mode === 'safe') {
      // Core answers status and enrollment; no plugin starts and no Soul is admitted.
      for (const n of order) if (states.get(n).state !== 'degraded') setState(n, 'waiting', `safe mode: ${modeReason}`);
      return status();
    }

    // 3–4. Plugins: init, then start, in dependency order.
    for (const n of order) if (states.get(n).state === 'resolved') await initPlugin(n);
    for (const n of order) if (states.get(n).state === 'initialized') await startPlugin(n);
    // 5. hq/v1 admissions open.
    mode = device === 'revoked' ? 'device_revoked' : 'running';
    if (mode === 'device_revoked') modeReason = 'device revoked: re-enroll';
    admissions = true;
    return status();
  }

  async function stop({ reason = 'shutdown', deadlineMs = stopDeadlineMs } = {}) {
    if (!['running', 'safe', 'device_revoked'].includes(mode)) fail('host.not_running', `host is ${mode}`);
    mode = 'stopping';
    admissions = false;
    const report = [];
    for (const name of [...started].reverse()) {
      const t0 = Date.now();
      core.phases.set(name, 'stop');
      try {
        await withTimeout(byName.get(name).stop(contexts.get(name), { reason, deadlineMs }), deadlineMs, `${name} stop`);
        setState(name, 'stopped');
        report.push({ name, ok: true, ms: Date.now() - t0 });
      } catch (e) {
        setState(name, 'stopped', `stop failed: ${describe(e)}`);
        report.push({ name, ok: false, ms: Date.now() - t0, error: describe(e), code: e?.code });
      } finally {
        dropSubscriptions(core, name, { phase: 'start' });
        core.phases.set(name, 'stopped');
      }
    }
    started = [];
    // Every context is revoked, so a retained one can't mint again, and
    // short-lived credentials never outlive the run.
    for (const name of leases.keys()) revokeLease(name, `host stopped (${reason})`);
    dropTokens(core);
    mode = 'stopped';
    modeReason = undefined;
    return report;
  }

  function status() {
    return {
      mode,
      ...(modeReason ? { reason: modeReason } : {}),
      admissions,
      profile: core.profile,
      identity: { device: device ?? 'unknown', link: core.identity.link },
      plugins: order.map((name) => ({ name, version: byName.get(name).version, ...states.get(name) })),
      ...(extraStatus ? extraStatus() : {}),
    };
  }

  async function dispatch(op, { auth, payload, session } = {}) {
    if (!(op in HQ_OPERATIONS)) fail('host.unknown_operation', `${op} is not an hq/v1 operation`, { op });
    if (!['running', 'safe', 'device_revoked'].includes(mode)) fail('host.not_running', `host is ${mode}`);
    if (auth !== HQ_OPERATIONS[op]) fail('host.auth_mismatch', `${op} needs auth ${HQ_OPERATIONS[op]}`, { op, auth, expected: HQ_OPERATIONS[op] });
    if (mode === 'safe' && !SAFE_MODE_OPERATIONS.includes(op)) fail('host.safe_mode', `safe mode (${modeReason}): ${op} is unavailable`, { op });
    if (ADMISSION_OPERATIONS.includes(op) && !admissions) fail('host.admissions_closed', `${op}: admissions are not open`, { op });
    if (op === 'status') return status();
    if (op === 'device.status') {
      const enrollment = typeof core.signer.enrollmentProgress === 'function' ? core.signer.enrollmentProgress() : undefined;
      return { device: device ?? 'unknown', link: core.identity.link, ...(enrollment ? { enrollment } : {}) };
    }
    if (op === 'device.enroll') return enroll(payload);
    const reg = registries.hq.get(op);
    if (!reg) fail('host.unknown_operation', `no plugin implements ${op}`, { op });
    if (states.get(reg.plugin)?.state !== 'running') fail('host.plugin_degraded', `${reg.plugin} is ${states.get(reg.plugin)?.state}`, { plugin: reg.plugin, ...states.get(reg.plugin) });
    return reg.handler(structuredClone(payload), Object.freeze({ auth, session }));
  }

  // Enrollment is core (PDR-0027). The test signer enrolls in place; the
  // real flow (identity-service device grant, §9 PR 15) replaces it. A
  // revoked device record is never revived: re-enrollment means a new key.
  async function enroll(payload) {
    if (typeof core.signer.enroll !== 'function') fail('host.invalid_request', 'this signer cannot enroll');
    const result = await core.signer.enroll(structuredClone(payload));
    // A grant the owner still has to approve: nothing is enrolled yet, and
    // the signer reports the outcome itself (device.status shows it).
    if (result?.pending === true) return { enrolled: false, ...result };
    // A new device key: the revoked record stays revoked at the identity
    // service, but this host is enrolled again from its next start.
    core.deviceRevoked = false;
    dropTokens(core);
    await pushReceipt(core, { plugin: 'hq', kind: 'device.enrolled' });
    return { enrolled: true, restart: true, ...(result ?? {}) };
  }

  // A frame on the member broker socket (§4.9). The auth class is the
  // socket; the serving plugin decides what the frame means.
  async function brokerAccept(kind, payload, { connection } = {}) {
    if (!['running', 'device_revoked'].includes(mode)) fail('host.not_running', `host is ${mode}`);
    // With no broker running every frame gets the same answer, whatever its shape.
    const server = registries.servers.get(BROKER);
    if (!server) fail('host.no_broker', 'no plugin serves the broker');
    if (states.get(server.plugin)?.state !== 'running') fail('host.no_broker', `${server.plugin}, which serves the broker, is ${states.get(server.plugin)?.state}`);
    if (typeof kind !== 'string' || !KIND.test(kind)) fail('host.invalid_request', `kind ${JSON.stringify(kind)} must match ${KIND}`);
    return server.accept(kind, structuredClone(payload), Object.freeze({ connection }));
  }

  // A broker connection ended. The serving plugin's cleanup never fails the
  // socket.
  async function brokerClosed(connection) {
    const server = registries.servers.get(BROKER);
    if (!server?.closed) return;
    try { await server.closed(connection); } catch { /* the plugin's own state; nothing to refuse */ }
  }

  // Entry-point frames arrive as text: strict parsing first (duplicate keys
  // and malformed JSON are refused before any handler sees them).
  const dispatchJson = async (op, text, meta = {}) => dispatch(op, { ...meta, payload: parseStrict(text) });

  function registrations() {
    const list = (r, f) => [...r.values()].map(f).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return {
      hq: list(registries.hq, (v) => ({ key: v.op, auth: v.auth, plugin: v.plugin })),
      servers: [...registries.servers.entries()].map(([key, v]) => ({ key, plugin: v.plugin })),
      kinds: list(registries.kinds, (v) => ({ key: v.kind, plugin: v.plugin })),
      adapters: list(registries.adapters, (v) => ({ key: v.id, class: v.class, plugin: v.plugin })),
      tools: list(registries.tools, (v) => ({ key: v.tool.name, plugin: v.plugin })),
      commands: list(registries.commands, (v) => ({ key: v.cmd.name, plugin: v.plugin })),
      hooks: list(registries.hooks, (v) => ({ key: v.hook.name, plugin: v.plugin })),
      probes: list(registries.probes, (v) => ({ key: v.probe.name, plugin: v.plugin })),
    };
  }

  async function readiness() {
    const out = [];
    for (const { probe, plugin } of registries.probes.values()) {
      try { out.push({ name: probe.name, plugin, ...(await probe.check()) }); } catch (e) { out.push({ name: probe.name, plugin, ok: false, error: describe(e) }); }
    }
    return out;
  }

  return Object.freeze({
    start, stop, status, dispatch, dispatchJson, brokerAccept, brokerClosed, registrations, readiness,
    core,
    provided: (name) => provided.get(name),
    get mode() { return mode; },
  });
}

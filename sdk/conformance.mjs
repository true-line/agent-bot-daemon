// The plugin conformance suite (plan §4.6). Each plugin repository runs it
// against its plugin on the test host:
//
//   const r = await checkPlugin(myPlugin, { deps: [otherPlugin] });
//   assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
//
// Checks: idempotent registration, repeatable start/stop, stop within its
// deadline, no global state, no writes outside the store, unique names, and
// an auth class on every hq/v1 operation.
import { mkdtempSync, mkdirSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HQ_OPERATIONS } from './operations.mjs';
import { createTestHost } from './test-host.mjs';

const SANDBOX_VARS = ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'];

const mine = (regs, name) => Object.fromEntries(Object.entries(regs).map(([k, list]) => [k, list.filter((r) => r.plugin === name)]));

export async function checkPlugin(plugin, { deps = [], hostOptions = {}, stopDeadlineMs = 2_000, cycles = 3 } = {}) {
  const results = [];
  const globalsBefore = new Set(Reflect.ownKeys(globalThis)); // before any plugin code runs
  const record = async (check, fn) => {
    try {
      const detail = await fn();
      results.push({ check, ok: true, ...(detail ? { detail } : {}) });
    } catch (e) {
      results.push({ check, ok: false, error: e?.message ?? String(e), ...(e?.code ? { code: e.code } : {}) });
    }
  };
  const newHost = () => createTestHost({ stopDeadlineMs, ...hostOptions, plugins: [...deps, plugin] });
  const stateOf = (host) => host.status().plugins.find((p) => p.name === plugin.name);
  const expectRunning = (host) => {
    const s = stateOf(host);
    if (s?.state !== 'running') throw new Error(`${plugin.name} is ${s?.state ?? 'absent'}${s?.reason ? `: ${s.reason}` : ''}`);
  };

  await record('unique names', async () => {
    const names = [...deps, plugin].map((p) => p.name);
    if (new Set(names).size !== names.length) throw new Error(`duplicate plugin names among ${names.join(', ')}`);
    const host = newHost();
    await host.start();
    try { expectRunning(host); } finally { await host.stop(); }
  });

  await record('auth class on every hq/v1 operation', async () => {
    const host = newHost();
    await host.start();
    try {
      expectRunning(host);
      for (const r of mine(host.registrations(), plugin.name).hq) {
        if (HQ_OPERATIONS[r.key] !== r.auth) throw new Error(`${r.key} registered with auth ${r.auth}`);
      }
      return `${mine(host.registrations(), plugin.name).hq.length} operations`;
    } finally { await host.stop(); }
  });

  await record('idempotent registration', async () => {
    const host = newHost();
    await host.start();
    const first = mine(host.registrations(), plugin.name);
    await host.stop();
    await host.start();
    const second = mine(host.registrations(), plugin.name);
    await host.stop();
    if (!isDeepStrictEqual(first, second)) throw new Error(`registrations changed on re-init: ${JSON.stringify(first)} vs ${JSON.stringify(second)}`);
  });

  await record('repeatable start/stop', async () => {
    const host = newHost();
    for (let i = 0; i < cycles; i++) {
      await host.start();
      expectRunning(host);
      const report = await host.stop();
      const r = report.find((x) => x.name === plugin.name);
      if (!r?.ok) throw new Error(`cycle ${i + 1}: stop failed: ${r?.error ?? 'not stopped'}`);
    }
    return `${cycles} cycles`;
  });

  await record('stop within its deadline', async () => {
    const host = newHost();
    await host.start();
    const r = (await host.stop({ reason: 'conformance', deadlineMs: stopDeadlineMs })).find((x) => x.name === plugin.name);
    if (!r?.ok) throw new Error(r?.error ?? 'not stopped');
    return `${r.ms} ms of ${stopDeadlineMs}`;
  });

  await record('no global state', async () => {
    const a = newHost();
    const b = newHost();
    await a.start();
    await b.start();
    try {
      expectRunning(a);
      expectRunning(b);
      if (!isDeepStrictEqual(mine(a.registrations(), plugin.name), mine(b.registrations(), plugin.name))) {
        throw new Error('two hosts running the plugin see different registrations');
      }
    } finally {
      await a.stop();
      await b.stop();
    }
    const added = Reflect.ownKeys(globalThis).filter((k) => !globalsBefore.has(k));
    if (added.length) throw new Error(`added globals: ${added.map(String).join(', ')}`);
  });

  await record('no writes outside the store', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-bot-conformance-')));
    const saved = Object.fromEntries(SANDBOX_VARS.map((k) => [k, process.env[k]]));
    try {
      for (const k of SANDBOX_VARS) {
        const dir = join(root, k.toLowerCase());
        mkdirSync(dir);
        process.env[k] = dir;
      }
      const host = newHost();
      await host.start();
      expectRunning(host);
      await host.stop();
      const touched = SANDBOX_VARS.filter((k) => readdirSync(join(root, k.toLowerCase())).length);
      if (touched.length) throw new Error(`wrote under ${touched.join(', ')}`);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      rmSync(root, { recursive: true, force: true });
    }
  });

  return { ok: results.every((r) => r.ok), plugin: plugin.name, results };
}

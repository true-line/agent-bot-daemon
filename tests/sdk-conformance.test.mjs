// The plugin conformance suite (plan §4.6): a well-behaved plugin passes
// every check, and each kind of misbehaviour fails the check that names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPlugin } from '../sdk/conformance.mjs';
import { definePlugin } from '../sdk/plugin.mjs';

const plugin = (extra) => definePlugin({ name: 'subject', version: '1.0.0', hostApi: 1, async init() {}, ...extra });
const failed = (r) => r.results.filter((x) => !x.ok).map((x) => x.check);

test('a well-behaved plugin passes every check', async () => {
  const good = plugin({
    services: ['store', 'events'],
    async init(ctx) {
      ctx.hq.register({ op: 'tasks.list', auth: 'owner', handler: async () => ctx.services.store.tx((tx) => tx.list('tasks')) });
      ctx.broker.registerKind({ kind: 'notices.take', consume() {} });
      ctx.readiness.register({ name: 'subject-ready', check: async () => ({ ok: true }) });
    },
    async start(ctx) {
      await ctx.services.store.tx((tx) => tx.put('tasks', 'boot', { at: 0 }));
      ctx.services.events.subscribe('soul.ready', () => {});
    },
  });
  const r = await checkPlugin(good);
  assert.deepEqual(failed(r), []);
  assert.deepEqual(r.results.map((x) => x.check), [
    'unique names', 'auth class on every hq/v1 operation', 'idempotent registration', 'repeatable start/stop',
    'stop within its deadline', 'no global state', 'no writes outside the store',
  ]);
});

test('registrations that change on re-init fail idempotent registration', async () => {
  let n = 0;
  const r = await checkPlugin(plugin({ async init(ctx) { n++; ctx.tools.register({ name: `tool-${n}` }); } }));
  assert.ok(failed(r).includes('idempotent registration'));
});

test('a plugin that only starts once fails repeatable start/stop', async () => {
  let starts = 0;
  const r = await checkPlugin(plugin({ async start() { if (++starts > 1) throw new Error('already started'); } }));
  assert.ok(failed(r).includes('repeatable start/stop'));
});

test('a stop that ignores its deadline fails', async () => {
  const r = await checkPlugin(plugin({ async stop() { await new Promise((res) => setTimeout(res, 200)); } }), { stopDeadlineMs: 20 });
  assert.ok(failed(r).includes('stop within its deadline'));
});

test('a plugin that sets a global fails no global state', async () => {
  const r = await checkPlugin(plugin({ async start() { globalThis.__subjectState ??= { started: true }; } }));
  delete globalThis.__subjectState;
  assert.deepEqual(failed(r), ['no global state']);
});

test('a plugin that writes under HOME or TMPDIR fails no writes outside the store', async () => {
  const r = await checkPlugin(plugin({ async start() { writeFileSync(join(process.env.HOME, '.subject'), 'x'); } }));
  assert.ok(failed(r).includes('no writes outside the store'));
  const t = await checkPlugin(plugin({ async start() { writeFileSync(join(tmpdir(), `subject-${process.pid}`), 'x'); } }));
  assert.ok(failed(t).includes('no writes outside the store'));
});

test('a name clash or a refused registration fails unique names', async () => {
  const clash = await checkPlugin(plugin({}), { deps: [definePlugin({ name: 'other', version: '1.0.0', hostApi: 1, async init(ctx) { ctx.commands.register({ name: 'doctor' }); } })] , hostOptions: {} });
  assert.deepEqual(failed(clash), []);
  const dup = await checkPlugin(plugin({ async init(ctx) { ctx.commands.register({ name: 'doctor' }); } }), {
    deps: [definePlugin({ name: 'other', version: '1.0.0', hostApi: 1, async init(ctx) { ctx.commands.register({ name: 'doctor' }); } })],
  });
  assert.ok(failed(dup).includes('unique names'));
  const self = await checkPlugin(plugin({}), { deps: [plugin({})] });
  assert.ok(failed(self).includes('unique names'));
});

test('an operation registered with the wrong auth class never registers, so the plugin fails', async () => {
  const r = await checkPlugin(plugin({ async init(ctx) { ctx.hq.register({ op: 'Hello', auth: 'owner', handler() {} }); } }));
  assert.ok(failed(r).includes('auth class on every hq/v1 operation'));
});

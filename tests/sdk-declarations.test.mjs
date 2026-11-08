// Member-surface declarations (plan §4.2.1, §4.2.2; #94): the documented
// field tables equal the code's, each declaration is checked whole, any
// duplicate name is refused, and registration closes after init.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPlugin } from '../sdk/conformance.mjs';
import { COMMAND_FIELDS, SUBCOMMAND_FIELDS, TOOL_FIELDS, validateCommand, validateTool } from '../sdk/declarations.mjs';
import { definePlugin } from '../sdk/plugin.mjs';
import { createTestHost } from '../sdk/test-host.mjs';

const plugin = (name, init) => definePlugin({ name, version: '1.0.0', hostApi: 1, init });
const stateOf = (host, name) => host.status().plugins.find((p) => p.name === name);

const tool = (extra = {}) => ({
  name: 'gh_status', description: 'Show the bot identity.', inputSchema: { type: 'object', properties: {} },
  class: 'read', handler() {}, ...extra,
});
const command = (extra = {}) => ({ name: 'whoami', visibility: 'public', module: 'cli/whoami.mjs', ...extra });

// The tables in plan §4.2.1 and §4.2.2, read from the plan itself: field → required.
function documented(heading, nth = 0) {
  const plan = readFileSync(new URL('../docs/daemon-plugin-split.md', import.meta.url), 'utf8');
  const start = plan.indexOf(`#### ${heading}`);
  assert.ok(start >= 0, `plan has #### ${heading}`);
  const section = plan.slice(start, plan.indexOf('\n#', start + 1));
  const tables = section.split(/\n\n/).filter((block) => block.startsWith('| Field |'));
  return Object.fromEntries([...tables[nth].matchAll(/^\| `([A-Za-z]+)` \| (yes|no) \|/gm)].map(([, f, r]) => [f, r === 'yes']));
}

test('the declaration fields equal the tables in plan §4.2.1 and §4.2.2', () => {
  assert.deepEqual(documented('4.2.1 Tool declaration'), { ...TOOL_FIELDS });
  assert.deepEqual(documented('4.2.2 Command declaration'), { ...COMMAND_FIELDS });
  assert.deepEqual(documented('4.2.2 Command declaration', 1), { ...SUBCOMMAND_FIELDS });
});

test('a full declaration registers, and the host keeps its own frozen copy', async () => {
  const decl = tool({ annotations: { readOnlyHint: true }, when: ['bound'] });
  const cmd = command({ help: 'Usage: agent-bot whoami', subcommands: [{ words: ['json'], module: 'cli/whoami.mjs', drop: 1 }], usage: 'whoami [json]' });
  const host = createTestHost({ plugins: [plugin('surfaces', async (ctx) => {
    ctx.tools.register(decl);
    ctx.commands.register(cmd);
    ctx.commands.register({ name: 'version', visibility: 'internal', run() {} });
  })] });
  await host.start();
  assert.equal(stateOf(host, 'surfaces').state, 'running');
  const regs = host.registrations();
  assert.deepEqual(regs.tools.map((r) => r.key), ['gh_status']);
  assert.deepEqual(regs.commands.map((r) => r.key), ['version', 'whoami']);
});

test('the host records a frozen copy, so the plugin cannot change a declaration after registering it', () => {
  const decl = tool({ when: ['bound'] });
  const kept = validateTool('surfaces', decl);
  decl.inputSchema.properties.injected = { type: 'string' };
  decl.when.push('late');
  assert.deepEqual(kept.inputSchema, { type: 'object', properties: {} });
  assert.deepEqual(kept.when, ['bound']);
  assert.ok(Object.isFrozen(kept) && Object.isFrozen(kept.when));
  const cmd = command({ subcommands: [{ words: ['json'], module: 'cli/whoami.mjs' }] });
  const c = validateCommand('surfaces', cmd);
  cmd.subcommands[0].words.push('late');
  assert.deepEqual(c.subcommands[0].words, ['json']);
  assert.ok(Object.isFrozen(c.subcommands[0]));
});

const REFUSED_TOOLS = {
  'not an object': 'gh',
  'class instance': Object.assign(new (class Tool {})(), tool()),
  'bad name': tool({ name: 'Gh-Status' }),
  'unknown field': tool({ schema: {} }),
  'missing description': tool({ description: undefined }),
  'blank description': tool({ description: '  ' }),
  'schema not an object type': tool({ inputSchema: { type: 'string' } }),
  'annotations not an object': tool({ annotations: [] }),
  'missing class': tool({ class: undefined }),
  'unknown class': tool({ class: 'admin' }),
  'empty when': tool({ when: [] }),
  'repeated condition': tool({ when: ['bound', 'bound'] }),
  'bad condition': tool({ when: ['Bound'] }),
  'missing handler': tool({ handler: undefined }),
};

const REFUSED_COMMANDS = {
  'not an object': null,
  'bad name': command({ name: 'Who_Am_I' }),
  'unknown field': command({ aliases: ['me'] }),
  'missing visibility': command({ visibility: undefined }),
  'unknown visibility': command({ visibility: 'hidden' }),
  'neither module nor run': command({ module: undefined }),
  'both module and run': command({ run() {} }),
  'absolute module': command({ module: '/usr/bin/whoami.mjs' }),
  'escaping module': command({ module: '../whoami.mjs' }),
  'run with help': { name: 'version', visibility: 'public', run() {}, help: 'x' },
  'blank help': command({ help: '' }),
  'usage without subcommands': command({ usage: 'whoami [json]' }),
  'empty prepend': command({ prepend: [] }),
  'bad env name': command({ env: { path: '/bin' } }),
  'env value not text': command({ env: { AGENT_BOT_X: 1 } }),
  'empty subcommands': command({ subcommands: [] }),
  'unknown subcommand field': command({ subcommands: [{ words: ['json'], module: 'cli/whoami.mjs', alias: 'j' }] }),
  'subcommand without module': command({ subcommands: [{ words: ['json'] }] }),
  'subcommand bad words': command({ subcommands: [{ words: ['JSON'], module: 'cli/whoami.mjs' }] }),
  'subcommand drop too large': command({ subcommands: [{ words: ['json'], module: 'cli/whoami.mjs', drop: 2 }] }),
  'subcommand follow false': command({ subcommands: [{ words: ['json'], module: 'cli/whoami.mjs', follow: false }] }),
  'subcommand declared twice': command({ subcommands: [{ words: ['json'], module: 'a.mjs' }, { words: ['json'], module: 'b.mjs' }] }),
};

test('a declaration with an unknown field, a missing field or a wrong shape is refused', async () => {
  const seen = {};
  const host = createTestHost({ plugins: [plugin('surfaces', async (ctx) => {
    for (const [what, decl] of Object.entries(REFUSED_TOOLS)) {
      try { ctx.tools.register(decl); seen[`tool: ${what}`] = 'registered'; } catch (e) { seen[`tool: ${what}`] = e.code; }
    }
    for (const [what, decl] of Object.entries(REFUSED_COMMANDS)) {
      try { ctx.commands.register(decl); seen[`command: ${what}`] = 'registered'; } catch (e) { seen[`command: ${what}`] = e.code; }
    }
  })] });
  await host.start();
  const expected = Object.fromEntries([
    ...Object.keys(REFUSED_TOOLS).map((k) => `tool: ${k}`),
    ...Object.keys(REFUSED_COMMANDS).map((k) => `command: ${k}`),
  ].map((k) => [k, 'host.invalid_request']));
  assert.deepEqual(seen, expected);
  assert.deepEqual(host.registrations().tools, []);
  assert.deepEqual(host.registrations().commands, []);
});

test('the same plugin registering a name twice is refused, as another plugin is', async () => {
  const seen = {};
  const attempt = (what, fn) => { try { fn(); seen[what] = 'registered'; } catch (e) { seen[what] = e.code; } };
  const host = createTestHost({ plugins: [
    plugin('first', async (ctx) => {
      ctx.tools.register(tool());
      ctx.commands.register(command());
      attempt('same plugin, tool', () => ctx.tools.register(tool({ description: 'A replacement.' })));
      attempt('same plugin, command', () => ctx.commands.register(command({ module: 'cli/other.mjs' })));
    }),
    definePlugin({ name: 'second', version: '1.0.0', hostApi: 1, requires: { first: '^1.0.0' }, async init(ctx) {
      attempt('other plugin, tool', () => ctx.tools.register(tool()));
      attempt('other plugin, command', () => ctx.commands.register(command()));
    } }),
  ] });
  await host.start();
  assert.deepEqual(seen, {
    'same plugin, tool': 'host.duplicate_registration', 'same plugin, command': 'host.duplicate_registration',
    'other plugin, tool': 'host.duplicate_registration', 'other plugin, command': 'host.duplicate_registration',
  });
  const regs = host.registrations();
  assert.deepEqual([regs.tools, regs.commands].map((l) => l.map((r) => `${r.key}:${r.plugin}`)), [['gh_status:first'], ['whoami:first']]);
});

test('registration closes after init', async () => {
  let kept;
  const host = createTestHost({ plugins: [plugin('surfaces', async (ctx) => { kept = ctx; })] });
  await host.start();
  assert.throws(() => kept.tools.register(tool()), (e) => e.code === 'host.registration_closed');
  assert.throws(() => kept.commands.register(command()), (e) => e.code === 'host.registration_closed');
  assert.deepEqual(host.registrations().tools, []);
});

test('a re-init registers the same declarations again without a duplicate', async () => {
  const r = await checkPlugin(plugin('subject', async (ctx) => {
    ctx.tools.register(tool());
    ctx.commands.register(command());
  }));
  assert.deepEqual(r.results.filter((x) => !x.ok), []);
});

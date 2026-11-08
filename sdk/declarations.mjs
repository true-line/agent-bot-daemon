// Member-surface declarations (plan §4.2.1, §4.2.2): what a plugin passes to
// ctx.tools.register(tool) and ctx.commands.register(cmd). The shapes start
// from agent-bot-identity's in-place registries (tool-registry.mjs and
// cli/command-registry.mjs), which the Stage 0 rows turn into these calls.
//
// A declaration is checked whole before the host records it: an unknown
// field, a missing required one, or a value of the wrong shape is refused
// with host.invalid_request. The host stores the frozen copy returned here,
// never the plugin's object.
import { fail } from './errors.mjs';

// Field name → required. Plan §4.2.1 and §4.2.2 document the same tables;
// tests/sdk-declarations.test.mjs keeps them equal.
export const TOOL_FIELDS = Object.freeze({
  name: true, description: true, inputSchema: true, annotations: false, class: true, when: false, handler: true,
});
export const COMMAND_FIELDS = Object.freeze({
  name: true, visibility: true, module: false, run: false, help: false, usage: false, prepend: false, env: false, subcommands: false,
});
export const SUBCOMMAND_FIELDS = Object.freeze({
  words: true, module: true, drop: false, prepend: false, follow: false, env: false,
});

export const TOOL_CLASSES = Object.freeze(['read', 'write']);
export const COMMAND_VISIBILITY = Object.freeze(['public', 'internal']);

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CONDITION = /^[a-z][a-z0-9-]{0,63}$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const WORD = /^[a-z][a-z0-9-]*$/;
// Relative to the plugin's package root; no `..`, no absolute paths.
const MODULE = /^(?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9.-]*\.mjs$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

const plainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const text = (v) => typeof v === 'string' && v.trim() !== '';
const distinct = (list) => new Set(list).size === list.length;

function fields(plugin, label, value, table) {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(table, key)) fail('host.invalid_request', `${plugin}: ${label} has an unknown field ${key}`, { field: key });
  }
  for (const [key, required] of Object.entries(table)) {
    if (required && value[key] === undefined) fail('host.invalid_request', `${plugin}: ${label} needs ${key}`, { field: key });
  }
}

export function validateTool(plugin, tool) {
  if (!plainObject(tool)) fail('host.invalid_request', `${plugin}: a tool is a plain object`);
  const { name, description, inputSchema, annotations, class: cls, when, handler } = tool;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) fail('host.invalid_request', `${plugin}: tool name ${JSON.stringify(name)} must match ${TOOL_NAME}`);
  const label = `tool ${name}`;
  fields(plugin, label, tool, TOOL_FIELDS);
  const bad = (what) => fail('host.invalid_request', `${plugin}: ${label}: ${what}`);
  if (!text(description)) bad('description is non-empty text');
  if (!plainObject(inputSchema) || inputSchema.type !== 'object') bad('inputSchema is a JSON Schema of type object');
  if (annotations !== undefined && !plainObject(annotations)) bad('annotations is an object');
  if (!TOOL_CLASSES.includes(cls)) bad(`class is one of ${TOOL_CLASSES.join(', ')}`);
  if (when !== undefined && (!Array.isArray(when) || when.length === 0 || !distinct(when)
    || !when.every((c) => typeof c === 'string' && CONDITION.test(c)))) bad(`when is a non-empty list of distinct conditions matching ${CONDITION}`);
  if (typeof handler !== 'function') bad('handler is a function');
  return Object.freeze({
    name, description, inputSchema: structuredClone(inputSchema),
    ...(annotations !== undefined ? { annotations: structuredClone(annotations) } : {}),
    class: cls, when: Object.freeze([...(when ?? [])]), handler,
  });
}

function launch(bad, { prepend, env, follow }) {
  if (prepend !== undefined && (!Array.isArray(prepend) || prepend.length === 0 || !prepend.every(text))) bad('prepend is a non-empty list of arguments');
  if (env !== undefined && (!plainObject(env) || Object.keys(env).length === 0
    || !Object.entries(env).every(([k, v]) => ENV_NAME.test(k) && typeof v === 'string'))) bad(`env maps names matching ${ENV_NAME} to strings`);
  if (follow !== undefined && follow !== true) bad('follow is true or absent');
}

function validateSubcommand(plugin, command, value) {
  if (!plainObject(value)) fail('host.invalid_request', `${plugin}: command ${command}: a subcommand is a plain object`);
  const { words, module, drop = 0, prepend, follow, env } = value;
  if (!Array.isArray(words) || words.length === 0 || !words.every((w) => typeof w === 'string' && WORD.test(w))) {
    fail('host.invalid_request', `${plugin}: command ${command}: subcommand words are a non-empty list matching ${WORD}`);
  }
  const label = `command ${command} ${words.join(' ')}`;
  fields(plugin, label, value, SUBCOMMAND_FIELDS);
  const bad = (what) => fail('host.invalid_request', `${plugin}: ${label}: ${what}`);
  if (typeof module !== 'string' || !MODULE.test(module)) bad('module is a .mjs path relative to the plugin');
  if (!Number.isInteger(drop) || drop < 0 || drop > words.length) bad(`drop is 0 to ${words.length}`);
  launch(bad, { prepend, env, follow });
  return Object.freeze({
    words: Object.freeze([...words]), module, drop,
    ...(prepend ? { prepend: Object.freeze([...prepend]) } : {}),
    ...(follow ? { follow } : {}),
    ...(env ? { env: Object.freeze({ ...env }) } : {}),
  });
}

export function validateCommand(plugin, cmd) {
  if (!plainObject(cmd)) fail('host.invalid_request', `${plugin}: a command is a plain object`);
  const { name, visibility, module, run, help, usage, prepend, env, subcommands } = cmd;
  if (typeof name !== 'string' || !COMMAND_NAME.test(name)) fail('host.invalid_request', `${plugin}: command name ${JSON.stringify(name)} must match ${COMMAND_NAME}`);
  const label = `command ${name}`;
  fields(plugin, label, cmd, COMMAND_FIELDS);
  const bad = (what) => fail('host.invalid_request', `${plugin}: ${label}: ${what}`);
  if (!COMMAND_VISIBILITY.includes(visibility)) bad(`visibility is one of ${COMMAND_VISIBILITY.join(', ')}`);
  if ((module === undefined) === (run === undefined)) bad('needs a module or a run function, not both');
  if (run !== undefined) {
    if (typeof run !== 'function') bad('run is a function');
    const extra = ['help', 'usage', 'prepend', 'env', 'subcommands'].find((k) => cmd[k] !== undefined);
    if (extra) bad(`${extra} goes with a module; run answers it itself`);
  } else if (typeof module !== 'string' || !MODULE.test(module)) bad('module is a .mjs path relative to the plugin');
  for (const [key, v] of [['help', help], ['usage', usage]]) if (v !== undefined && !text(v)) bad(`${key} is non-empty text`);
  launch(bad, { prepend, env });
  if (subcommands !== undefined && (!Array.isArray(subcommands) || subcommands.length === 0)) bad('subcommands is a non-empty list');
  if (usage !== undefined && subcommands === undefined) bad('usage goes with subcommands');
  const routes = (subcommands ?? []).map((s) => validateSubcommand(plugin, name, s));
  const seen = new Set();
  for (const r of routes) {
    const key = r.words.join(' ');
    if (seen.has(key)) bad(`subcommand ${key} is declared twice`);
    seen.add(key);
  }
  return Object.freeze({
    name, visibility,
    ...(module !== undefined ? { module } : { run }),
    ...(help !== undefined ? { help } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(prepend ? { prepend: Object.freeze([...prepend]) } : {}),
    ...(env ? { env: Object.freeze({ ...env }) } : {}),
    ...(routes.length ? { subcommands: Object.freeze(routes) } : {}),
  });
}

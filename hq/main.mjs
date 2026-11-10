#!/usr/bin/env node
// The HQ skeleton's command line (plan §9 PR 12).
//
//   node hq/main.mjs run    [--home DIR] [--plugins DIR] [--dev-plugins DIR]
//                                                 run HQ in the foreground
//   node hq/main.mjs status [--home DIR] [--json] ask a running HQ for status
//   node hq/main.mjs souls  [--home DIR] [--json] list admitted Souls
//   node hq/main.mjs signer rekey [--home DIR]    replace the HQ signer's key
//                                                 (HQ must be stopped)
//
// `signer rekey` makes a fresh key on the backend HQ's config names and a new
// key generation, so every signature from the old key stops verifying. It is
// how custody moves from the transition key file to a hardware helper; the
// key file is removed once the hardware key is pinned.
//
// --plugins loads installed plugins, each pinned by name, version and digest
// in governance/plugins.json; --dev-plugins loads a directory without pins
// and status always reports it (§4.5).
//
// DIR defaults to $AGENT_BOT_HQ_HOME, else ~/.agent-bot-hq. It is separate
// from the existing daemon's ~/.agent-bot, which HQ leaves unchanged.
//
// `run` loads the hq/v1, task/v1 and wire/v1 schemas it uses from the pinned soul-contracts release
// (scripts/soul-contracts.mjs verifies the digest; a development checkout
// fetches it into .cache/ on first use). A release will vendor the pinned
// tree with the plugins (§4.5) instead.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from '../scripts/soul-contracts.mjs';
import { SCHEMA_NAMES } from './admission.mjs';
import { TASK_SCHEMA_NAMES, TASK_WIRE_SCHEMA_NAMES } from './tasks.mjs';
import { createHQ, readConfig } from './hq.mjs';
import { backendFromConfig, createSigner, removeSoftwareKey } from './signer.mjs';
import { readPins } from './plugins.mjs';
import { connectSocket } from './socket.mjs';

const USAGE = 'usage: node hq/main.mjs <run|status|souls|signer rekey> [--home DIR] [--plugins DIR] [--dev-plugins DIR] [--json]';
const PINS = join(dirname(fileURLToPath(import.meta.url)), '../governance/plugins.json');

function parse(argv) {
  const args = { cmd: argv[0], home: process.env.AGENT_BOT_HQ_HOME || join(homedir(), '.agent-bot-hq'), json: false };
  if (args.cmd === 'signer') args.sub = argv[1];
  for (let i = args.cmd === 'signer' ? 2 : 1; i < argv.length; i++) {
    if (argv[i] === '--home') args.home = argv[++i];
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--plugins') args.plugins = argv[++i];
    else if (argv[i] === '--dev-plugins') args.devPlugins = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}\n${USAGE}`);
  }
  if (!args.home) throw new Error(`--home needs a directory\n${USAGE}`);
  return args;
}

function loadSchemas() {
  const { dir } = verify();
  const load = (contract, names) => names.map((n) => [n, JSON.parse(readFileSync(join(dir, 'schemas', contract, `${n}.schema.json`), 'utf8'))]);
  return Object.fromEntries([...load('hq/v1', SCHEMA_NAMES), ...load('task/v1', TASK_SCHEMA_NAMES), ...load('wire/v1', TASK_WIRE_SCHEMA_NAMES)]);
}

async function ask(home, op) {
  const client = await connectSocket(join(home, 'control.sock'));
  try { return await client.request(op); } finally { await client.close(); }
}

function signerLine(g) {
  if (!g.available) return `signer: unavailable (${g.reason})`;
  const custody = g.key_storage === 'hardware' ? 'hardware key' : 'software key file (transition custody)';
  return `signer: ${custody}, ${g.backend} backend, key ${g.thumbprint.slice(0, 12)}, generation ${g.generation}`;
}

// Replace the signer's key while HQ is stopped. A running HQ holds the old
// pin in memory, so it is refused rather than left signing with a dead key.
export async function rekeySigner(home) {
  let live = false;
  try { const c = await connectSocket(join(home, 'control.sock')); live = true; await c.close(); } catch { /* not running */ }
  if (live) throw new Error('HQ is running: stop it before replacing the signer key');
  const cfg = readConfig(home);
  const signer = createSigner({ home, backend: backendFromConfig(cfg.signer, { home }) });
  const made = signer.createKey({ replace: true });
  const removed = made.key_storage === 'hardware' ? removeSoftwareKey({ home }) : undefined;
  return { ...made, ...(removed === undefined ? {} : { software_key_removed: removed }) };
}

function printStatus(s) {
  const lines = [
    `HQ ${s.hq?.version ?? '?'}: ${s.mode}${s.reason ? ` (${s.reason})` : ''}; admissions ${s.admissions ? 'open' : 'closed'}`,
    `profile: ${s.profile}`,
    ...(s.hq?.profileReasons ?? []).map((r) => `  - ${r}`),
    `device: ${s.identity?.device}; identity-service link: ${s.identity?.link}`,
    ...(s.hq?.signer ? [signerLine(s.hq.signer)] : []),
    `legacy daemon: ${s.legacy?.state}${s.legacy?.version ? ` ${s.legacy.version}` : ''}${s.legacy?.supervise ? ' (supervised)' : ''}`,
    ...s.plugins.map((p) => `plugin ${p.name} ${p.version}: ${p.state}${p.reason ? ` (${p.reason})` : ''}`),
    ...(s.hq?.pluginLoad ?? []).filter((p) => p.state === 'refused').map((p) => `plugin ${p.name}: refused (${p.reason})`),
    ...(s.hq?.devPlugins ? [`dev plugins (unpinned): ${s.hq.devPlugins}`] : []),
  ];
  console.log(lines.join('\n'));
}

async function main(argv) {
  const args = parse(argv);
  if (args.cmd === 'run') {
    const hq = createHQ({ home: args.home, schemas: loadSchemas(), pins: readPins(PINS), pluginsDir: args.plugins, devPlugins: args.devPlugins });
    // Handlers first, so a signal during start still shuts down cleanly.
    let starting = true;
    const shutdown = (signal) => {
      const wait = starting ? new Promise((r) => { const i = setInterval(() => { if (!starting) { clearInterval(i); r(); } }, 50); }) : Promise.resolve();
      wait.then(() => hq.stop({ reason: signal })).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    try {
      printStatus(await hq.start());
    } finally {
      starting = false;
    }
    console.log(`listening: ${hq.paths.control} (owner), ${hq.paths.admission} (entry points), ${hq.paths.broker} (members)`);
    return;
  }
  if (args.cmd === 'signer') {
    if (args.sub !== 'rekey') throw new Error(USAGE);
    const made = await rekeySigner(args.home);
    console.log(args.json ? JSON.stringify(made, null, 2) : `signer key replaced: ${made.key_storage} key ${made.thumbprint.slice(0, 12)}, generation ${made.generation}`);
    return;
  }
  if (args.cmd === 'status' || args.cmd === 'souls') {
    const res = await ask(args.home, args.cmd === 'status' ? 'status' : 'souls.list');
    if (!res.ok) {
      console.error(JSON.stringify(res.refusal ?? res.host_refusal ?? res));
      process.exitCode = 1;
      return;
    }
    if (args.json || args.cmd === 'souls') console.log(JSON.stringify(res.result, null, 2));
    else printStatus(res.result);
    return;
  }
  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });

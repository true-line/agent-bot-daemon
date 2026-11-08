#!/usr/bin/env node
// The HQ skeleton's command line (plan §9 PR 12).
//
//   node hq/main.mjs run    [--home DIR]          run HQ in the foreground
//   node hq/main.mjs status [--home DIR] [--json] ask a running HQ for status
//   node hq/main.mjs souls  [--home DIR] [--json] list admitted Souls
//
// DIR defaults to $AGENT_BOT_HQ_HOME, else ~/.agent-bot-hq. It is separate
// from the existing daemon's ~/.agent-bot, which HQ leaves unchanged.
//
// `run` loads the hq/v1 schemas from the pinned soul-contracts release
// (scripts/soul-contracts.mjs verifies the digest; a development checkout
// fetches it into .cache/ on first use). A release will vendor the pinned
// tree with the plugins (§4.5) instead.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { verify } from '../scripts/soul-contracts.mjs';
import { SCHEMA_NAMES } from './admission.mjs';
import { createHQ } from './hq.mjs';
import { connectSocket } from './socket.mjs';

const USAGE = 'usage: node hq/main.mjs <run|status|souls> [--home DIR] [--json]';

function parse(argv) {
  const args = { cmd: argv[0], home: process.env.AGENT_BOT_HQ_HOME || join(homedir(), '.agent-bot-hq'), json: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--home') args.home = argv[++i];
    else if (argv[i] === '--json') args.json = true;
    else throw new Error(`unknown argument ${argv[i]}\n${USAGE}`);
  }
  if (!args.home) throw new Error(`--home needs a directory\n${USAGE}`);
  return args;
}

function loadSchemas() {
  const { dir } = verify();
  return Object.fromEntries(SCHEMA_NAMES.map((n) => [n, JSON.parse(readFileSync(join(dir, 'schemas/hq/v1', `${n}.schema.json`), 'utf8'))]));
}

async function ask(home, op) {
  const client = await connectSocket(join(home, 'control.sock'));
  try { return await client.request(op); } finally { await client.close(); }
}

function printStatus(s) {
  const lines = [
    `HQ ${s.hq?.version ?? '?'}: ${s.mode}${s.reason ? ` (${s.reason})` : ''}; admissions ${s.admissions ? 'open' : 'closed'}`,
    `profile: ${s.profile}`,
    ...(s.hq?.profileReasons ?? []).map((r) => `  - ${r}`),
    `device: ${s.identity?.device}; identity-service link: ${s.identity?.link}`,
    `legacy daemon: ${s.legacy?.state}${s.legacy?.version ? ` ${s.legacy.version}` : ''}${s.legacy?.supervise ? ' (supervised)' : ''}`,
    ...s.plugins.map((p) => `plugin ${p.name} ${p.version}: ${p.state}${p.reason ? ` (${p.reason})` : ''}`),
  ];
  console.log(lines.join('\n'));
}

async function main(argv) {
  const args = parse(argv);
  if (args.cmd === 'run') {
    const hq = createHQ({ home: args.home, schemas: loadSchemas() });
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
    console.log(`listening: ${hq.paths.control} (owner), ${hq.paths.admission} (entry points)`);
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

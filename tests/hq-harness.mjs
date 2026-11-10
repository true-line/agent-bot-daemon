// Shared setup for the HQ skeleton tests: a real HQ (store, sockets, SDK
// host, admission plugin) in a fresh 0700 directory, with the legacy
// commands replaced by canned output and a deterministic clock.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify } from '../scripts/soul-contracts.mjs';
import { testClock } from '../sdk/services.mjs';
import { SCHEMA_NAMES } from '../hq/admission.mjs';
import { TASK_SCHEMA_NAMES, TASK_WIRE_SCHEMA_NAMES } from '../hq/tasks.mjs';
import { createHQ } from '../hq/hq.mjs';
import { legacyDaemon, legacySigner } from '../hq/legacy.mjs';
import { connectSocket } from '../hq/socket.mjs';

export const contracts = verify().dir;
const load = (contract, names) => names.map((n) => [n, JSON.parse(readFileSync(join(contracts, 'schemas', contract, `${n}.schema.json`), 'utf8'))]);
export const schemas = Object.fromEntries([...load('hq/v1', SCHEMA_NAMES), ...load('task/v1', TASK_SCHEMA_NAMES), ...load('wire/v1', TASK_WIRE_SCHEMA_NAMES)]);
export const errorResponseSchema = JSON.parse(readFileSync(join(contracts, 'schemas/common/v1/error-response.schema.json'), 'utf8'));
export const fixture = (rel) => JSON.parse(readFileSync(join(contracts, 'fixtures', rel), 'utf8'));

export const SOUL = 'agent_0b3f1e2a-7c4d-4e8f-9a1b-2c3d4e5f6a7b';
export const DIGEST = `sha256:${'a1'.repeat(32)}`;
export const hello = (over = {}) => ({ ...fixture('positive/hello.first-start.json').input, ...over });

export const tempHome = () => mkdtempSync(join(tmpdir(), 'hq-'));

// Canned legacy CLI. `device` is what `agent-bot server status --json`
// reports; `daemon` what `agent-bot daemon status --json` reports.
export function fakeLegacy({ device = 'enrolled', daemon = 'running' } = {}) {
  const state = { device, daemon, calls: [] };
  const run = async (argv) => {
    const cmd = argv.join(' ');
    state.calls.push(cmd);
    if (cmd.includes('server status')) {
      if (state.device === 'broken') return { code: 1, stdout: 'not json' };
      if (state.device === 'revoked') return { code: 0, stdout: JSON.stringify({ enrolled: true, remote: { revoked: true } }) };
      return { code: 0, stdout: JSON.stringify({ enrolled: state.device === 'enrolled', device: { device_id: 'dev-x' } }) };
    }
    if (cmd.includes('daemon status')) {
      if (state.daemon === 'garbled') return { code: 0, stdout: '{}' };
      return { code: 0, stdout: JSON.stringify({ running: state.daemon === 'running', pid: 4242, version: '0.15.17', souls: [{ id: 'agent_x', soulDir: '/private/path' }] }) };
    }
    if (cmd.includes('daemon start')) { state.daemon = 'running'; return { code: 0, stdout: '' }; }
    return { code: 127, stdout: '' };
  };
  return { state, run };
}

export async function startHQ({ device = 'enrolled', daemon = 'running', supervise = false, config, home = tempHome(), plugins, pluginsDir, pins, devPlugins, account = 'user', platform = 'darwin', signer, enrollment } = {}) {
  const legacy = fakeLegacy({ device, daemon });
  const clock = testClock(Date.UTC(2026, 10, 8));
  const hq = createHQ({
    home,
    schemas,
    config: config ?? { acceptedDefinitions: { [SOUL]: [DIGEST] } },
    // null: let HQ pick the enrollment source from its config.
    ...(enrollment === null ? {} : { enrollment: enrollment ?? legacySigner({ run: legacy.run }) }),
    ...(signer ? { signer } : {}),
    legacy: legacyDaemon({ run: legacy.run, supervise, clock }),
    clock,
    account,
    platform,
    plugins,
    pluginsDir,
    pins,
    devPlugins,
  });
  const status = await hq.start();
  await hq.settled();
  const clients = [];
  const owner = async () => { const c = await connectSocket(hq.paths.control); clients.push(c); return c; };
  const entry = async () => { const c = await connectSocket(hq.paths.admission); clients.push(c); return c; };
  const member = async () => { const c = await connectSocket(hq.paths.broker); clients.push(c); return c; };
  const done = async ({ keep = false } = {}) => {
    for (const c of clients) await c.close().catch(() => {});
    await hq.stop();
    if (!keep) rmSync(home, { recursive: true, force: true });
  };
  return { hq, home, status, legacy, clock, owner, entry, member, done };
}

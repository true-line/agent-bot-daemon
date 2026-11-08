// Discover and load installed plugins (plan §4.1, §4.4, §4.5).
//
// An installed plugin is a directory named after the plugin, holding
// `plugin.json` (the static manifest fields) and `plugin.mjs` (exactly one
// default export, from definePlugin). HQ checks, in this order, and runs no
// plugin code until every check has passed:
//
//   1. plugin.json parses strictly, has only the static fields, and its name
//      is the directory name;
//   2. the installed tree's digest matches the pin in governance/plugins.json
//      (name, version and sha256) — unless the plugin came from
//      --dev-plugins, which skips the pin and is always reported;
//   3. the set resolves from the static fields alone: a supported hostApi,
//      every required plugin present at a satisfying version, no cycle. A
//      plugin whose dependency was refused is refused too;
//   4. only then is plugin.mjs imported, and its definePlugin fields must
//      equal plugin.json exactly.
//
// The digest is sha256-manifest-v1, the framing scripts/soul-contracts.mjs
// and the package format use: each regular file's relative path maps to
// { sha256, size, mode } (git modes 100644 / 100755), and the digest is the
// SHA-256 of that manifest's RFC 8785 bytes. Symlinks and other special
// files are refused, so the tree that was digested is the tree that runs.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalDigest, canonicalize } from '../sdk/wire/canonical-json.mjs';
import { parseStrict } from '../sdk/wire/strict-json.mjs';
import { staticManifest, supportedHostApis, validateManifest } from '../sdk/plugin.mjs';
import { satisfies } from '../sdk/semver.mjs';

export const PINS_FORMAT = 'agent-bot-hq-plugins/1';
const STATIC_FIELDS = ['name', 'version', 'hostApi', 'requires', 'optional', 'services', 'identityServiceRoutes'];

// The sha256-manifest-v1 digest of a directory tree.
export function treeDigest(root) {
  const manifest = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, path));
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        const bytes = readFileSync(join(root, path));
        manifest[path] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mode: st.mode & 0o111 ? '100755' : '100644' };
      } else throw new Error(`${path} is not a regular file or directory`);
    }
  };
  walk('');
  return canonicalDigest(manifest);
}

export function readPins(path) {
  const pins = parseStrict(readFileSync(path, 'utf8'));
  if (pins?.format !== PINS_FORMAT) throw new Error(`${path}: format must be ${PINS_FORMAT}`);
  if (pins.algorithm !== 'sha256-manifest-v1') throw new Error(`${path}: algorithm must be sha256-manifest-v1`);
  if (!Array.isArray(pins.plugins)) throw new Error(`${path}: plugins must be a list`);
  for (const p of pins.plugins) {
    if (typeof p?.name !== 'string' || typeof p.version !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(p.sha256 ?? '')) throw new Error(`${path}: each pin is { name, version, sha256 }`);
  }
  if (new Set(pins.plugins.map((p) => p.name)).size !== pins.plugins.length) throw new Error(`${path}: a plugin is pinned twice`);
  return pins;
}

const sameJson = (a, b) => canonicalize(a) === canonicalize(b);

function readManifest(dir, name) {
  const text = readFileSync(join(dir, 'plugin.json'), 'utf8');
  const m = parseStrict(text);
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('plugin.json is not an object');
  const extra = Object.keys(m).filter((k) => !STATIC_FIELDS.includes(k));
  if (extra.length) throw new Error(`plugin.json has non-static field ${extra[0]}`);
  // Validate the static fields with the SDK's manifest rules (init is code,
  // checked after import).
  validateManifest({ ...m, init: () => {} });
  if (m.name !== name) throw new Error(`plugin.json names ${m.name}, but the directory is ${name}`);
  return staticManifest({ requires: {}, optional: {}, services: [], identityServiceRoutes: [], ...m });
}

// Returns { loaded, report }. `report` has one entry per directory found,
// loaded or refused, with why; `loaded` pairs each definePlugin object with
// its report entry. `available` maps plugins already loaded elsewhere (HQ's
// built-ins, an earlier directory) to their versions, so a requirement on
// them resolves.
export async function loadPlugins({ dir, pins = { plugins: [] }, dev = false, available = {}, importer = (url) => import(url) }) {
  let names;
  try { names = readdirSync(dir).filter((n) => lstatSync(join(dir, n)).isDirectory()).sort(); } catch (e) { throw new Error(`cannot read plugin directory ${dir}: ${e.message}`); }
  const entries = names.map((name) => ({ name, dir: join(dir, name), dev }));
  const refuse = (e, reason) => { e.state = 'refused'; e.reason = reason; };

  // 1–2: manifest and digest.
  for (const e of entries) {
    try {
      e.manifest = readManifest(e.dir, e.name);
      e.version = e.manifest.version;
      e.digest = treeDigest(e.dir);
    } catch (err) { refuse(e, err.message); continue; }
    if (dev) continue;
    const pin = pins.plugins.find((p) => p.name === e.name);
    if (!pin) refuse(e, 'not pinned in governance/plugins.json');
    else if (pin.version !== e.version) refuse(e, `pinned at ${pin.version}, installed ${e.version}`);
    else if (pin.sha256 !== e.digest) refuse(e, `digest ${e.digest} does not match the pin ${pin.sha256}`);
  }

  // 3: resolve from static fields; refusals propagate to dependents.
  const apis = supportedHostApis();
  for (const e of entries) if (!e.state && !apis.includes(e.manifest.hostApi)) refuse(e, `hostApi ${e.manifest.hostApi} unsupported`);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of entries) {
      if (e.state) continue;
      for (const [dep, range] of Object.entries(e.manifest.requires)) {
        const d = entries.find((x) => x.name === dep && !x.state) ?? (dep in available ? { version: available[dep] } : undefined);
        if (!d) { refuse(e, `requires ${dep}, which is not loadable`); changed = true; break; }
        if (!satisfies(d.version, range)) { refuse(e, `requires ${dep} ${range}, installed ${d.version}`); changed = true; break; }
      }
    }
  }
  const live = entries.filter((e) => !e.state);
  const edges = (e) => Object.keys(e.manifest.requires).filter((d) => live.some((x) => x.name === d));
  const done = new Set();
  let progress = true;
  while (progress) {
    progress = false;
    for (const e of live) if (!done.has(e.name) && edges(e).every((d) => done.has(d))) { done.add(e.name); progress = true; }
  }
  for (const e of live) if (!done.has(e.name)) refuse(e, 'dependency cycle');

  // 4: import, and hold the code to its manifest.
  const loaded = [];
  for (const e of entries) {
    if (e.state) continue;
    try {
      const mod = await importer(pathToFileURL(join(e.dir, 'plugin.mjs')).href);
      const p = mod.default;
      validateManifest(p);
      if (!sameJson(staticManifest(p), e.manifest)) throw new Error('plugin.mjs fields differ from plugin.json');
      e.state = 'loaded';
      loaded.push({ plugin: p, entry: e });
    } catch (err) { refuse(e, `load failed: ${err.message}`); }
  }
  const summary = (e) => ({ name: e.name, ...(e.version ? { version: e.version } : {}), ...(e.digest ? { digest: e.digest } : {}), state: e.state, ...(e.reason ? { reason: e.reason } : {}), ...(e.dev ? { dev: true } : {}) });
  const report = entries.map(summary);
  return { loaded: loaded.map(({ plugin, entry }) => ({ plugin, entry: report[entries.indexOf(entry)] })), report };
}

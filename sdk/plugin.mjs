// definePlugin and manifest validation (plan §4.1).
//
// A manifest is static data plus three lifecycle functions. HQ reads the
// static fields (from plugin.json, in the real host) and runs no plugin code
// until the set has resolved. Unknown fields are refused rather than ignored,
// so a manifest written for a newer host API fails loudly (T14's rule for
// unknown required semantics, applied to the plugin contract).
import { fail } from './errors.mjs';
import { isVersion, validRange } from './semver.mjs';

export const HOST_API = 1;

// The host services a plugin may declare (§4.3).
export const HOST_SERVICES = Object.freeze([
  'config', 'store', 'log', 'receipts', 'events', 'clock', 'random', 'profile',
  'identityService', 'credentials', 'approvals', 'launch', 'budgets',
]);

export const PLUGIN_NAME = /^[a-z0-9-]{1,64}$/;
const ROUTE = /^\/[A-Za-z0-9._~\/-]*\*?$/;
const FIELDS = new Set(['name', 'version', 'hostApi', 'requires', 'optional', 'services', 'identityServiceRoutes', 'init', 'start', 'stop']);

// hostApi N and N-1 are supported (§4.5); there is no host API 0.
export const supportedHostApis = (current = HOST_API) => (current > 1 ? [current, current - 1] : [current]);

export function validateManifest(m) {
  const problems = [];
  if (!m || typeof m !== 'object') fail('host.invalid_manifest', 'a plugin manifest is an object');
  for (const k of Object.keys(m)) if (!FIELDS.has(k)) problems.push(`unknown field ${k}`);
  if (typeof m.name !== 'string' || !PLUGIN_NAME.test(m.name)) problems.push('name must match ^[a-z0-9-]{1,64}$');
  if (!isVersion(m.version)) problems.push('version must be MAJOR.MINOR.PATCH');
  if (!Number.isSafeInteger(m.hostApi) || m.hostApi < 1) problems.push('hostApi must be an integer >= 1');
  for (const field of ['requires', 'optional']) {
    const deps = m[field] ?? {};
    if (typeof deps !== 'object' || Array.isArray(deps)) { problems.push(`${field} must map plugin names to ranges`); continue; }
    for (const [dep, range] of Object.entries(deps)) {
      if (!PLUGIN_NAME.test(dep)) problems.push(`${field}: ${dep} is not a plugin name`);
      if (dep === m.name) problems.push(`${field}: a plugin cannot depend on itself`);
      if (!validRange(range)) problems.push(`${field}: ${dep} has an invalid range ${JSON.stringify(range)}`);
    }
  }
  for (const dep of Object.keys(m.requires ?? {})) if (dep in (m.optional ?? {})) problems.push(`${dep} is both required and optional`);
  const services = m.services ?? [];
  if (!Array.isArray(services)) problems.push('services must be a list');
  else {
    for (const s of services) if (!HOST_SERVICES.includes(s)) problems.push(`unknown host service ${s}`);
    if (new Set(services).size !== services.length) problems.push('services has duplicates');
  }
  const routes = m.identityServiceRoutes ?? [];
  if (!Array.isArray(routes) || routes.some((r) => typeof r !== 'string' || !ROUTE.test(r))) problems.push('identityServiceRoutes must be absolute route patterns');
  if (routes.length && !services.includes('identityService')) problems.push('identityServiceRoutes needs the identityService service');
  if (typeof m.init !== 'function') problems.push('init must be a function');
  for (const fn of ['start', 'stop']) if (m[fn] !== undefined && typeof m[fn] !== 'function') problems.push(`${fn} must be a function`);
  if (problems.length) fail('host.invalid_manifest', `${m.name ?? 'plugin'}: ${problems.join('; ')}`, { problems });
}

// Exactly one default export per plugin.mjs: `export default definePlugin({...})`.
export function definePlugin(manifest) {
  validateManifest(manifest);
  return Object.freeze({
    name: manifest.name,
    version: manifest.version,
    hostApi: manifest.hostApi,
    requires: Object.freeze({ ...(manifest.requires ?? {}) }),
    optional: Object.freeze({ ...(manifest.optional ?? {}) }),
    services: Object.freeze([...(manifest.services ?? [])]),
    identityServiceRoutes: Object.freeze([...(manifest.identityServiceRoutes ?? [])]),
    init: manifest.init,
    start: manifest.start ?? (async () => {}),
    stop: manifest.stop ?? (async () => {}),
  });
}

// The static fields HQ reads before running plugin code (plugin.json).
export const staticManifest = (p) => ({
  name: p.name, version: p.version, hostApi: p.hostApi,
  requires: { ...p.requires }, optional: { ...p.optional },
  services: [...p.services], identityServiceRoutes: [...p.identityServiceRoutes],
});

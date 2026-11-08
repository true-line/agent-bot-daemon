// Minimal semver for plugin versions and dependency ranges (§4.5). Zero
// dependencies (§3.4 rule 5), so only what plugin manifests need:
// versions MAJOR.MINOR.PATCH with an optional -prerelease, and ranges built
// from `*`, exact or partial (`1`, `1.2`) versions, `=`, `>`, `>=`, `<`, `<=`,
// `^` and `~`, joined by spaces (all must hold) and `||` (any alternative).

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(text) {
  const m = VERSION.exec(text);
  if (!m) throw new TypeError(`${JSON.stringify(text)} is not a MAJOR.MINOR.PATCH version`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

export const isVersion = (text) => typeof text === 'string' && VERSION.test(text);

function comparePre(a, b) {
  if (!a.length || !b.length) return a.length ? -1 : b.length ? 1 : 0; // a release outranks its prereleases
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const [na, nb] = [/^\d+$/.test(a[i]), /^\d+$/.test(b[i])];
    if (na && nb && +a[i] !== +b[i]) return +a[i] < +b[i] ? -1 : 1;
    if (na !== nb) return na ? -1 : 1;
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a, b) {
  const [x, y] = [typeof a === 'string' ? parseVersion(a) : a, typeof b === 'string' ? parseVersion(b) : b];
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  return comparePre(x.pre, y.pre);
}

const COMPARATOR = /^(\^|~|>=|<=|>|<|=)?(.+)$/;
const PARTIAL = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;

// One range token → full comparators [op, version]. Partial versions follow
// npm: `<1` is `<1.0.0`, `>1.2` is `>=1.3.0`, `<=1` is `<2.0.0`, a bare `1.2`
// is `~1.2.0`, and `^1`/`~1` fill the missing parts with 0.
function expand(token) {
  if (token === '*') return [];
  const [, op = '=', ver] = COMPARATOR.exec(token);
  const p = PARTIAL.exec(ver);
  if (!p) return [[op, parseVersion(ver)]];
  const major = +p[1];
  const minor = p[2] === undefined ? undefined : +p[2];
  const v = (M, m = 0) => ({ major: M, minor: m, patch: 0, pre: [] });
  const next = minor === undefined ? v(major + 1) : v(major, minor + 1);
  const low = v(major, minor ?? 0);
  switch (op) {
    case '<': case '>=': return [[op, low]];
    case '>': return [['>=', next]];
    case '<=': return [['<', next]];
    case '^': return [['^', low]];
    case '~': case '=': return [['>=', low], ['<', next]];
    default: return [[op, low]];
  }
}

function comparatorHolds([op, t], v) {
  const c = compareVersions(v, t);
  switch (op) {
    case '=': return c === 0;
    case '>': return c > 0;
    case '>=': return c >= 0;
    case '<': return c < 0;
    case '<=': return c <= 0;
    case '~': return c >= 0 && v.major === t.major && v.minor === t.minor;
    case '^':
      if (c < 0) return false;
      if (t.major > 0) return v.major === t.major;
      if (t.minor > 0) return v.major === 0 && v.minor === t.minor;
      return v.major === 0 && v.minor === 0 && v.patch === t.patch;
    default: return false;
  }
}

export function validRange(range) {
  try {
    rangeAlternatives(range);
    return true;
  } catch {
    return false;
  }
}

function rangeAlternatives(range) {
  if (typeof range !== 'string' || !range.trim()) throw new TypeError('a range is a non-empty string');
  return range.split('||').map((alt) => {
    const toks = alt.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) throw new TypeError(`empty alternative in ${JSON.stringify(range)}`);
    return toks.flatMap(expand);
  });
}

// A prerelease satisfies a range only when some comparator names the same
// MAJOR.MINOR.PATCH with a prerelease (the usual semver rule).
export function satisfies(version, range) {
  const v = parseVersion(version);
  return rangeAlternatives(range).some((alt) => {
    if (!alt.every((cmp) => comparatorHolds(cmp, v))) return false;
    if (!v.pre.length) return true;
    return alt.some(([, t]) => t.pre.length && t.major === v.major && t.minor === v.minor && t.patch === v.patch);
  });
}

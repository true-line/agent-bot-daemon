#!/usr/bin/env node
// Pin of the true-line/soul-contracts release this repository builds against (D5, §9 PR 7).
//
//   node scripts/soul-contracts.mjs [verify]   fetch the pinned release into .cache/ and check it
//   node scripts/soul-contracts.mjs pin <tag>  re-pin to a newer tag (pins never move backwards, §4.5)
//
// The repository keeps no copy of the contracts. The fetched, digest-checked
// tree under .cache/soul-contracts/<commit>/ is what tests load (§4.6).
//
// Digest (sha256-manifest-v1, the §5.3 package framing): a manifest maps each
// pinned file's path to { sha256, size, mode } (git modes 100644 / 100755);
// the digest is the SHA-256 of the manifest's RFC 8785 (JCS) bytes.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PIN_PATH = join(ROOT, 'governance/soul-contracts.json');
export const ALGORITHM = 'sha256-manifest-v1';
const CACHE = join(ROOT, '.cache/soul-contracts');
const MODES = new Set(['100644', '100755']);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// RFC 8785 for the values a manifest holds: objects, strings and safe integers.
// Keys sort by UTF-16 code units (JavaScript's default sort); strings and
// integers serialize as ECMAScript JSON does, which is what JCS specifies.
export function canonicalize(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Number.isSafeInteger(value)) return JSON.stringify(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`manifest values are objects, strings or safe integers, got ${JSON.stringify(value)}`);
}

// entries: [{ path, mode, bytes }]. Returns { manifest, digest, files }.
export function manifestDigest(entries) {
  const manifest = {};
  for (const { path, mode, bytes } of entries) {
    if (!MODES.has(mode)) throw new Error(`${path}: unsupported mode ${mode} (only regular files are pinned)`);
    if (path.startsWith('/') || path.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new Error(`${path}: not a canonical relative path`);
    if (path in manifest) throw new Error(`${path}: duplicate`);
    manifest[path] = { sha256: sha256(bytes), size: bytes.length, mode };
  }
  return { manifest, digest: `sha256:${sha256(Buffer.from(canonicalize(manifest), 'utf8'))}`, files: entries.length };
}

export function compareSemver(a, b) {
  const parse = (t) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(t);
    if (!m) throw new Error(`${t}: release tags are vMAJOR.MINOR.PATCH`);
    return m.slice(1).map(Number);
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function readPin(path = PIN_PATH) {
  const pin = JSON.parse(readFileSync(path, 'utf8'));
  const problems = [];
  if (pin.schema_version !== 1) problems.push('schema_version must be 1');
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(pin.repository ?? '')) problems.push('repository must be an https GitHub URL ending in .git');
  if (!/^v\d+\.\d+\.\d+$/.test(pin.tag ?? '')) problems.push('tag must be vMAJOR.MINOR.PATCH');
  if (!/^[0-9a-f]{40}$/.test(pin.commit ?? '')) problems.push('commit must be a full 40-hex SHA');
  if (!Array.isArray(pin.paths) || pin.paths.length === 0 || [...pin.paths].sort().join() !== pin.paths.join()) problems.push('paths must be a non-empty sorted list');
  if (pin.digest_algorithm !== ALGORITHM) problems.push(`digest_algorithm must be ${ALGORITHM}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(pin.digest ?? '')) problems.push('digest must be sha256:<64 hex>');
  if (!Number.isSafeInteger(pin.files) || pin.files < 1) problems.push('files must be a positive integer');
  if (problems.length) throw new Error(`${path}: ${problems.join('; ')}`);
  return pin;
}

const git = (args, opts = {}) => execFileSync('git', args, { maxBuffer: 1 << 28, ...opts });

// Fetch <tag> from <repository> into the cache; return the commit it points at.
function fetchTag(repository, tag) {
  const repo = join(CACHE, 'repo.git');
  if (!existsSync(repo)) git(['init', '-q', '--bare', repo]);
  // A credential-free fetch: the contracts repository is public, and no token is ever used here.
  git(['-C', repo, '-c', 'credential.helper=', 'fetch', '-q', '--depth', '1', '--no-tags', repository, `+refs/tags/${tag}:refs/tags/${tag}`],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { repo, commit: git(['-C', repo, 'rev-parse', `refs/tags/${tag}^{commit}`]).toString().trim() };
}

// Read the pinned paths of <commit> straight from git objects (modes as git records them).
function treeEntries(repo, commit, paths) {
  const listing = git(['-C', repo, 'ls-tree', '-r', '-z', commit, '--', ...paths]).toString();
  return listing.split('\0').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t');
    const [mode, type, oid] = meta.split(' ');
    if (type !== 'blob') throw new Error(`${path}: ${type} entries are not pinned`);
    return { path, mode, bytes: git(['-C', repo, 'cat-file', 'blob', oid]) };
  });
}

function materialize(dir, entries) {
  rmSync(dir, { recursive: true, force: true });
  for (const { path, bytes } of entries) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  writeFileSync(join(dir, '.verified'), '');
}

// Fetch and verify the pinned release; return the directory tests load from.
export function verify(pin = readPin()) {
  const { repo, commit } = fetchTag(pin.repository, pin.tag);
  if (commit !== pin.commit) throw new Error(`tag ${pin.tag} now points at ${commit}, not the pinned ${pin.commit}; refusing a moved tag`);
  const entries = treeEntries(repo, commit, pin.paths);
  const got = manifestDigest(entries);
  if (got.digest !== pin.digest || got.files !== pin.files) {
    throw new Error(`soul-contracts ${pin.tag} digest ${got.digest} (${got.files} files) does not match the pin ${pin.digest} (${pin.files} files)`);
  }
  const dir = join(CACHE, commit);
  materialize(dir, entries);
  return { dir, ...got };
}

export function repin(tag, pin = readPin()) {
  if (compareSemver(tag, pin.tag) < 0) throw new Error(`pins never move backwards: ${tag} is older than ${pin.tag}`);
  const { repo, commit } = fetchTag(pin.repository, tag);
  const got = manifestDigest(treeEntries(repo, commit, pin.paths));
  return { ...pin, tag, commit, digest: got.digest, files: got.files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd = 'verify', tag] = process.argv.slice(2);
  try {
    if (cmd === 'verify') {
      const pin = readPin();
      const { dir, digest, files } = verify(pin);
      console.log(`ok soul-contracts ${pin.tag} (${pin.commit.slice(0, 7)}) ${digest} ${files} files -> ${dir}`);
    } else if (cmd === 'pin' && tag) {
      const next = repin(tag);
      writeFileSync(PIN_PATH, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`pinned soul-contracts ${next.tag} (${next.commit.slice(0, 7)}) ${next.digest} ${next.files} files`);
    } else {
      console.error('usage: soul-contracts.mjs [verify] | pin <tag>');
      process.exit(2);
    }
  } catch (err) {
    console.error(`FAIL ${err.message}`);
    process.exit(1);
  }
}

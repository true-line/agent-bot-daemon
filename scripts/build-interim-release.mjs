#!/usr/bin/env node
// Build an unpublished HQ source artifact from the clean, exact checked-out
// commit. The caller supplies an already obtained public contracts tree; the
// pinned manifest is checked before any bytes enter the artifact.
import { createHash } from 'node:crypto';
import { cpSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readPin, verifyVendored } from './soul-contracts.mjs';

if (process.platform !== 'linux') throw new Error('interim artifact build is supported on Linux only');
const [commit, contracts, output, ...rest] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(commit ?? '') || !contracts || !output || rest.length) throw new Error('usage: node scripts/build-interim-release.mjs <full-commit> <verified-contracts-dir> <output.tar>');
const git = (args, options = {}) => execFileSync('git', args, options);
if (git(['rev-parse', 'HEAD']).toString().trim() !== commit) throw new Error('checkout HEAD must be the requested commit');
if (git(['status', '--porcelain', '--untracked-files=all']).length) throw new Error('checkout must be clean');
// Check Git's recorded modes before extracting anything: tar must never see a
// source symlink, gitlink or a path that can escape or collide with additions.
for (const row of git(['ls-tree', '-rz', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean)) {
  const tab = row.indexOf('\t');
  if (tab < 0) throw new Error('malformed source tree entry');
  const [mode, type] = row.slice(0, tab).split(' ');
  const path = row.slice(tab + 1);
  if (type !== 'blob' || !['100644', '100755'].includes(mode) || !path || path.startsWith('/')
    || path.split('/').some((part) => !part || part === '.' || part === '..') || /[\x00-\x1f\x7f]/.test(path)
    || path === 'hq/interim-core.mjs' || path === 'governance/interim-release.json'
    || path === 'vendor/soul-contracts' || path.startsWith('vendor/soul-contracts/')) {
    throw new Error(`unsupported source tree entry: ${path}`);
  }
}
const pin = readPin();
verifyVendored(resolve(contracts), pin);
const dest = resolve(output);
try { lstatSync(dest); throw new Error('output already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const work = mkdtempSync(join(tmpdir(), 'hq-interim-'));
const outputWork = mkdtempSync(join(dirname(dest), '.hq-interim-output-'));
try {
  const tree = join(work, 'hq');
  mkdirSync(tree);
  const sourceTar = join(work, 'source.tar');
  git(['archive', '--format=tar', '--output', sourceTar, commit]);
  execFileSync('tar', ['-xf', sourceTar, '-C', tree]);
  const vendor = join(tree, 'vendor/soul-contracts');
  mkdirSync(vendor, { recursive: true });
  for (const path of pin.paths) cpSync(join(resolve(contracts), path), join(vendor, path), { recursive: true, dereference: false, preserveTimestamps: false });
  verifyVendored(vendor, pin);
  writeFileSync(join(tree, 'governance/interim-release.json'), `${JSON.stringify({ schema_version: 1, hq_commit: commit, contracts_commit: pin.commit, contracts_digest: pin.digest }, null, 2)}\n`);
  renameSync(join(tree, 'hq/main.mjs'), join(tree, 'hq/interim-core.mjs'));
  writeFileSync(join(tree, 'hq/main.mjs'), "// Interim artifact entrypoint: verify vendored contracts without network fallback.\nif (process.platform !== 'linux') throw new Error('interim artifact runs on Linux only');\nprocess.env.HQ_INTERIM_OFFLINE = '1';\nawait import('./interim-core.mjs');\n");
  const temporaryTar = join(outputWork, 'artifact.tar');
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--mode=u+rwX,go+rX,go-w', '--format=ustar', '-cf', temporaryTar, '-C', work, 'hq']);
  const sha = createHash('sha256').update(readFileSync(temporaryTar)).digest('hex');
  // A hard link fails if a file or symlink appears at the destination meanwhile.
  linkSync(temporaryTar, dest);
  process.stdout.write(`${sha}  ${dest}\nHQ commit ${commit}\ncontracts ${pin.commit} ${pin.digest}\n`);
} finally { rmSync(work, { recursive: true, force: true }); rmSync(outputWork, { recursive: true, force: true }); }

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestDigest } from '../scripts/soul-contracts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...options });

test('interim artifact is reproducible, runs offline and refuses changed contracts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hq-builder-test-'));
  try {
    const repo = join(tmp, 'repo'), contracts = join(tmp, 'contracts');
    for (const d of ['scripts', 'hq', 'governance']) mkdirSync(join(repo, d), { recursive: true });
    const entries = [];
    for (const d of ['errors', 'fixtures', 'schemas']) {
      mkdirSync(join(contracts, d), { recursive: true });
      const bytes = Buffer.from(`${d}\n`);
      writeFileSync(join(contracts, d, 'one.json'), bytes);
      entries.push({ path: `${d}/one.json`, mode: '100644', bytes });
    }
    const got = manifestDigest(entries);
    const pin = { schema_version: 1, repository: 'https://github.com/test/contracts.git', tag: 'v0.4.1', commit: 'a'.repeat(40), paths: ['errors', 'fixtures', 'schemas'], digest_algorithm: 'sha256-manifest-v1', digest: got.digest, files: got.files };
    writeFileSync(join(repo, 'governance/soul-contracts.json'), JSON.stringify(pin));
    writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(repo, 'hq/main.mjs'), "import { verify } from '../scripts/soul-contracts.mjs'; verify(); console.log('offline-ok');\n");
    for (const f of ['soul-contracts.mjs', 'build-interim-release.mjs']) cpSync(join(root, 'scripts', f), join(repo, 'scripts', f));
    run('git', ['init', '-q', repo]);
    run('git', ['-C', repo, 'add', '.']);
    // A local disposable Git object fixture; it is never pushed or published.
    const tree = run('git', ['-C', repo, 'write-tree']).trim();
    const ident = { ...process.env, GIT_AUTHOR_NAME: 'trueline-codex-agent[bot]', GIT_COMMITTER_NAME: 'trueline-codex-agent[bot]', GIT_AUTHOR_EMAIL: '325086705+trueline-codex-agent[bot]@users.noreply.github.com', GIT_COMMITTER_EMAIL: '325086705+trueline-codex-agent[bot]@users.noreply.github.com' };
    const fixtureCommit = run('git', ['-C', repo, 'commit-tree', tree, '-m', 'fixture'], { env: ident }).trim();
    run('git', ['-C', repo, 'update-ref', 'HEAD', fixtureCommit]);
    const sha = run('git', ['-C', repo, 'rev-parse', 'HEAD']).trim();
    const one = join(tmp, 'one.tar'), two = join(tmp, 'two.tar');
    for (const out of [one, two]) run(process.execPath, [join(repo, 'scripts/build-interim-release.mjs'), sha, contracts, out], { cwd: repo });
    const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
    assert.equal(hash(one), hash(two));
    const extracted = join(tmp, 'extract'); mkdirSync(extracted);
    run('tar', ['-xf', one, '-C', extracted]);
    const executable = join(extracted, 'hq/hq/main.mjs');
    assert.match(run(process.execPath, [executable], { env: { PATH: '' } }), /offline-ok/);
    writeFileSync(join(extracted, 'hq/vendor/soul-contracts/errors/one.json'), 'tampered');
    const refused = spawnSync(process.execPath, [executable], { env: { PATH: '' }, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /digest/);
    const dangling = join(tmp, 'dangling.tar'); symlinkSync(join(tmp, 'absent'), dangling);
    assert.notEqual(spawnSync(process.execPath, [join(repo, 'scripts/build-interim-release.mjs'), sha, contracts, dangling], { cwd: repo }).status, 0);
    const fakeBin = join(tmp, 'bin'); mkdirSync(fakeBin);
    symlinkSync(run('which', ['git']).trim(), join(fakeBin, 'git'));
    writeFileSync(join(fakeBin, 'tar'), '#!/bin/sh\nexit 17\n', { mode: 0o755 });
    const failed = join(tmp, 'failed.tar');
    assert.notEqual(spawnSync(process.execPath, [join(repo, 'scripts/build-interim-release.mjs'), sha, contracts, failed], { cwd: repo, env: { ...process.env, PATH: fakeBin } }).status, 0);
    assert.equal(existsSync(failed), false);
    // Even a reviewed Git tree must be inspected before any archive extraction.
    symlinkSync('hq/main.mjs', join(repo, 'source-link'));
    run('git', ['-C', repo, 'add', 'source-link']);
    const symlinkTree = run('git', ['-C', repo, 'write-tree']).trim();
    const symlinkCommit = run('git', ['-C', repo, 'commit-tree', symlinkTree, '-p', sha, '-m', 'symlink fixture'], { env: ident }).trim();
    run('git', ['-C', repo, 'update-ref', 'HEAD', symlinkCommit]);
    const tarMarker = join(tmp, 'tar-invoked');
    writeFileSync(join(fakeBin, 'tar'), '#!/bin/sh\nprintf invoked > "$MARKER"\nexit 17\n', { mode: 0o755 });
    const unsafe = spawnSync(process.execPath, [join(repo, 'scripts/build-interim-release.mjs'), symlinkCommit, contracts, join(tmp, 'unsafe.tar')], { cwd: repo, env: { ...process.env, PATH: fakeBin, MARKER: tarMarker }, encoding: 'utf8' });
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /unsupported source tree entry/);
    assert.equal(existsSync(tarMarker), false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

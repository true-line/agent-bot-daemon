import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestDigest, verifyVendored } from '../scripts/soul-contracts.mjs';

test('vendored contracts verify exact content and refuse tampering and symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-contracts-'));
  try {
    mkdirSync(join(dir, 'schemas'));
    const file = join(dir, 'schemas', 'one.json');
    writeFileSync(file, '{}\n');
    const pin = { paths: ['schemas'], ...manifestDigest([{path:'schemas/one.json', mode:'100644', bytes:Buffer.from('{}\n')}]) };
    assert.equal(verifyVendored(dir, pin).digest, pin.digest);
    const alias = `${dir}-alias`;
    symlinkSync(dir, alias, 'dir');
    try { assert.throws(() => verifyVendored(join(alias, 'schemas'), pin), /ancestry/); } finally { rmSync(alias); }
    writeFileSync(join(dir, 'unexpected'), '{}\n');
    assert.throws(() => verifyVendored(dir, pin), /root entries differ/);
    rmSync(join(dir, 'unexpected'));
    writeFileSync(join(dir, 'schemas', 'extra.json'), '{}\n');
    assert.throws(() => verifyVendored(dir, pin), /does not match/);
    rmSync(join(dir, 'schemas', 'extra.json'));
    chmodSync(file, 0o755);
    assert.throws(() => verifyVendored(dir, pin), /does not match/);
    chmodSync(file, 0o644);
    truncateSync(file, 8 * 1024 * 1024 + 1);
    assert.throws(() => verifyVendored(dir, pin), /size limit/);
    writeFileSync(file, '{"changed":true}\n');
    assert.throws(() => verifyVendored(dir, pin), /does not match/);
    rmSync(file);
    assert.throws(() => verifyVendored(dir, pin), /does not match/);
    symlinkSync('/etc/passwd', file);
    assert.throws(() => verifyVendored(dir, pin), /symlink/);
  } finally { rmSync(dir, { recursive:true, force:true }); }
});

test('interim mode verifies offline and missing payload never falls back to git', async () => {
  const { copyFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'hq-interim-'));
  try {
    for (const path of ['scripts', 'governance', 'vendor/soul-contracts/schemas']) mkdirSync(join(dir, path), {recursive:true});
    copyFileSync(fileURLToPath(new URL('../scripts/soul-contracts.mjs', import.meta.url)), join(dir,'scripts/soul-contracts.mjs'));
    const bytes = Buffer.from('{}\n');
    const digest = manifestDigest([{path:'schemas/one.json', mode:'100644', bytes}]);
    const pin = {schema_version:1, repository:'https://github.com/example/contracts.git', tag:'v1.0.0', commit:'a'.repeat(40), paths:['schemas'], digest_algorithm:'sha256-manifest-v1', digest:digest.digest, files:digest.files};
    writeFileSync(join(dir,'governance/soul-contracts.json'), JSON.stringify(pin));
    const file = join(dir,'vendor/soul-contracts/schemas/one.json');
    writeFileSync(file, bytes);
    const run = () => spawnSync(process.execPath, [join(dir,'scripts/soul-contracts.mjs'),'verify'], {encoding:'utf8', env:{...process.env, PATH:'/nonexistent', HQ_INTERIM_OFFLINE:'1'}});
    assert.equal(run().status, 0);
    rmSync(file);
    const refused = run();
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /does not match/);
    assert.doesNotMatch(refused.stderr, /spawnSync git/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

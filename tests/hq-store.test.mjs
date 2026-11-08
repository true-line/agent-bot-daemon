// HQ's durable store (hq/store.mjs): committed writes survive a reopen, the
// state directory and file are private, a failed persist rolls the write
// back, and an unreadable store is refused rather than overwritten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore, bindServices } from '../sdk/services.mjs';
import { openStore, StoreError } from '../hq/store.mjs';
import { tempHome } from './hq-harness.mjs';

const plugin = { name: 'p', services: ['store', 'receipts'], identityServiceRoutes: [] };

function open(dir) {
  const store = openStore(dir);
  const core = createCore({ persist: () => store.persist() });
  store.load(core);
  core.phases.set('p', 'running');
  return { store, core, services: bindServices(core, plugin) };
}

test('committed tables, blobs and receipts survive a reopen; the file is 0600', async () => {
  const dir = tempHome();
  try {
    const a = open(dir);
    await a.services.store.tx((tx) => tx.put('rows', 'k', { v: 1 }));
    const digest = await a.services.store.blob.put(Buffer.from('hello'));
    await a.services.receipts.append({ kind: 'test' });
    assert.equal(statSync(join(dir, 'store.json')).mode & 0o777, 0o600);

    const b = open(dir);
    assert.deepEqual(await b.services.store.tx((tx) => tx.get('rows', 'k')), { v: 1 });
    assert.equal((await b.services.store.blob.get(digest)).toString(), 'hello');
    assert.equal(b.core.receipts.length, 1);
    assert.equal(b.core.receipts[0].kind, 'test');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a rolled-back transaction writes nothing to disk', async () => {
  const dir = tempHome();
  try {
    const a = open(dir);
    await a.services.store.tx((tx) => tx.put('rows', 'k', { v: 1 }));
    await assert.rejects(a.services.store.tx((tx) => { tx.put('rows', 'k', { v: 2 }); throw new Error('abort'); }), /abort/);
    const b = open(dir);
    assert.deepEqual(await b.services.store.tx((tx) => tx.get('rows', 'k')), { v: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed persist rolls the write back in memory and raises', async () => {
  const core = createCore({ persist: async () => { throw new Error('disk full'); } });
  core.phases.set('p', 'running');
  const services = bindServices(core, plugin);
  await assert.rejects(services.store.tx((tx) => tx.put('rows', 'k', { v: 1 })), /disk full/);
  assert.equal(await services.store.tx((tx) => tx.get('rows', 'k')), undefined);
  await assert.rejects(services.receipts.append({ kind: 'x' }), /disk full/);
  assert.equal(core.receipts.length, 0);
});

test('the state directory must be private and owned by HQ', () => {
  const dir = tempHome();
  try {
    chmodSync(dir, 0o755);
    assert.throws(() => openStore(dir), (e) => e instanceof StoreError && /must be 0700/.test(e.message));
    chmodSync(dir, 0o700);
    assert.throws(() => openStore(dir, { uid: process.getuid() + 1 }), /owned by uid/);
    const fresh = join(dir, 'nested');
    openStore(fresh);
    assert.equal(statSync(fresh).mode & 0o777, 0o700);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable or foreign store is refused and left untouched', () => {
  const dir = tempHome();
  try {
    const path = join(dir, 'store.json');
    writeFileSync(path, '{ not json', { mode: 0o600 });
    assert.throws(() => openStore(dir).load(createCore()), /HQ will not overwrite it/);
    assert.equal(readFileSync(path, 'utf8'), '{ not json');
    writeFileSync(path, JSON.stringify({ format: 'something-else' }), { mode: 0o600 });
    assert.throws(() => openStore(dir).load(createCore()), /format/);
    chmodSync(path, 0o644);
    assert.throws(() => openStore(dir).load(createCore()), /must be 0600/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('persist before load is refused', async () => {
  const dir = tempHome();
  try {
    mkdirSync(join(dir, 'x'), { mode: 0o700 });
    await assert.rejects(openStore(join(dir, 'x')).persist(), /persist before load/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a temporary file left by a crash mid-write is removed; the intact store loads', async () => {
  const dir = tempHome();
  try {
    const a = open(dir);
    await a.services.store.tx((tx) => tx.put('rows', 'k', { v: 1 }));
    writeFileSync(join(dir, 'store.json.tmp-999'), '{ torn', { mode: 0o600 });
    const b = open(dir);
    assert.equal(existsSync(join(dir, 'store.json.tmp-999')), false);
    assert.deepEqual(await b.services.store.tx((tx) => tx.get('rows', 'k')), { v: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

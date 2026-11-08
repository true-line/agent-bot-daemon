// HQ's authoritative store (plan §3.2, §4.3), skeleton form.
//
// The SDK's store service keeps tables, blobs and receipts in the core's
// maps; this module makes them durable. Every committed write calls
// `persist()`, which writes the whole state to `store.json` atomically
// (temporary file, fsync, rename, fsync of the directory). A crash leaves the
// previous or the new state, never a torn one.
//
// It is a stand-in for the transactional embedded database the plan names
// (0.4 §12). It rewrites the whole file on each commit, which is fine for
// the skeleton's few records. The interface (`load` into a core, `persist`)
// stays when the engine changes.
//
// Access: the state directory must be owned by HQ's account and closed to
// group and others (0700), and the file is written 0600. HQ refuses to start
// on a wider directory or a store it cannot parse; it never overwrites a
// store it could not read.
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const STORE_FORMAT = 'agent-bot-hq-store/1';

export class StoreError extends Error {
  constructor(message) { super(message); this.name = 'StoreError'; }
}

// Create the state directory if needed, then check its owner and mode.
export function ensurePrivateDir(dir, { uid = process.getuid?.() } = {}) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if (!st.isDirectory()) throw new StoreError(`${dir} is not a directory`);
  if (uid !== undefined && st.uid !== uid) throw new StoreError(`${dir} is owned by uid ${st.uid}, not HQ's uid ${uid}`);
  if (st.mode & 0o077) throw new StoreError(`${dir} has mode ${(st.mode & 0o777).toString(8)}; HQ's state directory must be 0700`);
  return dir;
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  const dfd = openSync(join(path, '..'), 'r');
  try { fsyncSync(dfd); } catch { /* some filesystems refuse a directory fsync */ } finally { closeSync(dfd); }
}

function snapshot(core) {
  return {
    format: STORE_FORMAT,
    tables: [...core.tables].map(([key, rows]) => [key, [...rows]]),
    blobs: [...core.blobs].map(([key, buf]) => [key, buf.toString('base64')]),
    receipts: core.receipts,
  };
}

// Open the store in `dir`. `load(core)` fills a fresh core from disk;
// `persist` is the hook createCore takes. Persists are serialised, so two
// commits never interleave their writes.
export function openStore(dir, { uid } = {}) {
  ensurePrivateDir(dir, { uid });
  const path = join(dir, 'store.json');
  let core;
  let tail = Promise.resolve();

  function read() {
    if (!existsSync(path)) return undefined;
    const st = statSync(path);
    if (st.mode & 0o077) throw new StoreError(`${path} has mode ${(st.mode & 0o777).toString(8)}; it must be 0600`);
    let data;
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new StoreError(`${path} is not readable JSON (${e.message}); HQ will not overwrite it`);
    }
    if (data?.format !== STORE_FORMAT) throw new StoreError(`${path} has format ${JSON.stringify(data?.format)}, not ${STORE_FORMAT}`);
    return data;
  }

  return {
    path,
    load(target) {
      core = target;
      // A crash mid-write leaves a temporary file beside the intact store.
      for (const f of readdirSync(dir)) if (f.startsWith('store.json.tmp-')) unlinkSync(join(dir, f));
      const data = read();
      if (!data) return { fresh: true };
      for (const [key, rows] of data.tables) core.tables.set(key, new Map(rows));
      for (const [key, b64] of data.blobs) core.blobs.set(key, Buffer.from(b64, 'base64'));
      core.receipts.push(...data.receipts);
      return { fresh: false, tables: data.tables.length, receipts: data.receipts.length };
    },
    persist() {
      if (!core) return Promise.reject(new StoreError('persist before load'));
      const run = tail.then(() => writeAtomic(path, JSON.stringify(snapshot(core))));
      tail = run.catch(() => {});
      return run;
    },
  };
}

// HQ core's own tables (owner sessions) live under the name `hq`. HQ refuses
// to load a plugin with that name (hq/hq.mjs), so no plugin's store service
// can reach them.
export const CORE_PLUGIN = 'hq';

export function coreTable(core, table) {
  const key = `${CORE_PLUGIN}\0${table}`;
  if (!core.tables.has(key)) core.tables.set(key, new Map());
  return core.tables.get(key);
}

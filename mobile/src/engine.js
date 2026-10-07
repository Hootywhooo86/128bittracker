// On-device database: SQLite compiled to WebAssembly (sql.js), wrapped to
// look like node:sqlite (see adapter.js). The database file lives in IndexedDB.
import initSqlJs from 'sql.js/dist/sql-wasm-browser.js';
import { migrate } from '../../src/db/schema.js';
import { adapt } from './adapter.js';

const IDB_NAME = '128bittracker';
const IDB_STORE = 'files';
const IDB_KEY = 'tracker.db';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet() {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(bytes) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(IDB_STORE, 'readwrite');
    t.objectStore(IDB_STORE).put(bytes, IDB_KEY);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function openDevice({ wasmUrl = '/sql-wasm-browser.wasm' } = {}) {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const saved = await idbGet();
  const raw = saved ? new SQL.Database(new Uint8Array(saved)) : new SQL.Database();
  const db = adapt(raw);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);

  let timer = null;
  let saving = Promise.resolve();
  function saveNow() {
    clearTimeout(timer);
    timer = null;
    // export() closes + reopens the connection, which resets per-connection pragmas.
    const bytes = raw.export();
    db.exec('PRAGMA foreign_keys = ON');
    saving = saving.then(() => idbPut(bytes));
    return saving;
  }
  if (!saved) await saveNow();

  return {
    db,
    /** Persist soon (writes are batched). */
    scheduleSave: () => {
      clearTimeout(timer);
      timer = setTimeout(saveNow, 250);
    },
    /** Persist immediately, e.g. when the app goes to the background. */
    flush: () => (timer ? saveNow() : saving),
  };
}

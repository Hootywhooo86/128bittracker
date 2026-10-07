// Full export / restore. The same JSON is the download, the server-side
// backup and the restore source, on the web and on the phone.
import { HttpError } from '../api/errors.js';
import { tx } from '../db/tx.js';

export const EXPORT_FORMAT = '128bittracker-export';

// Parents before children, so foreign keys hold on insert.
const TABLES = ['trackers', 'logs', 'freezes', 'items', 'sessions', 'collections', 'collection_items', 'events'];

export function exportAll(db) {
  const all = (t) => db.prepare(`SELECT * FROM ${t}`).all();
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exported_at: new Date().toISOString(),
    trackers: all('trackers'),
    logs: all('logs'),
    freezes: all('freezes'),
    items: all('items').map((i) => ({ ...i, meta: JSON.parse(i.meta) })),
    sessions: all('sessions'),
    collections: all('collections'),
    collection_items: all('collection_items'),
    events: all('events').map(({ payload, ...e }) => ({ ...e, data: JSON.parse(payload) })),
  };
}

/** Replace everything (except settings like sync config) with an export. */
export function importAll(db, data) {
  if (!data || data.format !== EXPORT_FORMAT) throw new HttpError(400, 'not a 128bit Tracker export');
  if (data.version !== 1) throw new HttpError(400, `unsupported export version ${data.version}`);
  for (const t of TABLES) {
    if (data[t] !== undefined && !Array.isArray(data[t])) throw new HttpError(400, `${t} must be an array`);
  }
  const counts = {};
  tx(db, () => {
    for (const t of [...TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
    for (const t of TABLES) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      const rows = data[t] ?? [];
      for (const raw of rows) {
        const row = { ...raw };
        if (t === 'items') row.meta = JSON.stringify(row.meta ?? {});
        if (t === 'events') row.payload = JSON.stringify(row.data ?? {});
        // Older exports may lack newer columns; unknown keys are dropped.
        const keys = cols.filter((c) => row[c] !== undefined);
        db.prepare(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(
          ...keys.map((k) => (typeof row[k] === 'boolean' ? (row[k] ? 1 : 0) : row[k])),
        );
      }
      counts[t] = rows.length;
    }
  });
  return { restored: counts, exported_at: data.exported_at ?? null };
}

// Phone ⇄ Tracker server sync.
//
// The phone is the source of truth for your data and works offline. A linked
// server acts as the hub for the rest of the 128bit family:
//   pull — events other apps (128bitplay, 128bitfit, …) sent to the server are
//          applied here through the same ingest code the server uses
//   push — this phone's own events (habit.completed, streak.milestone, …) go
//          to the server, which fans them out to webhooks (e.g. 128bitplay)
//   backup — after a sync where anything changed, a full export is stored on
//          the server (latest 10 kept) so a lost phone loses nothing
//
// Events derived while applying pulled events (e.g. "item.added" for a new
// 128bitplay game) are not pushed: the server derives its own copies.
import { ingest } from '../../src/integrations/index.js';
import { HttpError } from '../../src/api/errors.js';
import { exportAll, importAll } from '../../src/domain/backup.js';

const AUTO_EVERY_MS = 5 * 60 * 1000;

export function createSync(ctx, { scheduleSave, fetchImpl = (...a) => fetch(...a) } = {}) {
  const { db } = ctx;
  const get = (k) => db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value ?? null;
  const set = (k, v) => db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v == null ? null : String(v));
  const num = (k) => Number(get(k) ?? 0);
  const maxOwnSeq = () => db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM events WHERE source = '128bittracker'").get().m;

  function settings() {
    return {
      server_url: get('sync.server_url'),
      has_key: !!get('sync.api_key'),
      last_sync_at: get('sync.last_sync_at'),
      last_error: get('sync.last_error'),
      pulled_total: num('sync.pulled_total'),
      pushed_total: num('sync.pushed_total'),
      last_backup_at: get('backup.last_at'),
    };
  }

  /** Something changed locally since the last backup. */
  const markDirty = () => set('backup.dirty', '1');

  async function backupNow() {
    const snap = exportAll(db);
    await call('PUT', '/sync/backup', snap);
    set('backup.dirty', null);
    set('backup.last_at', snap.exported_at);
    scheduleSave?.();
    return { backed_up: true, at: snap.exported_at };
  }

  /** Replace this phone's data with a server backup (default: the newest). */
  async function restore(id = 'latest') {
    const data = await call('GET', `/sync/backups/${id}`);
    const res = importAll(db, data);
    afterRestore();
    return res;
  }

  /** After any restore: don't re-push restored history to the server. */
  function afterRestore() {
    set('sync.outbox_seq', maxOwnSeq());
    set('sync.skip', '[]');
    set('backup.dirty', null);
    scheduleSave?.();
  }

  function configure({ server_url, api_key } = {}) {
    if (server_url !== undefined) {
      const url = String(server_url).trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s/]+/.test(url)) throw new HttpError(400, 'server URL must start with http:// or https://');
      if (url !== (get('sync.server_url') ?? '')) {
        // New server → start both cursors fresh. Only push what happens from now on.
        set('sync.inbox_cursor', 0);
        set('sync.outbox_seq', maxOwnSeq());
        set('sync.skip', '[]');
        set('sync.last_error', null);
      }
      set('sync.server_url', url || null);
    }
    if (api_key !== undefined) {
      const key = String(api_key).trim();
      if (key && !/^tb128_[A-Za-z0-9_-]{8,}$/.test(key)) throw new HttpError(400, 'that doesn\'t look like a Tracker key (tb128_…)');
      set('sync.api_key', key || null);
    }
    scheduleSave?.();
    return settings();
  }

  async function call(method, path, body) {
    if (!get('sync.server_url') || !get('sync.api_key')) throw new HttpError(400, 'link a server first');
    const res = await fetchImpl(get('sync.server_url') + '/api/v1' + path, {
      method,
      headers: { authorization: `Bearer ${get('sync.api_key')}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ? `${data.error} (HTTP ${res.status})` : `HTTP ${res.status}`);
    return data;
  }

  // Ranges of own-event seqs that were derived from pulled events (never pushed).
  const skips = () => JSON.parse(get('sync.skip') ?? '[]');
  const skipped = (seq, list) => list.some(([a, b]) => seq >= a && seq <= b);

  async function push() {
    let sent = 0;
    for (;;) {
      const from = num('sync.outbox_seq');
      const rows = db
        .prepare("SELECT rowid AS seq, * FROM events WHERE source = '128bittracker' AND rowid > ? ORDER BY rowid LIMIT 200")
        .all(from);
      if (!rows.length) break;
      const list = skips();
      const batch = rows
        .filter((r) => !skipped(r.seq, list))
        .map(({ seq, payload, received_at, ...e }) => ({ ...e, data: JSON.parse(payload) }));
      if (batch.length) {
        const results = await call('POST', '/sync/outbox', batch);
        const failed = results.find((r) => r.status === 'error');
        if (failed) throw new Error(`server rejected ${failed.id}: ${failed.error}`);
        sent += batch.length;
      }
      const last = rows.at(-1).seq;
      set('sync.outbox_seq', last);
      set('sync.skip', JSON.stringify(list.filter(([, b]) => b > last)));
    }
    return sent;
  }

  async function pull() {
    let applied = 0;
    for (;;) {
      const page = await call('GET', `/sync/inbox?cursor=${num('sync.inbox_cursor')}&limit=200`);
      // Synchronous from here: no UI request can interleave with the ingest,
      // so every own event created in [before+1, after] is derived.
      const before = maxOwnSeq();
      for (const ev of page.events) {
        try {
          if (ingest(ctx, ev).status === 'accepted') applied++;
        } catch (err) {
          console.warn('sync: skipped event', ev.id, err.message);
        }
      }
      const after = maxOwnSeq();
      if (after > before) set('sync.skip', JSON.stringify([...skips(), [before + 1, after]]));
      set('sync.inbox_cursor', page.cursor);
      scheduleSave?.();
      if (!page.more) break;
    }
    return applied;
  }

  let running = null;
  function run() {
    if (!get('sync.server_url') || !get('sync.api_key')) return Promise.resolve({ pulled: 0, pushed: 0, error: 'not linked' });
    running ??= (async () => {
      try {
        const pushed = await push();
        const pulled = await pull();
        set('sync.pulled_total', num('sync.pulled_total') + pulled);
        set('sync.pushed_total', num('sync.pushed_total') + pushed);
        // Keep a server copy of everything whenever something changed.
        const backed_up = pulled > 0 || get('backup.dirty') ? (await backupNow()).backed_up : false;
        set('sync.last_sync_at', new Date().toISOString());
        set('sync.last_error', null);
        return { pulled, pushed, backed_up };
      } catch (err) {
        set('sync.last_error', err.message);
        return { pulled: 0, pushed: 0, error: err.message };
      } finally {
        scheduleSave?.();
        running = null;
      }
    })();
    return running;
  }

  /** Background-ish auto sync: on launch, on resume, and every few minutes while open. */
  function startAuto({ onSynced } = {}) {
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      const r = await run();
      if (!r.error && (r.pulled || r.pushed)) onSynced?.(r);
    };
    setTimeout(tick, 1500);
    setInterval(tick, AUTO_EVERY_MS);
    document.addEventListener('visibilitychange', tick);
  }

  return { settings, configure, run, startAuto, markDirty, backupNow, restore, afterRestore };
}

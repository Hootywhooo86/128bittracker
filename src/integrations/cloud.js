// Your library in the cloud (supabase/tracker.sql), per 128bit family account.
//
// Every device signed in to the same account sees the same library, lists and
// trophies, and 128bitPlay reads them (lists as rows on its screens, Up Next,
// watchlist, calendar). What you watch in Play lands in the cloud straight away
// (a database trigger), and comes down here on the next sync.
//
//   push  items / lists / list entries / trophies changed since the last push,
//         deletes (tombstones), and the Coming Up calendar for Play
//   pull  everything changed in the cloud since the last pull; the newer
//         updated_at wins
//
// Each account gets its own library: a Tracker that has synced as one account
// refuses another (the phone switches to a separate database instead).
import { HttpError } from '../api/errors.js';
import { createItem, updateItem } from '../domain/library.js';
import { tx } from '../db/tx.js';
import { upcoming } from './calendar.js';
import { lookupShowByImdb, lookupShowById } from './enrich.js';

const BATCH = 500;
const ENRICH_PER_SYNC = 10;

const kvGet = (ctx, k) => {
  const v = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value;
  return v ? JSON.parse(v) : null;
};
const kvPut = (ctx, k, v) =>
  ctx.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v == null ? null : JSON.stringify(v));

const state = (ctx) => kvGet(ctx, 'cloud.state') ?? {};
const setState = (ctx, patch) => kvPut(ctx, 'cloud.state', { ...state(ctx), ...patch });
export const cloudOwner = (ctx) => kvGet(ctx, 'cloud.owner');
export const cloudEnabled = (ctx) => !!state(ctx).enabled;

const newUid = (prefix) => `${prefix}-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '')}`;

/** Ids other apps know a title by, from the item's meta. */
const ID_KEYS = {
  tmdb_id: 'tmdb', imdb_id: 'imdb', tvdb_id: 'tvdb', tvmaze_id: 'tvmaze', anilist_id: 'anilist', mal_id: 'mal',
  kitsu_id: 'kitsu', play_id: 'play', igdb_id: 'igdb', steam_appid: 'steam', trakt_id: 'trakt', hardcover_id: 'hardcover', goodreads_id: 'goodreads',
};

export function idsOf(meta = {}) {
  const ids = {};
  for (const [k, name] of Object.entries(ID_KEYS)) if (meta[k] != null && meta[k] !== '') ids[name] = meta[k];
  return ids;
}

function metaFromIds(ids = {}) {
  const meta = {};
  for (const [k, name] of Object.entries(ID_KEYS)) if (ids[name] != null) meta[k] = ids[name];
  return meta;
}

/** Make sure the account syncing is this Tracker's account. */
export function claimOwner(ctx, userId) {
  if (!userId) return;
  const owner = cloudOwner(ctx);
  if (!owner) kvPut(ctx, 'cloud.owner', userId);
  else if (owner !== userId) {
    throw new HttpError(409, 'This Tracker already holds another 128bit account\'s library.', { code: 'other_account' });
  }
}

export function cloudStatus(ctx) {
  const s = state(ctx);
  return {
    enabled: !!s.enabled,
    last_sync_at: s.last_sync_at ?? null,
    last_error: s.last_error ?? null,
    pushed_total: s.pushed_total ?? 0,
    pulled_total: s.pulled_total ?? 0,
    profile: s.profile ?? null,
  };
}

// ---------- push ----------

function ensureUid(ctx, table, id, prefix) {
  const row = ctx.db.prepare(`SELECT uid FROM ${table} WHERE id = ?`).get(id);
  if (row?.uid) return row.uid;
  const uid = newUid(prefix);
  ctx.db.prepare(`UPDATE ${table} SET uid = ? WHERE id = ?`).run(uid, id);
  return uid;
}

function itemRow(ctx, i) {
  const meta = JSON.parse(i.meta);
  const { season, backdrop_url, ...rest } = meta;
  return {
    id: i.uid ?? ensureUid(ctx, 'items', i.id, 'i'),
    type: i.type, title: i.title, creator: i.creator, year: i.year, cover_url: i.cover_url, backdrop_url: backdrop_url ?? null,
    status: i.status, progress: i.progress, progress_total: i.progress_total, rating: i.rating, season: season ?? null,
    ids: idsOf(meta), meta: rest, started_at: i.started_at, finished_at: i.finished_at, updated_at: i.updated_at,
  };
}

function collectChanges(ctx, since) {
  const after = since ?? '';
  const items = ctx.db.prepare('SELECT * FROM items WHERE updated_at > ? OR uid IS NULL').all(after).map((i) => itemRow(ctx, i));
  const lists = ctx.db.prepare('SELECT * FROM collections WHERE COALESCE(updated_at, created_at) > ? OR uid IS NULL').all(after).map((c) => ({
    id: c.uid ?? ensureUid(ctx, 'collections', c.id, 'l'),
    name: c.name, description: c.description, kind: c.kind, show_in_play: !!c.show_in_play, is_public: !!c.is_public,
    position: c.position, updated_at: c.updated_at ?? c.created_at,
  }));
  const listItems = ctx.db
    .prepare(`SELECT c.uid AS list_uid, i.uid AS item_uid, ci.position, COALESCE(ci.updated_at, c.created_at) AS updated_at
                FROM collection_items ci JOIN collections c ON c.id = ci.collection_id JOIN items i ON i.id = ci.item_id
               WHERE COALESCE(ci.updated_at, c.created_at) > ?`)
    .all(after)
    .map((r) => ({ list_id: r.list_uid, item_id: r.item_uid, position: r.position, updated_at: r.updated_at }));
  const trophies = ctx.db
    .prepare('SELECT t.*, i.uid AS item_uid FROM trophies t LEFT JOIN items i ON i.id = t.item_id WHERE t.uid IS NULL OR t.earned_at > ?')
    .all(after)
    .map((t) => {
      // Two devices earning the same item's trophy make one trophy, not two.
      const uid = t.uid ?? (t.item_uid ? `tr-${t.item_uid}` : newUid('tr'));
      if (!t.uid) ctx.db.prepare('UPDATE trophies SET uid = ? WHERE id = ?').run(uid, t.id);
      return { id: uid, kind: t.kind, title: t.title, item_id: t.item_uid, earned_at: t.earned_at, updated_at: t.earned_at };
    });
  const tombs = ctx.db.prepare('SELECT * FROM tombstones').all();
  for (const t of tombs) {
    const row = { deleted: true, updated_at: t.at };
    if (t.kind === 'item') items.push({ ...row, id: t.uid, type: 'other', title: '(deleted)' });
    else if (t.kind === 'list') lists.push({ ...row, id: t.uid, name: '(deleted)' });
    else if (t.kind === 'list_item') {
      const [list_id, item_id] = t.uid.split('|');
      listItems.push({ ...row, list_id, item_id });
    }
  }
  return { items, lists, list_items: listItems, trophies, tombs };
}

async function push(ctx, rpc) {
  const startedAt = new Date().toISOString();
  const c = collectChanges(ctx, state(ctx).pushed_at);
  let sent = 0;
  const chunks = (arr) => Array.from({ length: Math.ceil(arr.length / BATCH) }, (_, i) => arr.slice(i * BATCH, (i + 1) * BATCH));
  // Items first, then the lists that point at them.
  for (const items of chunks(c.items)) { await rpc('tracker_push', { payload: { items } }); sent += items.length; }
  for (const lists of chunks(c.lists)) { await rpc('tracker_push', { payload: { lists } }); sent += lists.length; }
  for (const list_items of chunks(c.list_items)) { await rpc('tracker_push', { payload: { list_items } }); sent += list_items.length; }
  for (const trophies of chunks(c.trophies)) { await rpc('tracker_push', { payload: { trophies } }); sent += trophies.length; }
  // Coming Up, for 128bitPlay's calendar.
  try {
    const cal = await upcoming(ctx);
    const uidOf = (id) => (id ? ctx.db.prepare('SELECT uid FROM items WHERE id = ?').get(id)?.uid ?? null : null);
    const calendar = cal.filter((e) => e.date).slice(0, 300).map((e) => ({ date: e.date, kind: e.kind, title: e.title, detail: e.detail ?? null, item_id: uidOf(e.item_id) }));
    await rpc('tracker_push', { payload: { calendar } });
  } catch (err) {
    if (err instanceof HttpError && err.status === 502) throw err;
  }
  if (c.tombs.length) {
    const del = ctx.db.prepare('DELETE FROM tombstones WHERE kind = ? AND uid = ? AND at = ?');
    for (const t of c.tombs) del.run(t.kind, t.uid, t.at);
  }
  setState(ctx, { pushed_at: startedAt });
  return sent;
}

// ---------- pull ----------

function applyItem(ctx, r) {
  const local = ctx.db.prepare('SELECT * FROM items WHERE uid = ?').get(r.id);
  if (r.deleted) {
    if (local) {
      ctx.db.prepare('UPDATE trophies SET item_id = NULL WHERE item_id = ?').run(local.id);
      ctx.db.prepare('DELETE FROM items WHERE id = ?').run(local.id);
    }
    return null;
  }
  if (local && local.updated_at >= r.updated_at) return null; // ours is as new or newer
  const fields = {
    type: r.type, title: r.title, creator: r.creator, year: r.year, cover_url: /^https?:\/\//.test(r.cover_url ?? '') ? r.cover_url : null,
    status: r.status, progress: Number(r.progress) || 0, progress_total: r.progress_total == null ? null : Number(r.progress_total),
    rating: r.rating,
    meta: { ...(r.meta ?? {}), ...metaFromIds(r.ids), ...(r.season != null ? { season: r.season } : {}), ...(r.backdrop_url ? { backdrop_url: r.backdrop_url } : {}) },
  };
  let item;
  if (local) {
    item = updateItem(ctx, local.id, fields);
  } else {
    item = createItem(ctx, fields, { source: 'cloud', quiet: true });
    ctx.db.prepare('UPDATE items SET uid = ? WHERE id = ?').run(r.id, item.id);
  }
  // Keep the cloud's timestamps so this isn't pushed straight back.
  ctx.db.prepare('UPDATE items SET updated_at = ?, started_at = ?, finished_at = ? WHERE id = ?')
    .run(r.updated_at, r.started_at ?? item.started_at, r.finished_at ?? item.finished_at, item.id);
  return item.new_trophy ?? null;
}

function applyList(ctx, r) {
  const local = ctx.db.prepare('SELECT * FROM collections WHERE uid = ?').get(r.id);
  if (r.deleted) {
    if (local) ctx.db.prepare('DELETE FROM collections WHERE id = ?').run(local.id);
    return;
  }
  if (local && (local.updated_at ?? local.created_at) >= r.updated_at) return;
  const taken = (name) => ctx.db.prepare('SELECT id FROM collections WHERE name = ? AND (uid IS NULL OR uid != ?)').get(name, r.id);
  let name = String(r.name).slice(0, 60);
  for (let n = 2; taken(name); n++) name = `${String(r.name).slice(0, 55)} (${n})`;
  const vals = [name, r.description ?? null, r.kind ?? 'mixed', r.show_in_play ? 1 : 0, r.is_public ? 1 : 0, r.share_id ?? null, r.position ?? 0, r.updated_at];
  if (local) {
    ctx.db.prepare('UPDATE collections SET name = ?, description = ?, kind = ?, show_in_play = ?, is_public = ?, share_id = ?, position = ?, updated_at = ? WHERE id = ?')
      .run(...vals, local.id);
  } else {
    ctx.db.prepare('INSERT INTO collections (name, description, kind, show_in_play, is_public, share_id, position, updated_at, created_at, uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(...vals, r.updated_at, r.id);
  }
}

function applyListItem(ctx, r) {
  const list = ctx.db.prepare('SELECT id FROM collections WHERE uid = ?').get(r.list_id);
  const item = ctx.db.prepare('SELECT id FROM items WHERE uid = ?').get(r.item_id);
  if (!list || !item) return;
  const local = ctx.db.prepare('SELECT updated_at FROM collection_items WHERE collection_id = ? AND item_id = ?').get(list.id, item.id);
  if (r.deleted) {
    if (local && (local.updated_at ?? '') <= r.updated_at) ctx.db.prepare('DELETE FROM collection_items WHERE collection_id = ? AND item_id = ?').run(list.id, item.id);
    return;
  }
  if (local && (local.updated_at ?? '') >= r.updated_at) return;
  ctx.db.prepare(`INSERT INTO collection_items (collection_id, item_id, position, updated_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(collection_id, item_id) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`)
    .run(list.id, item.id, r.position ?? 0, r.updated_at);
}

function applyTrophy(ctx, r) {
  if (r.deleted || ctx.db.prepare('SELECT 1 FROM trophies WHERE uid = ?').get(r.id)) return;
  const item = r.item_id ? ctx.db.prepare('SELECT id FROM items WHERE uid = ?').get(r.item_id) : null;
  const mine = item ? ctx.db.prepare('SELECT id, uid FROM trophies WHERE item_id = ?').get(item.id) : null;
  if (mine) {
    if (!mine.uid) ctx.db.prepare('UPDATE trophies SET uid = ? WHERE id = ?').run(r.id, mine.id);
    return;
  }
  ctx.db.prepare('INSERT INTO trophies (item_id, kind, title, earned_at, uid) VALUES (?, ?, ?, ?, ?)').run(item?.id ?? null, r.kind, r.title, r.earned_at, r.id);
}

async function pull(ctx, rpc) {
  const s = state(ctx);
  const res = await rpc('tracker_pull', { since: s.pulled_at ?? null });
  const trophies = [];
  let n = 0;
  tx(ctx.db, () => {
    for (const r of res.items ?? []) { const t = applyItem(ctx, r); if (t) trophies.push(t); n++; }
    for (const r of res.lists ?? []) { applyList(ctx, r); n++; }
    for (const r of res.list_items ?? []) { applyListItem(ctx, r); n++; }
    for (const r of res.trophies ?? []) { applyTrophy(ctx, r); n++; }
  });
  setState(ctx, { pulled_at: res.at ?? s.pulled_at ?? null });
  return { pulled: n, trophies };
}

// Shows watched in 128bitPlay arrive with an IMDb id but maybe without the
// season's length: fill it in (and spot anime) so seasons can finish. Shows
// found by title get their IMDb id, so Play can open them.
async function enrich(ctx) {
  const fetch = ctx.fetch ?? globalThis.fetch;
  const rows = ctx.db
    .prepare(`SELECT id, type, meta, progress, progress_total FROM items
               WHERE type IN ('show','anime') AND status IN ('active','planned','on_hold')
                 AND (progress_total IS NULL OR json_extract(meta, '$.imdb_id') IS NULL) ORDER BY updated_at DESC LIMIT 50`)
    .all();
  let done = 0;
  for (const r of rows) {
    if (done >= ENRICH_PER_SYNC) break;
    const meta = JSON.parse(r.meta);
    if (meta.enriched_at && Date.now() - Date.parse(meta.enriched_at) < 7 * 86400_000) continue;
    done++;
    const show = meta.tvmaze_id ? await lookupShowById(fetch, meta.tvmaze_id) : meta.imdb_id ? await lookupShowByImdb(fetch, meta.imdb_id) : null;
    const patch = { meta: { enriched_at: new Date().toISOString() } };
    if (show) {
      if (show.imdb && !meta.imdb_id) patch.meta.imdb_id = show.imdb;
      if (show.tvmaze_id && !meta.tvmaze_id) patch.meta.tvmaze_id = show.tvmaze_id;
      const total = meta.season ? show.seasons[meta.season] : null;
      if (total && !r.progress_total) {
        patch.progress_total = total;
        if (r.progress >= total) patch.status = 'done';
      }
      if (show.anime && r.type === 'show') patch.type = 'anime';
    }
    updateItem(ctx, r.id, patch);
  }
}

const running = new WeakMap();
/** Push then pull. Needs the family sign-in (rpc from family-account.js). */
export function cloudSync(ctx, { rpc, userId }) {
  if (running.has(ctx.db)) return running.get(ctx.db);
  const job = (async () => {
    try {
      claimOwner(ctx, userId);
      const pushed = await push(ctx, rpc);
      const { pulled, trophies } = await pull(ctx, rpc);
      try { await enrich(ctx); } catch { /* offline: next time */ }
      const s = state(ctx);
      setState(ctx, {
        enabled: true, last_sync_at: new Date().toISOString(), last_error: null,
        pushed_total: (s.pushed_total ?? 0) + pushed, pulled_total: (s.pulled_total ?? 0) + pulled,
      });
      return { pushed, pulled, new_trophies: trophies };
    } catch (err) {
      // Not installed yet on this Supabase project: stay quiet, the feed still works.
      const missing = /tracker_push|tracker_pull|does not exist|Could not find the function|missing the family feed/i.test(err.message);
      setState(ctx, { last_error: missing ? 'cloud library not set up on the account server yet (supabase/tracker.sql)' : err.message, ...(missing ? { enabled: false } : {}) });
      if (err instanceof HttpError && err.status === 409) throw err;
      return { pushed: 0, pulled: 0, error: err.message };
    } finally {
      running.delete(ctx.db);
    }
  })();
  running.set(ctx.db, job);
  return job;
}

/** Profile + sharing, straight to the cloud. */
export async function setProfile(ctx, rpc, { handle, display_name, is_public } = {}) {
  const profile = await rpc('set_profile', {
    handle: handle ? String(handle).trim().toLowerCase() : null,
    display_name: display_name ?? null,
    is_public: is_public == null ? null : !!is_public,
  });
  setState(ctx, { profile });
  return profile;
}


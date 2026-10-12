// Two-way sync: what you change in Tracker goes back to the services you
// connected with the Connect button (supabase/functions/connect).
//
//   AniList  anime/manga with an AniList id: status, progress, score
//   MAL      anime/manga with a MAL id: status, episodes/chapters, score
//   Trakt    movies you finish → history; new episodes of a season → history;
//            ratings → ratings
//
// Each item remembers what each service last got (meta.wb), so nothing is sent
// twice and lists synced in from a service aren't echoed back to it.
import { isConnected, hubOn, routedFetch } from './hub.js';

const kvGet = (ctx, k) => {
  const v = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value;
  return v ? JSON.parse(v) : null;
};
const kvPut = (ctx, k, v) =>
  ctx.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));

const MAX_PER_RUN = 50;

const ANILIST_STATUS = { active: 'CURRENT', planned: 'PLANNING', done: 'COMPLETED', dropped: 'DROPPED', on_hold: 'PAUSED' };
const MAL_STATUS = {
  anime: { active: 'watching', planned: 'plan_to_watch', done: 'completed', dropped: 'dropped', on_hold: 'on_hold' },
  manga: { active: 'reading', planned: 'plan_to_read', done: 'completed', dropped: 'dropped', on_hold: 'on_hold' },
};

/** What a service would get for this item now (a fingerprint), or null when it doesn't take it. */
export function payloadFor(service, item) {
  const m = item.meta ?? {};
  if (service === 'anilist' && m.anilist_id && (item.type === 'anime' || item.type === 'manga')) {
    return { id: Number(m.anilist_id), status: ANILIST_STATUS[item.status], progress: Math.floor(item.progress ?? 0), scoreRaw: item.rating ? item.rating * 10 : 0 };
  }
  if (service === 'mal' && m.mal_id && (item.type === 'anime' || item.type === 'manga')) {
    const anime = item.type === 'anime';
    return {
      kind: item.type, id: Number(m.mal_id), status: MAL_STATUS[item.type][item.status],
      [anime ? 'num_watched_episodes' : 'num_chapters_read']: Math.floor(item.progress ?? 0), score: item.rating ?? 0,
    };
  }
  if (service === 'trakt' && (item.type === 'movie' || item.type === 'show' || item.type === 'anime')) {
    const ids = {};
    if (m.trakt_id) ids.trakt = Number(m.trakt_id);
    if (m.tmdb_id) ids.tmdb = Number(m.tmdb_id);
    if (m.imdb_id) ids.imdb = String(m.imdb_id);
    if (m.tvdb_id) ids.tvdb = Number(m.tvdb_id);
    if (!Object.keys(ids).length) return null;
    if (item.type === 'movie') return { kind: 'movie', ids, watched: item.status === 'done', rating: item.rating ?? null, at: item.finished_at };
    if (!m.season) return null;
    return { kind: 'show', ids, season: Number(m.season), episodes: Math.floor(item.progress ?? 0), rating: item.rating ?? null };
  }
  return null;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Mark an item as already matching a service (used by the importers, so imports aren't echoed). */
export function rememberSent(ctx, itemId, service, payload) {
  const row = ctx.db.prepare('SELECT meta FROM items WHERE id = ?').get(itemId);
  if (!row) return;
  const meta = JSON.parse(row.meta);
  meta.wb = { ...(meta.wb ?? {}), [service]: payload };
  // Straight to the row: bookkeeping, not an edit (no updated_at bump, no events).
  ctx.db.prepare('UPDATE items SET meta = ? WHERE id = ?').run(JSON.stringify(meta), itemId);
}

async function send(fetch, service, p, last) {
  const json = (res) => {
    if (!res.ok) throw new Error(`${service} answered ${res.status}`);
    return res;
  };
  if (service === 'anilist') {
    const query = 'mutation ($id: Int, $s: MediaListStatus, $p: Int, $sc: Int) { SaveMediaListEntry(mediaId: $id, status: $s, progress: $p, scoreRaw: $sc) { id } }';
    return json(await fetch('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { id: p.id, s: p.status, p: p.progress, sc: p.scoreRaw } }) }));
  }
  if (service === 'mal') {
    const { kind, id, ...fields } = p;
    return json(await fetch(`https://api.myanimelist.net/v2/${kind}/${id}/my_list_status`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])).toString() }));
  }
  // Trakt: only what's new since last time.
  const post = (path, body) => fetch(`https://api.trakt.tv${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  if (p.kind === 'movie') {
    if (p.watched && !last?.watched) await post('/sync/history', { movies: [{ ids: p.ids, ...(p.at ? { watched_at: p.at } : {}) }] });
    if (p.rating && p.rating !== last?.rating) await post('/sync/ratings', { movies: [{ ids: p.ids, rating: p.rating }] });
    return;
  }
  const from = last && last.season === p.season ? last.episodes : 0;
  if (p.episodes > from) {
    const episodes = Array.from({ length: p.episodes - from }, (_, i) => ({ number: from + i + 1 }));
    await post('/sync/history', { shows: [{ ids: p.ids, seasons: [{ number: p.season, episodes }] }] });
  }
  if (p.rating && p.rating !== last?.rating) await post('/sync/ratings', { shows: [{ ids: p.ids, seasons: [{ number: p.season, rating: p.rating }] }] });
}

/** Push what changed since the last run to every connected service. Never throws. */
export async function writeBack(ctx) {
  if (!hubOn(ctx)) return { sent: 0 };
  const services = ['anilist', 'mal', 'trakt'].filter((s) => isConnected(ctx, s));
  if (!services.length) return { sent: 0 };
  // A newly connected service starts from what's here now: the library you
  // already had isn't replayed into it (Trakt would count every episode twice).
  for (const service of services) {
    if (kvGet(ctx, `wb.init.${service}`)) continue;
    for (const row of ctx.db.prepare('SELECT * FROM items').all()) {
      const p = payloadFor(service, { ...row, meta: JSON.parse(row.meta) });
      if (p) rememberSent(ctx, row.id, service, p);
    }
    kvPut(ctx, `wb.init.${service}`, new Date().toISOString());
  }
  const since = kvGet(ctx, 'wb.since') ?? new Date().toISOString();
  const started = new Date().toISOString();
  const fetch = routedFetch(ctx);
  const rows = ctx.db.prepare('SELECT * FROM items WHERE updated_at >= ? ORDER BY updated_at LIMIT ?').all(since, MAX_PER_RUN + 1);
  let sent = 0;
  const errors = [];
  for (const row of rows.slice(0, MAX_PER_RUN)) {
    const item = { ...row, meta: JSON.parse(row.meta) };
    for (const service of services) {
      const p = payloadFor(service, item);
      const last = item.meta.wb?.[service];
      if (!p || same(p, last)) continue;
      try {
        await send(fetch, service, p, last);
        rememberSent(ctx, item.id, service, p);
        sent++;
      } catch (err) {
        errors.push(`${service}: ${err.message}`);
      }
    }
  }
  // More waiting: pick up from the last one done; otherwise from now.
  const next = rows.length > MAX_PER_RUN ? rows[MAX_PER_RUN - 1].updated_at : started;
  // Try again next time only if a service was down; a rejected item waits for its next change.
  if (!errors.some((e) => /answered 5\d\d|fetch failed|network|timed out/i.test(e))) kvPut(ctx, 'wb.since', next);
  return { sent, errors };
}

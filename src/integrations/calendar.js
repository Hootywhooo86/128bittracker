// Coming up: next episodes of shows/anime you're watching or planning, and
// release dates of games you're waiting for.
//
//   shows   TMDB next_episode_to_air when a TMDB id + key exist, else TVmaze (no key)
//   anime   AniList nextAiringEpisode (no key)
//   games   Steam store release dates (no key), IGDB when keys are set
//
// Lookups are cached for a few hours; titles without ids are matched by name once.
import { serviceConfig } from './services.js';
import { igdbQuery } from './metadata.js';
import { hubOn, routedFetch } from './hub.js';

const TTL = 6 * 3600_000;
const WATCHING = "status IN ('active','planned','on_hold')";

const kvGet = (ctx, k) => {
  const v = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value;
  return v ? JSON.parse(v) : null;
};
const kvPut = (ctx, k, v) =>
  ctx.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));

export async function upcoming(ctx, { refresh = false } = {}) {
  const cached = kvGet(ctx, 'cal.cache');
  if (!refresh && cached && Date.now() - cached.at < TTL) return cached.entries;
  // Signed in to a 128bit account: TMDB and IGDB go through 128bit's keys.
  const fetch = routedFetch(ctx);
  const items = ctx.db.prepare(`SELECT id, type, title, cover_url, meta FROM items WHERE type IN ('show','anime','game') AND ${WATCHING}`).all()
    .map((i) => ({ ...i, meta: JSON.parse(i.meta) }));

  const entries = [];
  const safe = async (fn) => { try { await fn(); } catch (err) { console.warn('calendar:', err.message); } };
  await safe(() => shows(ctx, fetch, items.filter((i) => i.type === 'show'), entries));
  await safe(() => anime(fetch, items.filter((i) => i.type === 'anime'), entries));
  await safe(() => games(ctx, fetch, items.filter((i) => i.type === 'game'), entries));

  const today = new Date().toISOString().slice(0, 10);
  const result = entries
    .filter((e) => !e.date || e.date >= today)
    .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  kvPut(ctx, 'cal.cache', { at: Date.now(), entries: result });
  return result;
}

async function json(fetch, url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return res.json();
}

/** Remember name → id matches so each title is searched only once. */
function idMap(ctx, name) {
  const map = kvGet(ctx, `cal.ids.${name}`) ?? {};
  return { get: (t) => map[t.toLowerCase()], set: (t, id) => { map[t.toLowerCase()] = id; kvPut(ctx, `cal.ids.${name}`, map); }, has: (t) => t.toLowerCase() in map };
}

async function shows(ctx, fetch, list, out) {
  // '' = no key of our own: 128bit Connect adds its own.
  const tmdb = serviceConfig(ctx, 'tmdb').token || (hubOn(ctx) ? '' : null);
  const ids = idMap(ctx, 'tvmaze');
  const seen = new Set();
  for (const item of list) {
    const key = item.title.toLowerCase();
    if (seen.has(key)) continue; // several seasons of one show: one entry
    seen.add(key);
    if (tmdb != null && item.meta.tmdb_id) {
      const v4 = tmdb.length > 40;
      const s = await json(fetch, `https://api.themoviedb.org/3/tv/${item.meta.tmdb_id}${v4 ? '' : `?api_key=${tmdb}`}`, {
        headers: v4 ? { Authorization: `Bearer ${tmdb}` } : {},
      });
      const n = s.next_episode_to_air;
      if (n) out.push({ kind: 'episode', date: n.air_date, title: item.title, detail: `S${n.season_number} E${n.episode_number}${n.name ? ` · ${n.name}` : ''}`, item_id: item.id, cover_url: item.cover_url });
      continue;
    }
    let id = item.meta.tvmaze_id ?? ids.get(item.title);
    if (id === undefined && !ids.has(item.title)) {
      const res = await fetch(`https://api.tvmaze.com/singlesearch/shows?${new URLSearchParams({ q: item.title })}`);
      id = res.ok ? (await res.json()).id : null;
      ids.set(item.title, id);
    }
    if (!id) continue;
    const s = await json(fetch, `https://api.tvmaze.com/shows/${id}?embed=nextepisode`);
    const n = s._embedded?.nextepisode;
    if (n) out.push({ kind: 'episode', date: n.airdate || null, title: item.title, detail: `S${n.season} E${n.number}${n.name ? ` · ${n.name}` : ''}`, item_id: item.id, cover_url: item.cover_url });
  }
}

const ANILIST_NEXT = `query ($ids: [Int], $search: String) {
  byId: Page(perPage: 50) { media(id_in: $ids, type: ANIME) { id title { english romaji } nextAiringEpisode { airingAt episode } } }
  byName: Media(search: $search, type: ANIME) { id title { english romaji } nextAiringEpisode { airingAt episode } }
}`;

async function anime(fetch, list, out) {
  if (!list.length) return;
  const post = (variables) => json(fetch, 'https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: ANILIST_NEXT, variables }),
  });
  const withId = list.filter((i) => i.meta.anilist_id);
  const found = new Map();
  if (withId.length) {
    const j = await post({ ids: withId.map((i) => i.meta.anilist_id), search: null });
    for (const m of j.data?.byId?.media ?? []) found.set(m.id, m);
  }
  for (const item of list) {
    let m = item.meta.anilist_id ? found.get(item.meta.anilist_id) : null;
    if (!item.meta.anilist_id) m = (await post({ ids: [], search: item.title }).catch(() => null))?.data?.byName ?? null;
    const n = m?.nextAiringEpisode;
    if (n) out.push({ kind: 'episode', date: new Date(n.airingAt * 1000).toISOString().slice(0, 10), title: item.title, detail: `Episode ${n.episode}`, item_id: item.id, cover_url: item.cover_url });
  }
}

async function games(ctx, fetch, list, out) {
  const igdb = serviceConfig(ctx, 'igdb');
  const planned = list.filter((i) => i.meta.steam_appid || i.meta.igdb_id || i.meta.provider === 'steam');
  for (const item of planned) {
    if (item.meta.igdb_id && ((igdb.client_id && igdb.client_secret) || hubOn(ctx))) {
      const [g] = await igdbQuery(ctx, fetch, igdb, 'games', `fields first_release_date,status; where id = ${Number(item.meta.igdb_id)};`);
      if (g?.first_release_date) {
        out.push({ kind: 'release', date: new Date(g.first_release_date * 1000).toISOString().slice(0, 10), title: item.title, detail: 'Release day', item_id: item.id, cover_url: item.cover_url });
      }
      continue;
    }
    const appid = item.meta.steam_appid ?? (item.meta.provider === 'steam' ? item.meta.provider_id : null);
    if (!appid) continue;
    const j = await json(fetch, `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appid)}&filters=release_date`);
    const rd = j[appid]?.data?.release_date;
    if (!rd?.coming_soon) continue;
    const t = Date.parse(rd.date);
    out.push({
      kind: 'release',
      date: Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10),
      title: item.title,
      detail: Number.isNaN(t) ? `Coming ${rd.date || 'soon'}` : 'Release day',
      item_id: item.id,
      cover_url: item.cover_url,
    });
  }
}

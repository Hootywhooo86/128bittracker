// Coming up: next episodes of shows/anime you're watching or planning, and
// release dates of games you're waiting for.
//
//   shows   TMDB next_episode_to_air when a TMDB id + key exist, else TVmaze (no key)
//   anime   AniList nextAiringEpisode (no key)
//   games   Steam store release dates (no key), IGDB when keys are set
//   movies  TMDB release dates for movies you plan to watch (by TMDB or IMDb id)
//   books   Google Books publication dates for books / audiobooks you plan to read (no key)
//   any item with meta.release_date (set by hand) shows on that day
//
// Lookups are cached for a few hours; titles without ids are matched by name once.
import { serviceConfig } from './services.js';
import { igdbQuery } from './metadata.js';
import { hubOn, routedFetch } from './hub.js';

const TTL = 6 * 3600_000;
const WATCHING = "status IN ('active','planned','on_hold')";

const CACHE_VERSION = 3; // bump when entries gain fields

const kvGet = (ctx, k) => {
  const v = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value;
  return v ? JSON.parse(v) : null;
};
const kvPut = (ctx, k, v) =>
  ctx.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));

export async function upcoming(ctx, { refresh = false } = {}) {
  const cached = kvGet(ctx, 'cal.cache');
  // Release dates set by hand show up straight away.
  const sig = ctx.db.prepare("SELECT group_concat(id || ':' || json_extract(meta, '$.release_date') || ':' || status) AS s FROM items WHERE json_extract(meta, '$.release_date') IS NOT NULL").get()?.s ?? '';
  if (!refresh && cached && cached.v === CACHE_VERSION && cached.sig === sig && Date.now() - cached.at < TTL) return cached.entries;
  // Signed in to a 128bit account: TMDB and IGDB go through 128bit's keys.
  const fetch = routedFetch(ctx);
  const items = ctx.db.prepare(`SELECT id, type, title, creator, status, year, cover_url, meta FROM items WHERE type IN ('show','anime','game','movie','book') AND ${WATCHING}`).all()
    .map((i) => ({ ...i, meta: JSON.parse(i.meta) }));

  const entries = [];
  const safe = async (fn) => { try { await fn(); } catch (err) { console.warn('calendar:', err.message); } };
  await safe(() => shows(ctx, fetch, items.filter((i) => i.type === 'show'), entries));
  await safe(() => anime(fetch, items.filter((i) => i.type === 'anime'), entries));
  await safe(() => games(ctx, fetch, items.filter((i) => i.type === 'game'), entries));
  // Set by hand: that date wins over any lookup.
  const manual = items.filter((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.meta.release_date ?? ''));
  const byHand = new Set(manual.map((i) => i.id));
  await safe(() => movies(ctx, fetch, items.filter((i) => i.type === 'movie' && !byHand.has(i.id)), entries));
  await safe(() => books(ctx, fetch, items.filter((i) => i.type === 'book' && !byHand.has(i.id)), entries));
  for (const i of manual) {
    entries.push({ kind: 'release', date: i.meta.release_date, title: i.title, detail: releaseDetail(i), type: i.type, format: i.meta.format ?? null, item_id: i.id, cover_url: i.cover_url });
  }

  const today = new Date().toISOString().slice(0, 10);
  const result = entries
    .filter((e) => !e.date || e.date >= today)
    .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  kvPut(ctx, 'cal.cache', { v: CACHE_VERSION, sig, at: Date.now(), entries: result });
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
      if (!n) continue;
      // The rest of that season too, so the calendar shows every coming episode.
      const season = await json(fetch, `https://api.themoviedb.org/3/tv/${item.meta.tmdb_id}/season/${n.season_number}${v4 ? '' : `?api_key=${tmdb}`}`, {
        headers: v4 ? { Authorization: `Bearer ${tmdb}` } : {},
      }).catch(() => ({ episodes: [n] }));
      const today = new Date().toISOString().slice(0, 10);
      for (const e of (season.episodes ?? [n]).filter((e) => e.air_date && e.air_date >= today && e.episode_number >= n.episode_number).slice(0, 26)) {
        out.push({ kind: 'episode', date: e.air_date, title: item.title, detail: `S${e.season_number} E${e.episode_number}${e.name ? ` · ${e.name}` : ''}`, season: e.season_number, number: e.episode_number, type: 'show', item_id: item.id, cover_url: item.cover_url });
      }
      continue;
    }
    let id = item.meta.tvmaze_id ?? ids.get(item.title);
    if (id === undefined && !ids.has(item.title)) {
      const res = await fetch(`https://api.tvmaze.com/singlesearch/shows?${new URLSearchParams({ q: item.title })}`);
      id = res.ok ? (await res.json()).id : null;
      ids.set(item.title, id);
    }
    if (!id) continue;
    const eps = await json(fetch, `https://api.tvmaze.com/shows/${id}/episodes`);
    const today = new Date().toISOString().slice(0, 10);
    for (const n of eps.filter((e) => e.airdate && e.airdate >= today).slice(0, 26)) {
      out.push({ kind: 'episode', date: n.airdate, title: item.title, detail: `S${n.season} E${n.number}${n.name ? ` · ${n.name}` : ''}`, season: n.season, number: n.number, type: 'show', item_id: item.id, cover_url: item.cover_url });
    }
  }
}

const ANILIST_NEXT = `query ($ids: [Int], $search: String) {
  byId: Page(perPage: 50) { media(id_in: $ids, type: ANIME) { id title { english romaji } airingSchedule(notYetAired: true, perPage: 26) { nodes { airingAt episode } } } }
  byName: Media(search: $search, type: ANIME) { id title { english romaji } airingSchedule(notYetAired: true, perPage: 26) { nodes { airingAt episode } } }
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
    for (const n of m?.airingSchedule?.nodes ?? []) {
      out.push({ kind: 'episode', date: new Date(n.airingAt * 1000).toISOString().slice(0, 10), title: item.title, detail: `Episode ${n.episode}`, number: n.episode, type: 'anime', item_id: item.id, cover_url: item.cover_url });
    }
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

// Movies on your list that aren't out yet: TMDB release dates (by TMDB id, else IMDb id).
async function movies(ctx, fetch, list, out) {
  const tmdb = serviceConfig(ctx, 'tmdb').token || (hubOn(ctx) ? '' : null);
  if (tmdb == null) return;
  const v4 = tmdb.length > 40;
  const get = (path) => json(fetch, `https://api.themoviedb.org/3${path}${v4 || !tmdb ? '' : `${path.includes('?') ? '&' : '?'}api_key=${tmdb}`}`, { headers: v4 ? { Authorization: `Bearer ${tmdb}` } : {} });
  const thisYear = new Date().getFullYear();
  // Only ones that could still be coming: no year yet, or this year or later.
  for (const item of list.filter((i) => !i.year || i.year >= thisYear).slice(0, 40)) {
    let m = null;
    if (item.meta.tmdb_id) m = await get(`/movie/${item.meta.tmdb_id}`);
    else if (item.meta.imdb_id) m = (await get(`/find/${item.meta.imdb_id}?external_source=imdb_id`)).movie_results?.[0] ?? null;
    if (m?.release_date && m.release_date >= new Date().toISOString().slice(0, 10)) {
      out.push({ kind: 'release', date: m.release_date, title: item.title, detail: 'In cinemas', type: 'movie', item_id: item.id, cover_url: item.cover_url });
    }
  }
}

const releaseDetail = (i) => (i.type === 'movie' ? 'In cinemas' : i.type === 'book' ? (i.meta.format === 'audiobook' ? 'Audiobook out' : 'Book out') : 'Out');

// Books and audiobooks you plan to read that aren't out yet: Google Books' publication date.
async function books(ctx, fetch, list, out) {
  const known = idMap(ctx, 'gbooks'); // title|author → date or null, looked up once
  const today = new Date().toISOString().slice(0, 10);
  for (const item of list.filter((i) => i.status !== 'active').slice(0, 40)) {
    const key = `${item.title}|${item.creator ?? ''}`;
    let date = known.get(key);
    if (date === undefined && !known.has(key)) {
      const q = `intitle:${item.title}${item.creator ? `+inauthor:${item.creator}` : ''}`;
      const j = await json(fetch, `https://www.googleapis.com/books/v1/volumes?${new URLSearchParams({ q, orderBy: 'newest', maxResults: '5', printType: 'books' })}`).catch(() => null);
      const hit = (j?.items ?? []).map((v) => v.volumeInfo).find((v) => v?.title?.toLowerCase() === item.title.toLowerCase() && /^\d{4}-\d{2}-\d{2}$/.test(v.publishedDate ?? ''));
      date = hit?.publishedDate ?? null;
      known.set(key, date);
    }
    if (date && date >= today) out.push({ kind: 'release', date, title: item.title, detail: releaseDetail(item), type: 'book', format: item.meta.format ?? null, item_id: item.id, cover_url: item.cover_url });
  }
}

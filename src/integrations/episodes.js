// A show's seasons and episodes, for the episode tracker and so a new season
// is noticed: TVmaze (no key) by its id, by IMDb id or by name; anime that
// TVmaze doesn't know come from AniList (one season, its episode count).
//
//   episodesFor(ctx, item)  → { source, seasons: [{ season, first_air, episodes: [{ number, name, air_date }] }] }
//   refreshShow(ctx, item)  → item, with each season's length and first air date in meta.seasons
//                             (a new season announced puts a finished show back in progress)
import { getItem, updateItem } from '../domain/library.js';
import { withCatalog } from '../domain/seasons.js';
import { serviceConfig } from './services.js';
import { hubOn, routedFetch } from './hub.js';

const TTL = 12 * 3600_000;

const kvGet = (ctx, k) => {
  const v = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value;
  return v ? JSON.parse(v) : null;
};
const kvPut = (ctx, k, v) =>
  ctx.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));

async function getJson(fetch, url, init) {
  const res = await fetch(url, init);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return res.json();
}

// TMDB (your key, or 128bit's through Connect): '' = Connect adds it, null = none.
const tmdbToken = (ctx) => serviceConfig(ctx, 'tmdb').token || (hubOn(ctx) ? '' : null);
function tmdbGet(ctx, path) {
  const token = tmdbToken(ctx);
  if (token == null) return null;
  const v4 = token.length > 40;
  return getJson(routedFetch(ctx), `https://api.themoviedb.org/3${path}${v4 || !token ? '' : `${path.includes('?') ? '&' : '?'}api_key=${token}`}`, {
    headers: v4 ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : { Accept: 'application/json' },
  });
}

/** A TMDB-only show: its IMDb id (so TVmaze finds it), or its seasons straight from TMDB. */
async function fromTmdb(ctx, item) {
  const id = item.meta?.tmdb_id;
  if (!id) return null;
  const show = await tmdbGet(ctx, `/tv/${encodeURIComponent(id)}?append_to_response=external_ids`).catch(() => null);
  if (!show) return null;
  const seasons = [];
  for (const s of (show.seasons ?? []).filter((x) => x.season_number > 0).slice(0, 30)) {
    const full = await tmdbGet(ctx, `/tv/${encodeURIComponent(id)}/season/${s.season_number}`).catch(() => null);
    const eps = (full?.episodes ?? []).map((e) => ({ number: e.episode_number, name: e.name ?? null, air_date: e.air_date || null }));
    seasons.push({
      season: s.season_number, first_air: s.air_date ?? eps[0]?.air_date ?? null,
      episodes: eps.length ? eps : Array.from({ length: s.episode_count ?? 0 }, (_, i) => ({ number: i + 1, name: null, air_date: null })),
    });
  }
  return { imdb: show.external_ids?.imdb_id ?? null, seasons };
}

async function tvmazeShowId(fetch, item) {
  const m = item.meta ?? {};
  if (m.tvmaze_id) return m.tvmaze_id;
  if (m.imdb_id) {
    const s = await getJson(fetch, `https://api.tvmaze.com/lookup/shows?${new URLSearchParams({ imdb: m.imdb_id })}`).catch(() => null);
    if (s?.id) return s.id;
  }
  if (m.tmdb_id) return null; // a TMDB show: TMDB says which (a name search could find another)
  const s = await getJson(fetch, `https://api.tvmaze.com/singlesearch/shows?${new URLSearchParams({ q: item.title })}`).catch(() => null);
  return s?.id ?? null;
}

const ANILIST = `query ($id: Int, $q: String) { Media(id: $id, search: $q, type: ANIME) { id episodes startDate { year month day }
  nextAiringEpisode { episode airingAt } airingSchedule(perPage: 50) { nodes { episode airingAt } } } }`;

async function fromAniList(fetch, item) {
  const m = item.meta ?? {};
  const j = await getJson(fetch, 'https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: ANILIST, variables: m.anilist_id ? { id: Number(m.anilist_id) } : { q: item.title } }),
  });
  const a = j?.data?.Media;
  if (!a) return null;
  const dates = new Map((a.airingSchedule?.nodes ?? []).map((n) => [n.episode, new Date(n.airingAt * 1000).toISOString().slice(0, 10)]));
  const count = a.episodes ?? Math.max(0, ...dates.keys(), (a.nextAiringEpisode?.episode ?? 1) - 1);
  if (!count) return null;
  const d = a.startDate;
  const first = d?.year ? `${d.year}-${String(d.month ?? 1).padStart(2, '0')}-${String(d.day ?? 1).padStart(2, '0')}` : null;
  return {
    source: 'anilist', anilist_id: a.id,
    seasons: [{ season: 1, first_air: first, episodes: Array.from({ length: count }, (_, i) => ({ number: i + 1, name: null, air_date: dates.get(i + 1) ?? null })) }],
  };
}

async function lookup(ctx, fetch, item) {
  let tmdb = null;
  if (!item.meta?.tvmaze_id && !item.meta?.imdb_id && item.meta?.tmdb_id) {
    tmdb = await fromTmdb(ctx, item);
    if (tmdb?.imdb) item = { ...item, meta: { ...item.meta, imdb_id: tmdb.imdb, tmdb_id: null } };
  }
  const id = await tvmazeShowId(fetch, item);
  if (id) {
    const [eps, seasons] = await Promise.all([
      getJson(fetch, `https://api.tvmaze.com/shows/${encodeURIComponent(id)}/episodes`),
      getJson(fetch, `https://api.tvmaze.com/shows/${encodeURIComponent(id)}/seasons`).catch(() => []),
    ]);
    const by = new Map();
    for (const s of seasons ?? []) if (s.number > 0) by.set(s.number, { season: s.number, first_air: s.premiereDate ?? null, order: s.episodeOrder ?? null, episodes: [] });
    for (const e of eps ?? []) {
      if (!(e.season > 0) || e.number == null) continue; // specials have no number
      if (!by.has(e.season)) by.set(e.season, { season: e.season, first_air: null, order: null, episodes: [] });
      by.get(e.season).episodes.push({ number: e.number, name: e.name ?? null, air_date: e.airdate || null });
    }
    const list = [...by.values()].sort((a, b) => a.season - b.season).map((s) => {
      // An announced season with a known length but no episode list yet: numbered placeholders.
      if (!s.episodes.length && s.order) s.episodes = Array.from({ length: s.order }, (_, i) => ({ number: i + 1, name: null, air_date: i ? null : s.first_air }));
      return { season: s.season, first_air: s.first_air ?? s.episodes[0]?.air_date ?? null, episodes: s.episodes.sort((a, b) => a.number - b.number) };
    });
    if (list.length) return { source: 'tvmaze', tvmaze_id: id, ...(tmdb?.imdb ? { imdb: tmdb.imdb } : {}), seasons: list };
  }
  if (tmdb?.seasons.length) return { source: 'tmdb', ...(tmdb.imdb ? { imdb: tmdb.imdb } : {}), seasons: tmdb.seasons };
  if (item.type === 'anime') return fromAniList(fetch, item);
  return null;
}

/** The show's seasons and episodes (cached for a few hours). null when no catalog knows it. */
export async function episodesFor(ctx, item, { refresh = false } = {}) {
  const key = `eps.${item.id}`;
  const cached = kvGet(ctx, key);
  if (!refresh && cached && Date.now() - cached.at < TTL) return cached.data;
  try {
    const data = await lookup(ctx, ctx.fetch ?? globalThis.fetch, item);
    kvPut(ctx, key, { at: Date.now(), data });
    return data;
  } catch (err) {
    if (cached) return cached.data; // offline: what we had
    throw err;
  }
}

/** Season lengths and first air dates into the item; a season announced after the ones you finished reopens it. */
export async function refreshShow(ctx, item, opts) {
  const data = await episodesFor(ctx, item, opts);
  if (!data) return item;
  const catalog = data.seasons.map((s) => ({ season: s.season, episodes: s.episodes.length, first_air: s.first_air }));
  const patch = withCatalog(item, catalog);
  if (data.tvmaze_id && !item.meta?.tvmaze_id) patch.meta.tvmaze_id = data.tvmaze_id;
  if (data.imdb && !item.meta?.imdb_id) patch.meta.imdb_id = data.imdb;
  if (data.anilist_id && !item.meta?.anilist_id) patch.meta.anilist_id = data.anilist_id;
  patch.meta.seasons_at = new Date().toISOString();
  return updateItem(ctx, item.id, patch);
}

/** Every show and anime you've started (finished ones too: that's how a new season is spotted), a few per sync. */
export async function refreshShows(ctx, { limit = 10 } = {}) {
  const rows = ctx.db
    .prepare(`SELECT id FROM items WHERE type IN ('show','anime') AND status IN ('active','done','on_hold')
               ORDER BY COALESCE(json_extract(meta, '$.seasons_at'), '') ASC, updated_at DESC LIMIT ?`)
    .all(limit * 3);
  let n = 0;
  for (const { id } of rows) {
    if (n >= limit) break;
    const item = getItem(ctx, id);
    const at = Date.parse(item.meta?.seasons_at ?? '');
    if (Number.isFinite(at) && Date.now() - at < TTL) continue;
    n++;
    try { await refreshShow(ctx, item); } catch { /* offline: next sync */ }
  }
  return n;
}

/** The episode tracker's view: every season, its episodes, and which you've watched. */
export async function episodeTracker(ctx, id, { refresh = false } = {}) {
  let item = getItem(ctx, id);
  let data = null;
  try {
    data = await episodesFor(ctx, item, { refresh });
    if (data) item = await refreshShow(ctx, item);
  } catch { /* offline: what the item knows */ }
  return trackerView(item, data);
}

export function trackerView(item, data) {
  const mine = item.meta?.seasons ?? {};
  const byNum = new Map((data?.seasons ?? []).map((s) => [s.season, s]));
  for (const k of Object.keys(mine)) {
    const s = Number(k);
    if (s > 0 && !byNum.has(s)) {
      const n = Math.max(mine[k].n ?? 0, mine[k].p ?? 0);
      byNum.set(s, { season: s, first_air: mine[k].a ?? null, episodes: Array.from({ length: n }, (_, i) => ({ number: i + 1, name: null, air_date: null })) });
    }
  }
  const seasons = [...byNum.values()].sort((a, b) => a.season - b.season).map((s) => {
    const p = mine[s.season]?.p ?? 0;
    return {
      season: s.season, first_air: s.first_air ?? null, watched: p, total: s.episodes.length || mine[s.season]?.n || null,
      done: !!mine[s.season]?.done,
      episodes: s.episodes.map((e) => ({ ...e, watched: e.number <= p })),
    };
  });
  return { item_id: item.id, source: data?.source ?? null, season: item.meta?.season ?? seasons[0]?.season ?? 1, status: item.status, seasons };
}

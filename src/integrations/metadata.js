// Title search: fill in cover, year, creator and length when adding things.
//
//   book          Open Library, then Google Books (no key; through 128bit Connect when signed in)
//   audiobook     Audible catalog first (no key), then Google Books / Open Library;
//                 saved as a book with meta.format 'audiobook'
//   anime, manga  AniList                 (no key)
//   podcast       iTunes                  (no key)
//   music         iTunes albums           (no key)
//   show          TMDB if a key is set, else TVmaze (no key; seasons + episode counts)
//   movie         TMDB if a key is set, else iTunes (thin outside some regions)
//   game          IGDB if keys are set, else the Steam store
//
// Signed in to a 128bit account, TMDB and IGDB work without your own keys
// (128bit Connect lends its own, see hub.js).
//
// Every result: { title, creator, year, cover_url, progress_total, provider, provider_id, meta }
import { HttpError } from '../api/errors.js';
import { serviceConfig, rememberService } from './services.js';
import { hubOn, routedFetch } from './hub.js';

const LIMIT = 10;

export async function searchTitles(ctx, { type, q }) {
  const query = String(q ?? '').trim();
  if (query.length < 2) throw new HttpError(400, 'type at least 2 characters');
  const fetch = routedFetch(ctx);
  const hub = hubOn(ctx);
  // '' = no key of our own: the request goes through 128bit Connect.
  const tmdb = serviceConfig(ctx, 'tmdb').token || (hub ? '' : null);
  const igdb = serviceConfig(ctx, 'igdb');
  const igdbReady = (igdb.client_id && igdb.client_secret) || hub;
  try {
    switch (type) {
      case 'book': return mergeBooks(await openLibrary(fetch, query), await quiet(googleBooks(fetch, query)));
      case 'audiobook': return await audiobooks(fetch, query);
      case 'anime': return await anilist(fetch, query, 'ANIME');
      case 'manga': return await anilist(fetch, query, 'MANGA');
      case 'podcast': return await itunes(fetch, query, { media: 'podcast' });
      case 'music': return await itunes(fetch, query, { media: 'music', entity: 'album' });
      case 'movie': return tmdb != null ? await tmdbSearch(fetch, tmdb, query, 'movie') : await itunes(fetch, query, { media: 'movie' });
      case 'show': return tmdb != null ? await tmdbSearch(fetch, tmdb, query, 'tv') : await tvmaze(fetch, query);
      case 'game': return igdbReady ? await igdbSearch(ctx, fetch, igdb, query) : await steamStore(fetch, query);
      default: return [];
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, `search failed: ${err.message}`);
  }
}

async function getJson(fetch, url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
  return res.json();
}

async function openLibrary(fetch, q) {
  const url = `https://openlibrary.org/search.json?${new URLSearchParams({ q, limit: String(LIMIT), fields: 'key,title,author_name,first_publish_year,cover_i,number_of_pages_median' })}`;
  const j = await getJson(fetch, url, { headers: { 'User-Agent': '128bitTracker/1 (https://github.com/Hootywhooo86/128bittracker)' } });
  return (j.docs ?? []).map((d) => ({
    title: d.title,
    creator: d.author_name?.[0] ?? null,
    year: d.first_publish_year ?? null,
    cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
    progress_total: d.number_of_pages_median ?? null,
    provider: 'openlibrary',
    provider_id: d.key,
  }));
}

// A second or third book source failing (Google Books' shared quota answers 429
// without a 128bit sign-in) never sinks the search: its results are just missing.
const quiet = (p) => p.catch((err) => { console.warn('search:', err.message); return []; });

const bookKey = (r) => `${String(r.title ?? '').toLowerCase().replace(/[:(].*$/, '').replace(/[^a-z0-9]+/g, ' ').trim()}|${String(r.creator ?? '').toLowerCase().replace(/[^a-z]+/g, '')}`;

/** Lists in order, later ones only adding titles (title + author) not seen yet. */
export function mergeBooks(...lists) {
  const seen = new Set();
  const out = [];
  for (const r of lists.flat()) {
    const k = bookKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

async function audiobooks(fetch, q) {
  const [aud, google, ol] = await Promise.all([quiet(audible(fetch, q)), quiet(googleBooks(fetch, q)), quiet(openLibrary(fetch, q))]);
  // Books found elsewhere still save as audiobooks.
  const asAudio = (r) => ({ ...r, meta: { ...(r.meta ?? {}), format: 'audiobook' } });
  return mergeBooks(aud, google.map(asAudio), ol.map(asAudio));
}

const AUDIBLE_GROUPS = 'product_desc,contributors,media,series,product_attrs,product_extended_attrs';

// Audible's own catalog: narrator, length, series and pre-order dates. No key.
async function audible(fetch, q) {
  const url = `https://api.audible.com/1.0/catalog/products?${new URLSearchParams({ keywords: q, num_results: '20', products_sort_by: 'Relevance', image_sizes: '500,1215', response_groups: AUDIBLE_GROUPS })}`;
  const j = await getJson(fetch, url, { headers: { Accept: 'application/json' } });
  return (j.products ?? []).filter((p) => p.asin && p.title).map((p) => {
    const series = p.series?.[0];
    const img = p.product_images ?? {};
    const narrators = (p.narrators ?? []).map((n) => n.name).filter(Boolean);
    return {
      title: p.title,
      creator: (p.authors ?? []).map((a) => a.name).filter(Boolean).join(', ') || null,
      year: Number(String(p.release_date ?? p.issue_date ?? '').slice(0, 4)) || null,
      cover_url: img['500'] ?? img['1215'] ?? Object.values(img)[0] ?? null,
      progress_total: null,
      provider: 'audible',
      provider_id: p.asin,
      meta: {
        format: 'audiobook',
        asin: p.asin,
        narrator: narrators.join(', ') || null,
        runtime_min: p.runtime_length_min ?? null,
        ...(series ? { series: series.title, series_position: series.sequence ?? null, series_asin: series.asin ?? null } : {}),
        release_date: /^\d{4}-\d{2}-\d{2}$/.test(p.release_date ?? '') ? p.release_date : null,
        ...(p.publisher_name ? { publisher: p.publisher_name } : {}),
      },
    };
  });
}

// Google Books: good on new and indie titles. Keyless, so signed in it goes
// through 128bit Connect with 128bit's key (routedFetch); otherwise the shared
// quota may say 429 and only the other sources answer.
async function googleBooks(fetch, q) {
  const url = `https://www.googleapis.com/books/v1/volumes?${new URLSearchParams({ q, maxResults: String(LIMIT), printType: 'books' })}`;
  const j = await getJson(fetch, url, { headers: { Accept: 'application/json' } });
  return (j.items ?? []).filter((v) => v.volumeInfo?.title).map((v) => {
    const b = v.volumeInfo;
    const img = b.imageLinks ?? {};
    const cover = img.thumbnail ?? img.smallThumbnail ?? null;
    const isbn = (b.industryIdentifiers ?? []).find((x) => x.type === 'ISBN_13')?.identifier ?? null;
    return {
      title: b.title,
      creator: b.authors?.[0] ?? null,
      year: Number(String(b.publishedDate ?? '').slice(0, 4)) || null,
      cover_url: cover ? cover.replace(/^http:/, 'https:').replace('&edge=curl', '') : null,
      progress_total: b.pageCount ?? null,
      provider: 'gbooks',
      provider_id: v.id,
      meta: {
        gbooks_id: v.id,
        ...(isbn ? { isbn } : {}),
        ...(/^\d{4}-\d{2}-\d{2}$/.test(b.publishedDate ?? '') ? { release_date: b.publishedDate } : {}),
      },
    };
  });
}

const ANILIST_SEARCH = `query ($q: String, $type: MediaType) {
  Page(perPage: ${LIMIT}) {
    media(search: $q, type: $type, sort: SEARCH_MATCH) {
      id title { english romaji } episodes chapters seasonYear startDate { year } status
      coverImage { large } studios(isMain: true) { nodes { name } } siteUrl
    }
  }
}`;

async function anilist(fetch, q, type) {
  const j = await getJson(fetch, 'https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: ANILIST_SEARCH, variables: { q, type } }),
  });
  return (j.data?.Page?.media ?? []).map((m) => ({
    title: m.title.english ?? m.title.romaji,
    creator: m.studios?.nodes?.[0]?.name ?? null,
    year: m.seasonYear ?? m.startDate?.year ?? null,
    cover_url: m.coverImage?.large ?? null,
    progress_total: (type === 'ANIME' ? m.episodes : m.chapters) ?? null,
    provider: 'anilist',
    provider_id: String(m.id),
    meta: { anilist_id: m.id, airing_status: m.status },
  }));
}

async function itunes(fetch, q, params) {
  const j = await getJson(fetch, `https://itunes.apple.com/search?${new URLSearchParams({ term: q, limit: String(LIMIT), ...params })}`);
  return (j.results ?? []).map((r) => ({
    title: r.collectionName ?? r.trackName,
    creator: r.artistName ?? null,
    year: r.releaseDate ? Number(r.releaseDate.slice(0, 4)) : null,
    cover_url: (r.artworkUrl600 ?? r.artworkUrl100 ?? '').replace(/\/\d+x\d+bb\./, '/600x600bb.') || null,
    progress_total: r.trackCount ?? null,
    provider: 'itunes',
    provider_id: String(r.collectionId ?? r.trackId),
  }));
}

async function tvmaze(fetch, q) {
  const list = await getJson(fetch, `https://api.tvmaze.com/search/shows?${new URLSearchParams({ q })}`);
  return list.slice(0, LIMIT).map(({ show }) => ({
    title: show.name,
    creator: show.network?.name ?? show.webChannel?.name ?? null,
    year: Number((show.premiered ?? '').slice(0, 4)) || null,
    cover_url: show.image?.original ?? show.image?.medium ?? null,
    progress_total: null,
    provider: 'tvmaze',
    provider_id: String(show.id),
    meta: { tvmaze_id: show.id },
  }));
}

/** Seasons of a show with episode counts, so a season can be tracked (and trophied). */
export async function showSeasons(ctx, { provider, id }) {
  const fetch = routedFetch(ctx);
  if (provider === 'tvmaze') {
    const list = await getJson(fetch, `https://api.tvmaze.com/shows/${encodeURIComponent(id)}/seasons`);
    return list.map((s) => ({ number: s.number, episodes: s.episodeOrder ?? null, year: Number((s.premiereDate ?? '').slice(0, 4)) || null, cover_url: s.image?.original ?? null }));
  }
  if (provider === 'tmdb') {
    const token = serviceConfig(ctx, 'tmdb').token || (hubOn(ctx) ? '' : null);
    if (token == null) throw new HttpError(400, 'add a TMDB key first');
    const v4 = token.length > 40;
    const j = await getJson(fetch, `https://api.themoviedb.org/3/tv/${encodeURIComponent(id)}${v4 ? '' : `?api_key=${token}`}`, {
      headers: v4 ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : { Accept: 'application/json' },
    });
    return (j.seasons ?? [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({ number: s.season_number, episodes: s.episode_count ?? null, year: Number((s.air_date ?? '').slice(0, 4)) || null, cover_url: s.poster_path ? `https://image.tmdb.org/t/p/w500${s.poster_path}` : null }));
  }
  throw new HttpError(400, 'seasons are available for TVmaze and TMDB shows');
}

async function tmdbSearch(fetch, token, q, kind) {
  const v4 = token.length > 40; // read access tokens are long JWTs; v3 keys are 32 hex chars
  const params = new URLSearchParams({ query: q, include_adult: 'false', ...(v4 ? {} : { api_key: token }) });
  const j = await getJson(fetch, `https://api.themoviedb.org/3/search/${kind}?${params}`, {
    headers: v4 ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : { Accept: 'application/json' },
  });
  return (j.results ?? []).slice(0, LIMIT).map((r) => ({
    title: kind === 'movie' ? r.title : r.name,
    creator: null,
    year: Number((r.release_date ?? r.first_air_date ?? '').slice(0, 4)) || null,
    cover_url: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
    progress_total: null,
    provider: 'tmdb',
    provider_id: String(r.id),
    meta: { tmdb_id: r.id, tmdb_kind: kind },
  }));
}

/** IGDB needs a Twitch app token (client credentials), cached until it expires. */
export async function igdbToken(ctx, fetch, cfg) {
  const cached = cfg.token_cache;
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const url = `https://id.twitch.tv/oauth2/token?${new URLSearchParams({ client_id: cfg.client_id, client_secret: cfg.client_secret, grant_type: 'client_credentials' })}`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) throw new HttpError(400, 'Twitch rejected the IGDB Client ID / Secret');
  const j = await res.json();
  rememberService(ctx, 'igdb', { token_cache: { token: j.access_token, expires: Date.now() + (j.expires_in ?? 3600) * 1000 } });
  return j.access_token;
}

export async function igdbQuery(ctx, fetch, cfg, endpoint, body) {
  if (!cfg.client_id || !cfg.client_secret) {
    // No keys of our own: 128bit Connect adds its own (routedFetch).
    return getJson(fetch, `https://api.igdb.com/v4/${endpoint}`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'text/plain' }, body });
  }
  const token = await igdbToken(ctx, fetch, cfg);
  return getJson(fetch, `https://api.igdb.com/v4/${endpoint}`, {
    method: 'POST',
    headers: { 'Client-ID': cfg.client_id, Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'text/plain' },
    body,
  });
}

async function igdbSearch(ctx, fetch, cfg, q) {
  const safe = q.replace(/"/g, '');
  const list = await igdbQuery(ctx, fetch, cfg, 'games',
    `search "${safe}"; fields name,first_release_date,cover.image_id,involved_companies.company.name,involved_companies.developer; limit ${LIMIT};`);
  return list.map((g) => ({
    title: g.name,
    creator: g.involved_companies?.find((c) => c.developer)?.company?.name ?? null,
    year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
    cover_url: g.cover?.image_id ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg` : null,
    progress_total: null,
    provider: 'igdb',
    provider_id: String(g.id),
    meta: { igdb_id: g.id },
  }));
}

async function steamStore(fetch, q) {
  const j = await getJson(fetch, `https://store.steampowered.com/api/storesearch/?${new URLSearchParams({ term: q, cc: 'us', l: 'en' })}`);
  return (j.items ?? []).slice(0, LIMIT).map((g) => ({
    title: g.name,
    creator: null,
    year: null,
    cover_url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.id}/library_600x900.jpg`,
    progress_total: null,
    provider: 'steam',
    provider_id: String(g.id),
    meta: { steam_appid: g.id },
  }));
}

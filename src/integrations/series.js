// Which series a book is in (Audible) and which collection a movie is in (TMDB),
// looked up once per title and kept in its meta, for the Stats page's lists.
import { listItems, updateItem } from '../domain/library.js';
import { groupHistory, kindOf, seriesKey, splitAuthor } from '../domain/series.js';
import { audible } from './metadata.js';
import { routedFetch } from './hub.js';
import { tmdbGet, tmdbToken } from './episodes.js';

const PER_CALL = 8;
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function bookSeries(ctx, item) {
  const { title, author } = splitAuthor(item.title, item.creator);
  const hits = await audible(routedFetch(ctx), [title, author].filter(Boolean).join(' '));
  const t = norm(title);
  const by = norm(author);
  // Audible's title may carry the series ("Book of the Dead 4: Vengeance" for "Vengeance"):
  // the title anywhere in it, word for word, by the same author when we know one.
  const words = (s) => ` ${s} `;
  const sameTitle = (h) => { const n = norm(h.title); return n === t || words(n).includes(words(t)) || words(t).includes(words(n)); };
  const sameAuthor = (h) => !by || norm(h.creator).includes(by) || by.includes(norm(h.creator));
  const hit = hits.find((h) => h.meta?.series && sameTitle(h) && sameAuthor(h)) ?? (by ? null : hits.find((h) => h.meta?.series && sameTitle(h)));
  return hit
    ? { series: hit.meta.series, series_position: hit.meta.series_position ?? null, series_asin: hit.meta.series_asin ?? null, asin: item.meta?.asin ?? hit.meta.asin }
    : {};
}

const kvGet = (ctx, k) => {
  const v = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value;
  return v ? JSON.parse(v) : null;
};
const kvPut = (ctx, k, v) =>
  ctx.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
const CATALOG_TTL = 3 * 86400_000;
const AUDIBLE = 'https://api.audible.com/1.0/catalog/products';

/** Every book of an Audible series, in order: [{ asin, position, title, release_date, cover_url }]. Cached for a few days. */
async function seriesCatalog(ctx, asin, { cachedOnly = false } = {}) {
  const k = `aud.series.${asin}`;
  const hit = kvGet(ctx, k);
  if (hit && (cachedOnly || Date.now() - hit.at < CATALOG_TTL)) return hit.books;
  if (cachedOnly) return null;
  const fetch = routedFetch(ctx);
  const get = async (url) => { const r = await fetch(url, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error(`audible ${r.status}`); return r.json(); };
  const rel = (await get(`${AUDIBLE}/${encodeURIComponent(asin)}?response_groups=relationships`)).product?.relationships ?? [];
  const kids = rel.filter((r) => r.relationship_type === 'series' && r.relationship_to_product === 'child' && r.asin);
  const books = [];
  for (let i = 0; i < kids.length; i += 40) {
    const part = kids.slice(i, i + 40);
    const j = await get(`${AUDIBLE}?${new URLSearchParams({ asins: part.map((r) => r.asin).join(','), response_groups: 'product_desc,media,product_attrs', image_sizes: '500' })}`);
    for (const p of j.products ?? []) {
      const r = part.find((x) => x.asin === p.asin);
      const position = Number(r?.sequence ?? r?.sort);
      books.push({ asin: p.asin, title: p.title, position: Number.isFinite(position) ? position : null,
        release_date: p.release_date ?? null, cover_url: p.product_images?.['500'] ?? null });
    }
  }
  // Omnibus editions ("Books 1-3") and half books stay, sorted by their number.
  books.sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
  kvPut(ctx, k, { at: Date.now(), books });
  return books;
}

async function movieCollection(ctx, item) {
  // No TMDB key (and not signed in to 128bit Connect): ask again once there is one.
  if (tmdbToken(ctx) == null) throw new Error('no TMDB key');
  let id = item.meta?.tmdb_id;
  if (!id && item.meta?.imdb_id) {
    const f = await tmdbGet(ctx, `/find/${encodeURIComponent(item.meta.imdb_id)}?external_source=imdb_id`);
    id = f?.movie_results?.[0]?.id;
  }
  if (!id) return {};
  const m = await tmdbGet(ctx, `/movie/${encodeURIComponent(id)}`);
  return m?.belongs_to_collection?.name ? { collection: m.belongs_to_collection.name, tmdb_id: id } : { tmdb_id: id };
}

/** Looks up a few titles that haven't been looked up yet; returns how many are still waiting. */
export async function fillSeries(ctx, kind) {
  const type = kind === 'audiobook' ? 'book' : kind;
  if (!['book', 'movie'].includes(type)) return 0;
  const todo = listItems(ctx, { type: kind, limit: 500 })
    .filter((i) => i.status !== 'planned' || kind !== 'movie')
    .filter((i) => !i.meta?.series && !i.meta?.collection && !i.meta?.series_checked_at);
  for (const i of todo.slice(0, PER_CALL)) {
    let found = {};
    try { found = type === 'movie' ? await movieCollection(ctx, i) : await bookSeries(ctx, i); }
    catch { continue; } // offline: try again next time
    updateItem(ctx, i.id, { meta: { ...found, series_checked_at: new Date().toISOString() } });
  }
  return Math.max(0, todo.length - PER_CALL);
}

/** The Stats list for one kind: by series / collection / show. */
export async function seriesHistory(ctx, kind, { lookup = true } = {}) {
  let pending = lookup ? await fillSeries(ctx, kind).catch(() => 0) : 0;
  const items = [];
  for (let offset = 0; ; offset += 500) {
    const page = listItems(ctx, { type: kind, limit: 500, offset });
    items.push(...page);
    if (page.length < 500) break;
  }
  const mine = items.filter((i) => kindOf(i) === kind);
  // Each series' full book list, so you can see what's next even if it isn't in your library.
  const catalogs = {};
  if (kind === 'audiobook' || kind === 'book') {
    const series = new Map();
    for (const i of mine) if (i.meta?.series_asin && i.status !== 'planned') series.set(i.meta.series_asin, i.meta.series);
    let fetched = 0;
    for (const [asin, name] of series) {
      let books = await seriesCatalog(ctx, asin, { cachedOnly: true }).catch(() => null);
      if (!books && lookup && fetched < 6) { fetched++; books = await seriesCatalog(ctx, asin).catch(() => null); }
      else if (!books) pending++;
      if (books?.length) catalogs[seriesKey(name)] = books;
    }
  }
  return { kind, pending, ...groupHistory(kind, mine, catalogs) };
}

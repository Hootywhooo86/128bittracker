// Which series a book is in (Audible) and which collection a movie is in (TMDB),
// looked up once per title and kept in its meta, for the Stats page's lists.
import { listItems, updateItem } from '../domain/library.js';
import { groupHistory, kindOf } from '../domain/series.js';
import { audible } from './metadata.js';
import { routedFetch } from './hub.js';
import { tmdbGet, tmdbToken } from './episodes.js';

const PER_CALL = 8;
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function bookSeries(ctx, item) {
  const hits = await audible(routedFetch(ctx), [item.title, item.creator].filter(Boolean).join(' '));
  const t = norm(item.title);
  const by = norm(item.creator);
  // Audible's title may carry the series ("Book of the Dead 4: Vengeance" for "Vengeance"):
  // the title anywhere in it, word for word, by the same author when we know one.
  const words = (s) => ` ${s} `;
  const sameTitle = (h) => { const n = norm(h.title); return n === t || words(n).includes(words(t)) || words(t).includes(words(n)); };
  const sameAuthor = (h) => !by || norm(h.creator).includes(by) || by.includes(norm(h.creator));
  const hit = hits.find((h) => h.meta?.series && sameTitle(h) && sameAuthor(h)) ?? (by ? null : hits.find((h) => h.meta?.series && sameTitle(h)));
  return hit ? { series: hit.meta.series, series_position: hit.meta.series_position ?? null } : {};
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
  const pending = lookup ? await fillSeries(ctx, kind).catch(() => 0) : 0;
  const items = [];
  for (let offset = 0; ; offset += 500) {
    const page = listItems(ctx, { type: kind, limit: 500, offset });
    items.push(...page);
    if (page.length < 500) break;
  }
  return { kind, pending, ...groupHistory(kind, items.filter((i) => kindOf(i) === kind)) };
}

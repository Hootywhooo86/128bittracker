// Everything you've watched, read or listened to, by series: the Stats page's
// "what have I been reading" lists. Pure: the lookups live in integrations/series.js.
//
//   books / audiobooks  by series (meta.series from Audible, else read from the title:
//                       "Series, Book 7", "Book 7 of Series", "Series: Title")
//   movies              by collection (meta.collection, from TMDB: "Spider-Man Collection")
//   shows / anime       each show with its seasons
//   anything else       one list

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const num = (s) => {
  if (s == null) return null;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  const i = WORDS.indexOf(String(s).toLowerCase());
  return i > 0 ? i : null;
};
const NUM = `(\\d+(?:\\.\\d+)?|${WORDS.slice(1).join('|')})`;
const clean = (s) => String(s ?? '').replace(/\s*[([](unabridged|abridged|dramatized[^)\]]*)[)\]]/gi, '').trim();

/** { series, position } read from a book's title, or null. */
export function seriesFromTitle(title) {
  const t = clean(title);
  let m = t.match(new RegExp(`^(?:book|volume|vol\\.?|part)\\s*${NUM}\\s+of\\s+(?:the\\s+)?(.+?)$`, 'i'));
  if (m) return { series: m[2].trim(), position: num(m[1]) };
  m = t.match(new RegExp(`^(?:.+?)[:\\-–]\\s*(?:book|volume|vol\\.?|part)\\s*${NUM}\\s+of\\s+(?:the\\s+)?(.+?)$`, 'i'));
  if (m) return { series: m[2].trim(), position: num(m[1]) };
  m = t.match(new RegExp(`^(.+?)[\\s,:\\-–]+(?:book|volume|vol\\.?|part|#)\\s*${NUM}\\b`, 'i'));
  if (m) return { series: m[1].replace(/^the\s+/i, (x) => x).trim(), position: num(m[2]) };
  m = t.match(/^(.+?):\s+.+$/);
  if (m && m[1].length >= 3) return { series: m[1].trim(), position: null };
  return null;
}

const key = (s) => String(s ?? '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const seen = (i) => i.status !== 'planned';
const lastAt = (i) => String(i.meta?.now?.at ?? i.finished_at ?? i.updated_at ?? '');

/** The kind a Stats row stands for: audiobooks apart from books. */
export const kindOf = (i) => (i.type === 'book' && i.meta?.format === 'audiobook' ? 'audiobook' : i.type);

function entry(i) {
  const m = i.meta ?? {};
  const pct = i.status === 'done' ? 100 : Number(m.pct) || (i.progress_total ? Math.round((100 * i.progress) / i.progress_total) : null);
  return {
    id: i.id, title: i.title, creator: i.creator, year: i.year, cover_url: i.cover_url, status: i.status,
    pct: pct == null ? null : Math.max(0, Math.min(100, Math.round(pct))),
    finished_at: i.finished_at, started_at: i.started_at, last_at: lastAt(i), rating: i.rating,
  };
}

/**
 * items: every library item of one kind. Returns { groups: [{ name, by, items, next }], singles }:
 * a group is a series (books), a collection (movies) or a show (its seasons as items);
 * most recently touched first. `next` is a book of that series still on your planned list.
 */
export function groupHistory(kind, items) {
  const mine = items.filter((i) => kindOf(i) === kind);
  if (kind === 'show' || kind === 'anime') {
    const groups = mine.filter(seen).map((i) => {
      const seasons = Object.entries(i.meta?.seasons ?? {}).map(([s, x]) => ({ season: Number(s), ...x })).filter((x) => x.season > 0).sort((a, b) => a.season - b.season);
      return {
        name: i.title, by: null, show: entry(i), last_at: lastAt(i),
        items: seasons.length
          ? seasons.map((x) => ({ id: i.id, title: `Season ${x.season}`, position: x.season, status: x.done ? 'done' : x.p > 0 ? 'active' : 'planned', pct: x.n ? Math.round((100 * Math.min(x.p, x.n)) / x.n) : null, watched: x.p, total: x.n ?? null, finished_at: x.done ?? null, first_air: x.a ?? null }))
          : [{ ...entry(i), title: i.meta?.season ? `Season ${i.meta.season}` : i.title, position: i.meta?.season ?? null }],
      };
    });
    return { groups: groups.sort((a, b) => b.last_at.localeCompare(a.last_at)), singles: [] };
  }
  const by = new Map();
  const singles = [];
  for (const i of mine) {
    const m = i.meta ?? {};
    let name = null, position = null;
    if (kind === 'movie') name = m.collection ?? null;
    else if (m.series) { name = m.series; position = num(m.series_position); }
    else { const p = seriesFromTitle(i.title); if (p) { name = p.series; position = p.position; } }
    if (!name) { if (seen(i)) singles.push(entry(i)); continue; }
    const k = key(name);
    const g = by.get(k) ?? { name, by: i.creator ?? null, all: [] };
    g.all.push({ ...entry(i), position });
    by.set(k, g);
  }
  const groups = [];
  for (const g of by.values()) {
    const watched = g.all.filter((e) => e.status !== 'planned');
    if (!watched.length) continue;
    // One title alone: a book whose "series" was only read from its title, or a lone movie of a collection.
    if (g.all.length === 1 && (kind === 'movie' || !mine.find((i) => i.id === g.all[0].id)?.meta?.series)) { singles.push(g.all[0]); continue; }
    const order = (a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || (a.year ?? 0) - (b.year ?? 0) || a.title.localeCompare(b.title);
    const next = g.all.filter((e) => e.status === 'planned').sort(order)[0] ?? null;
    groups.push({ name: g.name, by: g.by, items: watched.sort(order), next, last_at: watched.map((e) => e.last_at).sort().at(-1) ?? '' });
  }
  return {
    groups: groups.sort((a, b) => b.last_at.localeCompare(a.last_at)),
    singles: singles.sort((a, b) => b.last_at.localeCompare(a.last_at)),
  };
}

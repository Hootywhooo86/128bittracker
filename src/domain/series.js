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

/** "Azarinth Healer, Book 7 - Rhaegar" → { title: "Azarinth Healer, Book 7", author: "Rhaegar" } (Play's torrent names). */
export function splitAuthor(title, creator) {
  const t = String(title ?? '');
  if (creator) return { title: t.replace(new RegExp(`\\s+-\\s+${creator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), ''), author: creator };
  const m = t.match(/^(.+?)\s+-\s+([^-]{2,40})$/);
  return m ? { title: m[1].trim(), author: m[2].trim() } : { title: t, author: null };
}

const SUBTITLE = /:\s*(?:an?\s+)?(?:litrpg|progression|op mc|epic|dark|cultivation|fantasy|sci-?fi)\b.*$/i;

/** { series, position } read from a book's title, or null. */
export function seriesFromTitle(title) {
  let t = clean(splitAuthor(title).title).replace(SUBTITLE, '').trim();
  // "Interstellar Calamity …: All I Got Is This Stat Menu, Book 5": the series is after the colon.
  const after = t.match(new RegExp(`:\\s*([^:]+?),?\\s+(?:book|volume|vol\\.?|part|#)\\s*${NUM}\\s*$`, 'i'));
  if (after) return { series: after[1].trim(), position: num(after[2]) };
  let m = t.match(new RegExp(`\\((?:book|volume|vol\\.?)\\s*${NUM}\\)\\s*$`, 'i'));
  if (m) return { series: t.slice(0, m.index).trim(), position: num(m[1]) };
  m = t.match(new RegExp(`^(?:book|volume|vol\\.?|part)\\s*${NUM}\\s+of\\s+(?:the\\s+)?(.+?)$`, 'i'));
  if (m) return { series: m[2].trim(), position: num(m[1]) };
  m = t.match(new RegExp(`^(?:.+?)[:\\-–]\\s*(?:book|volume|vol\\.?|part)\\s*${NUM}\\s+of\\s+(?:the\\s+)?(.+?)$`, 'i'));
  if (m) return { series: m[2].trim(), position: num(m[1]) };
  m = t.match(new RegExp(`^(.+?)[\\s,:\\-–]+(?:book|volume|vol\\.?|part|#)\\s*${NUM}\\b`, 'i'));
  if (m) return { series: m[1].trim(), position: num(m[2]) };
  // "The Path of Ascension 4", "Book of the Dead 2: Sacrifice", "Mage Tank 5"
  m = t.match(/^(.+?\D)\s+(\d{1,3}(?:\.\d)?)(?:\s*:.*)?$/);
  if (m && !/^\d/.test(m[1])) return { series: m[1].replace(/[,:\-–]\s*$/, '').trim(), position: num(m[2]) };
  m = t.match(/^(.+?):\s+.+$/);
  if (m && m[1].length >= 3) return { series: m[1].trim(), position: null };
  return null;
}

export const seriesKey = (s) => String(s ?? '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const key = seriesKey;
const seen = (i) => i.status !== 'planned';
const lastAt = (i) => String(i.meta?.now?.at ?? i.finished_at ?? i.updated_at ?? '');

/** The kind a Stats row stands for: audiobooks apart from books. */
export const kindOf = (i) => (i.type === 'book' && i.meta?.format === 'audiobook' ? 'audiobook' : i.type);

// Played to the end bar the credits: finished, whatever the status says.
const FINISHED_PCT = 97;

function entry(i) {
  const m = i.meta ?? {};
  const pct = i.status === 'done' ? 100 : Number(m.pct) || (i.progress_total ? Math.round((100 * i.progress) / i.progress_total) : null);
  const status = i.status === 'active' && pct >= FINISHED_PCT ? 'done' : i.status;
  const { title, author } = splitAuthor(i.title, i.creator);
  return {
    id: i.id, title, creator: i.creator ?? author, year: i.year, cover_url: i.cover_url, status, asin: m.asin ?? null, play_id: m.play_id ?? null, type: i.type,
    finished_at_guess: status === 'done' && !i.finished_at ? (m.now?.at ?? i.updated_at) : null,
    pct: pct == null ? null : Math.max(0, Math.min(100, Math.round(pct))),
    finished_at: i.finished_at ?? null, started_at: i.started_at, last_at: lastAt(i), rating: i.rating,
  };
}

/**
 * Where you left off in a series: the book you're part-way through, else the first one after
 * the furthest you've finished that you haven't. null when you're caught up.
 */
export function leftOff(items) {
  const now = items.filter((e) => e.status === 'active').sort((a, b) => b.last_at.localeCompare(a.last_at))[0];
  if (now) return { ...now, why: 'listening' };
  const furthest = Math.max(-Infinity, ...items.filter((e) => e.status === 'done' && e.position != null).map((e) => e.position));
  return items.find((e) => e.status !== 'done' && e.position != null && e.position > furthest) ?? null;
}

const titleKey = (s) => seriesKey(String(s ?? '').replace(/\s*[([].*?[)\]]/g, '').replace(SUBTITLE, ''));

/** Your books of a series laid over the series' full list (Audible): every book in order, yours or not. */
function overCatalog(mine, catalog) {
  // One book per number (Audible lists some twice: other editions, dramatized versions).
  const seenPos = new Set();
  const books = catalog.filter((c) => c.position == null || (!seenPos.has(c.position) && seenPos.add(c.position)));
  const used = new Set();
  const take = (c, test) => {
    const e = mine.find((x) => !used.has(x.id) && test(x));
    if (e) used.add(e.id);
    return e;
  };
  // Best evidence first: the same Audible book, the same title, the same number, then one title inside the other.
  const passes = [
    (c) => (x) => x.asin && x.asin === c.asin,
    (c) => (x) => titleKey(x.title) === titleKey(c.title),
    (c) => (x) => c.position != null && x.position === c.position,
    (c) => (x) => x.position == null && (` ${titleKey(c.title)} `.includes(` ${titleKey(x.title)} `) || ` ${titleKey(x.title)} `.includes(` ${titleKey(c.title)} `)),
  ];
  const match = new Map();
  for (const pass of passes) for (const c of books) if (!match.has(c)) { const e = take(c, pass(c)); if (e) match.set(c, e); }
  const out = books.map((c) => {
    const e = match.get(c);
    if (!e) return { title: c.title, position: c.position, status: 'not_started', cover_url: c.cover_url, release_date: c.release_date, asin: c.asin, yours: false, last_at: '' };
    return { ...e, position: c.position ?? e.position, cover_url: e.cover_url ?? c.cover_url, yours: true };
  });
  return [...out, ...mine.filter((e) => !used.has(e.id)).map((e) => ({ ...e, yours: true }))];
}

/**
 * items: every library item of one kind. catalogs: each series' full book list, by seriesKey.
 * Returns { groups: [{ name, by, items, left_off, next }], singles }: a group is a series
 * (books), a collection (movies) or a show (its seasons as items); most recently touched first.
 */
export function groupHistory(kind, items, catalogs = {}) {
  const mine = items.filter((i) => kindOf(i) === kind);
  if (kind === 'show' || kind === 'anime') {
    const groups = mine.filter(seen).map((i) => {
      const seasons = Object.entries(i.meta?.seasons ?? {}).map(([s, x]) => ({ season: Number(s), ...x })).filter((x) => x.season > 0).sort((a, b) => a.season - b.season);
      const rows = seasons.length
        ? seasons.map((x) => ({ id: i.id, title: `Season ${x.season}`, position: x.season, status: x.done ? 'done' : x.p > 0 ? 'active' : 'not_started', pct: x.n ? Math.round((100 * Math.min(x.p, x.n)) / x.n) : null, watched: x.p, total: x.n ?? null, finished_at: x.done ?? null, first_air: x.a ?? null, last_at: lastAt(i), yours: true }))
        : [{ ...entry(i), title: i.meta?.season ? `Season ${i.meta.season}` : i.title, position: i.meta?.season ?? null, yours: true }];
      return { name: i.title, by: null, show: entry(i), last_at: lastAt(i), items: rows, left_off: leftOff(rows) };
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
    const g = by.get(k) ?? { name, by: null, all: [], fromAudible: false };
    const e = { ...entry(i), position };
    g.by ??= e.creator;
    if (m.series) g.fromAudible = true;
    g.all.push(e);
    by.set(k, g);
  }
  const order = (a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || (a.year ?? 0) - (b.year ?? 0) || a.title.localeCompare(b.title);
  const groups = [];
  for (const [k, g] of by) {
    const watched = g.all.filter((e) => e.status !== 'planned');
    if (!watched.length) continue;
    // One title alone: a book whose "series" was only read from its title, or a lone movie of a collection.
    if (g.all.length === 1 && !catalogs[k] && (kind === 'movie' || !g.fromAudible)) { singles.push(g.all[0]); continue; }
    const rows = (catalogs[k]?.length ? overCatalog(g.all, catalogs[k]) : g.all)
      .map((e) => (e.status === 'planned' ? { ...e, status: 'not_started', on_list: true } : e)).sort(order);
    const lo = leftOff(rows);
    groups.push({
      name: g.name, by: g.by, items: rows, left_off: lo, full_list: !!catalogs[k]?.length,
      next: lo, last_at: watched.map((e) => e.last_at).sort().at(-1) ?? '',
    });
  }
  return {
    groups: groups.sort((a, b) => b.last_at.localeCompare(a.last_at)),
    singles: singles.sort((a, b) => b.last_at.localeCompare(a.last_at)),
  };
}

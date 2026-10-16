// One show, its seasons inside.
//
// A show (or anime) is one library item. Each season's progress lives in
// meta.seasons, keyed by season number:
//
//   meta.seasons = { "1": { p: 10, n: 10, done: "2026-10-15T…" }, "2": { p: 0, n: 8, a: "2026-10-20" } }
//     p     episodes watched (1..p)
//     n     episodes in the season, when known (from TVmaze / TMDB / AniList)
//     a     the season's first air date, when known
//     done  when you finished it (each finished season earns its own golden trophy)
//
// meta.season is the season you're on; progress / progress_total are that season's,
// so Up Next ("S2 E1") and every older screen keep working. A show is only "done"
// when every season out there is watched: a new season announced puts it back to
// in progress, at that season's first episode, so it shows in Up Next and Coming up.

const SHOWISH = new Set(['show', 'anime']);
export const isShow = (item) => SHOWISH.has(item?.type);

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** meta.seasons as { [season]: {p, n?, a?, done?} }, with an older single-season item folded in. */
export function seasonsOf(item) {
  const meta = item.meta ?? {};
  const out = {};
  for (const [k, v] of Object.entries(meta.seasons ?? {})) {
    const s = Number(k);
    if (!Number.isInteger(s) || s < 0 || !v || typeof v !== 'object') continue;
    out[s] = { p: Math.max(0, num(v.p) ?? 0), ...(num(v.n) ? { n: num(v.n) } : {}), ...(v.a ? { a: String(v.a) } : {}), ...(v.done ? { done: String(v.done) } : {}) };
  }
  // An item from before seasons lived inside: its season, progress and length.
  if (!Object.keys(out).length && (item.progress > 0 || meta.season != null || item.status === 'done')) {
    const s = num(meta.season) ?? 1;
    const done = item.status === 'done';
    // Finished with no length known: what you watched was the whole season.
    const n = num(item.progress_total) ?? (done ? Math.max(1, Math.floor(Number(item.progress) || 0)) : null);
    const p = done && n ? n : Math.floor(Number(item.progress) || 0);
    out[s] = { p, ...(n ? { n } : {}), ...(item.status === 'done' ? { done: item.finished_at ?? new Date().toISOString() } : {}) };
  }
  return out;
}

/**
 * Where the show stands: the season you're on, its progress, and the status.
 * Statuses you set yourself (on hold, dropped) are kept; planned turns into
 * in progress once an episode is watched.
 */
export function settle(item, seasons, now = new Date().toISOString()) {
  const list = Object.keys(seasons).map(Number).filter((s) => s > 0).sort((a, b) => a - b);
  for (const s of list) {
    const x = seasons[s];
    if (x.n && x.p >= x.n) x.done ??= now;
    else delete x.done; // un-ticked an episode: not finished any more
  }
  const finished = list.filter((s) => seasons[s].done);
  const lastDone = finished.length ? Math.max(...finished) : 0;
  const open = list.filter((s) => !seasons[s].done);
  // The latest season you're part-way through; else the first one after the seasons you finished.
  const cur = open.filter((s) => seasons[s].p > 0).at(-1) ?? open.find((s) => s > lastDone) ?? open[0] ?? (list.length ? list[list.length - 1] : 1);
  const caughtUp = !open.some((s) => s > lastDone || seasons[s].p > 0) && finished.length > 0;
  const watchedAny = list.some((s) => seasons[s].p > 0);
  let status = item.status;
  if (status !== 'on_hold' && status !== 'dropped') {
    if (caughtUp) status = 'done';
    else if (watchedAny || finished.length) status = 'active';
  }
  const c = seasons[cur] ?? { p: 0 };
  return { season: cur, progress: c.p, progress_total: c.n ?? null, status, seasons, caughtUp };
}

/** The patch for updateItem that applies these seasons. */
export function seasonPatch(item, seasons, now) {
  const st = settle(item, seasons, now);
  const patch = { meta: { seasons: st.seasons, season: st.season }, progress: st.progress, progress_total: st.progress_total };
  if (st.status !== item.status) patch.status = st.status;
  return patch;
}

/** Watched episode `number` of `season` (forward only: earlier ones count as watched). */
export function watchEpisode(item, season, number, total = null) {
  const seasons = seasonsOf(item);
  const s = num(season) ?? num(item.meta?.season) ?? 1;
  const x = (seasons[s] ??= { p: 0 });
  x.p = Math.max(x.p, num(number) ?? x.p + 1);
  if (num(total) && !x.n) x.n = num(total);
  return seasonPatch(item, seasons);
}

/** Ticked (or un-ticked) up to episode `upto` of `season`, exactly. */
export function setSeasonProgress(item, season, upto) {
  const seasons = seasonsOf(item);
  const s = num(season) ?? 1;
  const x = (seasons[s] ??= { p: 0 });
  x.p = Math.max(0, Math.floor(num(upto) ?? 0));
  if (x.n) x.p = Math.min(x.p, x.n);
  return seasonPatch(item, seasons);
}

/** Season lengths and air dates from a catalog: [{ season, episodes: n, first_air }]. Keeps what you watched. */
export function withCatalog(item, catalog) {
  const seasons = seasonsOf(item);
  for (const c of catalog) {
    // A season announced with only a date still counts: it's coming.
    if (!(c.season > 0) || (!(c.episodes > 0) && !c.first_air)) continue;
    const x = (seasons[c.season] ??= { p: 0 });
    if (c.episodes > 0) x.n = c.episodes;
    if (c.first_air) x.a = c.first_air;
  }
  return seasonPatch(item, seasons);
}

/** Marked the whole show done by hand: every season known so far is watched. */
export function finishAll(item) {
  const seasons = seasonsOf(item);
  const cur = num(item.meta?.season) ?? 1;
  seasons[cur] ??= { p: 0 };
  for (const [s, x] of Object.entries(seasons)) if (x.n && Number(s) <= cur) x.p = x.n;
  if (!seasons[cur].n) {
    seasons[cur].n = Math.max(seasons[cur].p, 1);
    seasons[cur].p = seasons[cur].n;
  }
  return seasonPatch(item, seasons);
}

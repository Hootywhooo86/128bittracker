// Stats: the honest numbers. No guilt, just the record.
import { toDay, addDays } from './dates.js';
import { listTrackers } from './trackers.js';
import { trophyCounts } from './trophies.js';
import { sittingMinutes } from '../../public/sitting.js';

// Books with format audiobook count as audiobooks, apart from books.
const KIND_SQL = "CASE WHEN i.type = 'book' AND json_extract(i.meta, '$.format') = 'audiobook' THEN 'audiobook' ELSE i.type END";

// What you watched, listened to and read, from the other apps (128bitPlay's sittings).
const MEDIA_EVENTS = ['watch.session', 'listen.session', 'read.session', 'movie.watched', 'episode.watched', 'book.finished', 'chapter.read'];

/** A timeline event → { kind, minutes } when it's something watched, listened to or read. */
export function mediaOf(e) {
  const d = e.data ?? {};
  let kind = null;
  if (e.type === 'watch.session' || e.type === 'episode.watched' || e.type === 'movie.watched') {
    kind = d.kind === 'movie' || e.type === 'movie.watched' ? 'movie' : d.anime || d.kitsu ? 'anime' : 'show';
  } else if (e.type === 'listen.session') kind = 'audiobook';
  else if (e.type === 'book.finished') kind = e.source === '128bitplay' || d.format === 'audiobook' ? 'audiobook' : 'book';
  else if (e.type === 'read.session' || e.type === 'chapter.read') kind = 'comic';
  if (!kind) return null;
  const minutes = e.type.endsWith('.session') ? (e.type === 'read.session' ? Number(d.minutes) || 0 : sittingMinutes(d, e.occurred_at)) : 0;
  return { kind, minutes };
}

function mediaEvents(ctx, from = null, to = null) {
  const marks = MEDIA_EVENTS.map(() => '?').join(',');
  const range = from ? ' AND occurred_at >= ? AND occurred_at < ?' : '';
  return ctx.db
    .prepare(`SELECT type, source, occurred_at, payload FROM events WHERE type IN (${marks})${range}`)
    .all(...MEDIA_EVENTS, ...(from ? [from, to] : []))
    .map((r) => {
      let data = {};
      try { data = JSON.parse(r.payload ?? '{}'); } catch { /* bad payload */ }
      return { occurred_at: r.occurred_at, ...mediaOf({ ...r, data }) };
    })
    .filter((r) => r.kind);
}

export function overview(ctx) {
  const db = ctx.db;
  const trackers = listTrackers(ctx);
  const byType = db.prepare(`SELECT ${KIND_SQL} AS type, i.status, COUNT(*) AS n FROM items i GROUP BY 1, 2`).all();
  const library = {};
  for (const r of byType) {
    library[r.type] ??= { total: 0 };
    library[r.type][r.status] = r.n;
    library[r.type].total += r.n;
  }
  const minutesByType = db
    .prepare(`SELECT ${KIND_SQL} AS type, COALESCE(SUM(s.minutes),0) AS minutes FROM sessions s JOIN items i ON i.id = s.item_id GROUP BY 1`)
    .all();
  for (const r of minutesByType) {
    library[r.type] ??= { total: 0 };
    library[r.type].minutes = r.minutes;
  }
  // Time in 128bitPlay: every watching / listening / reading sitting it reported.
  for (const e of mediaEvents(ctx)) {
    if (!e.minutes) continue;
    library[e.kind] ??= { total: 0 };
    library[e.kind].minutes = (library[e.kind].minutes ?? 0) + e.minutes;
  }
  for (const v of Object.values(library)) if (v.minutes) v.minutes = Math.round(v.minutes);
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const finishedThisYear = db.prepare('SELECT COUNT(*) AS n FROM items WHERE status = ? AND finished_at >= ?').get('done', yearStart).n;
  const avgRating = db.prepare('SELECT AVG(rating) AS r FROM items WHERE rating IS NOT NULL').get().r;
  return {
    today: toDay(),
    habits: {
      count: trackers.length,
      done_today: trackers.filter((t) => t.today.done).length,
      best_current_streak: Math.max(0, ...trackers.map((t) => t.streak.current)),
      best_ever_streak: Math.max(0, ...trackers.map((t) => t.streak.best)),
      avg_completion_30d: trackers.length ? Math.round(trackers.reduce((a, t) => a + t.completion_30d, 0) / trackers.length) : 0,
    },
    library,
    finished_this_year: finishedThisYear,
    average_rating: avgRating == null ? null : Math.round(avgRating * 10) / 10,
    events_total: db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
    trophies: trophyCounts(ctx),
  };
}

/** Year in pixels: one cell per day, scored by how much got logged. */
export function yearInPixels(ctx, year = new Date().getFullYear()) {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const logs = new Map(
    ctx.db.prepare('SELECT day, COUNT(*) AS n FROM logs WHERE day BETWEEN ? AND ? GROUP BY day').all(start, end).map((r) => [r.day, r.n]),
  );
  // Timeline events are timestamps; bucket them by local day.
  const evs = ctx.db.prepare('SELECT occurred_at FROM events WHERE occurred_at >= ? AND occurred_at < ?').all(addDays(start, -1), addDays(end, 2));
  const events = new Map();
  for (const { occurred_at } of evs) {
    const d = toDay(occurred_at);
    if (d >= start && d <= end) events.set(d, (events.get(d) ?? 0) + 1);
  }
  // What each day was mostly: minutes (and count) per kind, for the cell's colour.
  const media = new Map();
  for (const e of mediaEvents(ctx, addDays(start, -1), addDays(end, 2))) {
    const d = toDay(e.occurred_at);
    if (d < start || d > end) continue;
    const m = media.get(d) ?? {};
    m[e.kind] ??= { n: 0, minutes: 0 };
    m[e.kind].n++;
    m[e.kind].minutes += e.minutes;
    media.set(d, m);
  }
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const m = media.get(d);
    const kinds = m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { n: v.n, minutes: Math.round(v.minutes) }])) : {};
    const top = Object.entries(kinds).sort((a, b) => b[1].minutes - a[1].minutes || b[1].n - a[1].n)[0]?.[0] ?? null;
    const minutes = Object.values(kinds).reduce((a, v) => a + v.minutes, 0);
    days.push({ day: d, logs: logs.get(d) ?? 0, events: events.get(d) ?? 0, minutes, top, kinds });
  }
  return { year, days };
}

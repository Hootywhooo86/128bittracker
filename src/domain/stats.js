// Stats: the honest numbers. No guilt, just the record.
import { toDay, addDays } from './dates.js';
import { listTrackers } from './trackers.js';

export function overview(ctx) {
  const db = ctx.db;
  const trackers = listTrackers(ctx);
  const byType = db.prepare('SELECT type, status, COUNT(*) AS n FROM items GROUP BY type, status').all();
  const library = {};
  for (const r of byType) {
    library[r.type] ??= { total: 0 };
    library[r.type][r.status] = r.n;
    library[r.type].total += r.n;
  }
  const minutesByType = db
    .prepare('SELECT i.type, COALESCE(SUM(s.minutes),0) AS minutes FROM sessions s JOIN items i ON i.id = s.item_id GROUP BY i.type')
    .all();
  for (const r of minutesByType) {
    library[r.type] ??= { total: 0 };
    library[r.type].minutes = r.minutes;
  }
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
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    days.push({ day: d, logs: logs.get(d) ?? 0, events: events.get(d) ?? 0 });
  }
  return { year, days };
}

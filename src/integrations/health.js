// Health Connect (Android) → Tracker. The phone reads workouts and daily
// totals and hands them here; runs on the server and the phone alike.
//
// Workouts become workout.logged events (keyed by the Health Connect id, so
// re-reading the same week is a no-op) and log any tracker listening to them.
// Each day becomes one health.day event, updated in place as the day goes on,
// and the Steps tracker is topped up to the day's total (never double-counted).
import { HttpError } from '../api/errors.js';
import { isDay } from '../domain/dates.js';
import { logTracker } from '../domain/trackers.js';
import { ingest } from './index.js';
import { tx } from '../db/tx.js';

const SOURCE = 'healthconnect';
const MAX = 2000;

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pretty = (t) => String(t || 'Workout').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function kvGet(db, key) {
  const v = db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value;
  return v == null ? null : JSON.parse(v);
}
function kvSet(db, key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function healthStatus(ctx) {
  const { db } = ctx;
  return {
    enabled: !!kvGet(db, 'health.enabled'),
    last_sync_at: kvGet(db, 'health.last_sync_at'),
    workouts: db.prepare("SELECT COUNT(*) AS n FROM events WHERE source = ? AND type = 'workout.logged'").get(SOURCE).n,
  };
}

export function setHealthEnabled(ctx, enabled) {
  kvSet(ctx.db, 'health.enabled', !!enabled);
  return healthStatus(ctx);
}

/** body: { workouts: [{id, startDate, endDate, workoutType, title?, duration (s), calories?, distance? (m), steps?}], days: [{day, steps?, active_calories?, distance_m?}] } */
export function applyHealth(ctx, body = {}) {
  const workouts = Array.isArray(body.workouts) ? body.workouts : [];
  const days = Array.isArray(body.days) ? body.days : [];
  if (workouts.length > MAX || days.length > MAX) throw new HttpError(400, `at most ${MAX} workouts and days per call`);

  let added = 0;
  for (const w of workouts) {
    if (!w?.id || !w.startDate) continue;
    const minutes = Math.max(1, Math.round((num(w.duration) ?? (Date.parse(w.endDate) - Date.parse(w.startDate)) / 1000) / 60));
    if (!Number.isFinite(minutes)) continue;
    const name = w.title || pretty(w.workoutType);
    const calories = num(w.calories);
    const distance = num(w.distance);
    const data = {
      name,
      kind: w.workoutType ?? null,
      minutes,
      ...(calories != null ? { calories: Math.round(calories) } : {}),
      ...(distance != null ? { distance_m: Math.round(distance) } : {}),
      ...(num(w.steps) != null ? { steps: Math.round(num(w.steps)) } : {}),
      ...(w.sourceBundleId ? { app: String(w.sourceBundleId) } : {}),
    };
    const res = ingest(ctx, {
      id: `hc-workout-${String(w.id).slice(0, 100)}`,
      type: 'workout.logged',
      source: SOURCE,
      occurred_at: w.endDate || w.startDate,
      title: `💪 ${name} · ${minutes} min`,
      data,
    });
    if (res.status === 'accepted') added++;
  }

  let updatedDays = 0;
  for (const d of days) {
    if (!d || !isDay(d.day)) continue;
    const steps = num(d.steps);
    const data = {
      ...(steps != null ? { steps: Math.round(steps) } : {}),
      ...(num(d.active_calories) != null ? { active_calories: Math.round(num(d.active_calories)) } : {}),
      ...(num(d.distance_m) != null ? { distance_m: Math.round(num(d.distance_m)) } : {}),
    };
    if (!Object.keys(data).length) continue;
    tx(ctx.db, () => {
      const id = `hc-day-${d.day}`;
      const title = `❤️ ${steps != null ? `${Math.round(steps).toLocaleString('en-US')} steps` : 'Health'}${data.active_calories ? ` · ${data.active_calories} kcal` : ''}`;
      const res = ingest(ctx, { id, type: 'health.day', source: SOURCE, occurred_at: `${d.day}T23:59:00`, title, data });
      if (res.status === 'duplicate') {
        ctx.db.prepare('UPDATE events SET payload = ?, title = ? WHERE id = ?').run(JSON.stringify(data), title, id);
      }
      if (steps != null) topUpSteps(ctx, d.day, Math.round(steps));
    });
    updatedDays++;
  }

  kvSet(ctx.db, 'health.last_sync_at', new Date().toISOString());
  return { workouts_added: added, days: updatedDays };
}

// Steps trackers (unit "steps", or listening to health.steps) get the day's
// total: only the part Health Connect hasn't already logged is added.
function topUpSteps(ctx, day, total) {
  const trackers = ctx.db
    .prepare("SELECT id FROM trackers WHERE archived = 0 AND kind = 'count' AND (unit = 'steps' OR (',' || listens || ',') LIKE '%,health.steps,%')")
    .all();
  for (const t of trackers) {
    const have = ctx.db.prepare('SELECT COALESCE(SUM(value), 0) AS n FROM logs WHERE tracker_id = ? AND day = ? AND source = ?').get(t.id, day, SOURCE).n;
    if (total > have) logTracker(ctx, t.id, { value: total - have, day }, { source: SOURCE });
  }
}

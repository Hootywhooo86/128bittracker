// Habit trackers: two-tap logging, presets, freezes, streaks.
import { HttpError, notFound } from '../api/errors.js';
import { toDay, isDay, addDays } from './dates.js';
import { computeStreak, milestoneCrossed } from './streaks.js';

export const KINDS = ['check', 'count', 'duration', 'scale'];

export const PRESETS = {
  water:   { name: 'Water',    icon: '💧', color: '#38bdf8', kind: 'count',    target: 8,  unit: 'glasses' },
  sleep:   { name: 'Sleep',    icon: '🌙', color: '#a78bfa', kind: 'duration', target: 480, unit: 'min' },
  reading: { name: 'Reading',  icon: '📖', color: '#ff9f1c', kind: 'duration', target: 20, unit: 'min' },
  mood:    { name: 'Mood',     icon: '🙂', color: '#ff5d8f', kind: 'scale',    target: 5,  unit: '/5' },
  meds:    { name: 'Meds',     icon: '💊', color: '#2dd4bf', kind: 'check',    target: 1 },
  steps:   { name: 'Steps',    icon: '👟', color: '#4ade80', kind: 'count',    target: 8000, unit: 'steps' },
  gaming:  { name: 'Play time', icon: '🎮', color: '#f472b6', kind: 'duration', target: 30, unit: 'min', listens: 'game.session' },
  workout: { name: 'Workout',  icon: '💪', color: '#fb923c', kind: 'check',    target: 1, listens: 'workout.logged' },
};

const MAX_FREEZES_PER_30_DAYS = 4;

function validate(input, partial = false) {
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 60) throw new HttpError(400, 'name is required (max 60 chars)');
    out.name = name;
  }
  if (!partial || input.kind !== undefined) {
    const kind = input.kind ?? 'check';
    if (!KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
    out.kind = kind;
  }
  if (input.target !== undefined) {
    const t = Number(input.target);
    if (!(t > 0)) throw new HttpError(400, 'target must be > 0');
    out.target = t;
  }
  if (input.icon !== undefined) out.icon = String(input.icon).slice(0, 8) || '⭐';
  if (input.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(input.color)) throw new HttpError(400, 'color must be #rrggbb');
    out.color = input.color;
  }
  if (input.remind_at !== undefined) {
    const r = input.remind_at == null || input.remind_at === '' ? null : String(input.remind_at);
    if (r != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(r)) throw new HttpError(400, 'remind_at must be HH:MM (24h)');
    out.remind_at = r;
  }
  if (input.unit !== undefined) out.unit = input.unit == null ? null : String(input.unit).slice(0, 20);
  if (input.archived !== undefined) out.archived = input.archived ? 1 : 0;
  if (input.listens !== undefined) {
    const list = (Array.isArray(input.listens) ? input.listens : String(input.listens ?? '').split(','))
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (list.some((t) => !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(t))) throw new HttpError(400, 'listens must be event types like workout.logged');
    out.listens = list.length ? list.join(',') : null;
  }
  return out;
}

export function createTracker(ctx, input) {
  const base = input.preset ? PRESETS[input.preset] : null;
  if (input.preset && !base) throw new HttpError(400, `unknown preset "${input.preset}"`);
  const t = { icon: '⭐', color: '#2dd4bf', target: 1, unit: null, listens: null, remind_at: null, ...base, ...validate({ ...base, ...input }) };
  const res = ctx.db
    .prepare('INSERT INTO trackers (name, icon, color, kind, target, unit, preset, listens, remind_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t.name, t.icon, t.color, t.kind, t.target, t.unit, input.preset ?? null, t.listens, t.remind_at, new Date().toISOString());
  return getTracker(ctx, Number(res.lastInsertRowid));
}

export function updateTracker(ctx, id, input) {
  getRow(ctx, id);
  const fields = validate(input, true);
  const keys = Object.keys(fields);
  if (keys.length) {
    ctx.db.prepare(`UPDATE trackers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  }
  return getTracker(ctx, id);
}

export function deleteTracker(ctx, id) {
  getRow(ctx, id);
  ctx.db.prepare('DELETE FROM trackers WHERE id = ?').run(id);
}

function getRow(ctx, id) {
  const row = ctx.db.prepare('SELECT * FROM trackers WHERE id = ?').get(id);
  if (!row) throw notFound('tracker');
  return row;
}

/** Days on which the tracker met its goal, plus per-day totals. */
function dayTotals(ctx, tracker, sinceDay) {
  const rows = ctx.db
    .prepare('SELECT day, SUM(value) AS total, COUNT(*) AS n FROM logs WHERE tracker_id = ? AND day >= ? GROUP BY day')
    .all(tracker.id, sinceDay ?? '0000-00-00');
  const totals = new Map(rows.map((r) => [r.day, r.total]));
  const done = new Set(rows.filter((r) => isDoneTotal(tracker, r.total, r.n)).map((r) => r.day));
  return { totals, done };
}

function isDoneTotal(tracker, total, n) {
  if (tracker.kind === 'check' || tracker.kind === 'scale') return n > 0;
  return total >= tracker.target;
}

function frozenDays(ctx, id) {
  return ctx.db.prepare('SELECT day FROM freezes WHERE tracker_id = ?').all(id).map((r) => r.day);
}

export function getTracker(ctx, id, today = toDay()) {
  const row = getRow(ctx, id);
  const { totals, done } = dayTotals(ctx, row);
  const frozen = frozenDays(ctx, id);
  const streak = computeStreak(done, frozen, today);
  const last30 = Array.from({ length: 30 }, (_, i) => addDays(today, i - 29));
  return {
    ...row,
    archived: !!row.archived,
    listens: row.listens ? row.listens.split(',') : [],
    today: { day: today, total: totals.get(today) ?? 0, done: done.has(today) },
    streak,
    completion_30d: Math.round((last30.filter((d) => done.has(d)).length / 30) * 100),
    history: last30.map((d) => ({ day: d, total: totals.get(d) ?? 0, done: done.has(d), frozen: frozen.includes(d) })),
  };
}

export function listTrackers(ctx, { includeArchived = false } = {}) {
  const ids = ctx.db
    .prepare(`SELECT id FROM trackers ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY id`)
    .all()
    .map((r) => r.id);
  const today = toDay();
  return ids.map((id) => getTracker(ctx, id, today));
}

/** Two-tap logging. `value` defaults to 1 (check / +1). */
export function logTracker(ctx, id, input = {}, { source = 'tracker' } = {}) {
  const tracker = getRow(ctx, id);
  const day = input.day ?? toDay();
  if (!isDay(day)) throw new HttpError(400, 'day must be YYYY-MM-DD');
  const value = input.value === undefined ? (tracker.kind === 'check' ? 1 : tracker.kind === 'count' ? 1 : null) : Number(input.value);
  if (value == null || !Number.isFinite(value)) throw new HttpError(400, `value is required for ${tracker.kind} trackers`);
  if (tracker.kind === 'scale' && (value < 1 || value > tracker.target)) throw new HttpError(400, `value must be 1..${tracker.target}`);

  const today = toDay();
  const before = getTracker(ctx, id, today);
  const wasDone = before.history.find((h) => h.day === day)?.done ?? false;

  const res = ctx.db
    .prepare('INSERT INTO logs (tracker_id, value, note, day, logged_at, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, value, input.note ? String(input.note).slice(0, 500) : null, day, new Date().toISOString(), source);

  const after = getTracker(ctx, id, today);
  const isDone = after.history.find((h) => h.day === day)?.done ?? false;
  const ref = { tracker_id: id, tracker: tracker.name, icon: tracker.icon };
  // Backfilled logs belong on their own day in the timeline.
  const at = day === today ? {} : { occurred_at: `${day}T12:00:00` };

  ctx.events.emit('habit.logged', { ...ref, value, unit: tracker.unit, day }, { ...at, title: `${tracker.icon} ${tracker.name} +${value}${tracker.unit ? ' ' + tracker.unit : ''}` });
  if (!wasDone && isDone) {
    ctx.events.emit('habit.completed', { ...ref, day, streak: after.streak.current }, { ...at, title: `${tracker.icon} ${tracker.name} done` });
  }
  const milestone = milestoneCrossed(before.streak.current, after.streak.current);
  if (milestone) {
    ctx.events.emit('streak.milestone', { ...ref, days: milestone }, { ...at, title: `🔥 ${milestone}-day ${tracker.name} streak` });
  }
  return { log_id: Number(res.lastInsertRowid), tracker: after, milestone };
}

export function undoLastLog(ctx, id, day = toDay()) {
  getRow(ctx, id);
  const last = ctx.db.prepare('SELECT id FROM logs WHERE tracker_id = ? AND day = ? ORDER BY id DESC LIMIT 1').get(id, day);
  if (!last) throw new HttpError(404, 'nothing to undo');
  ctx.db.prepare('DELETE FROM logs WHERE id = ?').run(last.id);
  return getTracker(ctx, id);
}

export function listLogs(ctx, id, { limit = 100 } = {}) {
  getRow(ctx, id);
  const n = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  return ctx.db.prepare(`SELECT * FROM logs WHERE tracker_id = ? ORDER BY logged_at DESC LIMIT ${n}`).all(id);
}

/** Spend a streak freeze on a day (default: yesterday). Limited per 30 days. */
export function freezeDay(ctx, id, day = addDays(toDay(), -1)) {
  const tracker = getRow(ctx, id);
  if (!isDay(day)) throw new HttpError(400, 'day must be YYYY-MM-DD');
  if (day > toDay()) throw new HttpError(400, "can't freeze a future day");
  const { n } = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM freezes WHERE tracker_id = ? AND day > ?')
    .get(id, addDays(toDay(), -30));
  if (n >= MAX_FREEZES_PER_30_DAYS) throw new HttpError(409, `freeze limit reached (${MAX_FREEZES_PER_30_DAYS} per 30 days)`);
  const res = ctx.db.prepare('INSERT OR IGNORE INTO freezes (tracker_id, day) VALUES (?, ?)').run(id, day);
  if (res.changes) ctx.events.emit('streak.frozen', { tracker_id: id, tracker: tracker.name, day }, { title: `🧊 ${tracker.name} streak frozen` });
  return getTracker(ctx, id);
}

// The 128bit event envelope and the unified timeline.
//
// Runs on the server and on the phone, so no Node-only imports here.
//
// Envelope (v1), shared by every 128bit app:
//   { id, type, source, occurred_at, title?, data }
// `type` is `<noun>.<verb>` (workout.logged, game.completed, habit.completed).
// `id` makes ingestion idempotent — resending the same event is a no-op.
import { HttpError } from '../api/errors.js';

const TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export function normalizeEnvelope(input, { defaultSource } = {}) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'event must be an object');
  const type = String(input.type ?? '');
  if (!TYPE_RE.test(type)) throw new HttpError(400, `invalid event type "${type}" (expected noun.verb)`);
  const source = String(input.source ?? defaultSource ?? '');
  if (!SOURCE_RE.test(source)) throw new HttpError(400, `invalid event source "${source}"`);
  const occurred = input.occurred_at ? new Date(input.occurred_at) : new Date();
  if (Number.isNaN(occurred.getTime())) throw new HttpError(400, 'invalid occurred_at');
  const data = input.data ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'data must be an object');
  const id = input.id == null ? globalThis.crypto.randomUUID() : String(input.id);
  if (id.length > 128) throw new HttpError(400, 'id too long');
  return {
    id,
    type,
    source,
    occurred_at: occurred.toISOString(),
    title: input.title == null ? null : String(input.title).slice(0, 280),
    data,
  };
}

/**
 * The timeline store. `onCommit(ev)` runs for Tracker's own events once the
 * surrounding transaction has settled — the server uses it for webhooks.
 */
export function createEventBus(db, { onCommit } = {}) {
  const pending = new Set();

  /** Store an event on the timeline. Returns false when it was a duplicate. */
  function record(ev) {
    const res = db
      .prepare(
        `INSERT INTO events (id, type, source, occurred_at, received_at, title, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(ev.id, ev.type, ev.source, ev.occurred_at, new Date().toISOString(), ev.title, JSON.stringify(ev.data));
    return res.changes > 0;
  }

  /** Record one of Tracker's own events (habit.completed, streak.milestone, ...). */
  function emit(type, data, { title, occurred_at } = {}) {
    const ev = normalizeEnvelope({ type, source: '128bittracker', data, title, occurred_at });
    if (record(ev) && onCommit) {
      // Only notify once the event survived its transaction (a rolled-back
      // ingest shouldn't notify anyone).
      track(
        new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
          if (db.prepare('SELECT 1 FROM events WHERE id = ?').get(ev.id)) return onCommit(ev);
        }),
      );
    }
    return ev;
  }

  function track(p) {
    pending.add(p);
    p.finally(() => pending.delete(p));
  }

  /** Wait for in-flight notifications (tests, graceful shutdown). */
  async function flush() {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  return { record, emit, flush, track };
}

export function listEvents(db, { before, after, type, source, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (before) { where.push('occurred_at < ?'); args.push(before); }
  if (after) { where.push('occurred_at > ?'); args.push(after); }
  if (type) {
    // `game.*` matches every game event.
    if (type.endsWith('.*')) { where.push('type LIKE ?'); args.push(type.slice(0, -1) + '%'); }
    else { where.push('type = ?'); args.push(type); }
  }
  if (source) { where.push('source = ?'); args.push(source); }
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const rows = db
    .prepare(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY occurred_at DESC LIMIT ${n}`)
    .all(...args);
  return rows.map(({ payload, received_at, ...ev }) => ({ ...ev, data: JSON.parse(payload) }));
}

/** '*' matches all, 'habit.*' matches every habit event, else exact. */
export function matchesType(pattern, type) {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

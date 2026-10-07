// Runs the shared Tracker core on sql.js (the phone's database) in Node,
// and syncs it against a real Tracker server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { adapt } from '../src/adapter.js';
import { createSync } from '../src/sync.js';
import { planReminders } from '../src/reminder-plan.js';
import { migrate } from '../../src/db/schema.js';
import { createEventBus } from '../../src/domain/events.js';
import * as trackers from '../../src/domain/trackers.js';
import * as library from '../../src/domain/library.js';
import { createApp } from '../../src/server.js';
import { openDb } from '../../src/db/index.js';

let SQL, server, base;
before(async () => {
  SQL = await initSqlJs();
  server = createApp({ db: openDb(':memory:'), fetchImpl: async () => new Response(null, { status: 200 }), secret: 't' });
  await new Promise((r) => server.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.server.address().port}`;
});
after(() => server.server.close());

function device() {
  const db = adapt(new SQL.Database());
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return { db, events: createEventBus(db) };
}

const web = (method, path, body, headers = {}) =>
  fetch(base + '/api/v1' + path, {
    method,
    headers: { 'x-128bit-client': 'web', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

test('domain code runs on sql.js: habits, streaks, library, transactions', () => {
  const ctx = device();
  const t = trackers.createTracker(ctx, { preset: 'water' });
  for (let i = 0; i < 8; i++) trackers.logTracker(ctx, t.id, {});
  const after = trackers.getTracker(ctx, t.id);
  assert.equal(after.today.total, 8);
  assert.equal(after.streak.current, 1);
  const item = library.createItem(ctx, { type: 'book', title: 'Dune', progress_total: 100 });
  const s = library.addSession(ctx, item.id, { minutes: 30, progress: 40 });
  assert.equal(s.status, 'active');
  assert.equal(s.minutes_total, 30);
  // cascade deletes need foreign keys on
  trackers.deleteTracker(ctx, t.id);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM logs').get().n, 0);
  assert.throws(() => library.addSession(ctx, item.id, {}), /minutes or progress/);
});

test('sync pulls 128bitplay events and pushes only the phone\'s own events', async () => {
  const phoneKey = (await web('POST', '/keys', { name: 'phone', scopes: ['sync'] })).key;
  const playKey = (await web('POST', '/keys', { name: '128bitplay', scopes: ['ingest'] })).key;
  const game = { id: 'g1', title: 'Star Hopper' };
  await web('POST', '/events', [
    { id: 'p1', type: 'game.started', data: { game } },
    { id: 'p2', type: 'game.session', data: { game, minutes: 40 } },
  ], { authorization: `Bearer ${playKey}` });

  const ctx = device();
  const habit = trackers.createTracker(ctx, { preset: 'gaming' });
  const sync = createSync(ctx);
  sync.configure({ server_url: base + '/', api_key: phoneKey });
  const meds = trackers.createTracker(ctx, { preset: 'meds' });
  trackers.logTracker(ctx, meds.id, {});

  const r = await sync.run();
  assert.equal(r.error, undefined);
  assert.equal(r.pulled, 2);
  assert.equal(r.pushed, 2); // habit.logged + habit.completed for Meds
  assert.equal(library.findByExternal(ctx, '128bitplay', 'g1').status, 'active');
  assert.equal(trackers.getTracker(ctx, habit.id).today.total, 40);

  const own = await web('GET', '/events?source=128bittracker&limit=100');
  assert.deepEqual(own.map((e) => e.data.tracker).filter(Boolean).sort(), ['Meds', 'Meds']);

  // Second run: nothing new either way (derived events stay local).
  const again = await sync.run();
  assert.deepEqual(again, { pulled: 0, pushed: 0, backed_up: false });
  assert.equal(sync.settings().pulled_total, 2);
});

test('sync reports server errors without throwing', async () => {
  const ctx = device();
  const sync = createSync(ctx);
  sync.configure({ server_url: base, api_key: 'tb128_notarealkey123' });
  const r = await sync.run();
  assert.match(r.error, /invalid or revoked API key/);
  assert.match(sync.settings().last_error, /401/);
});

test('backups: sync uploads a snapshot, restore brings it back on a new phone', async () => {
  const phoneKey = (await web('POST', '/keys', { name: 'phone-b', scopes: ['sync'] })).key;
  const ctx = device();
  const sync = createSync(ctx);
  sync.configure({ server_url: base, api_key: phoneKey });
  const t = trackers.createTracker(ctx, { preset: 'reading', remind_at: '21:00' });
  trackers.logTracker(ctx, t.id, { value: 25 });
  library.createItem(ctx, { type: 'show', title: 'Severance', rating: 9 });
  sync.markDirty();
  const r = await sync.run();
  assert.equal(r.backed_up, true);
  assert.ok(sync.settings().last_backup_at);

  // Lost phone: a fresh install restores everything from the server.
  const fresh = device();
  const sync2 = createSync(fresh);
  sync2.configure({ server_url: base, api_key: phoneKey });
  const res = await sync2.restore();
  assert.equal(res.restored.trackers, 1);
  const [restored] = trackers.listTrackers(fresh);
  assert.equal(restored.remind_at, '21:00');
  assert.equal(restored.today.total, 25);
  assert.equal(library.listItems(fresh, { q: 'Severance' })[0].rating, 9);
  // Restored history is not pushed again.
  const after = await sync2.run();
  assert.equal(after.pushed, 0);
});

test('reminder plan: next 7 days, skips today when done or already past', () => {
  const now = new Date(2026, 9, 7, 10, 0);
  const base = { id: 3, icon: '💧', name: 'Water', archived: false, streak: { current: 4 } };
  const notDone = planReminders([{ ...base, remind_at: '20:00', today: { done: false } }], now);
  assert.equal(notDone.length, 7);
  assert.equal(notDone[0].id, 30);
  assert.equal(notDone[0].at.getHours(), 20);
  assert.match(notDone[0].body, /4-day streak/);
  const done = planReminders([{ ...base, remind_at: '20:00', today: { done: true } }], now);
  assert.equal(done.length, 6);
  assert.equal(done[0].at.getDate(), 8);
  const past = planReminders([{ ...base, remind_at: '08:00', today: { done: false } }], now);
  assert.equal(past.length, 6);
  assert.equal(planReminders([{ ...base, remind_at: null, today: { done: false } }], now).length, 0);
});

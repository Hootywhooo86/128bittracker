import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createEventBus } from '../src/domain/events.js';
import { createTracker, getTracker } from '../src/domain/trackers.js';
import { toDay } from '../src/domain/dates.js';
import { applyHealth, healthStatus } from '../src/integrations/health.js';

function ctx() {
  const db = openDb(':memory:');
  return { db, events: createEventBus(db) };
}

test('Health Connect: workouts log once, steps top up to the day total', () => {
  const c = ctx();
  const steps = createTracker(c, { preset: 'steps' });
  const workout = createTracker(c, { preset: 'workout' });
  const day = toDay();
  const run = { id: 'abc', startDate: `${day}T07:00:00Z`, endDate: `${day}T07:31:00Z`, workoutType: 'RUNNING', duration: 1860, calories: 310.4, distance: 5012 };

  let r = applyHealth(c, { workouts: [run], days: [{ day, steps: 4200, active_calories: 300 }] });
  assert.deepEqual(r, { workouts_added: 1, days: 1 });
  assert.equal(getTracker(c, steps.id).today.total, 4200);
  assert.equal(getTracker(c, workout.id).today.total, 1);

  // Later the same day: same workout again (no-op), more steps (only the difference).
  r = applyHealth(c, { workouts: [run], days: [{ day, steps: 9100 }] });
  assert.equal(r.workouts_added, 0);
  assert.equal(getTracker(c, steps.id).today.total, 9100);
  assert.equal(getTracker(c, workout.id).today.total, 1);
  // A lower reading never takes steps away.
  applyHealth(c, { days: [{ day, steps: 100 }] });
  assert.equal(getTracker(c, steps.id).today.total, 9100);

  const ev = c.db.prepare("SELECT title, payload FROM events WHERE id = ?").get(`hc-day-${day}`);
  assert.equal(JSON.parse(ev.payload).steps, 100);
  const w = c.db.prepare("SELECT title, payload FROM events WHERE id = 'hc-workout-abc'").get();
  assert.equal(w.title, '💪 Running · 31 min');
  assert.equal(JSON.parse(w.payload).distance_m, 5012);
  assert.equal(healthStatus(c).workouts, 1);
});

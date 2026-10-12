// Any source, 128bitplay included. Every event lands on the timeline;
// habit trackers can also opt in via `listens`
// — e.g. a "Workout" tracker listening to workout.logged gets logged every
// time 128bitfit records one. No hard-coded per-app logic here.
//
// Logged value: check/scale → 1, count/duration → data.minutes ?? data.value ?? 1.
import { logTracker } from '../domain/trackers.js';
import { toDay } from '../domain/dates.js';

export function applyFamilyEvent(ctx, ev) {
  const trackers = ctx.db
    .prepare("SELECT id, kind FROM trackers WHERE archived = 0 AND (',' || listens || ',') LIKE ?")
    .all(`%,${ev.type},%`);
  const effects = [];
  for (const t of trackers) {
    const value = t.kind === 'check' || t.kind === 'scale' ? 1 : Number(ev.data.minutes ?? ev.data.value ?? 1);
    if (!Number.isFinite(value) || value <= 0) continue;
    logTracker(ctx, t.id, { value, day: toDay(ev.occurred_at) }, { source: ev.source });
    effects.push({ tracker_id: t.id, value });
  }
  return effects;
}

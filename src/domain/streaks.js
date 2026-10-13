// Streak engine — forgiving by design.
//
// A day "counts" when it was completed or covered by a freeze. Today is
// still in play, so an unlogged today never breaks a streak; it just isn't
// counted yet. Freezes keep a chain alive but don't add to its length.
import { addDays } from './dates.js';

export const MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365, 500, 1000];

/**
 * @param {Set<string>|string[]} doneDays  days the tracker hit its target
 * @param {Set<string>|string[]} frozenDays days covered by a streak freeze
 * @param {string} today
 */
export function computeStreak(doneDays, frozenDays, today) {
  const done = new Set(doneDays);
  const frozen = new Set(frozenDays);
  const alive = (d) => done.has(d) || frozen.has(d);

  // Current: walk back from today (or yesterday, if today isn't logged yet).
  let current = 0;
  let cursor = alive(today) ? today : addDays(today, -1);
  while (alive(cursor)) {
    if (done.has(cursor)) current++;
    cursor = addDays(cursor, -1);
  }

  // Best: scan every chain once, starting only at chain heads.
  let best = 0;
  for (const d of done) {
    if (alive(addDays(d, -1))) continue;
    let len = 0;
    let c = d;
    while (alive(c)) {
      if (done.has(c)) len++;
      c = addDays(c, 1);
    }
    best = Math.max(best, len);
  }

  const yesterday = addDays(today, -1);
  const doneToday = done.has(today);
  // "Never miss twice": yesterday slipped, today is the comeback day.
  const neverMissTwice = !doneToday && !alive(yesterday) && done.size > 0;
  const atRisk = !doneToday && current > 0 && !frozen.has(today);

  return { current, best: Math.max(best, current), doneToday, atRisk, neverMissTwice };
}

/** Milestone crossed when a streak goes from `before` to `after`, if any. */
export function milestoneCrossed(before, after) {
  return MILESTONES.find((m) => before < m && after >= m) ?? null;
}

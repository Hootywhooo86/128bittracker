import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStreak, milestoneCrossed } from '../src/domain/streaks.js';

const T = '2026-10-07';

test('unlogged today does not break the streak', () => {
  const s = computeStreak(['2026-10-04', '2026-10-05', '2026-10-06'], [], T);
  assert.equal(s.current, 3);
  assert.equal(s.atRisk, true);
  assert.equal(s.doneToday, false);
});

test('logging today extends it', () => {
  const s = computeStreak(['2026-10-05', '2026-10-06', T], [], T);
  assert.equal(s.current, 3);
  assert.equal(s.doneToday, true);
  assert.equal(s.atRisk, false);
});

test('freezes bridge a gap without counting', () => {
  const s = computeStreak(['2026-10-03', '2026-10-04', '2026-10-06', T], ['2026-10-05'], T);
  assert.equal(s.current, 4);
  assert.equal(s.best, 4);
});

test('a missed day resets current but keeps best', () => {
  const s = computeStreak(['2026-09-01', '2026-09-02', '2026-09-03', '2026-10-05'], [], T);
  assert.equal(s.current, 0);
  assert.equal(s.best, 3);
  assert.equal(s.neverMissTwice, true);
});

test('milestones', () => {
  assert.equal(milestoneCrossed(6, 7), 7);
  assert.equal(milestoneCrossed(7, 8), null);
  assert.equal(milestoneCrossed(0, 3), 3);
});

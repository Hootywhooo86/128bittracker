import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sittingMinutes, sittingWhere, fixSittingTitle } from '../public/sitting.js';
import { fromFamily } from '../src/integrations/family-account.js';

test('sittings: minutes from the positions when Play\'s ticks undercount (screen off)', () => {
  // Oct 14: "Masquerade · 7 min", 3:10–4:05 PM, player went from 4:41 to 59:41 in chapter 1.
  const d = { title: 'Masquerade', minutes: 7, from_chapter: 1, from_s: 281, to_chapter: 1, to_s: 3581, from_pct: 2, to_pct: 3, started_at: '2026-10-14T21:10:00Z' };
  assert.equal(sittingMinutes(d, '2026-10-14T22:05:00Z'), 55);
  assert.equal(sittingMinutes({ ...d, started_at: undefined }), 55, 'no start time: the position difference');
  assert.equal(sittingMinutes({ ...d, started_at: '2026-10-14T21:50:00Z' }, '2026-10-14T22:05:00Z'), 15, 'never more than the clock says (seeking, speed)');
  assert.equal(sittingMinutes({ ...d, minutes: 70 }), 70, 'ticks win when larger');
  assert.equal(sittingMinutes({ ...d, to_chapter: 3, to_s: 600 }), 7, 'across chapters: ticks stand');
  assert.equal(sittingMinutes({ minutes: 12, from_s: 100, to_s: 1900 }), 30, 'videos: no chapters');
  assert.equal(sittingMinutes({ minutes: 12, from_s: 1900, to_s: 100 }), 12, 'went back: ticks');
  assert.equal(sittingMinutes({ minutes: 12 }), 12);

  // Positions always show when present, even only one end.
  assert.equal(sittingWhere(d), 'Ch 1 4:41 → Ch 1 59:41');
  assert.equal(sittingWhere({ from_s: 2530, to_s: 4350 }), '42:10 → 1:12:30');
  assert.equal(sittingWhere({ to_chapter: 2, to_s: 61 }), '… → Ch 2 1:01');
  assert.equal(sittingWhere({}), '');

  // Titles saved before the fix are corrected on the timeline; new ones are right as stored.
  assert.equal(fixSittingTitle('🎧 Masquerade · 7 min · 2% → 3%', d, '2026-10-14T22:05:00Z'), '🎧 Masquerade · 55 min · 2% → 3%');
  assert.equal(fixSittingTitle('🎧 Masquerade · 2% → 3%', { ...d, minutes: 0 }, '2026-10-14T22:05:00Z'), '🎧 Masquerade · 55 min · 2% → 3%');
  assert.equal(fixSittingTitle('▶ Severance · S1 E2 · 40%', { show: 'Severance', episode: 'S1 E2', from_s: 0, to_s: 1800 }), '▶ Severance · S1 E2 · 30 min · 40%');
  const ev = fromFamily({ id: 'x', app: 'play', type: 'listen.session', at: Date.parse('2026-10-14T22:05:00Z'), data: d });
  assert.equal(ev.title, '🎧 Masquerade · 55 min · 2% → 3%');
});
